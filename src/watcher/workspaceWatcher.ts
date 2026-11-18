/**
 * workspaceWatcher.ts
 *
 * Theo dõi file thay đổi trong workspace qua VS Code API.
 * Khi bất kỳ file nào được ghi (bởi Claude, hay bất kỳ tool nào),
 * extension sẽ tự động snapshot và hiện inline diff.
 *
 * Flow:
 *   1. onDidSaveTextDocument → sync snapshot để FileSystemWatcher không trigger diff sai
 *   2. FileSystemWatcher → bắt được cả file ghi từ external process
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { DiffManager } from '../diff/diffManager';
import { BaselineScanner } from './baselineScanner';
import { BaselineStore } from './baselineStore';
import { isTextFile } from './fileTypeRules';
import { isExcludedPath } from './pathExclusions';
import { exceedsLineLimit, exceedsSizeLimitByBytes } from './fileSizeLimit';
import { BurstMeterConfig, WriteBurstMeter } from './writeBurstMeter';

/**
 * Which file-watcher event reported the write. A `change` proves the file
 * existed before; a `create` only suggests it is new (a write-to-temp-then-
 * rename save also reports `create` for an existing file).
 */
type WriteEventKind = 'create' | 'change';

interface ExternalWriteOptions {
  burstHoldOverride?: boolean;
  readDelayMs?: number;
  /** When the FS event was originally received (kept across queueing). */
  eventAtOverride?: number;
}

/**
 * Optional gate: decides whether an external write was made by the agent.
 * When absent or disabled, every external write is treated as an agent edit
 * (previous behaviour, needed for Codex/Qwen which have no hooks).
 */
export interface EditAttribution {
  isEnabled(): boolean;
  isAgentWrite(absPath: string, eventAt: number): Promise<boolean>;
  /** Called when a real change was ignored as not-the-agent's. */
  onIgnoredWrite?(absPath: string): void;
  /**
   * Lets the gate reclaim writes it wrongly ignored (e.g. Claude's turn-start
   * hook failed, noticed only at its Stop). The handler opens diffs for every
   * remembered ignored write that `match` accepts and returns how many.
   */
  setRecoveryHandler?(handler: (match: (absPath: string, eventAt: number) => boolean) => Promise<number>): void;
}

/** Before-image of a write the attribution gate ignored, kept for recovery. */
interface IgnoredWrite {
  before: string;
  existed: boolean;
  eventAt: number;
}

