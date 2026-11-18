/**
 * diffManager.ts
 *
 * Snapshot + accept/revert state cho các file đang được AI sửa.
 * Render bằng diff editor có sẵn của VS Code (`vscode.diff`): vế trái là
 * snapshot (virtual document, xem snapshotContentProvider.ts), vế phải là file
 * thật. Mỗi pending file = 1 tab diff.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { calculateHunks, Hunk } from './hunkCalculator';
import { toLf } from './eol';
import { SnapshotStore, SnapshotState } from './snapshotStore';
import { isPendingDiffInput, snapshotUriFor } from './snapshotUri';

function normalizePath(filePath: string): string {
  const fsPath = vscode.Uri.file(path.resolve(filePath)).fsPath;
  return process.platform === 'win32' ? fsPath.toLowerCase() : fsPath;
}

/**
 * Trả về path với case canonical từ OS (Windows preserve case từ disk).
 * Dùng khi gọi VS Code APIs để tab/tên file hiển thị đúng case như user.
 * Fallback về input nếu file không tồn tại.
 */
function canonicalCasePath(filePath: string): string {
  try {
    return fs.realpathSync.native(filePath);
  } catch {
    return filePath;
  }
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof vscode.FileSystemError && error.code === 'FileNotFound';
}

export interface DiffPreviewFile {
  filePath: string;
  originalContent: string;
  currentContent: string;
  hunks: Hunk[];
}

/** Lightweight data for navigators that must not receive file contents. */
export interface DiffPreviewMetadata {
  filePath: string;
  additions: number;
  deletions: number;
  hunks: number;
}

/**
 * Where and how to reopen a file as a plain editor once its diff closes: the
 * diff's editor group, and the cursor + scroll position of its modified side.
 */
interface ViewState {
  cursor?: vscode.Position;
  topLine?: number;
  viewColumn?: vscode.ViewColumn;
}

export class DiffManager implements vscode.Disposable {
  private _onDidChangeDiffs = new vscode.EventEmitter<void>();
  public readonly onDidChangeDiffs = this._onDidChangeDiffs.event;
  /**
   * The content of an already-pending file changed (the agent wrote it again,
   * or the user saved it) while its pending state did not. Separate from
   * onDidChangeDiffs so these frequent writes don't refresh snapshot documents
   * or context keys — only views showing per-file counts need it.
   */
  private _onDidChangePendingContent = new vscode.EventEmitter<void>();
  public readonly onDidChangePendingContent = this._onDidChangePendingContent.event;

  private snapshots: Map<string, SnapshotState> = new Map();
  private readonly store: SnapshotStore;
  private readonly disposables: vscode.Disposable[] = [];
  /**
   * Paths whose snapshot accept()/revert() is currently resolving. revert()
   * saves the file back to its snapshot content, which would otherwise also
   * trigger the "edited back to the original" cleanup for the same file.
   */
  private readonly resolving = new Set<string>();

  /**
   * filePath (normalized) của tab đang active NGAY TRƯỚC khi WorkspaceWatcher
   * bắt đầu tự động mở diff cho 1 cụm external write (checkout đổi vài file
   * hay hàng loạt file đều tính, xem markActiveTabBeforeAutoOpen()). undefined
   * nghĩa là không có tab file nào active lúc đó (vd: đang ở sidebar)
   * — vẫn khác với "chưa ghi hint nào", phân biệt bằng pendingActiveTabCaptured.
   */
  private pendingActiveTabPath: string | undefined;
  private pendingActiveTabCaptured = false;
  private pendingActiveTabCapturedAt = 0;
  /**
   * Hint quá cũ (vd: cụm write đó rốt cuộc không phải git checkout nên
   * clearAll() không bao giờ chạy theo sau nó) thì bỏ qua, để lần clearAll()
   * không liên quan sau đó không lỡ dùng lại path cũ. Rộng hơn nhiều so với
   * holdMs tối đa (10s) + debounce xác nhận HEAD (1s).
   */
  private static readonly PENDING_ACTIVE_TAB_TTL_MS = 15000;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.store = new SnapshotStore(context.workspaceState);
    this.snapshots = this.store.load();

