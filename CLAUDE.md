# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Extension Does

AI CLI diff view is a VS Code extension for reviewing AI CLI file edits inside VS Code.
Best supported review workflows: Claude, Codex, and Qwen — all detected uniformly via the workspace watcher (no CLI-specific hooks required). The extension does not launch or host any agent itself; the agent runs wherever the user likes (Claude Code extension, a terminal, …).

## Commands

```bash
npm install
npm run compile      # tsc -p ./  → out/  (main build / correctness check)
npm run watch        # tsc -watch -p ./  (normal dev loop)
npx @vscode/vsce package   # runs vscode:prepublish = clean out/ + compile
```

- Press `F5` to launch the Extension Development Host (`.vscode/launch.json`), and reload the host after each recompile.
- There is no lint, formatter, or test runner configured. `npm run compile` is the minimum correctness gate. Manually validate diff opening, accept/revert, and navigation against the sample files in `code_to_test/`.
- `out/` is untracked and `tsc` never deletes files, so output from deleted modules lingers locally; `vscode:prepublish` runs `npm run clean` first so it is never packaged.
- The only runtime dependency is `diff`. There are no webview bundles or native modules.
- Strict TypeScript (`tsconfig.json`: `strict: true`, CommonJS, ES2020 target). 2-space indentation, semicolons, single quotes; `PascalCase` for classes/providers, `camelCase` for functions/variables, `kebab-case` for asset filenames.

## Architecture

### Runtime shape

`src/extension.ts` is the entry point, activated `onStartupFinished` (and `onFileSystem:ai-cli-diff-original`, see below). It wires together the `DiffManager`, the snapshot content provider, the workspace and git-branch watchers, the navigation manager and the Pending Files view, then registers commands.

The core responsibility: capture a before-image of a file, detect the after-image once an AI tool writes it, then show it in VS Code's built-in diff editor while keeping enough per-file state to accept or revert the whole file.

### Diff rendering — VS Code's built-in diff editor

- `DiffManager.openDiff` calls `vscode.diff(left, right, '<name> (AI changes)')`. The **right/modified side** is the real file (`file:` URI), so editing, saving, undo, language features and keybindings are VS Code's own.
- The **left/original side** is a read-only virtual document on the `ai-cli-diff-original:` scheme (`src/diff/snapshotUri.ts`). The URI is the file URI with only the scheme swapped, so it keeps the file name and language. `SnapshotContentProvider` (`src/diff/snapshotContentProvider.ts`) serves `DiffManager.getSnapshot(uri.fsPath)` and fires `onDidChange` for every open snapshot document on each `onDidChangeDiffs`.
- Unchanged lines are collapsed through `contributes.configurationDefaults` → `diffEditor.hideUnchangedRegions.enabled: true`. That, inline vs side-by-side (`diffEditor.renderSideBySide`) and every other diff option are global user settings — there is no per-editor API.
- There is **no per-hunk accept/reject** (by design). Accept/revert work on whole files. The diff editor's own "revert block" arrows still work: they edit the right side, and once the user saves content equal to the snapshot, `DiffManager.onDocumentSettled` drops the pending entry like an accept. Because the agent can trigger this too (writing a file back to its original while you work elsewhere), it never moves focus: a diff that is the visible tab of its group is replaced in place by the plain file with `preserveFocus`, and a background diff tab is just closed.
- Diff tabs are recognised with `isPendingDiffInput()` — a `TabInputTextDiff` whose `original.scheme` is the snapshot scheme. There is no panel registry; `findDiffTabs` / `closeDiffTabs` scan `vscode.window.tabGroups`.
- Diff tabs survive a window reload. The `onFileSystem:ai-cli-diff-original` activation event lets VS Code activate the extension to resolve a restored left side; the provider is registered synchronously at the top of `activateExtension`, and `closeStaleDiffTabs()` closes restored tabs whose snapshot is gone. `DiffManager.dispose()` therefore never closes tabs.
- Accept/revert/clearAll/acceptAllPending **open the plain text editor first, then close the diff tab** (`reopenAsTextEditor` → `closeDiffTabs`). Closing the last editor of a document with unsaved edits would otherwise prompt save/discard. `captureViewState()` records the diff tab's editor group (so with split editors the plain editor replaces the diff in its own group, even when its title-bar button was clicked in an inactive group) and the cursor/scroll of the visible `file:` editor for that path in that group, i.e. the diff's right side.
- `extension.ts` auto-routes tabs: if a pending file is opened as a plain text editor, that tab is closed and reopened as its diff (`autoRouteTab`). A file whose snapshot was just removed is not rerouted, which is what lets `reopenAsTextEditor` work.
- `hunkCalculator.ts` (Myers via the `diff` library, compared on LF-normalised text) is still used to decide whether a file has any change at all (`openDiff` drops pure-EOL changes) and for the `+/−/hunks` counts in Pending Files. Its pass 3 (`splitAlignedLines`) and `groupId` were built for the removed Monaco renderer; the hunk count shown is the number of split sub-hunks.

