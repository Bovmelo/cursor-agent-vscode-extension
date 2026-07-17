# Changelog

## Unreleased

- Add a master switch and individual settings for every AI-native editor feature, with a settings shortcut in the chat header

- Add Autopilot change sessions with a task-oriented progress view and safe session revert
- Add post-run Keep/Restore review per Autopilot-edited file and defer verification until decisions are complete
- Keep the latest 20 AI change sessions and preserve dirty working-tree baselines in private checkpoints
- Preview generated inline edits in a diff before applying them
- Add AI Quick Fix actions for editor diagnostics and line-level AI review findings in Problems
- Automatically detect and run project verification commands after agent edits, with optional bounded self-repair
- Add project-memory refresh, debug-context analysis, and experimental quota-aware inline completions

## 0.1.11

- Restore the prompt caret after Typeless or another dictation tool temporarily takes focus
- Add an in-chat setting for enabling or disabling run completion notifications
- Apply sound setting changes immediately while an agent run is in progress
- Finalize completed runs even when the SDK event stream is slow to close, and recover stale active runs
- Keep the chat prompt focused when Typeless returns text after briefly taking system focus
- Show a persistent hint that file drag-and-drop requires holding Shift
- Restore the prompt even when Typeless moves focus outside the webview after inserting text

## 0.1.10

- Add in-chat toggles for running, completion, and error sounds
- Keep sound preferences synchronized with VS Code settings across platforms

## 0.1.9

- Keep chat from auto-scrolling away while reading older messages
- Prefer plain-text paste so voice tools like Typeless can insert into the prompt
- Do not treat IME / dictation confirmation Enter as send

## 0.1.8

- Play a distinct alert when an agent run fails
- Improve drag/drop and paste file attachments in chat

## 0.1.7

- Improve Marketplace Details (README overview)

## 0.1.6

- Show extension version in the chat footer
- Configurable agent sound cues
- Marketplace packaging: extension icon, publisher metadata

## 0.1.0

- Initial local release of Cursor Agent chat for VS Code