export class WorkspaceWatcher {
  private disposables: vscode.Disposable[] = [];
  /** Debounce: thời điểm lần cuối xử lý mỗi file */
  private lastProcessed = new Map<string, number>();
  /** Lưu thời điểm VS Code vừa Save file (để bỏ qua watcher trigger từ chính VS Code) */
  private savedFilesByVsCode = new Map<string, number>();
  private readonly snapshots: BaselineStore;
  private readonly baselineScanner: BaselineScanner;
  private readonly pendingTimers = new Set<NodeJS.Timeout>();
  /** Directory-create events waiting for one settled subtree reconciliation. */
  private readonly pendingDirectoryScans = new Map<string, NodeJS.Timeout>();
  private static readonly DIRECTORY_SETTLE_MS = 300;
  /** When a `create` event was last seen per path (see wasCreatedAround). */
  private readonly recentCreates = new Map<string, number>();
  /** A create counts for a write whose event came within this much of it. */
  private static readonly CREATE_MATCH_MS = 2000;
  /** Long enough to outlive a write queued behind a slow initial baseline scan. */
  private static readonly RECENT_CREATE_TTL_MS = 10 * 60_000;
  /** Debounce window is 500ms — keep entries an order of magnitude longer for safety, then drop. */
  private static readonly LAST_PROCESSED_TTL_MS = 60_000;
  /** VS Code save guard window is 2s — same safety multiplier. */
  private static readonly SAVED_BY_VSCODE_TTL_MS = 10_000;
  /**
   * Cờ "đang trong external batch operation" (vd: git checkout đổi branch).
   * Trong window này, mọi external write chỉ cập nhật baseline mà KHÔNG tạo diff.
   * Được set bởi GitBranchWatcher khi phát hiện .git/HEAD đổi.
   */
  private suppressUntil = 0;
  private readonly burstMeter = new WriteBurstMeter();
  /** Giữ external write đến khi initial baseline scan hoàn tất. */
  private baselineScansInProgress = 0;
  private readonly queuedExternalWrites = new Map<string, { kind: WriteEventKind; burstHold: boolean; readDelayMs: number; eventAt: number }>();
  /** Thời gian giữ file vượt ngưỡng burst chờ xác nhận git trước khi mở diff bình thường. */
  private holdMs = 2000;
  /** File vượt ngưỡng burst, đang chờ xác nhận git (xem resolveOrHold/scheduleHoldResolve). */
  private readonly heldWrites = new Map<string, { originalContent: string; newContent: string; fileExistedBefore: boolean }>();
  private holdResolveTimer: NodeJS.Timeout | undefined;
  /** Mốc thời gian write-triggered diff-open gần nhất — dùng để nhận biết "write đầu cụm" trong resolveOrHold(). */
  private lastAutoOpenActivityAt = 0;
  /** Khoảng cách tối thiểu giữa 2 write để coi là 2 cụm khác nhau (và ghi lại hint activeTab mới). */
  private static readonly ACTIVE_TAB_CAPTURE_GAP_MS = 500;
  /**
   * Writes the attribution gate judged not-the-agent's, oldest first per file.
   * The baseline has already moved past them, so this is the only copy of their
   * before-image if the gate later reclaims them (see recoverIgnoredWrites).
   */
  private readonly ignoredWrites = new Map<string, IgnoredWrite[]>();
  /** Longest a Claude turn can stay open (3 h) plus margin. */
  private static readonly IGNORED_WRITE_TTL_MS = 3 * 60 * 60_000 + 60_000;
  private static readonly IGNORED_WRITE_MAX_FILES = 500;
  private static readonly IGNORED_WRITE_MAX_PER_FILE = 20;

  constructor(
    private readonly diffManager: DiffManager,
    private readonly attribution?: EditAttribution
  ) {
    this.snapshots = new BaselineStore();
    this.baselineScanner = new BaselineScanner(this.snapshots);
    this.attribution?.setRecoveryHandler?.(match => this.recoverIgnoredWrites(match));
  }

