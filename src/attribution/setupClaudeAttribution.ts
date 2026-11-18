/**
 * setupClaudeAttribution.ts
 *
 * VS Code glue for the "claudeCodeHooks" attribution mode:
 *  - installs/removes the hooks when the setting changes,
 *  - provides the EditAttribution gate used by WorkspaceWatcher,
 *  - polls the hook events folder while the mode is on, so a `Stop` whose turn
 *    start was never recorded is noticed when the turn ends, and the writes the
 *    gate ignored during that turn are recovered as diffs,
 *  - warns once if writes are being ignored while no hook event ever arrived
 *    (hook not installed, or a Claude session started before the install).
 */

import * as fs from 'fs';
import * as vscode from 'vscode';
import { ClaudeAttribution, StopWithoutStartInfo, normalizeFsPath } from './claudeAttribution';
import { ClaudeHookSource } from './claudeHookSource';
import { applyClaudeAttributionHooks } from './claudeHookInstaller';
import type { EditAttribution } from '../watcher/workspaceWatcher';

const SECTION = 'ai-cli-diff-view';
const MODE_KEY = 'editAttribution';
const POLL_INTERVAL_MS = 2000;
type Mode = 'allExternalWrites' | 'claudeCodeHooks';
type RecoveryHandler = (match: (absPath: string, eventAt: number) => boolean) => Promise<number>;

function getMode(): Mode {
  return vscode.workspace.getConfiguration(SECTION).get<Mode>(MODE_KEY, 'allExternalWrites');
}

/** Canonical on-disk path, so a mapped drive and its UNC path compare equal. */
function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
}

export function setupClaudeEditAttribution(
  context: vscode.ExtensionContext,
  log: (msg: string) => void
): EditAttribution {
  let recover: RecoveryHandler | undefined;
  const loggedCwdMismatch = new Set<string>();
  const warnedRecoveredSessions = new Set<string>();

  const attribution: ClaudeAttribution = new ClaudeAttribution({
    workspaceFolders: () => (vscode.workspace.workspaceFolders ?? []).map(f => normalizeFsPath(f.uri.fsPath)),
    canonicalize: realpathOrSelf,
    onCwdMismatch: (cwd, root) => {
      if (loggedCwdMismatch.has(cwd)) { return; }
      loggedCwdMismatch.add(cwd);
      log(`attribution: Claude turn cwd ${cwd} is unrelated to workspace folder ${root} — its turns don't cover files here`);
    },
    onStopWithoutStart: info => { void recoverMissedTurn(info); },
  });
  const source = new ClaudeHookSource(attribution);
  let warnedNoEvents = false;

  async function recoverMissedTurn(info: StopWithoutStartInfo): Promise<void> {
    if (!attribution.cwdMatchesWorkspace(info.cwd)) { return; } // another project's session
    const { maxOpenMs, stopGraceMs } = attribution.timings;
    const from = info.since ?? info.at - maxOpenMs;
    const to = info.at + stopGraceMs;
    const session = info.sessionId ?? 'unknown';
    log(`attribution: Stop without turn start (session ${session}) — recovering ignored writes ` +
      `${new Date(from).toISOString()} … ${new Date(to).toISOString()}`);
    if (!recover) { return; }
    const opened = await recover((absPath, eventAt) =>
      eventAt > from && eventAt <= to && attribution.turnMatchesPath(info.cwd, absPath)
    );
    log(`attribution: recovered ${opened} write(s) for session ${session}`);
    if (opened > 0 && !warnedRecoveredSessions.has(session)) {
      warnedRecoveredSessions.add(session);
      void vscode.window.showWarningMessage(
        'AI CLI Diff View: the Claude Code turn-start hook did not run for this turn, so its diffs opened ' +
        'only when Claude finished. If this repeats, restart the Claude session so it loads the hook.'
      );
    }
  }

  let poller: { dispose(): void } | undefined;
  const setPolling = (on: boolean) => {
    if (on && !poller) {
      poller = source.start(POLL_INTERVAL_MS);
    } else if (!on && poller) {
      poller.dispose();
      poller = undefined;
    }
  };
  context.subscriptions.push({ dispose: () => setPolling(false) });

  const sync = (announce: boolean) => {
    const enabled = getMode() === 'claudeCodeHooks';
    const result = applyClaudeAttributionHooks(enabled);
    log(`attribution:hooks ${enabled ? 'enable' : 'disable'} → ${result}`);
    setPolling(enabled);
    if (result === 'parseError') {
      void vscode.window.showErrorMessage(
        'AI CLI Diff View: ~/.claude/settings.json is not valid JSON, so the Claude Code hook was not ' +
        (enabled ? 'installed' : 'removed') + '. Fix the file and toggle the setting again.'
      );
    } else if (result === 'writeError') {
      void vscode.window.showErrorMessage('AI CLI Diff View: could not write ~/.claude/settings.json.');
    } else if (result === 'installed' && announce) {
      void vscode.window.showInformationMessage(
        'AI CLI Diff View: Claude Code hook installed. Only file changes made during a Claude turn will open ' +
        'diffs. Restart any Claude session that was already running so it picks up the hook.'
      );
    }
  };

  sync(false);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(`${SECTION}.${MODE_KEY}`)) { sync(true); }
    })
  );

  return {
    isEnabled: () => getMode() === 'claudeCodeHooks',
    isAgentWrite: (absPath, eventAt) => source.isClaudeWrite(absPath, eventAt),
    onIgnoredWrite: (absPath) => {
      log(`attribution:ignored non-Claude write ${absPath}`);
      if (!warnedNoEvents && !source.hasSeenAnyEvent()) {
        warnedNoEvents = true;
        void vscode.window.showWarningMessage(
          'AI CLI Diff View ignored a file change because no Claude turn was running, and no hook ' +
          'event has been received yet. If Claude made this change, restart the Claude session so it ' +
          'loads the hook.'
        );
      }
    },
    setRecoveryHandler: (handler) => { recover = handler; },
  };
}
