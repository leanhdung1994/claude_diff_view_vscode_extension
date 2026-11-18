/**
 * The one path filter shared by the baseline scanner and the workspace
 * watcher. They MUST agree: a file the watcher processes but the scanner
 * skipped has no baseline, so its first write looks like a brand-new file and
 * Revert would delete it.
 *
 * Only path components INSIDE the workspace folder are checked (a workspace
 * that itself lives under e.g. `D:\build\app` is still tracked), compared
 * case-insensitively so a lowercased (Windows-normalised) path and an
 * on-disk-case path give the same answer. The file name itself counts as a
 * component, so `.env`, `.classpath` and `.project` files are excluded too.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/** Lowercase. Dependency, build-output, VCS and tool-cache directories. */
const EXCLUDED_SEGMENTS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.output',
  '.svelte-kit',
  '.angular',
  '.nx',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.docusaurus',
  '.expo',
  '.vercel',
  '.serverless',
  '.yarn',
  '.pnpm-store',
  '.terraform',
  '.history',
  '.dart_tool',
  'out',
  'dist',
  'build',
  '.vscode',
  '.idea',
  '.claude',
  // .NET / Visual Studio
  'bin',
  'obj',
  'testresults',
  'artifacts',
  '.vs',
  // Java / JVM
  'target',
  '.gradle',
  '.settings',
  '.classpath',
  '.project',
  // Python
  'venv',
  '.venv',
  'env',
  '.env',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
  '.nox',
  'site-packages',
  'dist-info',
  'egg-info',
]);

/**
 * Cache parentDir -> boolean: whether `<parentDir>/packages` is a legacy NuGet
 * solution folder. A NuGet `packages/` folder is always a sibling of a `.sln`
 * file. Anything else named `packages/` (npm/pnpm/yarn workspaces, lerna, …)
 * is real source we must NOT exclude.
 */
const nugetPackagesCache = new Map<string, boolean>();

function isNugetPackagesParent(parentDir: string): boolean {
  const key = process.platform === 'win32' ? parentDir.toLowerCase() : parentDir;
  const cached = nugetPackagesCache.get(key);
  if (cached !== undefined) { return cached; }
  let result = false;
  try {
    for (const entry of fs.readdirSync(parentDir)) {
      if (entry.toLowerCase().endsWith('.sln')) { result = true; break; }
    }
  } catch {
    result = false;
  }
  nugetPackagesCache.set(key, result);
  return result;
}

/**
 * The innermost workspace folder containing `absPath`, and the path's
 * components relative to it. undefined when it is in no workspace folder.
 */
function workspaceRelative(absPath: string): { root: string; segments: string[] } | undefined {
  const target = path.resolve(absPath);
  let best: { root: string; segments: string[] } | undefined;
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const root = path.resolve(folder.uri.fsPath);
    // path.win32.relative compares case-insensitively, as Windows paths are.
    const relative = path.relative(root, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) { continue; }
    if (!best || root.length > best.root.length) {
      best = { root, segments: relative.split(path.sep).filter(Boolean) };
    }
  }
  return best;
}

/** True when the file must be neither baselined nor diffed. Outside the workspace counts as excluded. */
export function isExcludedPath(absPath: string): boolean {
  const location = workspaceRelative(absPath);
  if (!location) { return true; }
  const { root, segments } = location;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i].toLowerCase();
    if (EXCLUDED_SEGMENTS.has(segment)) { return true; }
    if (segment === 'packages' && isNugetPackagesParent(path.join(root, ...segments.slice(0, i)))) {
      return true;
    }
  }
  return false;
}
