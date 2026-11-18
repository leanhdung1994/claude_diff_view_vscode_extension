# AI CLI Diff View

Review every file edit an AI CLI agent makes — Claude Code, Codex, Qwen, and more — in VS Code's own diff editor, before you keep it.

Works with any AI CLI tool out of the box: no setup, no hooks required. Edits are picked up from the file system, so it doesn't matter whether the agent runs in the Claude Code extension, VS Code's terminal or an external one.

![Welcome to AI CLI Diff](media/introduce/welcome.png)

## Features

- **Automatic diffs.** When an agent writes a file, its diff opens in VS Code's built-in diff editor: the version before the agent's edit on the left, the live file on the right.
- **Only the changed lines.** Unchanged regions are collapsed by default (`diffEditor.hideUnchangedRegions.enabled`); click a "hidden lines" bar to expand it.
- **A real editor on the right.** Edit, save, undo, IntelliSense and your keybindings all work while reviewing. `F7` / `Shift+F7` jump between changes.
- **Accept or revert per file.** Use the buttons in the diff tab's title bar, or `Ctrl+Shift+Y` / `Ctrl+Shift+Z`. Accept keeps the agent's version; Revert restores the file (or deletes it, if the agent created it).
- **Pending Files view.** The AI CLI Diff icon in the Activity Bar lists every file waiting for review in its folder structure, with `+added −removed` counts. Drag it into the Secondary Side Bar to keep it next to your agent's chat.
- **Survives reloads.** Pending diffs are kept in workspace state and restored when VS Code restarts.
- **Git-aware.** Switching branches, pulling or rebasing doesn't flood you with diffs.

## Usage

1. Run an AI agent and let it edit files in your workspace.
2. Each edited file opens as a diff tab titled `<file> (AI changes)`.
3. Review it, then **Accept** or **Revert** from the title bar. The next pending file opens automatically.
4. Use **Accept All** in the Pending Files view to accept everything at once.

## Commands

- `AI CLI Diff: Accept All Changes` — accept the current file
- `AI CLI Diff: Revert All Changes` — revert the current file
- `AI CLI Diff: Accept All Changes (All Files)`
- `AI CLI Diff: Open Pending File`
- `AI CLI Diff: Previous Edited File`
- `AI CLI Diff: Next Edited File`
- `AI CLI Diff: Open Settings`

## Keybindings

- `Ctrl+Shift+Y` / `Cmd+Shift+Y` on macOS: accept the file in the active diff.
- `Ctrl+Shift+Z` / `Cmd+Shift+Z` on macOS: revert the file in the active diff.
- `Alt+H`: previous edited file, while pending diffs exist.
- `Alt+L`: next edited file, while pending diffs exist.

## Settings

All settings are under `ai-cli-diff-view.*` (gear button in the Pending Files view). The most useful:

- `editAttribution` — `allExternalWrites` (default) treats every external write as an agent edit; `claudeCodeHooks` only counts writes made during a Claude Code turn.
- `supportedFileExtensions`, `supportedFilenames`, `supportedFilenamePatterns` — extra files to review.
- `maxFileLines` — skip very large files (default 5000).
- `soundNotificationsEnabled` — play a sound when Claude finishes or needs input (Windows).

To see whole files instead of only the changed lines, turn off `diffEditor.hideUnchangedRegions.enabled`. To see the diff inline rather than side by side, turn off `diffEditor.renderSideBySide`.

## Development

```bash
npm install
npm run compile
```

Press `F5` in VS Code to launch the Extension Development Host.

Package the extension:

```bash
npx @vscode/vsce package
```

## License

MIT
