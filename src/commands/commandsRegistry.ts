import * as path from 'path';
import * as vscode from 'vscode';
import { DiffManager } from '../diff/diffManager';

export interface CommandDeps {
  diffManager: DiffManager;
  context: vscode.ExtensionContext;
}

export function registerAllCommands(deps: CommandDeps): void {
  const { diffManager, context } = deps;

  function getActiveDiffFilePath(): string | undefined {
    return diffManager.getActiveFilePath() ?? diffManager.getPendingFiles()[0];
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
    vscode.commands.registerCommand('ai-cli-diff-view.acceptAllHunks', async () => {
      const filePath = getActiveDiffFilePath();
      if (!filePath) {
        vscode.window.showWarningMessage('No pending diff.');
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
    vscode.commands.registerCommand('ai-cli-diff-view.revertAllHunks', async () => {
      const filePath = getActiveDiffFilePath();
      if (!filePath) {
        vscode.window.showWarningMessage('No pending diff.');
        return;
      }
      await diffManager.revert(filePath);
      vscode.window.showInformationMessage(`Reverted all changes: ${path.basename(filePath)}`);
    })
  );

}
