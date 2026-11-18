/**
 * snapshotUri.ts
 *
 * URI scheme for the left (original) side of a pending diff. The URI keeps the
 * real file path, only the scheme differs, so the left side gets the same file
 * name, extension and therefore the same language/syntax colouring as the file.
 *
 * Content is served by SnapshotContentProvider from DiffManager's snapshot map.
 * Keep this module dependency-free: DiffManager and the provider both import it.
 */

import * as vscode from 'vscode';

export const SNAPSHOT_SCHEME = 'ai-cli-diff-original';

export function snapshotUriFor(fileUri: vscode.Uri): vscode.Uri {
  return fileUri.with({ scheme: SNAPSHOT_SCHEME });
}

/** True for a diff tab opened by this extension (left side is a snapshot). */
export function isPendingDiffInput(input: unknown): input is vscode.TabInputTextDiff {
  return input instanceof vscode.TabInputTextDiff && input.original.scheme === SNAPSHOT_SCHEME;
}
