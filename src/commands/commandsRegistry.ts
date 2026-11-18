import * as path from 'path';
import * as vscode from 'vscode';
import { DiffManager } from '../diff/diffManager';

export interface CommandDeps {
  diffManager: DiffManager;
  context: vscode.ExtensionContext;
}

export function registerAllCommands(deps: CommandDeps): void {
  const { diffManager, context } = deps;

  /**
   * The file an Accept/Revert applies to. A diff tab's title-bar button passes
   * that diff's file URI, which is exact even when the
   * `activeIsPendingDiff` context key lags behind a focus change. Otherwise
   * (keybinding, Command Palette) only the pending diff in the active tab
   * counts — never a guess: Revert overwrites the file on disk.
   */
  function getActiveDiffFilePath(arg?: unknown): string | undefined {
    if (arg instanceof vscode.Uri && arg.scheme === 'file' && diffManager.hasPendingDiff(arg.fsPath)) {
      return arg.fsPath;
    }
    return diffManager.getActiveDiffPath();
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('ai-cli-diff-view.openPendingFile', async (filePath?: string) => {
      if (!filePath || typeof filePath !== 'string') {
        return;
      }

      try {
        await diffManager.openDiff(filePath);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`AI CLI Diff: could not open file - ${message}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ai-cli-diff-view.acceptAllHunks', async (arg?: unknown) => {
      const filePath = getActiveDiffFilePath(arg);
      if (!filePath) {
        vscode.window.showWarningMessage('Open a pending diff first.');
        return;
      }
      await diffManager.accept(filePath);
      vscode.window.showInformationMessage(`Accepted all changes: ${path.basename(filePath)}`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ai-cli-diff-view.acceptAllChanges', async () => {
      const total = await diffManager.acceptAllPending();
      if (total === 0) {
        vscode.window.showWarningMessage('No pending changes to accept.');
        return;
      }
      vscode.window.showInformationMessage(`Accepted all changes in ${total} file(s).`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('ai-cli-diff-view.revertAllHunks', async (arg?: unknown) => {
      const filePath = getActiveDiffFilePath(arg);
      if (!filePath) {
        vscode.window.showWarningMessage('Open a pending diff first.');
        return;
      }
      await diffManager.revert(filePath);
      vscode.window.showInformationMessage(`Reverted all changes: ${path.basename(filePath)}`);
    })
  );

}
