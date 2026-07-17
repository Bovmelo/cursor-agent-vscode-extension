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
- AI Supervisor inbox with Observe and Autonomous modes
- Concurrent normal-chat agents across separate conversations
- Isolated Git worktree execution with conflict-safe, per-file apply/discard
- Multi-root workspace support for chat cwd, file search, Skills, MCP, and commands
- Preview-and-accept inline code generation instead of immediate edits
- AI Quick Fix actions for editor diagnostics
- Automatic validation with optional bounded self-repair
- AI review findings published into the Problems panel
- AI change-session history and revertible checkpoints, including dirty Git baselines
- Project memory, debug-context analysis, and experimental inline completions
- Japanese / English UI (follows VS Code display language)
- Token usage dashboard, conversation search / pin / export
- Cursor-style `.cursor/commands` slash templates and `/compare` best-of-N
- Branch + PR creation via GitHub CLI after verified edits

## AI-native workflow

### Parallel chat agents

Each conversation owns an independent Cursor agent and run. Start a task, click the prominent **Start parallel agent** button in the parallel-agent bar, and send another task to run both at the same time. The button is disabled with a limit indicator when every parallel slot is occupied. The bar lists running and queued conversations, switches to any task with one click, and stops only the selected agent. Completed, failed, and stopped parallel tasks remain as review-pending chips until you open that conversation and then leave it. Returning to history also shows **Running** or **Queued** badges and restores live output. Messages inside one conversation still run in order. Configure `cursorSubscription.maxParallelChatAgents` (default: 3, maximum: 8) to set the limit. Concurrent calls may consume Cursor plan quota simultaneously. Give editing agents separate files or scopes when possible because two agents writing the same file can conflict.

### AI Supervisor

The **AI Supervisor Inbox** turns saved editor errors and manually entered goals into durable tasks. **Observe** mode only detects and queues work, so detection itself does not use Cursor plan quota. **Autonomous** mode starts queued tasks after a configurable debounce and enforces hourly run, execution-time, file-count, and changed-line budgets.

Each Supervisor task runs with its own agent in a detached Git worktree. The normal chat has a separate agent and remains usable while Supervisor is working. The extension overlays the current non-excluded working state without committing it, stores only the dirty-file baseline in private extension storage, and runs the Supervisor away from the active editor. Results stay in the inbox until you apply all, apply individual files, or discard them. Every proposed file records why it changed; the reason appears in the inbox tooltip and above the proposed side of the diff. A file is not applied if the original workspace copy changed while AI was running. Sensitive and lock-file globs are excluded by default. Verified documentation and test-only changes can optionally be auto-applied, but this is disabled by default.

The current mode is always shown in the Supervisor inbox header, the first inbox row, and the status bar. Click the mode row or status-bar control, or run **Cursor: Choose AI Supervisor Mode**, to switch modes. Autonomous agent calls consume Cursor plan quota; if chat and Supervisor run together, both calls may consume quota concurrently. Local diagnostics, Git comparisons, and verification commands do not.

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
- 監視・自律実行を切り替えられる AI Supervisor 受信箱
- 別々の会話で通常チャットAgentを並列実行
- 隔離Git worktreeでの実行と、競合を防ぐファイル単位の適用・破棄
- マルチルートワークスペース対応（cwd、ファイル検索、Skills、MCP、コマンド）
- 適用前に確認できるインライン生成コードの差分プレビュー
- Problems の診断に対する AI Quick Fix と、行単位の AI コードレビュー
- 編集後の自動検証と、回数制限付きの自動修正
- 未コミット変更も保護するAI変更セッション履歴とチェックポイント
- プロジェクト記憶、デバッグ状況の解析、実験的なインライン補完
- VS Code の表示言語に連動した日英 UI
- トークン使用量、会話検索 / ピン留め / 書き出し
- Cursor 互換の `.cursor/commands` スラッシュテンプレートと `/compare` best-of-N
- 検証後の GitHub CLI によるブランチと PR 作成

### AIネイティブ機能

通常チャットは会話ごとに独立したCursor AgentとRunを持ちます。処理中に **並列Agent** バーの目立つ **並列Agentを起動** ボタンを押して別の指示を送ると、両方を同時実行できます。上限到達時はボタンが無効になり、現在数と上限を確認できます。バーには実行中・待機中の会話が常時表示され、クリックで即座に切り替え、×ボタンでそのAgentだけを停止できます。並列タスクが完了・失敗・停止した場合は「確認待ち」として残り、その会話を一度開いて別の会話または画面へ移動した時点で消えます。履歴にも **実行中** または **待機中** と表示され、会話へ戻ると途中の出力も復元されます。同一会話内のメッセージは従来どおり順番に処理します。同時数は `cursorSubscription.maxParallelChatAgents`（初期値3、最大8）で設定できます。同時呼び出しはCursorの利用枠を並行して消費する場合があります。同じファイルを複数Agentが編集すると競合し得るため、編集対象は分けてください。

**AI Supervisor受信箱**は、保存時のエラーと手動で追加した目標をタスクとして管理します。**監視**モードでは問題検出と受信箱への追加だけを行うため、検出自体はCursorの利用枠を消費しません。**自律実行**モードでは、待機時間、1時間あたりのAI実行数、実行時間、変更ファイル数、変更行数の上限内でタスクを自動実行します。

各タスクは専用エージェントを使い、通常の作業ツリーとは別のGit worktreeで実行されます。通常チャットも別のエージェントを持つため、Supervisorの実行中でも利用できます。現在の未コミット状態はGitへコミットせずに隔離環境へ反映し、AI実行前の差分だけを拡張機能専用ストレージへ退避します。結果は受信箱でファイルごと、または一括で適用・破棄できます。変更理由はファイルごとに保存され、受信箱のホバーと差分右ペインの先頭に表示されます。AI実行中に元ファイルが変更された場合、その変更は自動適用しません。秘密情報とロックファイルは初期状態で除外されます。

現在のモードはSupervisor受信箱の見出し、受信箱の先頭行、ステータスバーへ常時表示されます。モード行またはステータスバーをクリックするか、**Cursor: AI Supervisorモードを選択** で切り替えられます。自律実行のAI呼び出しはCursorの利用枠を使い、チャットとSupervisorを同時実行すると両方の呼び出しが並行して利用枠を消費する場合があります。診断検出、Git比較、検証コマンドはローカル処理です。

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
