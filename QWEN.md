# AI CLI diff view - Project Context

The full, maintained architecture guide is [CLAUDE.md](CLAUDE.md) (and the
shorter [AGENTS.md](AGENTS.md)). This file is a summary.

## Overview

AI CLI diff view is a VS Code extension for reviewing AI-generated file edits
in VS Code's built-in diff editor. Claude, Codex, Qwen and any other CLI are
detected the same way: a workspace file watcher compares each external write
against a baseline of the file's previous content.

## Project Structure

```text
src/
  attribution/  opt-in Claude Code turn-window attribution (hooks)
  commands/     command registration, sound-notification hooks
  diff/         snapshots, snapshot content provider, hunks, navigation
  views/        Pending Files webview view
  watcher/      workspace writes, baseline, file rules, burst + git detection
media/          activity-bar icon, file-type icons, README screenshots
code_to_test/   local smoke-test files
out/            compiled output (untracked)
```

## Main Flow

1. The workspace watcher keeps a baseline of every reviewable text file.
2. When a file is written outside VS Code, its previous content becomes a
   snapshot in `DiffManager` (persisted under workspace state key
   `ai-cli-diff.snapshots`).
3. `vscode.diff` opens with the snapshot (`ai-cli-diff-original:` scheme) on the
   left and the real file on the right; unchanged lines are collapsed.
4. The user accepts (keep the file) or reverts (restore the snapshot) the whole
   file.

## Commands

| Command | Description |
| --- | --- |
| `ai-cli-diff-view.acceptAllHunks` | Accept the current file |
| `ai-cli-diff-view.revertAllHunks` | Revert the current file |
| `ai-cli-diff-view.acceptAllChanges` | Accept all pending files |
| `ai-cli-diff-view.openPendingFile` | Open a pending file's diff |
| `ai-cli-diff-view.openSettings` | Open the extension's settings |
| `ai-cli-diff-view.nextFile` | Open the next pending file |
| `ai-cli-diff-view.prevFile` | Open the previous pending file |

## Development Notes

- TypeScript strict mode is enabled.
- Use `npm run compile` as the minimum validation step.
- Use `F5` in VS Code for manual testing.
- Do not edit `out/` by hand.
