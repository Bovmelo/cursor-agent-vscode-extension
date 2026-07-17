# Cursor Subscription for VS Code

**Unofficial** community extension. Not affiliated with Anysphere / Cursor.

Run [Cursor](https://cursor.com) agents from the VS Code sidebar with your Cursor user API key and plan. Built on the public [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript) (beta).

日本語は下の [日本語](#日本語) を参照してください。

## Features

- Local Cursor Agent for the current workspace
- Multi-turn chat with streaming Markdown
- Model picker (search, thinking / context / effort; default Auto)
- Profiles: Agent, Plan, Multitask (SDK subagents)
- Image context (PNG, JPEG, GIF, WebP)
- Project Skills and `.cursor/mcp.json` MCP servers
- Permission modes (auto-review / full access)
- `@` file search, drag-and-drop (hold Shift while dragging) / paste file references
- Active editor and selection context
- Conversation history across restarts
- Commit message generation from Source Control
- Autopilot change sessions with post-run file approval, verification, and review
- Preview-and-accept inline code generation instead of immediate edits
- AI Quick Fix actions for editor diagnostics
- Automatic validation with optional bounded self-repair
- AI review findings published into the Problems panel
- AI change-session history and revertible checkpoints, including dirty Git baselines
- Project memory, debug-context analysis, and experimental inline completions
- Japanese / English UI (follows VS Code display language)

## AI-native workflow

Run **Cursor: Run Autopilot Change** to give Cursor an outcome instead of an individual edit. After the agent finishes editing, review each file diff and choose whether to keep or restore it. Automatic verification waits until every proposed file has been decided. The **AI Change Session** view keeps the latest 20 sessions with edited files, decisions, verification results, and revert actions.

At session start, the extension stores a private workspace checkpoint. This protects pre-existing uncommitted files as well as clean Git baselines, so an individual AI edit or the full session can be restored without discarding earlier work. After changes are accepted, the extension detects `validate`, `compile`, `lint`, or `test` npm scripts and runs the best available verification automatically. Configure `cursorSubscription.verificationCommands` to override detection. Automatic repair is available through `cursorSubscription.autoRepair` and is disabled by default because it can consume additional plan quota.

Additional commands:

- **Cursor: Review Workspace Changes** publishes line-level findings to VS Code Problems.
- **Cursor: Analyze Debug Context** sends the active editor, diagnostics, breakpoints, and debug-session metadata to the agent.
- **Cursor: Refresh Project Memory** creates or updates `.cursor/project-memory.md`.
- AI Quick Fix actions appear alongside diagnostics in the editor.
- Experimental inline completions can be enabled with `cursorSubscription.enableInlineCompletions`.

Open **Cursor: Open AI Feature Settings** or use the gear button in the chat header to enable or disable these features. `cursorSubscription.enableAiNativeFeatures` is the master switch; core chat remains available when it is off. Each AI-native feature can also be controlled individually.

## Requirements

- VS Code 1.100 or later
- Node.js 22.13 or later (local agent runtime used by the SDK)
- A Cursor account and [user API key](https://cursor.com/dashboard)

Usage follows **your** Cursor plan. This extension does not read the Cursor desktop app login session.

## Getting started

1. Install this extension from the Marketplace.
2. Open the **Cursor** view in the Activity Bar.
3. Run **Cursor: Set API Key** and paste your key from the [Cursor Dashboard](https://cursor.com/dashboard).

The API key is stored in VS Code SecretStorage (not in settings or the workspace).

## Notes

- The Cursor SDK is in public beta; APIs may change.
- **Interrupt (`Ctrl+Enter`):** There is no public SDK API to steer a running prompt in place. This extension cancels the current run and sends a priority follow-up on the same conversation.

## Links

- [Source code](https://github.com/ark4ez/cursor-agent-vscode-extension)
- [Issues](https://github.com/ark4ez/cursor-agent-vscode-extension/issues)
- [Changelog](https://github.com/ark4ez/cursor-agent-vscode-extension/blob/master/CHANGELOG.md)
- [License (MIT)](https://github.com/ark4ez/cursor-agent-vscode-extension/blob/master/LICENSE)

---

## 日本語

Anysphere / Cursor 非提携の**非公式**拡張機能です。公式 TypeScript SDK（公開ベータ）を使い、VS Code のサイドバーから Cursor Agent を実行します。

### できること

- ワークスペース対象のローカル Cursor Agent
- 連続チャットとストリーミング Markdown
- モデル選択（検索、Thinking / Context / Effort、既定は Auto）
- 実行プロファイル: Agent / Plan / Multitask
- 画像コンテキスト、Skills、`.cursor/mcp.json` の MCP
- `@` ファイル参照、D&D / 貼り付け、選択範囲の添付
- 会話履歴の復元、コミットメッセージ生成
- ファイルごとの変更確認、検証、レビューを通して実行する Autopilot 変更セッション
- 適用前に確認できるインライン生成コードの差分プレビュー
- Problems の診断に対する AI Quick Fix と、行単位の AI コードレビュー
- 編集後の自動検証と、回数制限付きの自動修正
- 未コミット変更も保護するAI変更セッション履歴とチェックポイント
- プロジェクト記憶、デバッグ状況の解析、実験的なインライン補完
- VS Code の表示言語に連動した日英 UI

### AIネイティブ機能

**Cursor: Autopilot変更を実行**では、個別の編集内容ではなく達成したい結果を指示できます。エージェントの編集後、ファイルごとの差分を確認して保持または復元できます。すべてのファイルを確定するまで自動検証は保留されます。**AI変更セッション**ビューには直近20件の履歴、編集ファイル、判断結果、検証結果が表示されます。

セッション開始時にワークスペース専用のチェックポイントを保存するため、開始前から未コミットだったファイルも保護したまま、個別のAI編集またはセッション全体を復元できます。変更確定後、検証コマンドを npm の `validate`、`compile`、`lint`、`test` から自動検出します。`cursorSubscription.verificationCommands` で上書きできます。検証失敗時の自動修正は追加の利用枠を消費する場合があるため、初期状態では無効です。

チャット上部の歯車ボタン、または **Cursor: AI機能の設定を開く** から機能別にオン・オフできます。マスタースイッチを無効にしても基本チャットは引き続き利用できます。

### 必要なもの

- VS Code 1.100 以降
- Node.js 22.13 以降
- [Cursor Dashboard](https://cursor.com/dashboard) のユーザー API キー

課金・利用枠はご自身の Cursor プランに従います。Cursor アプリのログインは使いません。

### 使い方

1. Marketplace からインストール
2. Activity Bar の **Cursor** を開く
3. **Cursor: APIキーを設定** でキーを入力（SecretStorage に保存）