    // The modified side is a normal editor: the user can edit it (or use the
    // diff editor's own "revert block" arrows) until it matches the snapshot
    // again. Only react to settled content — never to unsaved edits — so a
    // dirty document is never closed under the user.
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((document) => this.onDocumentSettled(document)),
      vscode.workspace.onDidChangeTextDocument((event) => this.onDocumentSettled(event.document)),
    );
  }

  async openDiff(filePath: string, options?: { preserveFocus?: boolean }): Promise<void> {
    const absPath = normalizePath(filePath);
    const snapshot = this.snapshots.get(absPath);
    if (snapshot === undefined) { return; }

    let modifiedContent: string;
    try {
      modifiedContent = Buffer.from(
        await vscode.workspace.fs.readFile(vscode.Uri.file(absPath))
      ).toString('utf8');
    } catch {
      return;
    }

    // So trên LF thuần: thay đổi thuần EOL (git checkout, đổi setting files.eol,
    // formatter...) cho ra 0 hunk và rơi vào nhánh dọn dẹp bên dưới, thay vì mở
    // một diff phủ cả file.
    const hunks = calculateHunks(toLf(snapshot.content), toLf(modifiedContent));
    if (hunks.length === 0) {
      // A newly-created empty file is still pending: Revert must delete it and
      // Accept must keep it. There is simply no text hunk to render.
      if (!snapshot.fileExistedBefore) { return; }
      this.snapshots.delete(absPath);
      void this.store.save(this.snapshots);
      this._onDidChangeDiffs.fire();
      return;
    }

    await this.closeTextTabsFor(absPath);

    const fileUri = vscode.Uri.file(canonicalCasePath(absPath));
    // Reveal an already-open diff in its own group instead of opening a
    // second copy in the active group.
    const existing = this.findDiffTabs(absPath)[0];
    const showOptions: vscode.TextDocumentShowOptions = {
      preview: false,
      preserveFocus: options?.preserveFocus === true,
      viewColumn: existing?.group.viewColumn,
    };
    const label = path.basename(fileUri.fsPath);
    const title = snapshot.fileExistedBefore ? `${label} (AI changes)` : `${label} (new file, AI)`;
    await vscode.commands.executeCommand('vscode.diff', snapshotUriFor(fileUri), fileUri, title, showOptions);

    // vscode.diff là async: nếu clearAll()/accept() chạy xong TRƯỚC khi tab kịp
    // mở (vd: git branch confirm ngay giữa lúc đang mở), snapshot đã bị xoá nhưng
    // tab này vẫn được mở ra sau đó. Không còn gì để diff — đóng luôn.
    if (!this.snapshots.has(absPath)) {
      await this.closeDiffTabs(absPath);
    }
    this._onDidChangeDiffs.fire();
  }

  /**
   * Đóng mọi tab text editor đang trỏ tới file này, để diff editor mới mở
   * không tạo tab thứ hai cùng file.
   */
  private async closeTextTabsFor(absPath: string): Promise<void> {
    const targets: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (!(tab.input instanceof vscode.TabInputText)) { continue; }
        if (normalizePath(tab.input.uri.fsPath) === absPath) {
          // Preserve unsaved user edits. Closing a dirty text tab here would
          // trigger VS Code's save/discard dialog while an external change is
          // being routed to the diff editor.
          if (tab.isDirty) { continue; }
          targets.push(tab);
        }
      }
    }
    if (targets.length === 0) { return; }
    try {
      await vscode.window.tabGroups.close(targets);
    } catch (err) {
      console.error('[ai-cli-diff] closeTextTabsFor failed:', err);
    }
  }

  loadSnapshot(filePath: string, content: string, fileExistedBefore = true): void {
    const absPath = normalizePath(filePath);
    if (!this.snapshots.has(absPath)) {
      this.snapshots.set(absPath, { content, fileExistedBefore });
      void this.store.save(this.snapshots);
      this._onDidChangeDiffs.fire();
    }
  }

  /**
   * Accept toàn bộ thay đổi của 1 file: file đã sẵn trên đĩa với currentContent,
   * chỉ cần xoá snapshot.
   */
  async accept(filePath: string): Promise<void> {
    const absPath = normalizePath(filePath);
    if (!this.snapshots.has(absPath)) { return; }

    const nextTarget = this.nextPendingAfter(absPath);
    const view = this.captureViewState(absPath);

    this.resolving.add(absPath);
    try {
      this.snapshots.delete(absPath);
      void this.store.save(this.snapshots);
      // Open the plain editor BEFORE closing the diff: if the diff's modified
      // side has unsaved edits, closing the last editor showing that document
      // would make VS Code ask to save or discard.
      await this.reopenAsTextEditor(absPath, view);
      await this.closeDiffTabs(absPath);
    } finally {
      this.resolving.delete(absPath);
    }

    if (nextTarget) {
      await this.openDiff(nextTarget);
    }
    this._onDidChangeDiffs.fire();
  }

  /**
   * Revert toàn bộ: ghi originalContent ra đĩa.
   * Nếu file vốn không tồn tại trước đó -> xoá file.
   */
  async revert(filePath: string): Promise<void> {
    const absPath = normalizePath(filePath);
    const snapshot = this.snapshots.get(absPath);
    if (!snapshot) { return; }

    const nextTarget = this.nextPendingAfter(absPath);
    const view = this.captureViewState(absPath);

    this.resolving.add(absPath);
    try {
      if (snapshot.fileExistedBefore) {
        await this.writeFile(absPath, snapshot.content);
      } else {
        await this.deleteFile(absPath);
      }

      this.snapshots.delete(absPath);
      void this.store.save(this.snapshots);
      if (snapshot.fileExistedBefore) {
        await this.reopenAsTextEditor(absPath, view);
      }
      await this.closeDiffTabs(absPath);
    } finally {
      this.resolving.delete(absPath);
    }

    if (nextTarget) {
      await this.openDiff(nextTarget);
    }
    this._onDidChangeDiffs.fire();
  }

  async acceptAllPending(): Promise<number> {
    const count = this.snapshots.size;
    const activePath = this.getActiveDiffPath();
    const view = activePath ? this.captureViewState(activePath) : undefined;
    this.snapshots.clear();
    void this.store.save(this.snapshots);
    if (activePath) {
      await this.reopenAsTextEditor(activePath, view);
    }
    await this.closeDiffTabs();
    this._onDidChangeDiffs.fire();
    return count;
  }

  hasPendingDiff(filePath: string): boolean {
    return this.snapshots.has(normalizePath(filePath));
  }

  /**
   * Called by WorkspaceWatcher when an already-pending file is written again.
   * Needed when no editor has the file open: then VS Code raises no document
   * event for the write.
   */
  notifyPendingContentChanged(filePath: string): void {
    if (this.snapshots.has(normalizePath(filePath))) {
      this._onDidChangePendingContent.fire();
    }
  }

  getPendingFiles(): string[] {
    return Array.from(this.snapshots.keys());
  }

  /** Snapshot content (left side of the diff), in the file's original EOL. */
  getSnapshot(filePath: string): string | undefined {
    return this.snapshots.get(normalizePath(filePath))?.content;
  }

  /**
   * Build the diff payload for a pending file: the snapshot is the original
   * side, the open document (or the file on disk) the modified side. Both are
   * normalized to LF before calculating hunks.
   */
  async getDiffPreviewFile(filePath: string): Promise<DiffPreviewFile | undefined> {
    const absPath = normalizePath(filePath);
    const snapshot = this.snapshots.get(absPath);
    if (!snapshot) { return undefined; }

    let currentContent = '';
    const openDocument = vscode.workspace.textDocuments.find(
      (document) => document.uri.scheme === 'file' && normalizePath(document.uri.fsPath) === absPath
    );
    if (openDocument) {
      currentContent = openDocument.getText();
    } else {
      try {
        currentContent = Buffer.from(
          await vscode.workspace.fs.readFile(vscode.Uri.file(absPath))
        ).toString('utf8');
      } catch (err) {
        if (!isFileNotFound(err)) {
          return undefined;
        }
      }
    }

    const originalLf = toLf(snapshot.content);
    const currentLf = toLf(currentContent);
    const hunks = calculateHunks(originalLf, currentLf);
    if (hunks.length === 0 && snapshot.fileExistedBefore) {
      return undefined;
    }

    return {
      filePath: absPath,
      originalContent: originalLf,
      currentContent: currentLf,
      hunks,
    };
  }

  /**
   * Return pending-diff counters without exposing either side of a file to a
   * webview. Computed in the extension host so the Pending Files view stays a
   * navigator, not a second diff renderer.
   */
  async getDiffPreviewMetadata(): Promise<DiffPreviewMetadata[]> {
    const files = await Promise.all(this.getPendingFiles().map(async (filePath) => {
      const preview = await this.getDiffPreviewFile(filePath);
      if (!preview) { return undefined; }
      return {
        filePath: preview.filePath,
        additions: preview.hunks.reduce((total, hunk) => total + hunk.addedLines.length, 0),
        deletions: preview.hunks.reduce((total, hunk) => total + hunk.removedLines.length, 0),
        hunks: preview.hunks.length,
      };
    }));
    return files.filter((file): file is DiffPreviewMetadata => file !== undefined);
  }

  /** Path of the pending diff in the active tab, if the active tab is one. */
  getActiveDiffPath(): string | undefined {
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (!isPendingDiffInput(input)) { return undefined; }
    const absPath = normalizePath(input.modified.fsPath);
    return this.snapshots.has(absPath) ? absPath : undefined;
  }

  /**
   * Diff tabs survive a window reload, but their snapshot may not (file
   * deleted, workspace state cleared). Close those, since their left side
   * would render as empty.
   */
  async closeStaleDiffTabs(): Promise<void> {
    const stale = this.allDiffTabs().filter((tab) => (
      !this.snapshots.has(normalizePath((tab.input as vscode.TabInputTextDiff).modified.fsPath))
    ));
    await this.closeTabs(stale);
  }

  /** Disposes listeners only: diff tabs are left open so a reload restores them. */
  dispose(): void {
    while (this.disposables.length) {
      this.disposables.pop()?.dispose();
    }
    this._onDidChangeDiffs.dispose();
    this._onDidChangePendingContent.dispose();
  }

  /**
   * Xoá toàn bộ pending (vd: git branch switch). Cần persist clean state để
   * sau reload window không bị `SnapshotStore.load()` kéo lại.
   *
   * Nếu tab đang active đúng là 1 diff tab bị xoá, mở lại nó dưới dạng text
   * editor thường (giữ cursor/scroll) thay vì để nó biến mất đột ngột — chỉ
   * áp dụng cho tab đang active, KHÔNG áp dụng cho mọi tab bị đóng (nếu
   * không sẽ mở lại hàng loạt tab cho các file nền user không đang xem).
   */
  async clearAll(): Promise<void> {
    const hint = this.consumePendingActiveTabHint();
    const activeDiffPath = hint.captured
      ? (hint.path !== undefined && this.snapshots.has(hint.path) ? hint.path : undefined)
      : this.getActiveDiffPath();
    const view = activeDiffPath ? this.captureViewState(activeDiffPath) : undefined;

    this.snapshots.clear();
    await this.store.clear();

    if (activeDiffPath) {
      await this.reopenAsTextEditor(activeDiffPath, view);
    }
    await this.closeDiffTabs();
    this._onDidChangeDiffs.fire();
  }

  /**
   * Gọi bởi WorkspaceWatcher ở write ĐẦU TIÊN của 1 cụm external write sắp tự
   * động mở diff (xem WorkspaceWatcher.resolveOrHold — áp dụng cho cả mở ngay
   * lẫn hold-rồi-dump, không riêng burst). Ghi lại tab đang active THẬT SỰ tại
   * thời điểm đó — trước khi các openDiff() không đồng bộ trong cụm chạy đua
   * khiến activeTab trở nên ngẫu nhiên. clearAll() (khi git xác nhận branch
   * đổi đến sau đó) sẽ ưu tiên dùng giá trị này thay vì tab thắng cuộc đua.
   */
  markActiveTabBeforeAutoOpen(): void {
    this.pendingActiveTabPath = this.getCurrentTabFsPath();
    this.pendingActiveTabCaptured = true;
    this.pendingActiveTabCapturedAt = Date.now();
  }

  private getCurrentTabFsPath(): string | undefined {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const uri =
      tab?.input instanceof vscode.TabInputText ? tab.input.uri :
      isPendingDiffInput(tab?.input) ? tab.input.modified :
      tab?.input instanceof vscode.TabInputNotebook ? tab.input.uri :
      undefined;
    return uri ? normalizePath(uri.fsPath) : undefined;
  }

  /** Dùng 1 lần: đọc xong luôn reset state, để lần clearAll() sau (không có
   *  cụm auto-open nào xảy ra trước đó) không vô tình dùng lại hint cũ. */
  private consumePendingActiveTabHint(): { captured: boolean; path: string | undefined } {
    const captured = this.pendingActiveTabCaptured;
    const path = this.pendingActiveTabPath;
    const capturedAt = this.pendingActiveTabCapturedAt;
    this.pendingActiveTabCaptured = false;
    this.pendingActiveTabPath = undefined;
    this.pendingActiveTabCapturedAt = 0;
    if (!captured || Date.now() - capturedAt > DiffManager.PENDING_ACTIVE_TAB_TTL_MS) {
      return { captured: false, path: undefined };
    }
    return { captured, path };
  }

  // ---- Diff tab bookkeeping ----

  private allDiffTabs(): vscode.Tab[] {
    const tabs: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (isPendingDiffInput(tab.input)) { tabs.push(tab); }
      }
    }
    return tabs;
  }

  private findDiffTabs(absPath: string): vscode.Tab[] {
    return this.allDiffTabs().filter((tab) => (
      normalizePath((tab.input as vscode.TabInputTextDiff).modified.fsPath) === absPath
    ));
  }

  /** Close the diff tabs of one file, or of every pending file when omitted. */
  private async closeDiffTabs(absPath?: string): Promise<void> {
    await this.closeTabs(absPath === undefined ? this.allDiffTabs() : this.findDiffTabs(absPath));
  }

  private async closeTabs(tabs: vscode.Tab[]): Promise<void> {
    if (tabs.length === 0) { return; }

    // A diff whose right side has unsaved edits: closing the last editor of
    // that document would prompt save/discard. Open the file as a plain tab in
    // the same group first (focus stays put), so the edits stay visible and
    // nothing prompts. Callers remove the snapshot before closing, so
    // autoRouteTab doesn't send the new tab back into a diff.
    const dirty = tabs.filter((tab) => tab.isDirty && isPendingDiffInput(tab.input));
    for (const tab of dirty) {
      try {
        await vscode.window.showTextDocument((tab.input as vscode.TabInputTextDiff).modified, {
          viewColumn: tab.group.viewColumn,
          preserveFocus: true,
          preview: false,
        });
      } catch (err) {
        console.error('[ai-cli-diff] keeping unsaved edits open failed:', err);
      }
    }

    // Opening tabs changed the tab model; look the diff tabs up again rather
    // than closing possibly stale Tab objects.
    let targets = tabs;
    if (dirty.length > 0) {
      const keyOf = (tab: vscode.Tab): string => (
        `${tab.group.viewColumn}|${normalizePath((tab.input as vscode.TabInputTextDiff).modified.fsPath)}`
      );
      const wanted = new Set(tabs.map(keyOf));
      targets = this.allDiffTabs().filter((tab) => wanted.has(keyOf(tab)));
    }

    try {
      await vscode.window.tabGroups.close(targets);
    } catch (err) {
      console.error('[ai-cli-diff] closing diff tabs failed:', err);
    }
  }

  private nextPendingAfter(absPath: string): string | undefined {
    const pending = this.getPendingFiles();
    const idx = pending.findIndex(p => normalizePath(p) === absPath);
    return pending.length > 1 && idx !== -1
      ? pending[(idx + 1) % pending.length]
      : undefined;
  }

  /**
   * The editor group of the file's diff tab (the active one if several), plus
   * the cursor and scroll position of the visible editor showing the real
   * file — in a diff, that is the modified (right) side.
   *
   * The group matters with split editors: a diff's title-bar Accept/Revert can
   * be clicked in a group that isn't the active one, and the plain editor must
   * replace the diff there, not appear in the other group.
   */
  private captureViewState(absPath: string): ViewState | undefined {
    const diffTabs = this.findDiffTabs(absPath);
    const diffTab = diffTabs.find((tab) => tab.group.isActive) ?? diffTabs[0];
    const viewColumn = diffTab?.group.viewColumn;

    const matches = (editor: vscode.TextEditor): boolean => (
      editor.document.uri.scheme === 'file' &&
      normalizePath(editor.document.uri.fsPath) === absPath &&
      (viewColumn === undefined || editor.viewColumn === viewColumn)
    );
    const active = vscode.window.activeTextEditor;
    const editor = active && matches(active) ? active : vscode.window.visibleTextEditors.find(matches);
    if (!editor && viewColumn === undefined) { return undefined; }
    return {
      cursor: editor?.selection.active,
      topLine: editor?.visibleRanges[0]?.start.line,
      viewColumn,
    };
  }

  /**
   * @param opts.preserveFocus Keep keyboard focus where it is. Used when the
   *   reopen is not a reaction to the user acting on this diff.
   */
  private async reopenAsTextEditor(
    absPath: string,
    view: ViewState | undefined,
    opts?: { preserveFocus?: boolean }
  ): Promise<void> {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(absPath));
    } catch (err) {
      if (!isFileNotFound(err)) {
        console.error('[ai-cli-diff] cannot stat file before reopening:', err);
      }
      return;
    }
    const uri = vscode.Uri.file(canonicalCasePath(absPath));
    const showOptions: vscode.TextDocumentShowOptions = {
      preview: false,
      viewColumn: view?.viewColumn,
      preserveFocus: opts?.preserveFocus === true,
    };
    if (view?.cursor) {
      showOptions.selection = new vscode.Range(view.cursor, view.cursor);
    }
    try {
      const editor = await vscode.window.showTextDocument(uri, showOptions);
      if (view?.topLine !== undefined) {
        const lastLine = Math.max(0, editor.document.lineCount - 1);
        const top = Math.min(lastLine, Math.max(0, view.topLine));
        editor.revealRange(
          new vscode.Range(top, 0, top, 0),
          vscode.TextEditorRevealType.AtTop
        );
      }
    } catch (err) {
      console.error('[ai-cli-diff] reopenAsTextEditor failed:', err);
    }
  }

  /**
   * Saved/reloaded content of a pending file changed. If it is back to its
   * snapshot there is nothing left to review (edited back by hand, the diff
   * editor's revert arrows + save, or the agent undoing its own change): drop
   * it like an accept. Otherwise only its +/− counts are out of date.
   *
   * Unlike Accept/Revert, this can be triggered by the agent while the user
   * works elsewhere, so it must not move focus or bring a hidden tab forward:
   * a diff that is the visible tab of its group is replaced in place by the
   * plain file without taking focus; a background diff tab is just closed
   * (the document isn't dirty here, so closing never prompts).
   */
  private onDocumentSettled(document: vscode.TextDocument): void {
    if (document.uri.scheme !== 'file' || document.isDirty) { return; }
    const absPath = normalizePath(document.uri.fsPath);
    if (this.resolving.has(absPath)) { return; }
    const snapshot = this.snapshots.get(absPath);
    if (!snapshot) { return; }
    if (!snapshot.fileExistedBefore || toLf(document.getText()) !== toLf(snapshot.content)) {
      this._onDidChangePendingContent.fire();
      return;
    }

    void (async () => {
      const visibleDiff = this.findDiffTabs(absPath).find((tab) => tab.isActive);
      const view = visibleDiff
        ? { ...this.captureViewState(absPath), viewColumn: visibleDiff.group.viewColumn }
        : undefined;
      this.resolving.add(absPath);
      try {
        this.snapshots.delete(absPath);
        void this.store.save(this.snapshots);
        if (view) {
          await this.reopenAsTextEditor(absPath, view, { preserveFocus: true });
        }
        await this.closeDiffTabs(absPath);
      } finally {
        this.resolving.delete(absPath);
      }
      this._onDidChangeDiffs.fire();
    })();
  }

  /** Ghi content (đúng dạng byte của snapshot) ra file, qua document nếu đang mở. */
  private async writeFile(absPath: string, content: string): Promise<void> {
    const uri = vscode.Uri.file(absPath);
    const doc = vscode.workspace.textDocuments.find(
      d => d.uri.scheme === 'file' && normalizePath(d.uri.fsPath) === absPath
    );

    if (doc) {
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        new vscode.Position(0, 0),
        doc.lineAt(doc.lineCount - 1).range.end
      );
      edit.replace(uri, fullRange, content);
      await vscode.workspace.applyEdit(edit);
      await doc.save();
    } else {
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    }
  }

  private async deleteFile(absPath: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(absPath));
    } catch (err) {
      if (!isFileNotFound(err)) {
        throw err;
      }
    }
  }
}
