/**
 * claudeAttribution.ts
 *
 * Pure logic (no `vscode` import) that decides whether a filesystem write seen
 * by WorkspaceWatcher was made by Claude Code, using a TURN WINDOW:
 *
 *   every write between the user's message (`UserPromptSubmit` hook) and
 *   Claude's `Stop` hook (+ a grace period) is Claude's.
 *
 * Claude Code waits for `UserPromptSubmit` to finish before Claude starts
 * working, so the turn is on record long before Claude's first edit — the
 * watcher's decision ~200 ms after a write always finds it, even when the
 * change notice arrives late (network/sync drives).
 *
 * A turn only covers files in a workspace folder related to the turn's `cwd`
 * (same folder, inside it, or a parent of it), so a Claude session in another
 * project never claims writes here.
 *
 * Anything not covered is NOT Claude's: the watcher just refreshes its baseline
 * and opens no diff (copying a file into the folder, git, formatters, …).
 *
 * Assumptions (see CLAUDE.md, "Claude turn-window attribution"): nothing but
 * Claude writes workspace files during a Claude turn, and turns are not
 * interrupted with Esc (an interrupt fires no `Stop`).
 */

import * as path from 'path';

export type HookEventName = 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'Stop';

const KNOWN_EVENTS: ReadonlySet<string> = new Set<HookEventName>([
  'PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop',
]);

export interface HookEvent {
  event: HookEventName;
  sessionId?: string;
  /** Normalized working directory of the Claude session, when present. */
  cwd?: string;
  /** When the hook ran (event file mtime), ms since epoch. */
  at: number;
}

export interface AttributionTimings {
  /** Writes noticed up to this long after `Stop` still count (watcher latency). */
  stopGraceMs: number;
  /** Lifetime of a turn whose `Stop` never arrives (crash, window closed mid-turn). */
  maxOpenMs: number;
}

export const DEFAULT_TIMINGS: AttributionTimings = {
  stopGraceMs: 10_000,
  maxOpenMs: 3 * 60 * 60_000,
};

/** A `Stop` arrived for a session with no open turn (its turn-start hook failed). */
export interface StopWithoutStartInfo {
  sessionId?: string;
  cwd?: string;
  at: number;
  /** That session's previous `Stop`, if seen: the missing turn started after it. */
  since?: number;
}

export interface ClaudeAttributionOptions {
  timings?: AttributionTimings;
  /** Normalized workspace folder roots (as VS Code reports them). */
  workspaceFolders?: () => string[];
  /**
   * Resolves a path to a canonical form before comparing a turn's `cwd` with a
   * workspace folder (e.g. realpath, so `P:\x` and `\\server\share\x` match).
   * Results are cached per path. Default: identity.
   */
  canonicalize?: (p: string) => string;
  onStopWithoutStart?: (info: StopWithoutStartInfo) => void;
  /** A turn's `cwd` shares no workspace folder with a written file. */
  onCwdMismatch?: (cwd: string, root: string) => void;
}