### Diff state model

`src/diff/diffManager.ts` is the center of the extension. It owns:

- the original-content snapshot map (left side of each diff), keyed by normalised path
- persistence via `src/diff/snapshotStore.ts` in workspace state under `ai-cli-diff.snapshots` (survives VS Code restarts)
- the public `openDiff` / `accept` / `revert` / `acceptAllPending` / `clearAll` operations used by commands, the watchers and the Pending Files view
- the "edited back to original" cleanup (`onDocumentSettled`, only on saved / non-dirty content, skipped for paths in `resolving` so `revert()`'s own save doesn't trigger it)

Accept and revert are intentionally asymmetric: accepting just deletes the snapshot (the file on disk already holds the agent's version); reverting writes the snapshot back to disk (or deletes a file the agent created). After either, the next pending file's diff opens.

### Two edit-detection pipelines

Every CLI — including Claude — is detected through the workspace watcher. By default (`editAttribution = allExternalWrites`) every external write is treated as an agent edit. The opt-in Claude turn-window mode below only *filters* the watcher's writes; it is not a separate detection pipeline.

**Workspace watcher (the only path for agent edits)**

`src/watcher/workspaceWatcher.ts` combines save events with a `FileSystemWatcher` for any external write, regardless of which tool made it. `src/watcher/baselineScanner.ts` builds the per-folder text-file baseline and `src/watcher/baselineStore.ts` stores it, so a newly written file is compared against prior content rather than treated as brand new. `src/watcher/pathExclusions.ts` (`isExcludedPath`) is the single filter for paths that should not be tracked, shared by the scanner and the watcher: they must agree, because a file the watcher processes without a baseline looks brand new and Revert would delete it. It checks only components inside the workspace folder, case-insensitively, and excludes named build/cache directories rather than all dot-folders (so `.github/` etc. are tracked). As a second guard, the watcher records whether a write came from a `create` or a `change` event: a `change` to a file with no baseline proves it existed, so it only becomes the baseline and opens no diff. A `create` with no baseline is still treated as a new file, because a write-to-temp-then-rename save also reports `create`. `src/watcher/writeBurstMeter.ts` decides whether a write is part of a burst (git checkout vs AI edits); writes past the burst threshold are held in `WorkspaceWatcher`'s `heldWrites` queue for `burstDetectionHoldMs` instead of opening a diff immediately — if `GitBranchWatcher` confirms a branch change in that window (`notifyExternalBatch()`), held writes are silently dropped; otherwise they open normally once the hold expires. A held file that is written again stays held and keeps its **first** before-image (`resolveOrHold`): the watcher's baseline already contains the first write, so taking the before-image from it would hide that write and make Revert stop at the in-between version. See `docs/GIT_VS_AI_EDIT_DETECTION.md`.

### Claude turn-window attribution (opt-in, `editAttribution = claudeCodeHooks`)

`src/attribution/` decides whether an external write was Claude's, so files you copy in, git, formatters etc. don't open diffs. `claudeHookInstaller.ts` adds one `UserPromptSubmit` and one `Stop` hook to `~/.claude/settings.json` (timeout 30 s; the hook copies its stdin JSON into `~/.ai-cli-diff-view/claude-events/` and must print nothing, because `UserPromptSubmit` stdout reaches Claude's context). It owns only entries whose command contains both `ai-cli-diff-view` and `claude-events`, and also removes such entries under `PreToolUse`/`PostToolUse` left by the earlier per-edit design.

- **Rule** (`claudeAttribution.ts`, no `vscode` import): a write is Claude's if `turn.start ≤ writeAt ≤ (turn.end ?? start + 3 h) + 10 s` for a turn whose `cwd` is the same as, inside, or a parent of the file's workspace folder (both sides realpath'd, so a mapped drive matches its UNC path). A new `UserPromptSubmit` closes the session's previous open turn.
- **Why turns, not per-edit events:** the watcher overwrites its baseline *before* asking the gate, so a write wrongly judged "not Claude's" loses its before-image. Claude Code waits for `UserPromptSubmit` before Claude starts, so the turn is always on record by the time the watcher decides (~200 ms after the write), even when the change notice is late.
- **Recovery:** `WorkspaceWatcher` keeps the before-image of every ignored write (`ignoredWrites`). If a `Stop` arrives for a session with no open turn (its turn-start hook failed), `setupClaudeAttribution.ts` asks the watcher to open diffs for that session's ignored writes since its previous `Stop`. `ClaudeHookSource` polls the events folder every 2 s while the mode is on so this happens when the turn ends; its reads are serialized (overlapping reads would ingest one `Stop` twice) and it catches up on the last 30 min of events at startup.
- **Assumptions:** nothing but Claude writes workspace files during a Claude turn, and turns are not interrupted with Esc (no `Stop` fires; the turn stays open until the next message or 3 h).
- Tests: `npm run compile && node scripts/test-attribution.js` (includes running the real hook command).

### Sound notifications (unrelated to diff detection)

`src/commands/soundNotifications.ts` (`applySoundNotifications`) writes or removes `Notification`/`Stop` hook entries in `~/.claude/settings.json` (Windows only, via PowerShell `SoundPlayer`). `extension.ts` calls it whenever `ai-cli-diff-view.soundNotificationsEnabled` changes. It only ever touches its own entries under those two keys, preserving any other hooks already present in the file.

### Git branch watcher

`src/watcher/gitBranchWatcher.ts` watches each workspace root's `.git/HEAD` (resolving `gitdir:` for worktrees/submodules). On a HEAD ref change (branch switch / checkout / detached) it clears all pending diffs (`DiffManager.clearAll`) so stale snapshots aren't compared against a different branch's working tree. That content-compare path deliberately does **not** react to pull/rebase/reset on the same branch (those change `refs/heads/<branch>`, not HEAD's content) to avoid wiping pending state on every commit. Instead, `pull`/`merge`/`rebase`/`reset` on the same branch are confirmed via a second, narrower source: the same watcher also tails `.git/logs/HEAD` (reflog) and matches the action label git appends to the last line (`pull:`, `merge …`, `rebase (finish): …`, `reset: …`); on a match it calls `workspaceWatcher.notifyExternalBatch()` — silently dropping burst-held writes and rebuilding the baseline — **without** clearing already-open pending diffs, since those are unaffected by a same-branch pull/rebase/reset. `commit`/`checkout` are excluded from that regex on purpose (commit shouldn't suppress anything; checkout-to-another-ref is already handled by the HEAD-content path above).

### UI composition

- **Diff tabs** — VS Code's diff editor. Title-bar buttons (`editor/title`, shown when `ai-cli-diff-view.activeIsPendingDiff`): previous file, next file, revert file, accept file.
- **Pending Files view** — `src/views/pendingFilesPanel.ts` (`PendingFilesPanel`, view id `ai-cli-diff-view.pendingFiles`) in the "AI CLI Diff" Activity Bar container. A webview tree of pending files with `+/−` counts from `DiffManager.getDiffPreviewMetadata()` (computed in the extension host; file contents never reach the webview), icons from `media/file-icons/`. It recounts on `onDidChangeDiffs` (a file became or stopped being pending) and, 250 ms after the last one, on `onDidChangePendingContent` — an already-pending file's content changed: `WorkspaceWatcher` calls `notifyPendingContentChanged()` when it skips a write to a pending file (no document event fires if no editor has it open), and `onDocumentSettled` fires it when a saved/reloaded pending file still differs from its snapshot. Clicking a file calls `openDiff`. View title buttons: Accept All (`acceptAllChanges`) and a gear (`openSettings`, opens Settings filtered to this extension).

Pending-file navigation lives in `src/diff/navigationManager.ts`, reachable via the `prevFile`/`nextFile` commands, their `Alt+H`/`Alt+L` keybindings and the diff title-bar buttons. `updatePendingContext` in `extension.ts` keeps two context keys in sync via `DiffManager.onDidChangeDiffs` and tab-change events: `ai-cli-diff-view.hasPendingDiff` (any pending file) and `ai-cli-diff-view.activeIsPendingDiff` (the active tab is a pending diff).

On startup, `restoreLegacyAgentModeTabs` restores a `workbench.editor.showTabs` value stored by the removed Agent mode, in case a window was closed while it was on.

### Configurable text-file detection

`refreshTextFileRules()` / `isTextFile()` in `src/watcher/fileTypeRules.ts` decide which files are reviewable. They read four settings (see below) and are refreshed on the corresponding `onDidChangeConfiguration` events. `supportedFileDetectionMode` chooses between built-in rules + custom, or custom-only.

### Important implementation constraints

- Path normalization is load-bearing: paths go through `vscode.Uri.file(...).fsPath` and are lowercased on Windows before comparison. `canonicalCasePath` (via `fs.realpathSync.native`) is used when calling VS Code APIs so tab titles show the on-disk case. Snapshot URIs are built from the canonical-case file URI; the provider maps them back through `normalizePath`.
- Snapshot persistence is designed to survive restarts; changes to snapshot shape or cleanup affect restore logic (including restored diff tabs) as well as live diffing.
- Snapshots keep the file's original bytes/EOL; hunk comparisons are done on LF-normalised text (`src/diff/eol.ts`).

## Settings (contributed configuration)

| Setting | Purpose |
| --- | --- |
| `ai-cli-diff-view.editAttribution` | `allExternalWrites` (default: every external write is an agent edit) or `claudeCodeHooks` (Claude turn-window attribution; installs hooks in `~/.claude/settings.json`) |
| `ai-cli-diff-view.supportedFileDetectionMode` | `defaultAndCustom` (default) or `customOnly` |
| `ai-cli-diff-view.supportedFileExtensions` | Extra extensions to treat as text (dot optional) |
| `ai-cli-diff-view.supportedFilenames` | Extra exact filenames to treat as text |
| `ai-cli-diff-view.supportedFilenamePatterns` | Extra basename globs (`*`, `?`) to treat as text |
| `ai-cli-diff-view.maxFileLines` | Advanced: ignore files above this many lines — no baseline, no diff (default 5000; `0` disables). Enforced in `src/watcher/fileSizeLimit.ts`, applied by `baselineScanner` and both write paths in `workspaceWatcher`. Skipped files are recorded in `BaselineStore.sizeSkipped` so that one later dropping below the limit is not mistaken for a brand-new file (which would make Revert delete it) |
| `ai-cli-diff-view.baselineScanConcurrency` | Advanced: maximum number of files read concurrently during the initial baseline scan (default 4, range 1–16). Lower it for large or remote workspaces to reduce I/O and memory pressure. |
| `ai-cli-diff-view.burstDetectionEnabled` | Advanced: hold files beyond the burst threshold to confirm a git branch change before opening their diff, instead of opening immediately (see `docs/GIT_VS_AI_EDIT_DETECTION.md`) |
| `ai-cli-diff-view.burstDetectionWindowMs` | Advanced: sliding window (ms) used to count file changes for burst detection (default 300) |
| `ai-cli-diff-view.burstDetectionThreshold` | Advanced: number of distinct files changed within the window that counts as a burst (default 8) |
| `ai-cli-diff-view.burstDetectionHoldMs` | Advanced: how long (ms) to hold burst-threshold-exceeding files before opening their diff if no git branch change is confirmed (default 2000) |
| `ai-cli-diff-view.soundNotificationsEnabled` | Play a sound when Claude finishes a turn or needs input (Windows only, default off) — unrelated to diff detection |

All of these are edited in VS Code's Settings UI (the Pending Files gear opens it filtered to this extension). `contributes.configurationDefaults` also sets `diffEditor.hideUnchangedRegions.enabled` to `true`. `.git/index`-based early confirmation is a known gap — the burst hold relies solely on `GitBranchWatcher`'s existing `HEAD`-change confirmation (see `docs/GIT_VS_AI_EDIT_DETECTION.md`).

## Registered Commands and Keybindings

| Command | Keybinding | Purpose |
| --- | --- | --- |
| `ai-cli-diff-view.acceptAllHunks` | `Ctrl+Shift+Y` (when `activeIsPendingDiff`) | Accept the pending diff in the active tab (or the one whose title-bar button was clicked); otherwise warn, never guess |
| `ai-cli-diff-view.revertAllHunks` | `Ctrl+Shift+Z` (when `activeIsPendingDiff`) | Revert the pending diff in the active tab (or the one whose title-bar button was clicked); otherwise warn, never guess |
| `ai-cli-diff-view.acceptAllChanges` | — | Accept all pending changes across files |
| `ai-cli-diff-view.openPendingFile` | — | Open a pending file's diff (takes a path arg) |
| `ai-cli-diff-view.openSettings` | — | Open Settings filtered to this extension |
| `ai-cli-diff-view.prevFile` | `Alt+H` (when `hasPendingDiff`) | Go to previous pending file |
| `ai-cli-diff-view.nextFile` | `Alt+L` (when `hasPendingDiff`) | Go to next pending file |

The `acceptAllHunks` / `revertAllHunks` ids are historical; they act on the whole file.
