# Repository Guidelines

## Purpose

AI CLI Diff View is a VS Code extension that detects file edits made by AI CLI
tools and opens them in VS Code's built-in diff editor for review. Claude,
Codex, Qwen, and other tools are detected through workspace file events; the
extension does not launch or host any agent itself.

## Project Structure

- `src/extension.ts` — extension activation and service wiring.
- `src/commands/` — command registration and sound-notification settings.
- `src/diff/` — diff state, snapshots, the snapshot content provider (left
  side of each diff), hunk calculation, and navigation.
- `src/attribution/` — opt-in Claude Code turn-window attribution.
- `src/views/` — the Pending Files webview view.
- `src/watcher/` — workspace writes, baseline scanning, file rules, size
  limits, burst detection, and Git branch-operation detection.
- `media/` — activity-bar icon, file-type icons, README screenshots.
- `code_to_test/` — manual smoke-test fixtures.
- `docs/` — architecture notes and regression-test reports.
- `out/` — generated TypeScript output; never edit by hand.

## Build and Test

```bash
npm install
npm run compile
npm run watch
npx @vscode/vsce package
```

There is no configured linter, formatter, or automated test runner. Run
`npm run compile` after code changes, then press `F5` to launch the Extension
Development Host for manual checks. Use files in `code_to_test/` to verify
external edits, diff opening, file accept/revert, pending-file navigation,
branch changes, and diff tabs restored after a window reload. Attribution has
a script: `npm run compile && node scripts/test-attribution.js`.

`out/` is untracked and `tsc` never deletes stale output; `vscode:prepublish`
cleans it before packaging. The only runtime dependency is `diff`.

## Runtime Architecture

The extension activates on `onStartupFinished` and on
`onFileSystem:ai-cli-diff-original` (so restored diff tabs can resolve their
left side). `extension.ts` creates and connects `DiffManager`,
`SnapshotContentProvider`, `WorkspaceWatcher`, `GitBranchWatcher`,
`NavigationManager`, and `PendingFilesPanel`, then registers commands.

### Diff editor

Each pending file opens with `vscode.diff`. The left side is the before-image
stored by `DiffManager`, served read-only on the `ai-cli-diff-original:` scheme
(same path as the file, only the scheme differs); the right side is the real
file, so editing and saving work normally. Unchanged regions are collapsed via
a `configurationDefaults` entry for `diffEditor.hideUnchangedRegions.enabled`.

`DiffManager` owns pending snapshots, persistence, diff-tab bookkeeping (via
`TabInputTextDiff`, no panel registry) and file-level accept/revert. Snapshots
are persisted in VS Code workspace state under `ai-cli-diff.snapshots`, so
changes to snapshot shape or cleanup must preserve restore compatibility.

There is no per-hunk accept/reject. Accepting a file deletes its snapshot;
reverting writes the snapshot back to disk (or deletes a file the agent
created). A pending file whose saved content matches its snapshot again is
dropped automatically. When closing a diff, open the plain editor first, then
close the diff tab, so unsaved edits never trigger a save prompt.

### Workspace and baseline detection

`WorkspaceWatcher` combines `onDidSaveTextDocument` with a VS Code
`FileSystemWatcher('**/*')` so edits from any external AI CLI can be detected.
The initial `BaselineScanner` recursively reads eligible files in each
workspace folder and stores them in `BaselineStore`. This deep scan is required
for files nested beyond shallow snapshot limits and prevents issue #20's
whole-file false additions.

The watcher must also handle:

- text-file rules from `fileTypeRules.ts`;
- excluded path segments from `pathExclusions.ts`;
- line and byte limits from `fileSizeLimit.ts`;
- edits arriving while the initial baseline scan is still running;
- VS Code's own save event without creating a duplicate diff;
- burst writes from Git operations without losing genuine AI edits.

`WriteBurstMeter` holds files that exceed the burst threshold briefly. If
`GitBranchWatcher` confirms a Git batch operation during that window, held
writes are discarded and the baseline is rebuilt; otherwise the files open as
normal diffs after the hold expires.

### Git operations

`GitBranchWatcher` watches `.git/HEAD`, including worktree `gitdir:` indirection.
A real HEAD change clears stale pending diffs and rebuilds the baseline so files
from different branches are not compared. Same-branch `pull`, `merge`,
`rebase`, and `reset` are detected through `.git/logs/HEAD` reflog entries and
only resolve burst-held writes; they must not clear unrelated pending diffs.

The current early-confirmation gap is `.git/index`/`index.lock` monitoring.
Do not claim it is implemented unless the watcher is actually extended.

### UI

- Diff tabs show title-bar buttons (previous / next file, revert, accept) when
  the `ai-cli-diff-view.activeIsPendingDiff` context key is set;
  `Ctrl+Shift+Y` / `Ctrl+Shift+Z` use the same key.
- `ai-cli-diff-view.pendingFiles` (activity-bar container "AI CLI Diff") lists
  pending files with `+/−` counts, with Accept All and Settings buttons in its
  title bar.

Navigation commands are `Alt+H` and `Alt+L`, gated by the
`ai-cli-diff-view.hasPendingDiff` context key. A pending plain-text tab is
automatically routed back to its diff.

Claude sound notifications are unrelated to diff detection. When the setting
changes (Windows only), `soundNotifications.ts` updates only its own
`Notification` and `Stop` entries in `~/.claude/settings.json` and preserves
other settings.

## Configuration

Contributed settings are defined in `package.json`:

- `supportedFileDetectionMode`, `supportedFileExtensions`,
  `supportedFilenames`, and `supportedFilenamePatterns` control reviewable
  text files.
- `maxFileLines` skips files that are too large for safe diffing; `0` disables
  the limit.
- `baselineScanConcurrency` controls initial scan concurrency.
- `burstDetectionEnabled`, `burstDetectionWindowMs`,
  `burstDetectionThreshold`, and `burstDetectionHoldMs` control Git/batch-write
  protection.
- `soundNotificationsEnabled` controls the optional Windows Claude sounds.

- `editAttribution` chooses between every external write and Claude Code
  turn-window attribution.

When changing a setting, update its configuration listener. Keep defaults and
descriptions synchronized with the implementation.

## Coding Conventions

Use strict TypeScript with CommonJS modules and an ES2020 target. Follow the
existing style: two-space indentation, semicolons, single quotes,
`PascalCase` for classes/providers, `camelCase` for functions and variables,
and `kebab-case` for asset filenames. Prefer small, explicit changes and keep
path normalization consistent across watcher, snapshot, and VS Code APIs.

## Repository Safety

- Do not edit generated `out/` files manually.
- Do not commit secrets, `.env*` files, `.claude/` state, or generated `.vsix`
  artifacts.
- Keep filesystem paths workspace-safe; never hardcode a developer's home
  directory.
- Preserve unrelated working-tree changes.
- For UI changes, include manual test notes and a screenshot or GIF in the PR.
- Use short imperative commit subjects. When work addresses an issue, include
  its GitHub reference in the commit subject or body, for example `#20`, so
  GitHub links the commit to that issue.