export function normalizeFsPath(p: string, platform: string = process.platform): string {
  const resolved = path.resolve(p);
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** True if `child` is `parent` or inside it. Both must already be normalized. */
export function isInside(child: string, parent: string): boolean {
  if (child === parent) { return true; }
  const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return child.startsWith(prefix);
}

/** Parse one raw hook payload (Claude Code hook stdin JSON). Returns undefined if unusable. */
export function parseHookEvent(raw: string, at: number): HookEvent | undefined {
  let obj: Record<string, unknown>;
  try {
    // PowerShell writers may prepend a BOM.
    obj = JSON.parse(raw.replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
  if (!obj || typeof obj !== 'object') { return undefined; }

  const event = obj['hook_event_name'];
  if (typeof event !== 'string' || !KNOWN_EVENTS.has(event)) { return undefined; }
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const cwd = str(obj['cwd']);

  return {
    event: event as HookEventName,
    sessionId: str(obj['session_id']),
    cwd: cwd ? normalizeFsPath(cwd) : undefined,
    at,
  };
}

interface Turn {
  sessionId?: string;
  cwd?: string;
  start: number;
  end?: number;
}

/** Closed turns are kept this long past their window for delayed watcher decisions. */
const PRUNE_MARGIN_MS = 60_000;

export class ClaudeAttribution {
  readonly timings: AttributionTimings;
  private readonly turns: Turn[] = [];
  /** Last `Stop` time per session — bounds the recovery window of a missed turn start. */
  private readonly lastStopAt = new Map<string, number>();
  private readonly canonCache = new Map<string, string>();
  private everSawEvent = false;

  private readonly workspaceFolders: () => string[];
  private readonly canonicalize: (p: string) => string;
  private readonly onStopWithoutStart: (info: StopWithoutStartInfo) => void;
  private readonly onCwdMismatch: (cwd: string, root: string) => void;

  constructor(options: ClaudeAttributionOptions = {}) {
    this.timings = options.timings ?? DEFAULT_TIMINGS;
    this.workspaceFolders = options.workspaceFolders ?? (() => []);
    this.canonicalize = options.canonicalize ?? (p => p);
    this.onStopWithoutStart = options.onStopWithoutStart ?? (() => {});
    this.onCwdMismatch = options.onCwdMismatch ?? (() => {});
  }

  hasSeenAnyEvent(): boolean {
    return this.everSawEvent;
  }

  /**
   * @param historical the event happened before this window started (startup
   *        catch-up): record it, but never report a missed turn start for it.
   */
  ingest(evt: HookEvent, historical = false): void {
    this.everSawEvent = true;

    if (evt.event === 'UserPromptSubmit') {
      // A still-open turn of this session missed its Stop: it ends here.
      for (const t of this.openTurns(evt.sessionId)) { t.end = Math.max(t.start, evt.at); }
      this.turns.push({ sessionId: evt.sessionId, cwd: evt.cwd, start: evt.at });
      return;
    }

    if (evt.event === 'Stop') {
      const open = this.openTurns(evt.sessionId);
      const since = evt.sessionId ? this.lastStopAt.get(evt.sessionId) : undefined;
      if (evt.sessionId) { this.lastStopAt.set(evt.sessionId, evt.at); }
      if (open.length === 0) {
        if (!historical) {
          this.onStopWithoutStart({ sessionId: evt.sessionId, cwd: evt.cwd, at: evt.at, since });
        }
        return;
      }
      for (const t of open) { t.end = Math.max(t.start, evt.at); }
    }
    // PreToolUse / PostToolUse: leftovers from the per-edit design — ignored.
  }

  /**
   * @param absPath absolute path of the written file (normalized here, so
   *                callers can pass any form)
   * @param writeAt when the watcher received the write event (ms)
   */
  isClaudeWrite(absPath: string, writeAt: number): boolean {
    return this.turns.some(t =>
      writeAt >= t.start && writeAt <= this.closesAt(t) && this.turnMatchesPath(t.cwd, absPath)
    );
  }

  /** Workspace filter: does a turn running in `cwd` cover this file? */
  turnMatchesPath(cwd: string | undefined, absPath: string): boolean {
    if (!cwd) { return true; }
    const target = normalizeFsPath(absPath);
    const root = this.workspaceFolders().find(r => isInside(target, r));
    if (!root) { return true; } // no folder info: don't over-filter
    const ok = this.related(cwd, root);
    if (!ok) { this.onCwdMismatch(cwd, root); }
    return ok;
  }

  /** Is `cwd` related to any workspace folder (same, inside, or parent)? */
  cwdMatchesWorkspace(cwd: string | undefined): boolean {
    if (!cwd) { return true; }
    const roots = this.workspaceFolders();
    return roots.length === 0 || roots.some(r => this.related(cwd, r));
  }

  /** Drop turns that can no longer match any future write. */
  prune(now: number): void {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      if (now - this.closesAt(this.turns[i]) > PRUNE_MARGIN_MS) { this.turns.splice(i, 1); }
    }
    for (const [sessionId, at] of this.lastStopAt) {
      if (now - at > this.timings.maxOpenMs + this.timings.stopGraceMs) { this.lastStopAt.delete(sessionId); }
    }
  }

  private closesAt(t: Turn): number {
    return (t.end ?? t.start + this.timings.maxOpenMs) + this.timings.stopGraceMs;
  }

  private openTurns(sessionId?: string): Turn[] {
    return this.turns.filter(t => t.end === undefined && (!sessionId || t.sessionId === sessionId));
  }

  private related(cwd: string, root: string): boolean {
    const c = this.canon(cwd);
    const r = this.canon(root);
    return isInside(c, r) || isInside(r, c);
  }

  private canon(p: string): string {
    let v = this.canonCache.get(p);
    if (v === undefined) {
      let resolved = p;
      try { resolved = this.canonicalize(p); } catch { /* keep p */ }
      v = normalizeFsPath(resolved);
      this.canonCache.set(p, v);
    }
    return v;
  }
}
