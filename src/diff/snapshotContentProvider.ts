/**
 * snapshotContentProvider.ts
 *
 * Serves the before-image held by DiffManager as a read-only virtual document
 * (`ai-cli-diff-original:` URIs), used as the left side of VS Code's built-in
 * diff editor. The right side is the real file.
 */

import * as vscode from 'vscode';
import { DiffManager } from './diffManager';
import { SNAPSHOT_SCHEME } from './snapshotUri';

export class SnapshotContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly diffManager: DiffManager) {
    // A file can get a fresh snapshot after an earlier one was resolved while
    // VS Code still caches the old virtual document; refresh every open one.
    this.subscription = this.diffManager.onDidChangeDiffs(() => {
      for (const document of vscode.workspace.textDocuments) {
        if (document.uri.scheme === SNAPSHOT_SCHEME) {
          this.emitter.fire(document.uri);
        }
      }
    });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.diffManager.getSnapshot(uri.fsPath) ?? '';
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
