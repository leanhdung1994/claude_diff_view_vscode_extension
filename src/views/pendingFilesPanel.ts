import * as path from 'path';
import * as vscode from 'vscode';
import { DiffManager, DiffPreviewMetadata } from '../diff/diffManager';

type PendingElement = PendingFolder | PendingFile;

interface PendingFolder {
  type: 'folder';
  id: string;
  label: string;
  children: PendingElement[];
}

interface PendingFile {
  type: 'file';
  metadata: DiffPreviewMetadata;
}

/**
 * Pending-files tree (files with unreviewed AI changes) with +/- stats aligned
 * independently of Git decorations. Clicking a file opens its diff.
 */
export class PendingFilesPanel implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = 'ai-cli-diff-view.pendingFiles';

  /** Coalesces a burst of writes to pending files into one recount. */
  private static readonly CONTENT_REFRESH_DELAY_MS = 250;

  private readonly diffDisposable: vscode.Disposable;
  private readonly contentDisposable: vscode.Disposable;
  private contentRefreshTimer?: ReturnType<typeof setTimeout>;
  private view?: vscode.WebviewView;
  private viewMessageDisposable?: vscode.Disposable;
  private activeFilePath?: string;
  private root: PendingFolder = { type: 'folder', id: 'root', label: '', children: [] };
  private generation = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly diffManager: DiffManager,
  ) {
    this.diffDisposable = this.diffManager.onDidChangeDiffs(() => {
      void this.refresh();
    });
    this.contentDisposable = this.diffManager.onDidChangePendingContent(() => {
      if (this.contentRefreshTimer) { clearTimeout(this.contentRefreshTimer); }
      this.contentRefreshTimer = setTimeout(() => {
        this.contentRefreshTimer = undefined;
        void this.refresh();
      }, PendingFilesPanel.CONTENT_REFRESH_DELAY_MS);
    });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media', 'file-icons')],
    };
    this.viewMessageDisposable?.dispose();
    this.viewMessageDisposable = webviewView.webview.onDidReceiveMessage((message: unknown) => {
      if (!message || typeof message !== 'object') { return; }
      const msg = message as { type?: string; path?: unknown };
      if (msg.type === 'open' && typeof msg.path === 'string') {
        void this.diffManager.openDiff(msg.path);
      }
    });
    void this.refresh();
  }

  setActiveFile(filePath: string | undefined): void {
    if (this.activeFilePath === filePath) { return; }
    this.activeFilePath = filePath;
    this.render();
  }

  private async refresh(): Promise<void> {
    const generation = ++this.generation;
    const metadata = await this.diffManager.getDiffPreviewMetadata();
    if (generation !== this.generation) { return; }
    this.root = this.createTree(metadata);
    if (this.activeFilePath && !metadata.some((file) => file.filePath === this.activeFilePath)) {
      this.activeFilePath = undefined;
    }
    this.render();
  }

  private render(): void {
    if (!this.view) { return; }
    const iconBase = this.view.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'file-icons'),
    ).toString() + '/';
    const rows = this.renderChildren(this.root.children, 0, iconBase);
    this.view.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${this.view.webview.cspSource}; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; padding: 5px 0; overflow: auto; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font: 12px var(--vscode-font-family); }
  .row { width: 100%; min-height: 22px; display: flex; align-items: center; padding: 2px 8px; gap: 5px; }
  .folder { color: var(--vscode-foreground); font-weight: 500; border: 0; background: transparent; text-align: left; cursor: pointer; font: inherit; }
  .folder:hover { background: var(--vscode-list-hoverBackground); }
  .folder .chevron { position: relative; z-index: 1; width: 7px; height: 7px; margin: 0 3px 2px 1px; border-right: 1.4px solid currentColor; border-bottom: 1.4px solid currentColor; transform: rotate(45deg); transition: transform .1s ease; }
  .folder-block.collapsed .folder .chevron { transform: rotate(-45deg); margin-bottom: -2px; }
  .folder-block.collapsed > .folder-children { display: none; }
  .folder-children {
    position: relative;
  }
  .folder-children::before {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: calc(12px + var(--tree-depth) * 8px);
    border-left: 1px solid var(--vscode-tree-indentGuidesStroke, var(--vscode-widget-border, rgba(128,128,128,.28)));
    pointer-events: none;
    opacity: 0;
    transition: opacity .12s ease;
  }
  .folder-block:hover > .folder-children::before { opacity: .28; }
  .file { border: 0; color: inherit; background: transparent; text-align: left; cursor: pointer; font: inherit; }
  .file:hover { background: var(--vscode-list-hoverBackground); }
  .file.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .icon { width: 16px; height: 16px; flex: 0 0 16px; object-fit: contain; }
  .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .stats { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; flex: 0 0 auto; white-space: nowrap; font-size: 11px; }
  .added { color: var(--vscode-gitDecoration-addedResourceForeground, #73c991); }
  .removed { color: var(--vscode-gitDecoration-deletedResourceForeground, #f14c4c); }
  .hunks { color: var(--vscode-descriptionForeground); }
  .empty { padding: 10px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
${rows || '<div class="empty">No pending changes</div>'}
<script>
  const vscode = acquireVsCodeApi();
  document.querySelectorAll('[data-folder-toggle]').forEach((el) => {
    el.addEventListener('click', () => el.parentElement.classList.toggle('collapsed'));
  });
  document.querySelectorAll('[data-path]').forEach((el) => {
    el.addEventListener('click', () => vscode.postMessage({ type: 'open', path: el.dataset.path }));
  });
</script>
</body>
</html>`;
  }

  private renderChildren(children: PendingElement[], depth: number, iconBase: string): string {
    return children.map((child) => {
      if (child.type === 'folder') {
        return `<div class="folder-block"><button class="row folder" data-folder-toggle="true" style="padding-left:${8 + depth * 8}px"><span class="chevron" aria-hidden="true"></span><span>${escapeHtml(child.label)}</span></button><div class="folder-children" style="--tree-depth:${depth}">${this.renderChildren(child.children, depth + 1, iconBase)}</div></div>`;
      }
      const metadata = child.metadata;
      const active = metadata.filePath === this.activeFilePath ? ' active' : '';
      const icon = `${iconBase}${this.fileIconName(metadata.filePath)}`;
      const stats = metadata.hunks === 0
        ? '<span class="hunks">empty</span>'
        : `<span class="added">+${metadata.additions}</span><span class="removed">-${metadata.deletions}</span><span class="hunks">${metadata.hunks} ${metadata.hunks === 1 ? 'hunk' : 'hunks'}</span>`;
      return `<button class="row file${active}" style="padding-left:${22 + depth * 8}px" data-path="${escapeAttribute(metadata.filePath)}" title="${escapeAttribute(metadata.filePath)}"><img class="icon" src="${escapeAttribute(icon)}" alt=""><span class="name">${escapeHtml(path.basename(metadata.filePath))}</span><span class="stats">${stats}</span></button>`;
    }).join('');
  }

  private createTree(metadata: DiffPreviewMetadata[]): PendingFolder {
    const root = this.emptyRoot();
    const folders = new Map<string, PendingFolder>([['', root]]);
    for (const file of metadata) {
      const segments = this.pathSegments(file.filePath);
      let parent = root;
      let folderPath = '';
      for (const segment of segments.slice(0, -1)) {
        folderPath = folderPath ? `${folderPath}/${segment}` : segment;
        let folder = folders.get(folderPath);
        if (!folder) {
          folder = { type: 'folder', id: `folder:${folderPath}`, label: segment, children: [] };
          parent.children.push(folder);
          folders.set(folderPath, folder);
        }
        parent = folder;
      }
      parent.children.push({ type: 'file', metadata: file });
    }
    this.sortTree(root);
    for (const child of root.children) {
      if (child.type === 'folder') {
        this.compactSingleChildFolders(child);
      }
    }
    return root;
  }

  /**
   * A package-style path such as src/main/java/com/example otherwise spends
   * most of a narrow side bar on indentation. Preserve meaningful branches,
   * but show each unbranched run as one compact, expandable path label.
   */
  private compactSingleChildFolders(folder: PendingFolder): void {
    for (const child of folder.children) {
      if (child.type === 'folder') {
        this.compactSingleChildFolders(child);
      }
    }

    while (folder.children.length === 1 && folder.children[0]?.type === 'folder') {
      const onlyChild = folder.children[0];
      if (onlyChild.type !== 'folder') { break; }
      folder.label = folder.label ? `${folder.label}/${onlyChild.label}` : onlyChild.label;
      folder.id = `folder:${folder.label}`;
      folder.children = onlyChild.children;
    }
  }

  private sortTree(folder: PendingFolder): void {
    folder.children.sort((left, right) => {
      if (left.type !== right.type) { return left.type === 'folder' ? -1 : 1; }
      const leftName = left.type === 'folder' ? left.label : path.basename(left.metadata.filePath);
      const rightName = right.type === 'folder' ? right.label : path.basename(right.metadata.filePath);
      return leftName.localeCompare(rightName, undefined, { sensitivity: 'base' });
    });
    for (const child of folder.children) {
      if (child.type === 'folder') { this.sortTree(child); }
    }
  }

  private pathSegments(filePath: string): string[] {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
    if (!folder) { return [path.basename(filePath)]; }
    const relative = path.relative(folder.uri.fsPath, filePath) || path.basename(filePath);
    return [folder.name, ...relative.split(path.sep).filter(Boolean)];
  }

  private fileIconName(filePath: string): string {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const icons: Record<string, string> = {
      ts: 'typescript.svg', tsx: 'react_ts.svg', js: 'javascript.svg', jsx: 'react.svg',
      css: 'css.svg', scss: 'sass.svg', sass: 'sass.svg', less: 'less.svg',
      html: 'html.svg', htm: 'html.svg', json: 'json.svg', jsonc: 'json.svg',
      md: 'markdown.svg', mdx: 'markdown.svg', py: 'python.svg', rs: 'rust.svg', go: 'go.svg',
      java: 'java.svg', kt: 'kotlin.svg', kts: 'kotlin.svg', rb: 'ruby.svg', php: 'php.svg',
      c: 'c.svg', cc: 'cpp.svg', cpp: 'cpp.svg', h: 'h.svg', hpp: 'hpp.svg', cs: 'csharp.svg',
      sh: 'console.svg', bash: 'console.svg', yaml: 'yaml.svg', yml: 'yaml.svg', toml: 'toml.svg',
      xml: 'xml.svg', svg: 'svg.svg', vue: 'vue.svg', svelte: 'svelte.svg', sql: 'database.svg',
      graphql: 'graphql.svg', png: 'image.svg', jpg: 'image.svg', jpeg: 'image.svg',
      gif: 'image.svg', webp: 'image.svg',
    };
    return icons[ext] ?? 'file.svg';
  }

  private emptyRoot(): PendingFolder {
    return { type: 'folder', id: 'root', label: '', children: [] };
  }

  dispose(): void {
    this.generation += 1;
    if (this.contentRefreshTimer) { clearTimeout(this.contentRefreshTimer); }
    this.diffDisposable.dispose();
    this.contentDisposable.dispose();
    this.viewMessageDisposable?.dispose();
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}
