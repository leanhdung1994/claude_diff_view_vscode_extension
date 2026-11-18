import * as vscode from 'vscode';
import { DiffManager } from './diff/diffManager';
import { SnapshotContentProvider } from './diff/snapshotContentProvider';
import { SNAPSHOT_SCHEME } from './diff/snapshotUri';
import { WorkspaceWatcher } from './watcher/workspaceWatcher';
import { refreshTextFileRules } from './watcher/fileTypeRules';
import { refreshFileSizeLimit } from './watcher/fileSizeLimit';
import { GitBranchWatcher } from './watcher/gitBranchWatcher';
import { registerAllCommands } from './commands/commandsRegistry';
import { applySoundNotifications } from './commands/soundNotifications';
import { NavigationManager } from './diff/navigationManager';
import { PendingFilesPanel } from './views/pendingFilesPanel';
import { setupClaudeEditAttribution } from './attribution/setupClaudeAttribution';

const LOG_PREFIX = '[ai-cli-diff-view]';

/**
 * Left behind by the removed Agent mode, which temporarily set
 * `workbench.editor.showTabs` to `none` and stored the user's previous value
 * here. If a window was closed mid-Agent-mode, restore that value once.
 */
const LEGACY_AGENT_MODE_TABS_STATE_KEY = 'ai-cli-diff-view.agentMode.editorTabsState';

interface LegacyAgentModeTabsState {
  target: vscode.ConfigurationTarget;
  value: string | undefined;
}

let diagnosticChannel: vscode.OutputChannel | undefined;

function debugLog(message: string): void {
  const line = `${LOG_PREFIX} ${new Date().toISOString()} ${message}`;
  console.log(line);
  diagnosticChannel?.appendLine(line);
}

function debugError(message: string, error?: unknown): void {
  const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error ?? '');
  const line = `${LOG_PREFIX} ${new Date().toISOString()} ${message} ${detail}`;
  console.error(line, error ?? '');
  diagnosticChannel?.appendLine(line);
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  diagnosticChannel = vscode.window.createOutputChannel('AI CLI Diff View');
  context.subscriptions.push(diagnosticChannel);

  try {
    await activateExtension(context);
  } catch (error: unknown) {
    debugError('activate:failed', error);
    void vscode.window.showErrorMessage(
      `AI CLI Diff View failed to activate: ${error instanceof Error ? error.message : String(error)}`
    );
    throw error;
  }
}

async function restoreLegacyAgentModeTabs(context: vscode.ExtensionContext): Promise<void> {
  const stale = context.workspaceState.get<LegacyAgentModeTabsState>(LEGACY_AGENT_MODE_TABS_STATE_KEY);
  if (!stale) { return; }
  try {
    await vscode.workspace.getConfiguration('workbench.editor').update('showTabs', stale.value, stale.target);
    debugLog('legacy agent-mode editor tabs setting restored');
  } catch (error: unknown) {
    debugError('legacy agent-mode editor tabs restore failed', error);
  }
  await context.workspaceState.update(LEGACY_AGENT_MODE_TABS_STATE_KEY, undefined);
}