  start(): void {
    this.watchVscodeEvents();
    this.watchWorkspaceFolders();
    this.applyBurstConfig();
    const d = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('ai-cli-diff-view.burstDetectionEnabled') ||
          e.affectsConfiguration('ai-cli-diff-view.burstDetectionWindowMs') ||
          e.affectsConfiguration('ai-cli-diff-view.burstDetectionThreshold') ||
          e.affectsConfiguration('ai-cli-diff-view.burstDetectionHoldMs')) {
        this.applyBurstConfig();
      }
    });
    this.disposables.push(d);
  }

  private applyBurstConfig(): void {
    this.burstMeter.updateConfig(this.loadBurstMeterConfig());
    const config = vscode.workspace.getConfiguration('ai-cli-diff-view');
    const holdMs = config.get<number>('burstDetectionHoldMs', 2000);
    this.holdMs = Number.isFinite(holdMs) ? Math.min(10000, Math.max(500, holdMs)) : 2000;
  }

  private loadBurstMeterConfig(): BurstMeterConfig {
    const config = vscode.workspace.getConfiguration('ai-cli-diff-view');
    const windowMs = config.get<number>('burstDetectionWindowMs', 300);
    const threshold = config.get<number>('burstDetectionThreshold', 8);
    return {
      enabled: config.get<boolean>('burstDetectionEnabled', true),
      windowMs: Number.isFinite(windowMs) ? Math.min(5000, Math.max(50, windowMs)) : 300,
      threshold: Number.isFinite(threshold) ? Math.min(500, Math.max(2, threshold)) : 8,
    };
  }

  /**
   * Báo cho watcher biết vừa có external batch operation (vd: git checkout).
   * - Wipe baseline trong RAM để rebuild từ disk hiện tại.
   * - Set suppress window để các fs event đến sau (kể cả từ setTimeout 200ms
   *   đã pending) không tạo diff nữa, chỉ ghi đè baseline.
   * - Xác nhận git thật đã xảy ra: bỏ toàn bộ file đang bị giữ (heldWrites) —
   *   không mở diff cho chúng nữa, đúng như baseline vừa rebuild.
   */
  notifyExternalBatch(windowMs = 5000): void {
    this.suppressUntil = Date.now() + windowMs;
    this.snapshots.clear();
    if (this.holdResolveTimer) {
      clearTimeout(this.holdResolveTimer);
      this.holdResolveTimer = undefined;
    }
    this.heldWrites.clear();
    // Baseline is rebuilt from the new working tree; old before-images are stale.
    this.ignoredWrites.clear();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      void this.watchFolder(folder.uri.fsPath).catch(() => {
        // ignore — sẽ tự rebuild dần qua các event sau
      });
    }
  }

  private isSuppressed(): boolean {
    return Date.now() < this.suppressUntil;
  }

  private normalizePath(p: string): string {
    const fsPath = vscode.Uri.file(path.resolve(p)).fsPath;
    return process.platform === 'win32' ? fsPath.toLowerCase() : fsPath;
  }

  private normalizeContent(content: string): string {
    return content.trim().replace(/\r\n/g, '\n');
  }

  /**
   * Sync snapshot khi VS Code save — đảm bảo FileSystemWatcher không trigger diff sai.
   * (onDidSaveTextDocument luôn fire trước watcher event)
   */
  private watchVscodeEvents(): void {
    const d = vscode.workspace.onDidSaveTextDocument((doc) => {
      const filePath = this.normalizePath(doc.uri.fsPath);
      // File quá lớn thì không giữ baseline — nhưng phải ĐÁNH DẤU, không chỉ bỏ
      // qua: nếu sau này nó tụt xuống dưới ngưỡng, "không có baseline" sẽ bị hiểu
      // là file mới và Revert all sẽ xoá mất file. Vẫn ghi nhận VS Code vừa lưu
      // để FileSystemWatcher không hiểu nhầm đây là external write.
      const text = doc.getText();
      if (exceedsLineLimit(text)) {
        this.snapshots.markSizeSkipped(filePath);
      } else {
        this.snapshots.set(filePath, text);
      }
      this.savedFilesByVsCode.set(filePath, Date.now());
      // The user edited the file in VS Code: an older ignored write's
      // before-image would now fold the user's edit into a recovered diff.
      this.ignoredWrites.delete(filePath);
      this.pruneStaleMapEntries();
    });
    this.disposables.push(d);
  }

  private pruneStaleMapEntries(): void {
    const now = Date.now();
    for (const [key, ts] of this.lastProcessed) {
      if (now - ts > WorkspaceWatcher.LAST_PROCESSED_TTL_MS) {
        this.lastProcessed.delete(key);
      }
    }
    for (const [key, ts] of this.savedFilesByVsCode) {
      if (now - ts > WorkspaceWatcher.SAVED_BY_VSCODE_TTL_MS) {
        this.savedFilesByVsCode.delete(key);
      }
    }
    for (const [key, ts] of this.recentCreates) {
      if (now - ts > WorkspaceWatcher.RECENT_CREATE_TTL_MS) {
        this.recentCreates.delete(key);
      }
    }
    for (const [key, list] of this.ignoredWrites) {
      const kept = list.filter(w => now - w.eventAt <= WorkspaceWatcher.IGNORED_WRITE_TTL_MS);
      if (kept.length === 0) {
        this.ignoredWrites.delete(key);
      } else if (kept.length !== list.length) {
        this.ignoredWrites.set(key, kept);
      }
    }
  }

  private watchWorkspaceFolders(): void {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) { return; }

    // Sử dụng FileSystemWatcher native của VS Code để tránh kẹt event loop
    // khi tạo mới project có hàng ngàn file (VD: node_modules trong Next.js)
    const fileWatcher = vscode.workspace.createFileSystemWatcher('**/*');
    fileWatcher.onDidChange((uri) => {
      this.handleExternalWrite(uri, 'change');
    });
    fileWatcher.onDidCreate((uri) => {
      // Record it now, before handleExternalCreate's async stat: a `change`
      // for the same new file can take the debounce slot meanwhile and drop
      // this `create`, and it must still count as a new file.
      this.recentCreates.set(this.normalizePath(uri.fsPath), Date.now());
      void this.handleExternalCreate(uri);
    });
    
    this.disposables.push(fileWatcher);

    for (const folder of folders) {
      void this.watchFolder(folder.uri.fsPath);
    }

    const d = vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      for (const added of e.added) {
        void this.watchFolder(added.uri.fsPath);
      }
    });
    this.disposables.push(d);
  }

  private async watchFolder(folderPath: string): Promise<void> {
    this.baselineScansInProgress++;
    try {
      await this.baselineScanner.buildInitialSnapshots(folderPath);
    } catch (err) {
      console.error('[ai-cli-diff-view] workspaceWatcher buildInitialSnapshots error:', err);
    } finally {
      this.baselineScansInProgress--;
      if (this.baselineScansInProgress === 0) {
        const queued = Array.from(this.queuedExternalWrites.entries());
        this.queuedExternalWrites.clear();
        for (const [filePath, queuedWrite] of queued) {
          this.lastProcessed.delete(filePath);
          this.handleExternalWrite(vscode.Uri.file(filePath), queuedWrite.kind, {
            burstHoldOverride: queuedWrite.burstHold,
            readDelayMs: queuedWrite.readDelayMs,
            eventAtOverride: queuedWrite.eventAt,
          });
        }
      }
    }
  }

  /**
   * File-create events follow the normal write path. Directory-create events
   * need one delayed subtree scan because a recursive watcher can observe the
   * new directory but miss children created in the same filesystem batch.
   */
  private async handleExternalCreate(uri: vscode.Uri): Promise<void> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      const isDirectory = (stat.type & vscode.FileType.Directory) !== 0;
      const isSymlink = (stat.type & vscode.FileType.SymbolicLink) !== 0;
      if (!isDirectory) {
        this.handleExternalWrite(uri, 'create');
        return;
      }

      const absPath = this.normalizePath(uri.fsPath);
      if (isSymlink || isExcludedPath(absPath)) {
        return;
      }
      this.scheduleDirectoryScan(uri, absPath);
    } catch {
      // The created path may already have been moved or deleted.
    }
  }

  private scheduleDirectoryScan(uri: vscode.Uri, absPath: string): void {
    // A pending ancestor scan already covers this directory.
    for (const pendingPath of this.pendingDirectoryScans.keys()) {
      if (this.isSameOrDescendant(absPath, pendingPath)) {
        return;
      }
    }

    // Prefer the broader scan if a parent event arrives after child events.
    for (const [pendingPath, timer] of this.pendingDirectoryScans) {
      if (this.isSameOrDescendant(pendingPath, absPath)) {
        clearTimeout(timer);
        this.pendingDirectoryScans.delete(pendingPath);
      }
    }

    const timer = setTimeout(() => {
      this.pendingDirectoryScans.delete(absPath);
      void this.scanCreatedDirectory(uri);
    }, WorkspaceWatcher.DIRECTORY_SETTLE_MS);
    this.pendingDirectoryScans.set(absPath, timer);
  }

  private isSameOrDescendant(candidatePath: string, parentPath: string): boolean {
    const relative = path.relative(parentPath, candidatePath);
    return relative === '' ||
      (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
  }

  private async scanCreatedDirectory(rootUri: vscode.Uri): Promise<void> {
    const pending = [rootUri];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(directory);
      } catch {
        continue;
      }

      for (const [name, type] of entries) {
        const childUri = vscode.Uri.joinPath(directory, name);
        const childPath = this.normalizePath(childUri.fsPath);
        if (isExcludedPath(childPath) || (type & vscode.FileType.SymbolicLink) !== 0) {
          continue;
        }
        if ((type & vscode.FileType.Directory) !== 0) {
          pending.push(childUri);
        } else if ((type & vscode.FileType.File) !== 0 && isTextFile(name)) {
          // The directory already had a settle delay, so do not add the normal
          // 200ms file-write delay again. Existing file debounce handles overlap
          // with a child onDidCreate event that VS Code did deliver.
          // Children of a newly created directory are new files.
          this.handleExternalWrite(childUri, 'create', { readDelayMs: 0 });
        }
      }
    }
  }

  private handleExternalWrite(
    uri: vscode.Uri,
    kind: WriteEventKind,
    options: ExternalWriteOptions = {}
  ): void {
    const absPath = this.normalizePath(uri.fsPath);
    const readDelayMs = options.readDelayMs ?? 200;
    const eventAt = options.eventAtOverride ?? Date.now();

    // Đo tốc độ ghi TRƯỚC mọi filter bên dưới — xem writeBurstMeter.ts. Capture
    // quyết định NGAY tại thời điểm raw event tới (chính xác nhất so với cửa
    // sổ trượt), mang theo qua debounce/setTimeout bên dưới tới lúc quyết định
    // triggerDiff — không gọi record() lần 2 để tránh đếm trùng.
    const burstHold = options.burstHoldOverride ?? this.burstMeter.record(absPath);

    // Bỏ qua dependency / build output / tooling (dotnet bin/obj, node_modules, …)
    // và mọi thứ ngoài workspace — cùng bộ lọc với BaselineScanner.
    if (isExcludedPath(absPath)) {
      return;
    }

    // 1. Kiểm tra xem file này vừa được VS Code Save hay không
    const lastVsCodeSave = this.savedFilesByVsCode.get(absPath) ?? 0;
    const now = Date.now();
    if (now - lastVsCodeSave < 2000) {
      // Bỏ qua vì đây là viết từ chính VS Code editor
      return;
    }

    // 2. Debounce: bỏ qua nếu vừa xử lý file này trong 500ms
    const lastTime = this.lastProcessed.get(absPath) ?? 0;
    if (now - lastTime < 500) { return; }
    this.lastProcessed.set(absPath, now);
    this.pruneStaleMapEntries();

    if (!isTextFile(path.basename(absPath))) { return; }

    if (this.baselineScansInProgress > 0) {
      // A file created and then changed while queued is still new: keep
      // `create`, otherwise the change would make it look like an existing
      // file without a baseline and its diff would never open.
      const queuedKind = this.queuedExternalWrites.get(absPath)?.kind === 'create' ? 'create' : kind;
      this.queuedExternalWrites.set(absPath, { kind: queuedKind, burstHold, readDelayMs, eventAt });
      return;
    }

    if (readDelayMs <= 0) {
      void this.processExternalWrite(uri, absPath, kind, burstHold, eventAt);
      return;
    }

    // Đọc nội dung mới sau một chút để đảm bảo write xong.
    const timer = setTimeout(() => {
      this.pendingTimers.delete(timer);
      void this.processExternalWrite(uri, absPath, kind, burstHold, eventAt);
    }, readDelayMs);
    this.pendingTimers.add(timer);
  }

  private async processExternalWrite(
    uri: vscode.Uri,
    absPath: string,
    kind: WriteEventKind,
    burstHold: boolean,
    eventAt: number
  ): Promise<void> {
    // Re-check immediately before reading in case VS Code saved the document
    // while this write was waiting for its settle delay.
    const lastVsCodeSaveAfterTimeout = this.savedFilesByVsCode.get(absPath) ?? 0;
    if (Date.now() - lastVsCodeSaveAfterTimeout < 2000) {
      return;
    }

    try {
      // Lọc thô theo byte TRƯỚC khi đọc, để file vài MB không bị đọc lên chỉ để loại.
      // stat() cũng là phép kiểm tra file tồn tại; nếu file đã bị xóa, nó sẽ throw.
      const stat = await vscode.workspace.fs.stat(uri);
      if (exceedsSizeLimitByBytes(stat.size)) {
        this.snapshots.markSizeSkipped(absPath);
        return;
      }

      const newContentRaw = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');

      // File vượt giới hạn số dòng -> coi như không tồn tại với extension:
      // không giữ baseline, không mở diff. Xoá cả baseline cũ phòng khi file
      // vừa vượt ngưỡng (hoặc user vừa hạ setting xuống).
      if (exceedsLineLimit(newContentRaw)) {
        this.snapshots.markSizeSkipped(absPath);
        return;
      }

      // Trong window external batch (vd: git checkout): chỉ refresh baseline,
      // không tạo diff. Tránh việc so working tree mới với baseline branch cũ.
      if (this.isSuppressed()) {
        this.snapshots.set(absPath, newContentRaw);
        return;
      }

      const oldContentRaw = this.snapshots.get(absPath);

      const newContent = this.normalizeContent(newContentRaw);
      const oldContent = oldContentRaw !== undefined ? this.normalizeContent(oldContentRaw) : undefined;

      if (oldContent === undefined) {
        this.snapshots.set(absPath, newContentRaw);
        // File từng bị bỏ qua vì quá lớn và giờ vừa lọt xuống dưới ngưỡng:
        // nó KHÔNG phải file mới. Không có baseline cũ để so, nên chỉ nhận nội
        // dung hiện tại làm baseline rồi thôi. Mở diff ở đây sẽ hiện cả file là
        // "thêm mới", và Revert all trên diff đó sẽ xoá mất file.
        if (this.snapshots.consumeSizeSkipped(absPath)) { return; }
        // A `change` event proves the file existed, but its before-image is
        // unknown (scanner couldn't read it, `files.exclude`, …). Treating it
        // as new would make Revert delete a real file, so only take the
        // current content as its baseline, like the size-skipped case above.
        if (kind === 'change' && !this.wasCreatedAround(absPath, eventAt)) { return; }
        // Baseline is already refreshed above; a write the agent didn't make
        // (copying a file in, git, a formatter…) must not open a diff.
        if (!(await this.isAgentWrite(absPath, eventAt, { before: '', existed: false, eventAt }))) { return; }
        // A new empty file still needs a pending snapshot: accepting keeps it,
        // while reverting removes it. It has no content hunk to render.
        this.resolveOrHold(absPath, '', newContentRaw, false, burstHold);
        return;
      }

      if (oldContent === newContent) {
        // normalizeContent() bỏ qua EOL, nên nhánh này còn nuốt cả trường hợp
        // file chỉ đổi CRLF <-> LF. Phải refresh baseline raw trước khi thoát,
        // nếu không snapshot giữ EOL cũ vĩnh viễn và lần sửa 1 dòng kế tiếp sẽ
        // bị so lệch EOL -> diff phủ cả file (bug #15).
        this.snapshots.set(absPath, newContentRaw);
        return;
      }

      // Trước khi trigger diff mới, cập nhật baseline vào snapshot store của watcher
      // để lần save kế tiếp không bị trigger lại.
      this.snapshots.set(absPath, newContentRaw);

      if (!this.diffManager.hasPendingDiff(absPath)) {
        if (!(await this.isAgentWrite(absPath, eventAt, { before: oldContentRaw!, existed: true, eventAt }))) { return; }
        this.resolveOrHold(absPath, oldContentRaw!, newContentRaw, true, burstHold);
      } else {
        // Already pending: its snapshot (left side) stays the version before
        // the first edit and the diff shows the live file, so only the
        // Pending Files counts need refreshing.
        this.diffManager.notifyPendingContentChanged(absPath);
      }
    } catch {
      // file đang bị lock, không có quyền đọc hoặc đã bị xóa — bỏ qua
    }
  }

  /**
   * A `create` event for this path came close to this write's event. Covers a
   * new file whose `create` lost the debounce slot to its `change`.
   */
  private wasCreatedAround(absPath: string, eventAt: number): boolean {
    const createdAt = this.recentCreates.get(absPath);
    if (createdAt === undefined) { return false; }
    this.recentCreates.delete(absPath);
    return Math.abs(createdAt - eventAt) <= WorkspaceWatcher.CREATE_MATCH_MS;
  }

  private async isAgentWrite(absPath: string, eventAt: number, ignored: IgnoredWrite): Promise<boolean> {
    if (!this.attribution?.isEnabled()) { return true; }
    try {
      if (await this.attribution.isAgentWrite(absPath, eventAt)) { return true; }
    } catch {
      return true; // fail open: a broken gate must not hide agent edits
    }
    this.rememberIgnoredWrite(absPath, ignored);
    this.attribution.onIgnoredWrite?.(absPath);
    return false;
  }

  private rememberIgnoredWrite(absPath: string, write: IgnoredWrite): void {
    const list = this.ignoredWrites.get(absPath);
    if (list) {
      list.push(write);
      if (list.length > WorkspaceWatcher.IGNORED_WRITE_MAX_PER_FILE) { list.shift(); }
      return;
    }
    if (this.ignoredWrites.size >= WorkspaceWatcher.IGNORED_WRITE_MAX_FILES) {
      // Map iterates in insertion order: drop the file remembered longest ago.
      const oldest = this.ignoredWrites.keys().next().value;
      if (oldest !== undefined) { this.ignoredWrites.delete(oldest); }
    }
    this.ignoredWrites.set(absPath, [write]);
  }

  /**
   * Open diffs for remembered ignored writes that the gate now reclaims. For
   * each file, the earliest matching write's before-image is the left side and
   * the file on disk is the right side.
   */
  private async recoverIgnoredWrites(match: (absPath: string, eventAt: number) => boolean): Promise<number> {
    let opened = 0;
    for (const [absPath, list] of Array.from(this.ignoredWrites)) {
      const hit = list.find(w => match(absPath, w.eventAt));
      if (!hit) { continue; }
      this.ignoredWrites.delete(absPath);
      if (this.diffManager.hasPendingDiff(absPath)) { continue; }

      let current: string;
      try {
        current = Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(absPath))).toString('utf8');
      } catch {
        continue; // deleted since — nothing to show
      }
      if (exceedsLineLimit(current)) { continue; }
      if (hit.existed && this.normalizeContent(current) === this.normalizeContent(hit.before)) { continue; }
      // The write may have arrived while this was reading the file.
      if (this.diffManager.hasPendingDiff(absPath)) { continue; }
      this.resolveOrHold(absPath, hit.before, current, hit.existed, false);
      opened++;
    }
    return opened;
  }

  private triggerDiff(
    filePath: string,
    originalContent: string,
    newContent: string,
    fileExistedBefore: boolean,
    fromBurstDump = false
  ): void {
    // The open diff now owns this file's before-image.
    this.ignoredWrites.delete(filePath);
    this.diffManager.loadSnapshot(filePath, originalContent, fileExistedBefore);
    this.diffManager.openDiff(filePath, fromBurstDump ? { preserveFocus: true } : undefined).catch((err: unknown) => {
      console.error('[ai-cli-diff-view] workspaceWatcher openDiff failed:', err);
    });
  }

  /**
   * File dưới ngưỡng burst: mở diff ngay như trước. File vượt ngưỡng: giữ lại
   * chờ `holdMs` — nếu trong lúc chờ git branch được xác nhận đổi thật
   * (`notifyExternalBatch()` chạy), file bị bỏ âm thầm; nếu không, mở diff
   * bình thường sau khi hết giờ chờ, như chưa từng bị giữ.
   */
  private resolveOrHold(
    filePath: string,
    originalContent: string,
    newContent: string,
    fileExistedBefore: boolean,
    hold: boolean
  ): void {
    // Ghi lại tab đang active THẬT SỰ trước khi mở diff — chỉ ở write ĐẦU
    // TIÊN của 1 cụm (cách write gần nhất > ACTIVE_TAB_CAPTURE_GAP_MS), để
    // không ghi đè bằng activeTab đã bị các openDiff() không đồng bộ trước đó
    // trong cùng cụm làm ngẫu nhiên. Áp dụng cho cả nhánh mở ngay (checkout
    // đổi ít file, dưới ngưỡng burst nhưng vẫn ghi gần như đồng thời) lẫn
    // nhánh hold-rồi-dump — không chỉ riêng burst. DiffManager.clearAll() sẽ
    // dùng hint này thay vì activeTab tại thời điểm clear (đã có thể bị hỏng
    // bởi race) nếu git branch đổi ngay sau đó.
    const now = Date.now();
    if (now - this.lastAutoOpenActivityAt > WorkspaceWatcher.ACTIVE_TAB_CAPTURE_GAP_MS) {
      this.diffManager.markActiveTabBeforeAutoOpen();
    }
    this.lastAutoOpenActivityAt = now;

    // Already held (written again while its burst awaits git confirmation):
    // the held entry has the before-image from BEFORE the first write, while
    // `originalContent` here is the baseline, which already contains the first
    // write. Keep the earliest one, otherwise the diff hides the first write
    // and Revert only goes back to the in-between version. This applies even
    // when this write is not itself a burst: opening now would use the
    // in-between version and skip the pending git check for this file. The
    // hold timer is already running and opens the diff when it fires.
    const held = this.heldWrites.get(filePath);
    if (held) {
      held.newContent = newContent;
      return;
    }

    if (!hold) {
      this.triggerDiff(filePath, originalContent, newContent, fileExistedBefore);
      return;
    }
    this.heldWrites.set(filePath, { originalContent, newContent, fileExistedBefore });
    this.scheduleHoldResolve();
  }

  /** Debounce dùng chung cho cả cụm burst: mỗi file mới vào hàng chờ sẽ reset lại. */
  private scheduleHoldResolve(): void {
    if (this.holdResolveTimer) {
      clearTimeout(this.holdResolveTimer);
    }
    this.holdResolveTimer = setTimeout(() => {
      this.holdResolveTimer = undefined;
      const entries = Array.from(this.heldWrites.entries());
      this.heldWrites.clear();
      for (const [filePath, w] of entries) {
        this.triggerDiff(filePath, w.originalContent, w.newContent, w.fileExistedBefore, true);
      }
    }, this.holdMs);
  }


  /** Cập nhật snapshot khi người dùng tự sửa file (để baseline luôn đúng) */
  updateSnapshot(filePath: string, content: string): void {
    this.snapshots.set(this.normalizePath(filePath), content);
  }

  dispose(): void {
    for (const d of this.disposables) { d.dispose(); }
    this.disposables = [];
    for (const timer of this.pendingTimers) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
    for (const timer of this.pendingDirectoryScans.values()) {
      clearTimeout(timer);
    }
    this.pendingDirectoryScans.clear();
    if (this.holdResolveTimer) {
      clearTimeout(this.holdResolveTimer);
      this.holdResolveTimer = undefined;
    }
    this.heldWrites.clear();
    this.queuedExternalWrites.clear();
    this.recentCreates.clear();
  }
}