async function activateExtension(context: vscode.ExtensionContext): Promise<void> {
  debugLog(`activate:start mode=${context.extensionMode} workspace=${vscode.workspace.workspaceFile?.fsPath ?? 'none'}`);

  refreshTextFileRules();
  refreshFileSizeLimit();
  debugLog('activate:configuration initialized');

  const diffManager       = new DiffManager(context);
  // Register the left-side provider first, before anything awaits: VS Code
  // may already be restoring diff tabs from the previous session.
  const snapshotProvider  = new SnapshotContentProvider(diffManager);
  context.subscriptions.push(
    snapshotProvider,
    vscode.workspace.registerTextDocumentContentProvider(SNAPSHOT_SCHEME, snapshotProvider),
  );
  const editAttribution   = setupClaudeEditAttribution(context, debugLog);
  const workspaceWatcher  = new WorkspaceWatcher(diffManager, editAttribution);
  const gitBranchWatcher  = new GitBranchWatcher(diffManager, context.workspaceState, workspaceWatcher);
  const navigationManager = new NavigationManager(diffManager);
  debugLog('activate:core services constructed');

  const pendingFilesPanel = new PendingFilesPanel(context.extensionUri, diffManager);
  context.subscriptions.push(
    pendingFilesPanel,
    vscode.window.registerWebviewViewProvider(PendingFilesPanel.viewType, pendingFilesPanel),
  );
  debugLog('activate:pending files view registered');

  context.subscriptions.push(
    diffManager,
    { dispose: () => workspaceWatcher.dispose() },
    { dispose: () => gitBranchWatcher.dispose() }
  );

  await restoreLegacyAgentModeTabs(context);

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('ai-cli-diff-view.supportedFileDetectionMode') ||
          e.affectsConfiguration('ai-cli-diff-view.supportedFileExtensions') ||
          e.affectsConfiguration('ai-cli-diff-view.supportedFilenames') ||
          e.affectsConfiguration('ai-cli-diff-view.supportedFilenamePatterns')) {
        refreshTextFileRules();
      }
      if (e.affectsConfiguration('ai-cli-diff-view.maxFileLines')) {
        refreshFileSizeLimit();
      }
      if (e.affectsConfiguration('ai-cli-diff-view.soundNotificationsEnabled')) {
        const enabled = vscode.workspace
          .getConfiguration('ai-cli-diff-view')
          .get<boolean>('soundNotificationsEnabled', false);
        try {
          applySoundNotifications(enabled);
        } catch (error: unknown) {
          debugError('sound notifications: could not update ~/.claude/settings.json', error);
        }
      }
    })
  );

  workspaceWatcher.start();
  debugLog('activate:workspace watcher started');
  gitBranchWatcher.start();
  debugLog('activate:git branch watcher started');

  registerAllCommands({ diffManager, context });
  debugLog('activate:standard commands registered');

  context.subscriptions.push(
    vscode.commands.registerCommand('ai-cli-diff-view.nextFile', () => navigationManager.nextFile()),
    vscode.commands.registerCommand('ai-cli-diff-view.prevFile', () => navigationManager.prevFile()),
    vscode.commands.registerCommand('ai-cli-diff-view.openSettings', () => (
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:${context.extension.id}`)
    )),
  );

  function updatePendingContext(): void {
    const hasPending = diffManager.getPendingFiles().length > 0;
    const activeDiff = diffManager.getActiveDiffPath();
    pendingFilesPanel.setActiveFile(activeDiff);
    void vscode.commands.executeCommand('setContext', 'ai-cli-diff-view.hasPendingDiff', hasPending);
    // Gates the diff tab's title-bar buttons and the Ctrl+Shift+Y/Z keybindings.
    void vscode.commands.executeCommand('setContext', 'ai-cli-diff-view.activeIsPendingDiff', activeDiff !== undefined);
  }

  context.subscriptions.push(
    diffManager.onDidChangeDiffs(() => updatePendingContext()),
    vscode.window.tabGroups.onDidChangeTabs(() => updatePendingContext()),
    // Focusing another editor group changes the active tab without changing
    // any tab, so onDidChangeTabs alone leaves activeIsPendingDiff stale.
    vscode.window.tabGroups.onDidChangeTabGroups(() => updatePendingContext()),
    vscode.window.onDidChangeActiveTextEditor(() => updatePendingContext()),
  );

  const autoRouteTab = (tab: vscode.Tab): void => {
    if (!(tab.input instanceof vscode.TabInputText)) { return; }
    // A tab becomes `changed` when the user edits it. Never close a dirty
    // document from the auto-router: doing so makes VS Code show its
    // save/discard confirmation and can discard edits before auto-save runs.
    if (tab.isDirty) { return; }
    const fsPath = tab.input.uri.fsPath;
    if (!diffManager.hasPendingDiff(fsPath)) { return; }
    void (async () => {
      try {
        await vscode.window.tabGroups.close(tab);
        await diffManager.openDiff(fsPath);
      } catch (err) {
        console.error('[ai-cli-diff] auto-route failed:', err);
      }
    })();
  };

  context.subscriptions.push(
    vscode.window.tabGroups.onDidChangeTabs((e) => {
      for (const tab of e.opened) { autoRouteTab(tab); }
      for (const tab of e.changed) { autoRouteTab(tab); }
    })
  );

  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) { autoRouteTab(tab); }
  }
  await diffManager.closeStaleDiffTabs();

  updatePendingContext();
  debugLog('activate:complete');
}

export function deactivate(): void {
  // Nothing to do: every disposable is registered on context.subscriptions.
}
