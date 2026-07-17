import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

/** Owns the chat webview document and its bundled client-side UI. */
export class WebviewController {
  private view: vscode.WebviewView | undefined;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly isJapanese: boolean,
    private readonly supportsLocalSandbox: boolean,
    private readonly maxDroppedFileBytes: number,
  ) {}

  public attach(view: vscode.WebviewView, onDispose: () => void): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    view.webview.html = this.getHtml(view.webview);
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
        onDispose();
      }
    });
  }

  public post(message: Record<string, unknown>): Thenable<boolean> | undefined {
    return this.view?.webview.postMessage(message);
  }

  public get visible(): boolean {
    return this.view?.visible === true;
  }

  public getHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString("base64");
    const SUPPORTS_LOCAL_SANDBOX = this.supportsLocalSandbox;
    const MAX_DROPPED_FILE_BYTES = this.maxDroppedFileBytes;
    const extensionVersion = String(
      (this.context.extension.packageJSON as { version?: string }).version ?? "",
    );
    const markedUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "node_modules",
        "marked",
        "lib",
        "marked.umd.js",
      ),
    );
    const purifyUri = webview.asWebviewUri(
      vscode.Uri.joinPath(
        this.context.extensionUri,
        "node_modules",
        "dompurify",
        "dist",
        "purify.min.js",
      ),
    );
    const ui = this.isJapanese
      ? {
          history: "会話履歴",
          newChat: "新規チャット（実行中の会話とは別Agentで並列実行できます）",
          setApiKey: "APIキーを設定",
          authMessage: "Cursor DashboardでユーザーAPIキーを発行し、VS Codeに設定してください。",
          openDashboard: "Dashboardを開く",
          tasks: "タスク",
          detach: "添付を解除",
          referencedFiles: "参照ファイル",
          workspaceFiles: "ワークスペースのファイル",
          slashCommands: "スラッシュコマンド",
          prompt: "何でも依頼してください",
          promptLabel: "プロンプト",
          attachActive: "アクティブファイル/選択範囲を添付",
          addContextTools: "エージェント、コンテキスト、ツールを追加…",
          standardProfile: "標準",
          planProfile: "Plan",
          multitaskProfile: "Multitask",
          standardProfileDescription: "通常のエージェント実行",
          planProfileDescription: "実装計画を作成（ファイルは編集しない）",
          multitaskProfileDescription: "並列サブエージェントに分割して実行",
          noMatchingCommands: "一致するコマンドがありません",
          image: "画像を添付",
          skills: "Skills",
          mcpServers: "MCPサーバー",
          back: "戻る",
          noSkills: "プロジェクトSkillsはありません",
          noMcpServers: "設定済みMCPサーバーはありません",
          openSkillsFolder: "Skillsフォルダーを開く",
          openMcpSettings: "mcp.jsonを開く",
          apiKeyMissing: "APIキー未設定",
          model: "モデル",
          searchModels: "モデルを検索",
          modelOptions: "オプション",
          noMatchingModels: "一致するモデルがありません",
          variant: "バリアント",
          send: "送信",
          queue: "キュー",
          queueTitle: "実行後に送信（Enter / Alt+Enter）",
          interrupt: "割り込み",
          interruptTitle: "現在の実行を停止して最優先で送信（Ctrl+Enter）",
          queuedMessages: "送信待ち",
          queued: "キュー",
          interruptQueued: "割り込み",
          removeQueued: "キューから削除",
          localRun: "ローカルで実行",
          checkingConnection: "接続を確認中…",
          justNow: "たった今",
          minutesAgo: "分前",
          hoursAgo: "時間前",
          yesterday: "昨日",
          daysAgo: "日前",
          deleteConversation: "この会話を削除",
          showAll: "すべて表示",
          noActiveFile: "アクティブなファイルがありません",
          noMatchingFiles: "一致するファイルがありません",
          removeReference: "参照を解除",
          openFile: "ファイルを開く",
          showDiff: "差分を表示",
          connected: "接続済み",
          runningIn: "でローカル実行",
          selectWorkspace: "クリックしてワークスペースを選択",
          stop: "停止",
          running: "実行中",
          activeAgents: "Agent稼働中",
          parallelAgents: "並列Agent",
          queuedTask: "待機中",
          completedTask: "完了・確認待ち",
          failedTask: "失敗・確認待ち",
          stoppedTask: "停止・確認待ち",
          launchParallelAgent: "並列Agentを起動",
          parallelLimitReached: "並列Agentの上限に達しています",
          switchTask: "このタスクへ切り替え",
          stopTask: "このAgentを停止",
          removeQueuedTask: "待機を解除",
          attached: "添付",
          stopped: "停止しました。",
          progressRunning: "処理中",
          progressPreparing: "処理を準備しています…",
          progressCompleted: "処理が完了しました",
          progressStopped: "処理を停止しました",
          progressFailed: "処理中にエラーが発生しました",
          progressStep: "ステップ",
          dropFiles: "Shiftを押しながらドロップして添付",
          dropHelp: "ファイルはShiftを押しながらドラッグ＆ドロップできます",
          dropFailed: "ドロップしたファイルを読み取れませんでした。Shiftを押しながらドロップしてください。",
          pasteFailed: "クリップボードの画像を読み取れませんでした。",
          approvalMode: "実行権限",
          safeWorktree: "安全worktree（推奨）",
          safeWorktreeDescription: "自動レビューを使用し、編集を分離worktreeで実行します",
          autoReview: "自動レビュー",
          autoReviewDescription: SUPPORTS_LOCAL_SANDBOX
            ? "危険な可能性がある操作を自動判定し、サンドボックスを使用します"
            : "危険な可能性がある操作を自動判定します（この環境ではサンドボックス非対応）",
          fullAccess: "フルアクセス",
          fullAccessDescription: "確認とサンドボックスなしで実行します",
          sandboxUnavailable: "サンドボックスなし・自動レビュー有効",
          fullAccessStatus: "サンドボックスなし・フルアクセス",
          safeModeStatus: "Windows安全worktree・OS隔離なし",
          sandboxBannerSafeText: "Windowsではサンドボックスが無効です。安全worktreeで編集を分離しますが、ホストのファイルシステムとネットワークはOSレベルで隔離されません。",
          sandboxBannerDirectText: "Windowsではサンドボックスが無効です。ファイルシステムとネットワークの隔離はなく、エージェントはワークスペースを直接変更できます。",
          sandboxBannerLearnMore: "詳細",
          copyCode: "コードをコピー",
          copyMessage: "メッセージをコピー",
          copied: "コピーしました",
          featureSettings: "AI機能の設定",
          soundSettings: "通知と音の設定",
          completionNotification: "処理完了の通知",
          soundWhileRunning: "処理中の音",
          soundOnComplete: "完了時の音",
          soundOnError: "エラー時の音",
          usageTitle: "使用量",
          usageToday: "今日",
          usageWeek: "直近7日",
          usageChat: "チャット",
          usageSupervisor: "Supervisor",
          usageConversations: "会話合計",
          searchConversations: "会話を検索",
          pinConversation: "ピン留め",
          unpinConversation: "ピン解除",
          exportConversation: "書き出し",
          tokensLabel: "トークン",
          noMatchingConversations: "一致する会話がありません",
          projectMemory: "プロジェクト記憶",
          projectMemoryOn: "rules / project-memory を含める",
          projectMemoryOff: "rules / project-memory を除外",
          projectCommands: "プロジェクトコマンド",
          userCommand: "ユーザー",
          projectCommand: "プロジェクト",
          bestOfNDescription: "同じ指示を複数会話で並列実行して比較",
          pickWinner: "勝者にする",
          compareRuns: "比較",
          compareTitle: "best-of-N 比較",
          contextPreview: "送信コンテキスト",
          openCandidate: "開く",
          experimentsTitle: "比較実験",
          noAssistantYet: "まだ応答がありません",
        }
      : {
          history: "Conversation history",
          newChat: "New chat (runs with a separate agent in parallel)",
          setApiKey: "Set API key",
          authMessage: "Generate a user API key in Cursor Dashboard and set it in VS Code.",
          openDashboard: "Open Dashboard",
          tasks: "Tasks",
          detach: "Remove attachment",
          referencedFiles: "Referenced files",
          workspaceFiles: "Workspace files",
          slashCommands: "Slash commands",
          prompt: "Ask anything",
          promptLabel: "Prompt",
          attachActive: "Attach active file/selection",
          addContextTools: "Add agents, context, tools…",
          standardProfile: "Standard",
          planProfile: "Plan",
          multitaskProfile: "Multitask",
          standardProfileDescription: "Standard agent run",
          planProfileDescription: "Create an implementation plan without edits",
          multitaskProfileDescription: "Split work across parallel subagents",
          noMatchingCommands: "No matching commands",
          image: "Attach image",
          skills: "Skills",
          mcpServers: "MCP Servers",
          back: "Back",
          noSkills: "No project skills found",
          noMcpServers: "No MCP servers configured",
          openSkillsFolder: "Open Skills folder",
          openMcpSettings: "Open mcp.json",
          apiKeyMissing: "API key not set",
          model: "Model",
          searchModels: "Search models",
          modelOptions: "Options",
          noMatchingModels: "No matching models",
          variant: "Variant",
          send: "Send",
          queue: "Queue",
          queueTitle: "Send after the current run (Enter / Alt+Enter)",
          interrupt: "Interrupt",
          interruptTitle: "Stop the current run and send this next (Ctrl+Enter)",
          queuedMessages: "Queued messages",
          queued: "Queued",
          interruptQueued: "Interrupt",
          removeQueued: "Remove from queue",
          localRun: "Run locally",
          checkingConnection: "Checking connection…",
          justNow: "Just now",
          minutesAgo: " min ago",
          hoursAgo: " hr ago",
          yesterday: "Yesterday",
          daysAgo: " days ago",
          deleteConversation: "Delete this conversation",
          showAll: "Show all",
          noActiveFile: "No active file",
          noMatchingFiles: "No matching files",
          removeReference: "Remove reference",
          openFile: "Open file",
          showDiff: "Show diff",
          connected: "Connected",
          runningIn: "running locally",
          selectWorkspace: "Click to choose workspace folder",
          stop: "Stop",
          running: "Running",
          activeAgents: "agents active",
          parallelAgents: "Parallel agents",
          queuedTask: "Queued",
          completedTask: "Completed · review pending",
          failedTask: "Failed · review pending",
          stoppedTask: "Stopped · review pending",
          launchParallelAgent: "Start parallel agent",
          parallelLimitReached: "Parallel-agent limit reached",
          switchTask: "Switch to this task",
          stopTask: "Stop this agent",
          removeQueuedTask: "Remove from queue",
          attached: "Attached",
          stopped: "Stopped.",
          progressRunning: "Working",
          progressPreparing: "Preparing the run…",
          progressCompleted: "Work completed",
          progressStopped: "Work stopped",
          progressFailed: "Work failed",
          progressStep: "steps",
          dropFiles: "Hold Shift and drop files to attach",
          dropHelp: "Hold Shift while dragging and dropping to attach files",
          dropFailed: "Could not read the dropped files. Hold Shift while dropping.",
          pasteFailed: "Could not read the image from the clipboard.",
          approvalMode: "Execution permissions",
          safeWorktree: "Safe worktree (recommended)",
          safeWorktreeDescription: "Use Auto-review and run edits in a detached worktree",
          autoReview: "Auto-review",
          autoReviewDescription: SUPPORTS_LOCAL_SANDBOX
            ? "Classify potentially unsafe actions and use the sandbox"
            : "Classify potentially unsafe actions (sandbox unavailable in this environment)",
          fullAccess: "Full access",
          fullAccessDescription: "Run without review or sandbox restrictions",
          sandboxUnavailable: "No sandbox · Auto-review enabled",
          fullAccessStatus: "No sandbox · Full access",
          safeModeStatus: "Windows Safe worktree · No OS isolation",
          sandboxBannerSafeText: "The Windows sandbox is unavailable. Safe worktree mode separates edits, but the host filesystem and network are not OS-isolated.",
          sandboxBannerDirectText: "The Windows sandbox is unavailable. There is no filesystem or network isolation, and the agent can modify your workspace directly.",
          sandboxBannerLearnMore: "Details",
          copyCode: "Copy code",
          copyMessage: "Copy message",
          copied: "Copied",
          featureSettings: "AI feature settings",
          soundSettings: "Notification and sound settings",
          completionNotification: "Run completion notifications",
          soundWhileRunning: "While running",
          soundOnComplete: "On completion",
          soundOnError: "On error",
          usageTitle: "Usage",
          usageToday: "Today",
          usageWeek: "Last 7 days",
          usageChat: "Chat",
          usageSupervisor: "Supervisor",
          usageConversations: "All conversations",
          searchConversations: "Search conversations",
          pinConversation: "Pin",
          unpinConversation: "Unpin",
          exportConversation: "Export",
          tokensLabel: "tokens",
          noMatchingConversations: "No matching conversations",
          projectMemory: "Project memory",
          projectMemoryOn: "Include rules / project-memory",
          projectMemoryOff: "Exclude rules / project-memory",
          projectCommands: "Project commands",
          userCommand: "User",
          projectCommand: "Project",
          bestOfNDescription: "Run the same prompt in parallel chats to compare",
          pickWinner: "Pick as winner",
          compareRuns: "Compare",
          compareTitle: "best-of-N compare",
          contextPreview: "Send context",
          openCandidate: "Open",
          experimentsTitle: "Compare experiments",
          noAssistantYet: "No assistant reply yet",
        };

    return /* html */ `<!doctype html>
<html lang="${this.isJapanese ? "ja" : "en"}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';"
  >
  <title>Cursor Agent</title>
  <style>
    * { box-sizing: border-box; }
    :root {
      --radius-card: 16px;
      --muted: var(--vscode-descriptionForeground);
    }
    body {
      height: 100vh;
      margin: 0;
      display: flex;
      flex-direction: column;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font: var(--vscode-font-size) var(--vscode-font-family);
    }

    /* ---- Header ---- */
    .header {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 10px 14px 8px;
    }
    .brand {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: .08em;
      text-transform: uppercase;
      padding-bottom: 3px;
      border-bottom: 2px solid var(--vscode-foreground);
    }
    .header .spacer { flex: 1; }
    .icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      padding: 0;
      color: var(--vscode-icon-foreground);
      background: transparent;
      border: 0;
      border-radius: 6px;
      cursor: pointer;
    }
    .icon-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
    .icon-btn svg { width: 15px; height: 15px; }
    .sound-control { position: relative; }
    #soundButton.active { background: var(--vscode-toolbar-hoverBackground); }
    #soundMenu {
      position: absolute;
      top: calc(100% + 4px);
      right: 0;
      z-index: 30;
      width: 220px;
      padding: 6px;
      color: var(--vscode-menu-foreground, var(--vscode-foreground));
      background: var(--vscode-menu-background, var(--vscode-editorWidget-background));
      border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, transparent));
      border-radius: 8px;
      box-shadow: 0 4px 14px var(--vscode-widget-shadow, rgba(0, 0, 0, .3));
    }
    #soundMenu[hidden] { display: none; }
    .sound-menu-title {
      padding: 3px 7px 6px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 600;
    }
    .sound-option {
      display: flex;
      align-items: center;
      gap: 9px;
      min-height: 30px;
      padding: 5px 7px;
      border-radius: 5px;
      cursor: pointer;
      user-select: none;
    }
    .sound-option:hover { background: var(--vscode-menu-selectionBackground); }
    .sound-option input { margin: 0; accent-color: var(--vscode-focusBorder); }

    /* ---- Sandbox warning banner ---- */
    #sandboxBanner {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      flex: none;
      margin: 0 10px 6px;
      padding: 8px 10px;
      font-size: 11.5px;
      line-height: 1.45;
      color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground));
      background: var(--vscode-inputValidation-warningBackground, rgba(255, 200, 0, .12));
      border: 1px solid var(--vscode-inputValidation-warningBorder, rgba(255, 200, 0, .5));
      border-radius: 6px;
    }
    #sandboxBanner[hidden] { display: none; }
    .sandbox-banner-icon { flex: none; width: 15px; height: 15px; margin-top: 1px; }
    .sandbox-banner-text { flex: 1; }
    .sandbox-banner-link {
      flex: none;
      padding: 0;
      color: inherit;
      background: transparent;
      border: 0;
      font: inherit;
      font-weight: 600;
      text-decoration: underline;
      cursor: pointer;
    }
    /* ---- Parallel agents ---- */
    #parallelBar {
      flex: none;
      padding: 6px 10px 8px;
      border-top: 1px solid var(--vscode-widget-border, transparent);
      border-bottom: 1px solid var(--vscode-widget-border, transparent);
      background: var(--vscode-sideBarSectionHeader-background, transparent);
    }
    #parallelBar[hidden] { display: none; }
    .parallel-bar-header {
      display: flex;
      align-items: center;
      gap: 6px;
      min-height: 18px;
      padding: 0 2px 5px;
      color: var(--muted);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: .04em;
      text-transform: uppercase;
    }
    #parallelBarCount {
      margin-left: auto;
      padding: 1px 6px;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      border-radius: 9px;
      font-size: 10px;
      letter-spacing: 0;
    }
    #parallelTaskList {
      display: flex;
      gap: 6px;
      overflow-x: auto;
      padding-bottom: 2px;
      scrollbar-width: thin;
    }
    #startParallelAgentButton {
      display: flex;
      width: 100%;
      min-height: 28px;
      align-items: center;
      justify-content: center;
      gap: 6px;
      margin: 0 0 7px;
      padding: 4px 10px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 1px solid transparent;
      border-radius: 7px;
      font: inherit;
      font-size: 11px;
      font-weight: 600;
      cursor: pointer;
    }
    #startParallelAgentButton:hover:not(:disabled) {
      background: var(--vscode-button-hoverBackground);
    }
    #startParallelAgentButton:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }
    #startParallelAgentButton:disabled {
      color: var(--vscode-disabledForeground);
      background: var(--vscode-button-secondaryBackground, var(--vscode-editorWidget-background));
      cursor: not-allowed;
      opacity: .8;
    }
    #startParallelAgentButton[hidden] { display: none; }
    .parallel-launch-plus {
      font-size: 16px;
      font-weight: 400;
      line-height: 1;
    }
    .parallel-task {
      display: inline-flex;
      flex: 0 0 auto;
      align-items: stretch;
      max-width: 230px;
      min-width: 128px;
      overflow: hidden;
      color: var(--vscode-foreground);
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
      border: 1px solid var(--vscode-widget-border, var(--vscode-contrastBorder, transparent));
      border-radius: 999px;
    }
    .parallel-task.active {
      color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
      background: var(--vscode-list-activeSelectionBackground, var(--vscode-editorWidget-background));
      border-color: var(--vscode-focusBorder);
    }
    .parallel-task-main,
    .parallel-task-stop {
      color: inherit;
      background: transparent;
      border: 0;
      cursor: pointer;
    }
    .parallel-task-main {
      display: flex;
      min-width: 0;
      flex: 1;
      align-items: center;
      gap: 6px;
      padding: 5px 5px 5px 8px;
      text-align: left;
    }
    .parallel-task-main:hover,
    .parallel-task-stop:hover {
      background: var(--vscode-toolbar-hoverBackground);
    }
    .parallel-task-status {
      display: inline-flex;
      flex: none;
      align-items: center;
      justify-content: center;
      width: 11px;
      height: 11px;
      color: var(--vscode-testing-iconPassed, #45a85a);
    }
    .parallel-task.queued .parallel-task-status {
      color: var(--vscode-charts-yellow, #cca700);
      font-size: 13px;
      line-height: 1;
    }
    .parallel-task.completed .parallel-task-status {
      color: var(--vscode-testing-iconPassed, #45a85a);
      font-size: 13px;
      font-weight: 700;
    }
    .parallel-task.error .parallel-task-status {
      color: var(--vscode-testing-iconFailed, var(--vscode-errorForeground));
      font-size: 13px;
      font-weight: 700;
    }
    .parallel-task.stopped .parallel-task-status {
      color: var(--vscode-disabledForeground, var(--muted));
      font-size: 11px;
    }
    .parallel-task-title {
      min-width: 0;
      overflow: hidden;
      flex: 1;
      font-size: 11px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .parallel-task-queue-count {
      flex: none;
      color: var(--muted);
      font-size: 9px;
    }
    .parallel-task.active .parallel-task-queue-count { color: inherit; opacity: .8; }
    .parallel-task-stop {
      display: inline-flex;
      flex: none;
      align-items: center;
      justify-content: center;
      width: 25px;
      padding: 0 7px 0 5px;
      opacity: .7;
      font-size: 14px;
    }
    .parallel-task-stop:hover { opacity: 1; }

    /* ---- Messages ---- */
    #scroller {
      flex: 1;
      overflow-y: auto;
      padding: 4px 14px;
      display: flex;
      flex-direction: column;
    }
    #messages {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    #home {
      flex: 1;
      display: flex;
      flex-direction: column;
    }
    #tasks { padding: 2px 0 8px; }
    .tasks-title {
      padding: 4px 8px 6px;
      font-size: 12px;
      font-weight: 600;
    }
    #usagePanel {
      margin: 0 0 10px;
      padding: 8px 10px;
      border: 1px solid var(--vscode-widget-border, transparent);
      border-radius: 10px;
      background: color-mix(in srgb, var(--vscode-sideBar-background) 88%, var(--vscode-foreground) 12%);
    }
    #experimentsPanel,
    #comparePanel {
      margin: 0 0 10px;
      padding: 8px 10px;
      border: 1px solid var(--vscode-widget-border, transparent);
      border-radius: 10px;
    }
    .compare-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .compare-prompt {
      margin: 0 0 8px;
      color: var(--muted);
      font-size: 11px;
      white-space: pre-wrap;
    }
    .compare-grid {
      display: grid;
      grid-template-columns: 1fr;
      gap: 8px;
    }
    .compare-card {
      padding: 8px;
      border: 1px solid var(--vscode-widget-border, transparent);
      border-radius: 8px;
      background: var(--vscode-editor-background);
    }
    .compare-card.winner {
      border-color: var(--vscode-focusBorder);
    }
    .compare-card-title {
      display: flex;
      align-items: center;
      gap: 6px;
      margin-bottom: 6px;
      font-size: 12px;
      font-weight: 600;
    }
    .compare-card-body {
      max-height: 160px;
      overflow: auto;
      color: var(--muted);
      font-size: 11px;
      white-space: pre-wrap;
    }
    .compare-card-actions {
      display: flex;
      gap: 6px;
      margin-top: 8px;
    }
    #contextPreviewRow {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      margin-bottom: 6px;
    }
    .preview-chip {
      display: inline-flex;
      align-items: center;
      padding: 2px 7px;
      border-radius: 999px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      font-size: 10px;
    }
    .usage-title {
      margin-bottom: 6px;
      font-size: 12px;
      font-weight: 600;
    }
    .usage-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 6px 10px;
      font-size: 11px;
      color: var(--muted);
    }
    .usage-grid strong {
      color: var(--vscode-foreground);
      font-weight: 600;
    }
    #taskSearch {
      width: 100%;
      margin: 0 0 8px;
      padding: 6px 8px;
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 8px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      font: inherit;
      outline: none;
    }
    #taskSearch:focus {
      border-color: var(--vscode-focusBorder);
    }
    .task-row {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 8px;
      border-radius: 8px;
      cursor: pointer;
    }
    .task-row:hover { background: var(--vscode-list-hoverBackground); }
    .task-row.pinned .task-title::before {
      content: "📌 ";
    }
    .task-title {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .task-meta {
      display: flex;
      flex: none;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--muted);
    }
    .task-tokens {
      font-variant-numeric: tabular-nums;
    }
    .task-actions {
      display: none;
      flex: none;
      align-items: center;
      gap: 2px;
    }
    .task-action {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      padding: 0;
      font-size: 12px;
      line-height: 1;
      color: var(--muted);
      background: transparent;
      border: 0;
      border-radius: 4px;
      cursor: pointer;
    }
    .task-action:hover { color: var(--vscode-foreground); }
    .task-delete:hover { color: var(--vscode-errorForeground); }
    .task-row:hover .task-meta { display: none; }
    .task-row:hover .task-actions { display: inline-flex; }
    #taskEmpty {
      padding: 8px;
      color: var(--muted);
      font-size: 12px;
    }
    #viewAll {
      padding: 6px 8px;
      font-size: 12px;
      text-align: left;
      color: var(--muted);
      background: transparent;
      border: 0;
      cursor: pointer;
    }
    #viewAll:hover { color: var(--vscode-foreground); }
    .ghost {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 140px;
    }
    .ghost svg {
      width: 64px;
      height: 64px;
      opacity: .28;
    }
    .message {
      position: relative;
      line-height: 1.55;
      overflow-wrap: anywhere;
    }
    .user {
      align-self: flex-end;
      max-width: 88%;
      padding: 8px 28px 8px 12px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 14px;
      border-bottom-right-radius: 4px;
      white-space: pre-wrap;
    }
    .assistant {
      align-self: stretch;
      padding-right: 28px;
    }
    .assistant.error > .message-body {
      color: var(--vscode-errorForeground);
      white-space: pre-wrap;
    }
    .assistant > .message-body > :first-child { margin-top: 0; }
    .assistant > .message-body > :last-child { margin-bottom: 0; }
    .assistant .code-block {
      position: relative;
      margin: .75em 0;
    }
    .assistant .code-block > pre {
      margin: 0;
      padding: 10px 36px 10px 10px;
      overflow-x: auto;
      background: var(--vscode-textCodeBlock-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 10px;
    }
    .assistant code {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: .95em;
    }
    .assistant :not(pre) > code {
      padding: 1px 4px;
      background: var(--vscode-textCodeBlock-background);
      border-radius: 4px;
    }
    .copy-btn {
      position: absolute;
      top: 4px;
      right: 4px;
      z-index: 1;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      padding: 0;
      color: var(--vscode-icon-foreground);
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      opacity: 0;
      cursor: pointer;
    }
    .code-block > .copy-btn {
      top: 6px;
      right: 6px;
      background: var(--vscode-textCodeBlock-background);
    }
    .message:hover > .copy-btn,
    .message:focus-within > .copy-btn,
    .code-block:hover > .copy-btn,
    .code-block:focus-within > .copy-btn,
    .copy-btn:focus-visible,
    .copy-btn.copied {
      opacity: 1;
    }
    .copy-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
    .copy-btn:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }
    .copy-btn.copied {
      color: var(--vscode-testing-iconPassed, var(--vscode-charts-green, #3fb950));
    }
    .copy-btn svg {
      width: 14px;
      height: 14px;
      pointer-events: none;
    }
    .chat-progress {
      align-self: stretch;
      overflow: hidden;
      color: var(--muted);
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-panel-border);
      border-radius: 9px;
      font-size: 11px;
    }
    .chat-progress > summary {
      display: flex;
      align-items: center;
      gap: 7px;
      min-height: 29px;
      padding: 5px 8px;
      color: var(--vscode-foreground);
      cursor: pointer;
      list-style: none;
      user-select: none;
    }
    .chat-progress > summary::-webkit-details-marker { display: none; }
    .chat-progress > summary::after {
      content: "›";
      margin-left: auto;
      color: var(--muted);
      transform: rotate(90deg);
      transition: transform .12s ease;
    }
    .chat-progress[open] > summary::after { transform: rotate(-90deg); }
    .progress-spinner {
      width: 11px;
      height: 11px;
      flex: none;
      border: 1.5px solid currentColor;
      border-right-color: transparent;
      border-radius: 50%;
      animation: running-spin .8s linear infinite;
    }
    .chat-progress:not(.running) .progress-spinner { display: none; }
    .progress-list {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 2px 8px 8px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .progress-empty { padding-top: 5px; }
    .progress-item {
      display: flex;
      align-items: flex-start;
      gap: 7px;
      min-width: 0;
      padding-top: 4px;
    }
    .progress-status {
      width: 12px;
      flex: none;
      text-align: center;
      line-height: 1.4;
    }
    .progress-item.running .progress-status {
      width: 9px;
      height: 9px;
      margin: 2px 2px 0 1px;
      border: 1.3px solid currentColor;
      border-right-color: transparent;
      border-radius: 50%;
      animation: running-spin .8s linear infinite;
    }
    .progress-item.completed .progress-status { color: var(--vscode-testing-iconPassed, #4caf50); }
    .progress-item.error .progress-status { color: var(--vscode-errorForeground); }
    .progress-text {
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .workspace-file-link {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      cursor: pointer;
    }
    .workspace-file-link:hover {
      color: var(--vscode-textLink-activeForeground);
      text-decoration: underline;
    }
    .files {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
    }
    .file-chip {
      padding: 3px 10px;
      font-size: 11px;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      border: 0;
      border-radius: 10px;
      cursor: pointer;
    }
    .context-note {
      margin-top: 5px;
      font-size: 11px;
      color: var(--muted);
    }
    .user-attachments {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 4px;
      margin-top: 6px;
    }
    .user-attachment {
      padding: 2px 6px;
      color: var(--vscode-textLink-foreground);
      background: transparent;
      border: 1px solid color-mix(in srgb, var(--vscode-textLink-foreground) 45%, transparent);
      border-radius: 7px;
      font: inherit;
      font-size: 11px;
      cursor: pointer;
    }

    /* ---- Auth panel ---- */
    #auth {
      display: none;
      margin: 4px 14px;
      padding: 12px;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: var(--radius-card);
    }
    #auth p { margin: 0 0 10px; line-height: 1.5; }
    #auth .row { display: flex; gap: 6px; }
    #auth button {
      padding: 5px 12px;
      border: 0;
      border-radius: 8px;
      cursor: pointer;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }
    #auth button.secondary {
      color: var(--vscode-foreground);
      background: var(--vscode-button-secondaryBackground);
    }

    /* ---- Composer card ---- */
    .composer-wrap {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 8px 12px 4px;
    }
    .card {
      position: relative;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: var(--radius-card);
      box-shadow: 0 2px 10px rgba(0, 0, 0, .10);
      padding: 10px 12px 8px;
    }
    .card:focus-within { border-color: var(--vscode-focusBorder); }
    .drop-help {
      margin: -1px 4px 0;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.3;
      text-align: right;
    }
    #dropHint {
      position: absolute;
      inset: 5px;
      z-index: 10;
      display: none;
      align-items: center;
      justify-content: center;
      color: var(--vscode-button-foreground);
      background: color-mix(in srgb, var(--vscode-button-background) 88%, transparent);
      border: 1px dashed var(--vscode-button-foreground);
      border-radius: 12px;
      font-weight: 600;
      pointer-events: none;
    }
    .card.drag-active #dropHint { display: flex; }
    #filePicker,
    #slashPicker {
      max-height: 250px;
      margin: -2px -4px 8px;
      overflow-y: auto;
      background: var(--vscode-dropdown-background);
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 10px;
      box-shadow: 0 5px 18px rgba(0, 0, 0, .25);
    }
    #filePicker[hidden],
    #slashPicker[hidden] { display: none; }
    .file-result {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 6px 8px;
      color: var(--vscode-dropdown-foreground);
      background: transparent;
      border: 0;
      text-align: left;
      cursor: pointer;
    }
    .file-result:hover,
    .file-result.selected {
      color: var(--vscode-list-activeSelectionForeground);
      background: var(--vscode-list-activeSelectionBackground);
    }
    .file-result svg { width: 13px; height: 13px; flex: none; }
    .file-result-label {
      flex: none;
      max-width: 55%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .file-result-path {
      flex: 1;
      overflow: hidden;
      color: var(--muted);
      font-size: 11px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .file-result.selected .file-result-path { color: inherit; opacity: .8; }
    .file-empty { padding: 8px; color: var(--muted); font-size: 11px; }
    #mentionRow {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
      padding-bottom: 7px;
    }
    #mentionRow[hidden] { display: none; }
    #queueRow {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin: 0 -2px 8px;
      padding: 7px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
    }
    #queueRow[hidden] { display: none; }
    .queue-heading {
      color: var(--muted);
      font-size: 10px;
      font-weight: 600;
      letter-spacing: .02em;
      text-transform: uppercase;
    }
    .queue-item {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      font-size: 11px;
    }
    .queue-kind {
      flex: none;
      padding: 1px 5px;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      border-radius: 5px;
      font-size: 10px;
    }
    .queue-item.interrupt .queue-kind {
      color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground));
      background: var(--vscode-inputValidation-warningBackground, var(--vscode-badge-background));
    }
    .queue-text {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .queue-remove {
      flex: none;
      padding: 0 3px;
      color: var(--muted);
      background: transparent;
      border: 0;
      border-radius: 3px;
      cursor: pointer;
    }
    .queue-remove:hover {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground);
    }
    .mention-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      max-width: 100%;
      padding: 3px 5px 3px 8px;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      border-radius: 8px;
      font-size: 11px;
    }
    .mention-chip-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .mention-remove {
      padding: 0 3px;
      color: inherit;
      background: transparent;
      border: 0;
      border-radius: 3px;
      cursor: pointer;
    }
    .mention-remove:hover { background: rgba(255, 255, 255, .15); }
    textarea {
      display: block;
      width: 100%;
      min-height: 44px;
      max-height: 200px;
      resize: none;
      padding: 2px 2px 8px;
      color: var(--vscode-input-foreground);
      background: transparent;
      border: 0;
      outline: none;
      font: inherit;
      line-height: 1.5;
    }
    textarea::placeholder { color: var(--muted); }
    .card-row {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    #runningActions {
      display: flex;
      align-items: center;
      gap: 6px;
    }
    #runningActions[hidden] { display: none; }
    .run-action {
      flex: 1;
      min-width: 0;
      height: 28px;
      padding: 0 10px;
      color: var(--vscode-foreground);
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-panel-border);
      border-radius: 8px;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    .run-action:hover { background: var(--vscode-toolbar-hoverBackground); }
    .round-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      padding: 0;
      color: var(--vscode-icon-foreground);
      background: transparent;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 50%;
      cursor: pointer;
    }
    .round-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
    .round-btn.active {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border-color: var(--vscode-button-background);
    }
    .round-btn svg { width: 13px; height: 13px; }
    .add-control { position: relative; }
    #addMenu {
      position: absolute;
      left: 0;
      bottom: 34px;
      z-index: 35;
      width: min(250px, calc(100vw - 32px));
      max-height: min(420px, calc(100vh - 130px));
      overflow-y: auto;
      padding: 6px;
      color: var(--vscode-menu-foreground, var(--vscode-foreground));
      background: var(--vscode-menu-background, var(--vscode-dropdown-background));
      border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, var(--vscode-panel-border)));
      border-radius: 11px;
      box-shadow: 0 8px 28px rgba(0, 0, 0, .32);
    }
    #addMenu[hidden] { display: none; }
    .add-menu-title {
      padding: 4px 8px 6px;
      color: var(--muted);
      font-size: 12px;
    }
    .add-menu-row {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      min-height: 32px;
      padding: 5px 8px;
      color: inherit;
      background: transparent;
      border: 0;
      border-radius: 6px;
      text-align: left;
      font: inherit;
      cursor: pointer;
    }
    .add-menu-row:hover { background: var(--vscode-list-hoverBackground); }
    .add-menu-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .add-menu-row:disabled { color: var(--muted); cursor: default; }
    .add-menu-row:disabled:hover { background: transparent; }
    .add-menu-icon {
      width: 18px;
      flex: none;
      color: var(--muted);
      text-align: center;
      font-size: 15px;
    }
    .add-menu-label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .add-menu-meta { color: var(--muted); font-size: 11px; }
    .add-menu-separator {
      height: 1px;
      margin: 5px -6px;
      background: var(--vscode-menu-separatorBackground, var(--vscode-panel-border));
    }
    #profileChip {
      display: none;
      max-width: 110px;
      padding: 3px 7px;
      overflow: hidden;
      color: var(--vscode-badge-foreground);
      background: var(--vscode-badge-background);
      border: 0;
      border-radius: 9px;
      text-overflow: ellipsis;
      white-space: nowrap;
      font: inherit;
      font-size: 11px;
      cursor: pointer;
    }
    #contextRow {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding-bottom: 6px;
    }
    .ctx-chip {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      max-width: 100%;
      padding: 3px 6px 3px 8px;
      font-size: 11px;
      color: var(--muted);
      background: var(--vscode-toolbar-hoverBackground);
      border-radius: 8px;
      border: 0;
    }
    .ctx-chip svg { width: 12px; height: 12px; flex: none; }
    .memory-chip {
      cursor: pointer;
      opacity: .9;
    }
    .memory-chip[aria-pressed="false"] {
      opacity: .5;
      text-decoration: line-through;
    }
    #ctxLabel {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #ctxLabel.none { font-style: italic; }
    #ctxRemove {
      padding: 0 3px;
      font-size: 13px;
      line-height: 1;
      color: var(--muted);
      background: transparent;
      border: 0;
      border-radius: 4px;
      cursor: pointer;
    }
    #ctxRemove:hover { color: var(--vscode-foreground); }
    #authChip {
      display: none;
      align-items: center;
      gap: 4px;
      padding: 3px 9px;
      font-size: 11px;
      color: var(--vscode-editorWarning-foreground);
      background: transparent;
      border: 1px solid var(--vscode-editorWarning-foreground);
      border-radius: 10px;
      cursor: pointer;
    }
    .card-row .spacer { flex: 1; }
    #approvalSelect {
      max-width: 108px;
      padding: 2px 2px;
      font-size: 12px;
      color: var(--muted);
      background: transparent;
      border: 0;
      outline: none;
      cursor: pointer;
    }
    #approvalSelect option {
      color: var(--vscode-dropdown-foreground);
      background: var(--vscode-dropdown-background);
    }
    .model-control { position: relative; }
    #modelButton {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      max-width: 132px;
      padding: 3px 4px;
      color: var(--muted);
      background: transparent;
      border: 0;
      border-radius: 5px;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    #modelButton:hover,
    #modelButton[aria-expanded="true"] {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground);
    }
    #modelButtonLabel {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #modelButton svg {
      width: 10px;
      height: 10px;
      flex: none;
    }
    #modelPicker {
      position: fixed;
      left: 12px;
      bottom: 72px;
      z-index: 30;
      display: grid;
      grid-template-columns: minmax(190px, 1.1fr) minmax(170px, .9fr);
      width: min(500px, calc(100vw - 32px));
      max-height: min(430px, calc(100vh - 130px));
      overflow: hidden;
      color: var(--vscode-menu-foreground, var(--vscode-foreground));
      background: var(--vscode-menu-background, var(--vscode-dropdown-background));
      border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, var(--vscode-panel-border)));
      border-radius: 12px;
      box-shadow: 0 8px 28px rgba(0, 0, 0, .32);
    }
    #modelPicker[hidden] { display: none; }
    #modelPicker.options-empty { grid-template-columns: 1fr; width: min(270px, calc(100vw - 32px)); }
    .model-pane {
      min-width: 0;
      min-height: 0;
      overflow-y: auto;
    }
    .model-list-pane {
      display: flex;
      flex-direction: column;
      padding: 7px;
    }
    #modelSearch {
      width: 100%;
      margin-bottom: 5px;
      padding: 7px 8px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid transparent;
      border-radius: 7px;
      outline: none;
      font: inherit;
    }
    #modelSearch:focus { border-color: var(--vscode-focusBorder); }
    #modelList {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
    }
    .model-row,
    .model-option-row,
    .model-toggle-row {
      display: flex;
      align-items: center;
      width: 100%;
      min-height: 30px;
      padding: 5px 7px;
      color: inherit;
      background: transparent;
      border: 0;
      border-radius: 6px;
      text-align: left;
      font: inherit;
      cursor: pointer;
    }
    .model-row:hover,
    .model-option-row:hover,
    .model-toggle-row:hover { background: var(--vscode-list-hoverBackground); }
    .model-row.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .model-row-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .model-row-description {
      margin-left: 5px;
      overflow: hidden;
      color: var(--muted);
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 11px;
    }
    .model-empty {
      padding: 12px 8px;
      color: var(--muted);
      font-size: 12px;
    }
    #modelOptionsPane {
      border-left: 1px solid var(--vscode-menu-separatorBackground, var(--vscode-panel-border));
      padding: 8px 7px;
    }
    #modelOptionsPane[hidden] { display: none; }
    .model-options-title,
    .model-param-title {
      padding: 1px 7px 6px;
      color: var(--muted);
      font-size: 11px;
    }
    .model-param-group {
      margin: 4px 0;
      padding-top: 6px;
      border-top: 1px solid var(--vscode-menu-separatorBackground, var(--vscode-panel-border));
    }
    .model-option-label { flex: 1; }
    .model-check {
      width: 15px;
      margin-left: 8px;
      text-align: center;
    }
    .model-switch {
      position: relative;
      width: 30px;
      height: 18px;
      margin-left: auto;
      background: var(--vscode-inputOption-activeBackground, var(--vscode-disabledForeground));
      border-radius: 10px;
    }
    .model-switch::after {
      content: "";
      position: absolute;
      top: 2px;
      left: 2px;
      width: 14px;
      height: 14px;
      background: var(--vscode-button-foreground);
      border-radius: 50%;
      transition: transform .12s ease;
    }
    .model-switch.on { background: var(--vscode-button-background); }
    .model-switch.on::after { transform: translateX(12px); }

    /* Narrow sidebar (typical VS Code activity-bar width) */
    @media (max-width: 420px) {
      .header { padding: 8px 10px 6px; gap: 2px; }
      #scroller { padding: 4px 10px; }
      #auth { margin: 4px 10px; padding: 10px; }
      #auth .row { flex-wrap: wrap; }
      .composer-wrap { padding: 6px 8px 2px; }
      .card {
        padding: 8px 8px 6px;
        border-radius: 12px;
      }
      .user { max-width: 100%; }
      .assistant { padding-right: 24px; }
      .tasks-title { padding-left: 4px; }
      .task-row { padding: 6px 4px; gap: 6px; }
      .task-time { font-size: 10px; }

      .card-row {
        flex-wrap: wrap;
        align-items: center;
        row-gap: 6px;
        column-gap: 6px;
      }
      .model-control { min-width: 0; }
      #sendButton { margin-left: auto; }
      #approvalSelect { max-width: min(96px, 28vw); }
      #modelButton { max-width: min(110px, 34vw); }
      #profileChip { max-width: 88px; }
      #authChip {
        max-width: 7.2em;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #addMenu {
        width: min(250px, calc(100vw - 20px));
        max-height: min(360px, calc(100vh - 110px));
      }
      .file-result-label { max-width: 100%; }
      .file-result-path {
        flex: 1 1 100%;
        padding-left: 21px;
      }
      .model-row-description { display: none; }

      .footer {
        gap: 4px;
        padding: 2px 10px 8px;
        font-size: 11px;
      }
      #workspaceLabel {
        min-width: 0;
        max-width: 36%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #workspaceLabel.selectable {
        max-width: 42%;
      }

      #modelPicker {
        grid-template-columns: 1fr;
        grid-template-rows: minmax(150px, 1fr) minmax(120px, .75fr);
        width: min(290px, calc(100vw - 16px));
        height: min(520px, calc(100vh - 120px));
        max-height: min(520px, calc(100vh - 120px));
      }
      #modelPicker.options-empty {
        grid-template-rows: minmax(0, auto);
        height: auto;
      }
      #modelOptionsPane {
        min-height: 0;
        max-height: none;
        overflow-y: auto;
        border-top: 1px solid var(--vscode-menu-separatorBackground, var(--vscode-panel-border));
        border-left: 0;
      }
    }

    @media (max-width: 300px) {
      .brand {
        font-size: 10px;
        letter-spacing: .06em;
      }
      .ghost svg {
        width: 48px;
        height: 48px;
      }
      #auth .row {
        flex-direction: column;
      }
      #auth .row button { width: 100%; }
      .footer > svg:first-child,
      #workspaceLabel,
      .footer-sep:not(.footer-version-sep) {
        display: none;
      }
      #runningIndicator { padding: 2px 5px; }
      #runningIndicator > span:not(.running-spinner) { display: none; }
      #approvalSelect { max-width: 72px; }
      #modelButton { max-width: 84px; }
    }
    #sendButton {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 30px;
      height: 30px;
      padding: 0;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 0;
      border-radius: 50%;
      cursor: pointer;
    }
    #sendButton:hover { background: var(--vscode-button-hoverBackground); }
    #sendButton svg { width: 14px; height: 14px; }
    #sendButton .stop-icon { display: none; }
    #sendButton.running .send-icon { display: none; }
    #sendButton.running .stop-icon { display: block; }

    /* ---- Footer ---- */
    .footer {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 16px 10px;
      font-size: 12px;
      color: var(--muted);
    }
    .footer svg { width: 13px; height: 13px; flex: none; }
    #workspaceLabel {
      min-width: 0;
      max-width: 42%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      margin: 0;
      padding: 0;
      border: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: default;
    }
    #workspaceLabel.selectable {
      cursor: pointer;
      text-decoration: underline dotted;
      text-underline-offset: 2px;
    }
    #workspaceLabel.selectable:hover,
    #workspaceLabel.selectable:focus-visible {
      color: var(--vscode-foreground);
      outline: none;
    }
    #workspaceLabel:disabled {
      opacity: 1;
      cursor: default;
    }
    #status {
      min-width: 0;
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #extensionVersion {
      flex: none;
      opacity: .85;
      font-variant-numeric: tabular-nums;
    }
    #runningIndicator {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      flex: none;
      margin-left: auto;
      padding: 2px 7px;
      color: var(--vscode-statusBarItem-prominentForeground, var(--vscode-foreground));
      background: var(--vscode-statusBarItem-prominentBackground, var(--vscode-badge-background));
      border-radius: 9px;
      font-size: 11px;
    }
    #runningIndicator[hidden] { display: none; }
    .running-spinner {
      width: 10px;
      height: 10px;
      border: 1.5px solid currentColor;
      border-right-color: transparent;
      border-radius: 50%;
      animation: running-spin .8s linear infinite;
    }
    @keyframes running-spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="header">
    <span class="brand">Cursor</span>
    <span class="spacer"></span>
    <button id="featureSettingsButton" class="icon-btn" type="button" title="${ui.featureSettings}" aria-label="${ui.featureSettings}">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="8" cy="8" r="2"/>
        <path d="M6.5 1.6h3l.45 1.9 1.55.9 1.9-.5 1.5 2.6-1.45 1.2v1.8l1.45 1.2-1.5 2.6-1.9-.5-1.55.9L9.5 14.4h-3l-.45-1.9-1.55-.9-1.9.5-1.5-2.6 1.45-1.2V7.8L1.6 6.6l1.5-2.6 1.9.5 1.55-.9z"/>
      </svg>
    </button>
    <div class="sound-control">
      <button id="soundButton" class="icon-btn" type="button" title="${ui.soundSettings}" aria-label="${ui.soundSettings}" aria-expanded="false">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
          <path d="M2.5 6.2h2.3L8 3.5v9L4.8 9.8H2.5z"/>
          <path d="M10.5 5.5a3.2 3.2 0 0 1 0 5M12.3 3.7a5.7 5.7 0 0 1 0 8.6"/>
        </svg>
      </button>
      <div id="soundMenu" role="group" aria-label="${ui.soundSettings}" hidden>
        <div class="sound-menu-title">${ui.soundSettings}</div>
        <label class="sound-option"><input id="notificationToggle" type="checkbox"><span>${ui.completionNotification}</span></label>
        <label class="sound-option"><input id="runningSoundToggle" type="checkbox"><span>${ui.soundWhileRunning}</span></label>
        <label class="sound-option"><input id="completionSoundToggle" type="checkbox"><span>${ui.soundOnComplete}</span></label>
        <label class="sound-option"><input id="errorSoundToggle" type="checkbox"><span>${ui.soundOnError}</span></label>
      </div>
    </div>
    <button id="historyButton" class="icon-btn" type="button" title="${ui.history}">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="8" cy="8" r="6.2"/>
        <path d="M8 4.8V8l2.2 1.6"/>
      </svg>
    </button>
    <button id="newChatButton" class="icon-btn" type="button" title="${ui.newChat}">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4">
        <path d="M11.5 2.5l2 2L6 12l-2.7.7L4 10l7.5-7.5z"/>
        <path d="M13.5 8.5v4a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h4"/>
      </svg>
    </button>
    <button id="keyButton" class="icon-btn" type="button" title="${ui.setApiKey}">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="5" cy="8" r="3"/>
        <path d="M8 8h6M11 8v2M13.5 8v2"/>
      </svg>
    </button>
  </div>

  <div id="sandboxBanner" role="alert" hidden>
    <svg class="sandbox-banner-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M8 1.6 1.8 4.3v3.4c0 3.6 2.5 5.9 6.2 7 3.7-1.1 6.2-3.4 6.2-7V4.3z"/>
      <path d="M8 5.6v3.1M8 10.7v.05"/>
    </svg>
    <span id="sandboxBannerText" class="sandbox-banner-text">${ui.sandboxBannerSafeText}</span>
    <button id="sandboxBannerLearnMore" class="sandbox-banner-link" type="button">${ui.sandboxBannerLearnMore}</button>
  </div>

  <div id="parallelBar" hidden>
    <div class="parallel-bar-header">
      <span id="parallelBarTitle">${ui.parallelAgents}</span>
      <span id="parallelBarCount"></span>
    </div>
    <button id="startParallelAgentButton" type="button">
      <span class="parallel-launch-plus" aria-hidden="true">＋</span>
      <span>${ui.launchParallelAgent}</span>
    </button>
    <div id="parallelTaskList"></div>
  </div>

  <div id="auth">
    <p>${ui.authMessage}</p>
    <div class="row">
      <button id="connectButton" type="button">${ui.setApiKey}</button>
      <button id="dashboardButton" class="secondary" type="button">${ui.openDashboard}</button>
    </div>
  </div>

  <div id="scroller">
    <div id="messages" aria-live="polite" style="display: none;"></div>
    <div id="home">
      <div id="usagePanel" hidden>
        <div class="usage-title">${ui.usageTitle}</div>
        <div class="usage-grid">
          <div>${ui.usageToday}: <strong id="usageTodayTotal">0</strong></div>
          <div>${ui.usageWeek}: <strong id="usageWeekTotal">0</strong></div>
          <div>${ui.usageChat}: <strong id="usageChatTotal">0</strong></div>
          <div>${ui.usageSupervisor}: <strong id="usageSupervisorTotal">0</strong></div>
          <div>${ui.usageConversations}: <strong id="usageConversationTotal">0</strong></div>
        </div>
      </div>
      <div id="experimentsPanel" hidden>
        <div class="tasks-title">${ui.experimentsTitle}</div>
        <div id="experimentList"></div>
      </div>
      <div id="comparePanel" hidden>
        <div class="compare-header">
          <div class="tasks-title">${ui.compareTitle}</div>
          <button id="compareClose" class="task-action" type="button" title="${ui.back}">×</button>
        </div>
        <div id="comparePrompt" class="compare-prompt"></div>
        <div id="compareGrid" class="compare-grid"></div>
      </div>
      <div id="tasks" hidden>
        <div class="tasks-title">${ui.tasks}</div>
        <input id="taskSearch" type="search" placeholder="${ui.searchConversations}" aria-label="${ui.searchConversations}">
        <div id="taskList"></div>
        <div id="taskEmpty" hidden>${ui.noMatchingConversations}</div>
        <button id="viewAll" type="button" hidden></button>
      </div>
      <div class="ghost">
        <svg viewBox="668 350 264 300" fill="currentColor">
          <path d="M920.015 424.958L805.919 359.086C802.256 356.97 797.735 356.97 794.071 359.086L679.981 424.958C676.901 426.736 675 430.025 675 433.587V566.419C675 569.981 676.901 573.269 679.981 575.048L794.077 640.92C797.74 643.036 802.261 643.036 805.925 640.92L920.02 575.048C923.1 573.269 925.001 569.981 925.001 566.419V433.587C925.001 430.025 923.1 426.736 920.02 424.958H920.015ZM912.848 438.911L802.706 629.682C801.961 630.968 799.995 630.443 799.995 628.954V504.039C799.995 501.543 798.662 499.234 796.498 497.981L688.321 435.526C687.036 434.781 687.561 432.816 689.05 432.816H909.334C912.462 432.816 914.417 436.206 912.853 438.917H912.848V438.911Z"/>
        </svg>
      </div>
    </div>
  </div>

  <div class="composer-wrap">
    <div id="runningActions" hidden>
      <button id="queueButton" class="run-action" type="button" title="${ui.queueTitle}">${ui.queue}</button>
      <button id="interruptButton" class="run-action" type="button" title="${ui.interruptTitle}">${ui.interrupt}</button>
    </div>
    <div class="card">
      <div id="dropHint" aria-live="polite">${ui.dropFiles}</div>
      <div id="contextPreviewRow" aria-label="${ui.contextPreview}" hidden></div>
      <div id="contextRow">
        <span id="editorChip" class="ctx-chip" hidden>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
            <path d="M9.5 1.5H4.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V4.5l-3-3z"/>
            <path d="M9.5 1.5v3h3"/>
          </svg>
          <span id="ctxLabel"></span>
          <button id="ctxRemove" type="button" title="${ui.detach}">×</button>
        </span>
        <button id="memoryChip" class="ctx-chip memory-chip" type="button" title="${ui.projectMemoryOn}" aria-pressed="true">
          <span id="memoryChipLabel">${ui.projectMemory}</span>
        </button>
      </div>
      <div id="mentionRow" aria-label="${ui.referencedFiles}" hidden></div>
      <div id="queueRow" aria-label="${ui.queuedMessages}" hidden></div>
      <div id="filePicker" role="listbox" aria-label="${ui.workspaceFiles}" hidden></div>
      <div id="slashPicker" role="listbox" aria-label="${ui.slashCommands}" hidden></div>
      <textarea id="prompt" placeholder="${ui.prompt}" aria-label="${ui.promptLabel}" rows="2"></textarea>
      <div class="card-row">
        <div class="add-control">
          <button id="attachButton" class="round-btn" type="button" title="${ui.addContextTools}" aria-expanded="false">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
              <path d="M8 3v10M3 8h10"/>
            </svg>
          </button>
          <div id="addMenu" hidden>
            <div id="addMenuContent"></div>
          </div>
        </div>
        <button id="profileChip" type="button"></button>
        <button id="authChip" type="button" title="${ui.setApiKey}">${ui.apiKeyMissing}</button>
        <span class="spacer"></span>
        <select id="approvalSelect" aria-label="${ui.approvalMode}">
          ${SUPPORTS_LOCAL_SANDBOX ? "" : `<option value="safe-worktree">${ui.safeWorktree}</option>`}
          <option value="auto-review">${ui.autoReview}</option>
          <option value="full-access">${ui.fullAccess}</option>
        </select>
        <div class="model-control">
          <button id="modelButton" type="button" aria-label="${ui.model}" aria-expanded="false">
            <span id="modelButtonLabel">Auto</span>
            <svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2">
              <path d="M2 3.5 5 6.5 8 3.5"/>
            </svg>
          </button>
          <div id="modelPicker" hidden>
            <div class="model-pane model-list-pane">
              <input id="modelSearch" type="search" placeholder="${ui.searchModels}" aria-label="${ui.searchModels}">
              <div id="modelList"></div>
            </div>
            <div id="modelOptionsPane" class="model-pane" hidden>
              <div class="model-options-title">${ui.modelOptions}</div>
              <div id="modelOptions"></div>
            </div>
          </div>
        </div>
        <button id="sendButton" type="button" title="${ui.send}">
          <svg class="send-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/>
          </svg>
          <svg class="stop-icon" viewBox="0 0 16 16" fill="currentColor">
            <rect x="4" y="4" width="8" height="8" rx="1.5"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="drop-help">${ui.dropHelp}</div>
  </div>

  <div class="footer">
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">
      <rect x="1.8" y="3" width="12.4" height="8" rx="1"/>
      <path d="M5.5 13.5h5"/>
    </svg>
    <button type="button" id="workspaceLabel" disabled>${ui.localRun}</button>
    <span class="footer-sep" aria-hidden="true">·</span>
    <span id="status">${ui.checkingConnection}</span>
    <span class="footer-sep footer-version-sep" aria-hidden="true">·</span>
    <span id="extensionVersion" title="Extension version">v${extensionVersion}</span>
    <span id="runningIndicator" hidden>
      <span class="running-spinner" aria-hidden="true"></span>
      <span>${ui.running}</span>
    </span>
  </div>

  <script nonce="${nonce}" src="${markedUri}"></script>
  <script nonce="${nonce}" src="${purifyUri}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const i18n = ${JSON.stringify(ui)};
    const messages = document.getElementById("messages");
    const home = document.getElementById("home");
    const tasks = document.getElementById("tasks");
    const taskList = document.getElementById("taskList");
    const taskEmpty = document.getElementById("taskEmpty");
    const taskSearch = document.getElementById("taskSearch");
    const usagePanel = document.getElementById("usagePanel");
    const usageTodayTotal = document.getElementById("usageTodayTotal");
    const usageWeekTotal = document.getElementById("usageWeekTotal");
    const usageChatTotal = document.getElementById("usageChatTotal");
    const usageSupervisorTotal = document.getElementById("usageSupervisorTotal");
    const usageConversationTotal = document.getElementById("usageConversationTotal");
    const experimentsPanel = document.getElementById("experimentsPanel");
    const experimentList = document.getElementById("experimentList");
    const comparePanel = document.getElementById("comparePanel");
    const comparePrompt = document.getElementById("comparePrompt");
    const compareGrid = document.getElementById("compareGrid");
    const compareClose = document.getElementById("compareClose");
    const contextPreviewRow = document.getElementById("contextPreviewRow");
    const viewAll = document.getElementById("viewAll");
    const parallelBar = document.getElementById("parallelBar");
    const parallelBarTitle = document.getElementById("parallelBarTitle");
    const parallelBarCount = document.getElementById("parallelBarCount");
    const startParallelAgentButton = document.getElementById("startParallelAgentButton");
    const parallelTaskList = document.getElementById("parallelTaskList");
    const historyButton = document.getElementById("historyButton");
    const soundButton = document.getElementById("soundButton");
    const featureSettingsButton = document.getElementById("featureSettingsButton");
    const soundMenu = document.getElementById("soundMenu");
    const notificationToggle = document.getElementById("notificationToggle");
    const runningSoundToggle = document.getElementById("runningSoundToggle");
    const completionSoundToggle = document.getElementById("completionSoundToggle");
    const errorSoundToggle = document.getElementById("errorSoundToggle");
    const scroller = document.getElementById("scroller");
    const prompt = document.getElementById("prompt");
    const composerCard = document.querySelector(".composer-wrap .card");
    const sendButton = document.getElementById("sendButton");
    const attachButton = document.getElementById("attachButton");
    const addMenu = document.getElementById("addMenu");
    const addMenuContent = document.getElementById("addMenuContent");
    const profileChip = document.getElementById("profileChip");
    const newChatButton = document.getElementById("newChatButton");
    const status = document.getElementById("status");
    const runningIndicator = document.getElementById("runningIndicator");
    const workspaceLabel = document.getElementById("workspaceLabel");
    const auth = document.getElementById("auth");
    const authChip = document.getElementById("authChip");
    const sandboxBanner = document.getElementById("sandboxBanner");
    const sandboxBannerText = document.getElementById("sandboxBannerText");
    const sandboxBannerLearnMore = document.getElementById("sandboxBannerLearnMore");
    const approvalSelect = document.getElementById("approvalSelect");
    const modelButton = document.getElementById("modelButton");
    const modelButtonLabel = document.getElementById("modelButtonLabel");
    const modelPicker = document.getElementById("modelPicker");
    const modelSearch = document.getElementById("modelSearch");
    const modelList = document.getElementById("modelList");
    const modelOptionsPane = document.getElementById("modelOptionsPane");
    const modelOptions = document.getElementById("modelOptions");
    const contextRow = document.getElementById("contextRow");
    const editorChip = document.getElementById("editorChip");
    const ctxLabel = document.getElementById("ctxLabel");
    const ctxRemove = document.getElementById("ctxRemove");
    const memoryChip = document.getElementById("memoryChip");
    const memoryChipLabel = document.getElementById("memoryChipLabel");
    const mentionRow = document.getElementById("mentionRow");
    const queueRow = document.getElementById("queueRow");
    const runningActions = document.getElementById("runningActions");
    const queueButton = document.getElementById("queueButton");
    const interruptButton = document.getElementById("interruptButton");
    const filePicker = document.getElementById("filePicker");
    const slashPicker = document.getElementById("slashPicker");
    let assistantNode;
    let assistantRaw = "";
    let activeProgress;
    let running = false;
    let activeChatRuns = 0;
    let maximumChatRuns = 3;
    let parallelTasks = [];
    let runningSoundEnabled = false;
    let completionSoundEnabled = false;
    let errorSoundEnabled = false;
    let webviewSoundPlayback = false;
    let runningSoundTimer;
    let runningAudioContext;
    const runningSoundVoices = new Set();
    let sandboxUnavailable = false;
    let sandboxSupported = true;
    let attach = false;
    let includeProjectMemory = true;
    let projectCommands = [];
    let view = "home";
    let allConversations = [];
    let tasksExpanded = false;
    let conversationSearchQuery = "";
    let conversationSearchTimer;
    let usageSummary = null;
    let bestOfNExperiments = [];
    let contextEstimateTimer;
    let selectedFiles = [];
    let fileResults = [];
    let selectedFileIndex = 0;
    let fileRequestId = 0;
    let mentionRange;
    let slashResults = [];
    let selectedSlashIndex = 0;
    let slashRange;
    let workspacePaths = new Set();
    let workspaceBasenames = new Set();
    let attachmentRequestId = 0;
    let availableModels = [];
    let selectedModelId = "auto";
    let modelParamState = {};
    let runProfile = "agent";
    let availableSkills = [];
    let selectedSkills = [];
    let availableMcpServers = [];
    let queuedMessages = [];
    let followOutput = true;

    function setSoundMenuOpen(open) {
      soundMenu.hidden = !open;
      soundButton.classList.toggle("active", open);
      soundButton.setAttribute("aria-expanded", String(open));
    }

    function profileLabel(profile) {
      return {
        agent: i18n.standardProfile,
        plan: i18n.planProfile,
        multitask: i18n.multitaskProfile,
      }[profile] || profile;
    }

    function updateProfileChip() {
      const labels = [];
      if (runProfile !== "agent") labels.push(profileLabel(runProfile));
      if (selectedSkills.length > 0) labels.push(i18n.skills + " " + selectedSkills.length);
      profileChip.style.display = labels.length > 0 ? "inline-block" : "none";
      profileChip.textContent = labels.join(" · ");
      profileChip.title = labels.join(", ");
      attachButton.classList.toggle("active", attach || labels.length > 0);
    }

    function addMenuTitle(text) {
      const title = document.createElement("div");
      title.className = "add-menu-title";
      title.textContent = text;
      addMenuContent.appendChild(title);
    }

    function addMenuSeparator() {
      const separator = document.createElement("div");
      separator.className = "add-menu-separator";
      addMenuContent.appendChild(separator);
    }

    function addMenuRow(iconText, labelText, options) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "add-menu-row" + (options.selected ? " selected" : "");
      row.disabled = options.disabled === true;
      if (options.title) row.title = options.title;
      const icon = document.createElement("span");
      icon.className = "add-menu-icon";
      icon.textContent = iconText;
      const label = document.createElement("span");
      label.className = "add-menu-label";
      label.textContent = labelText;
      row.append(icon, label);
      if (options.meta) {
        const meta = document.createElement("span");
        meta.className = "add-menu-meta";
        meta.textContent = options.meta;
        row.appendChild(meta);
      }
      if (options.onClick) row.addEventListener("click", options.onClick);
      addMenuContent.appendChild(row);
      return row;
    }

    function selectRunProfile(profile) {
      runProfile = profile;
      updateProfileChip();
      closeAddMenu();
      requestContextPreview();
    }

    function slashCommands() {
      const builtins = [
        {
          id: "agent",
          aliases: ["agent", "standard"],
          label: i18n.standardProfile,
          description: i18n.standardProfileDescription,
          icon: "A",
          profile: "agent",
        },
        {
          id: "plan",
          aliases: ["plan"],
          label: i18n.planProfile,
          description: i18n.planProfileDescription,
          icon: "☷",
          profile: "plan",
        },
        {
          id: "multitask",
          aliases: ["multitask"],
          label: i18n.multitaskProfile,
          description: i18n.multitaskProfileDescription,
          icon: "⑂",
          profile: "multitask",
        },
        {
          id: "compare",
          aliases: ["compare", "bestofn"],
          label: "/compare",
          description: i18n.bestOfNDescription,
          icon: "☰",
          bestOfN: true,
        },
      ];
      const templates = projectCommands.map((command) => ({
        id: command.id,
        aliases: [command.id],
        label: command.label,
        description: command.description
          + (command.source === "user" ? " · " + i18n.userCommand : " · " + i18n.projectCommand),
        icon: "/",
        commandId: command.id,
      }));
      return builtins.concat(templates);
    }

    function consumeLeadingSlashCommand(text) {
      const compareMatch = /^\\/(compare|bestofn)(?:\\s+|$)/i.exec(text);
      if (compareMatch) {
        return {
          text: text.slice(compareMatch[0].length).replace(/^\\s+/, ""),
          profile: undefined,
          commandId: undefined,
          bestOfN: true,
        };
      }
      const profileMatch = /^\\/(agent|standard|plan|multitask)(?:\\s+|$)/i.exec(text);
      if (profileMatch) {
        const command = profileMatch[1].toLowerCase();
        const profile = command === "standard" || command === "agent" ? "agent" : command;
        return {
          text: text.slice(profileMatch[0].length).replace(/^\\s+/, ""),
          profile,
          commandId: undefined,
          bestOfN: false,
        };
      }
      const templateMatch = /^\\/([a-z0-9][a-z0-9_-]{0,63})(?:\\s+|$)/i.exec(text);
      if (templateMatch) {
        const commandId = templateMatch[1].toLowerCase();
        if (projectCommands.some((command) => command.id === commandId)) {
          return {
            text: text.slice(templateMatch[0].length).replace(/^\\s+/, ""),
            profile: undefined,
            commandId,
            bestOfN: false,
          };
        }
      }
      return { text, profile: undefined, commandId: undefined, bestOfN: false };
    }

    function renderMainAddMenu() {
      addMenuContent.innerHTML = "";
      addMenuTitle(i18n.addContextTools);
      addMenuRow("＋", i18n.attachActive, {
        selected: attach,
        onClick: () => {
          setAttach(!attach);
          closeAddMenu();
        },
      });
      addMenuSeparator();
      for (const profile of ["agent", "plan", "multitask"]) {
        const icons = { agent: "A", plan: "☷", multitask: "⑂" };
        addMenuRow(icons[profile], profileLabel(profile), {
          selected: runProfile === profile,
          meta: runProfile === profile ? "✓" : "",
          onClick: () => selectRunProfile(profile),
        });
      }
      addMenuSeparator();
      addMenuRow("▧", i18n.image, {
        onClick: () => {
          attachmentRequestId += 1;
          vscode.postMessage({ type: "pickImages", requestId: attachmentRequestId });
          closeAddMenu();
        },
      });
      addMenuRow("◇", i18n.skills, {
        meta: selectedSkills.length > 0 ? String(selectedSkills.length) + " ›" : "›",
        onClick: renderSkillsMenu,
      });
      addMenuRow("⌁", i18n.mcpServers, {
        meta: availableMcpServers.length > 0 ? String(availableMcpServers.length) + " ›" : "›",
        onClick: renderMcpMenu,
      });
    }

    function renderSkillsMenu() {
      addMenuContent.innerHTML = "";
      addMenuRow("‹", i18n.back, { onClick: renderMainAddMenu });
      addMenuTitle(i18n.skills);
      if (availableSkills.length === 0) {
        addMenuRow("◇", i18n.noSkills, { disabled: true });
      } else {
        for (const skill of availableSkills) {
          addMenuRow("◇", skill.name, {
            title: skill.description || skill.name,
            selected: selectedSkills.includes(skill.name),
            meta: selectedSkills.includes(skill.name) ? "✓" : "",
            onClick: () => {
              if (selectedSkills.includes(skill.name)) {
                selectedSkills = selectedSkills.filter((name) => name !== skill.name);
              } else {
                selectedSkills.push(skill.name);
              }
              updateProfileChip();
              renderSkillsMenu();
            },
          });
        }
      }
      addMenuSeparator();
      addMenuRow("↗", i18n.openSkillsFolder, {
        onClick: () => {
          vscode.postMessage({ type: "openSkillsFolder" });
          closeAddMenu();
        },
      });
    }

    function renderMcpMenu() {
      addMenuContent.innerHTML = "";
      addMenuRow("‹", i18n.back, { onClick: renderMainAddMenu });
      addMenuTitle(i18n.mcpServers);
      if (availableMcpServers.length === 0) {
        addMenuRow("⌁", i18n.noMcpServers, { disabled: true });
      } else {
        for (const server of availableMcpServers) {
          addMenuRow("●", server, { disabled: true, meta: "✓" });
        }
      }
      addMenuSeparator();
      addMenuRow("↗", i18n.openMcpSettings, {
        onClick: () => {
          vscode.postMessage({ type: "openMcpSettings" });
          closeAddMenu();
        },
      });
    }

    function openAddMenu() {
      closeModelPicker();
      renderMainAddMenu();
      addMenu.hidden = false;
      attachButton.setAttribute("aria-expanded", "true");
    }

    function closeAddMenu() {
      addMenu.hidden = true;
      attachButton.setAttribute("aria-expanded", "false");
    }

    function selectedModelDefinition() {
      return availableModels.find((model) => model.id === selectedModelId);
    }

    function defaultParamsFor(model) {
      const defaultVariant = (model.variants || []).find((variant) => variant.isDefault);
      const params = defaultVariant ? defaultVariant.params.map((param) => ({ ...param })) : [];
      for (const parameter of model.parameters || []) {
        if (!params.some((param) => param.id === parameter.id) && parameter.values.length > 0) {
          params.push({ id: parameter.id, value: parameter.values[0].value });
        }
      }
      return params;
    }

    function paramsForModel(model) {
      if (!Object.prototype.hasOwnProperty.call(modelParamState, model.id)) {
        modelParamState[model.id] = defaultParamsFor(model);
      }
      return modelParamState[model.id];
    }

    function updateModelButton() {
      const model = selectedModelDefinition();
      modelButtonLabel.textContent = model ? model.label : selectedModelId;
      modelButton.title = model && model.description
        ? model.label + ": " + model.description
        : modelButtonLabel.textContent;
    }

    function postModelSelection() {
      const model = selectedModelDefinition();
      vscode.postMessage({
        type: "selectModel",
        modelId: selectedModelId,
        modelParams: model ? paramsForModel(model) : [],
      });
    }

    function setModelParameter(model, parameterId, value) {
      const params = paramsForModel(model);
      const existing = params.find((param) => param.id === parameterId);
      if (existing) {
        existing.value = value;
      } else {
        params.push({ id: parameterId, value });
      }
      postModelSelection();
      renderModelOptions();
    }

    function booleanValues(parameter) {
      if (parameter.values.length !== 2) return;
      const truthy = new Set(["true", "on", "enabled", "yes", "1"]);
      const falsy = new Set(["false", "off", "disabled", "no", "0"]);
      const enabled = parameter.values.find((item) =>
        truthy.has(item.value.toLowerCase()) || truthy.has(item.label.toLowerCase()));
      const disabled = parameter.values.find((item) =>
        falsy.has(item.value.toLowerCase()) || falsy.has(item.label.toLowerCase()));
      return enabled && disabled ? { enabled, disabled } : undefined;
    }

    function hasModelOptions(model) {
      return Boolean(model && ((model.parameters || []).length || (model.variants || []).length));
    }

    function renderModelList() {
      modelList.innerHTML = "";
      const query = modelSearch.value.trim().toLowerCase();
      const filtered = availableModels.filter((model) =>
        !query || [model.id, model.label, model.description || ""]
          .some((value) => value.toLowerCase().includes(query)));
      if (filtered.length === 0) {
        const empty = document.createElement("div");
        empty.className = "model-empty";
        empty.textContent = i18n.noMatchingModels;
        modelList.appendChild(empty);
        return;
      }
      for (const model of filtered) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "model-row" + (model.id === selectedModelId ? " selected" : "");
        row.title = model.description || model.label;

        const name = document.createElement("span");
        name.className = "model-row-name";
        name.textContent = model.label;
        row.appendChild(name);
        if (model.description) {
          const description = document.createElement("span");
          description.className = "model-row-description";
          description.textContent = model.description;
          row.appendChild(description);
        }
        row.addEventListener("click", () => {
          selectedModelId = model.id;
          paramsForModel(model);
          updateModelButton();
          postModelSelection();
          renderModelList();
          renderModelOptions();
          if (!hasModelOptions(model)) closeModelPicker();
        });
        modelList.appendChild(row);
      }
    }

    function addModelOption(group, label, selected, onSelect) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "model-option-row";
      const text = document.createElement("span");
      text.className = "model-option-label";
      text.textContent = label;
      const check = document.createElement("span");
      check.className = "model-check";
      check.textContent = selected ? "✓" : "";
      row.append(text, check);
      row.addEventListener("click", onSelect);
      group.appendChild(row);
    }

    function renderModelOptions() {
      modelOptions.innerHTML = "";
      const model = selectedModelDefinition();
      const showOptions = hasModelOptions(model);
      modelOptionsPane.hidden = !showOptions;
      modelPicker.classList.toggle("options-empty", !showOptions);
      if (!modelPicker.hidden) requestAnimationFrame(positionModelPicker);
      if (!model || !showOptions) return;

      const params = paramsForModel(model);
      for (const parameter of model.parameters || []) {
        const group = document.createElement("div");
        group.className = "model-param-group";
        const boolean = booleanValues(parameter);
        const selected = params.find((param) => param.id === parameter.id)?.value;
        if (boolean) {
          const row = document.createElement("button");
          row.type = "button";
          row.className = "model-toggle-row";
          row.setAttribute("role", "switch");
          const on = selected === boolean.enabled.value;
          row.setAttribute("aria-checked", String(on));
          const label = document.createElement("span");
          label.className = "model-option-label";
          label.textContent = parameter.label;
          const toggle = document.createElement("span");
          toggle.className = "model-switch" + (on ? " on" : "");
          row.append(label, toggle);
          row.addEventListener("click", () =>
            setModelParameter(model, parameter.id, on ? boolean.disabled.value : boolean.enabled.value));
          group.appendChild(row);
        } else {
          const title = document.createElement("div");
          title.className = "model-param-title";
          title.textContent = parameter.label;
          group.appendChild(title);
          for (const value of parameter.values) {
            addModelOption(group, value.label, selected === value.value, () =>
              setModelParameter(model, parameter.id, value.value));
          }
        }
        modelOptions.appendChild(group);
      }

      if ((model.parameters || []).length === 0 && (model.variants || []).length > 0) {
        const group = document.createElement("div");
        group.className = "model-param-group";
        const title = document.createElement("div");
        title.className = "model-param-title";
        title.textContent = i18n.variant;
        group.appendChild(title);
        for (const variant of model.variants) {
          const selected = variant.params.every((expected) =>
            params.some((param) => param.id === expected.id && param.value === expected.value));
          addModelOption(group, variant.label, selected, () => {
            modelParamState[model.id] = variant.params.map((param) => ({ ...param }));
            postModelSelection();
            renderModelOptions();
          });
        }
        modelOptions.appendChild(group);
      }
    }

    function positionModelPicker() {
      if (modelPicker.hidden) return;
      const narrow = window.innerWidth <= 420;
      const veryNarrow = window.innerWidth <= 300;
      const margin = veryNarrow ? 8 : narrow ? 8 : 12;
      const gap = 6;
      const buttonRect = modelButton.getBoundingClientRect();
      const desiredWidth = modelPicker.classList.contains("options-empty")
        ? narrow ? Math.min(270, window.innerWidth - margin * 2) : 270
        : narrow ? 290 : 500;
      const width = Math.min(desiredWidth, Math.max(0, window.innerWidth - margin * 2));
      const left = Math.min(
        Math.max(margin, buttonRect.right - width),
        Math.max(margin, window.innerWidth - margin - width),
      );
      const availableAbove = Math.max(80, buttonRect.top - gap - margin);
      const maxHeight = Math.min(narrow ? 520 : 430, availableAbove);

      modelPicker.style.left = Math.round(left) + "px";
      modelPicker.style.right = "auto";
      modelPicker.style.bottom = Math.round(window.innerHeight - buttonRect.top + gap) + "px";
      modelPicker.style.width = Math.round(width) + "px";
      modelPicker.style.maxHeight = Math.round(maxHeight) + "px";
    }

    function openModelPicker() {
      closeAddMenu();
      modelPicker.hidden = false;
      modelButton.setAttribute("aria-expanded", "true");
      renderModelList();
      renderModelOptions();
      positionModelPicker();
      modelSearch.focus();
      modelSearch.select();
    }

    function closeModelPicker() {
      modelPicker.hidden = true;
      modelButton.setAttribute("aria-expanded", "false");
      modelSearch.value = "";
    }

    function relTime(ts) {
      const seconds = (Date.now() - ts) / 1000;
      if (seconds < 60) return i18n.justNow;
      const minutes = seconds / 60;
      if (minutes < 60) return Math.floor(minutes) + i18n.minutesAgo;
      const hours = minutes / 60;
      if (hours < 24) return Math.floor(hours) + i18n.hoursAgo;
      const days = hours / 24;
      if (days < 2) return i18n.yesterday;
      if (days < 7) return Math.floor(days) + i18n.daysAgo;
      return new Date(ts).toLocaleDateString();
    }

    function formatTokens(value) {
      const amount = Number(value) || 0;
      if (amount >= 1000000) {
        return (amount / 1000000).toFixed(amount >= 10000000 ? 0 : 1) + "M";
      }
      if (amount >= 1000) {
        return (amount / 1000).toFixed(amount >= 10000 ? 0 : 1) + "k";
      }
      return String(Math.round(amount));
    }

    function renderUsagePanel() {
      if (!usageSummary) {
        usagePanel.hidden = true;
        return;
      }
      usagePanel.hidden = false;
      usageTodayTotal.textContent = formatTokens(usageSummary.today.total);
      usageWeekTotal.textContent = formatTokens(usageSummary.last7Days.total);
      usageChatTotal.textContent = formatTokens(usageSummary.last7Days.chat);
      usageSupervisorTotal.textContent = formatTokens(usageSummary.last7Days.supervisor);
      usageConversationTotal.textContent = formatTokens(usageSummary.conversationTotal);
    }

    function renderExperiments() {
      experimentList.innerHTML = "";
      experimentsPanel.hidden = bestOfNExperiments.length === 0 || !comparePanel.hidden;
      for (const experiment of bestOfNExperiments) {
        const row = document.createElement("div");
        row.className = "task-row";
        const title = document.createElement("span");
        title.className = "task-title";
        title.textContent = experiment.prompt.split("\\n")[0] || experiment.id;
        const meta = document.createElement("span");
        meta.className = "task-meta";
        meta.textContent = experiment.candidateCount + " · " + relTime(experiment.createdAt);
        const actions = document.createElement("span");
        actions.className = "task-actions";
        const compare = document.createElement("button");
        compare.className = "task-action";
        compare.type = "button";
        compare.textContent = "⇄";
        compare.title = i18n.compareRuns;
        compare.addEventListener("click", (event) => {
          event.stopPropagation();
          vscode.postMessage({ type: "compareBestOfN", id: experiment.id });
        });
        actions.appendChild(compare);
        row.append(title, meta, actions);
        row.addEventListener("click", () => {
          vscode.postMessage({ type: "compareBestOfN", id: experiment.id });
        });
        experimentList.appendChild(row);
      }
    }

    function renderCompare(experiment) {
      if (!experiment) {
        comparePanel.hidden = true;
        renderExperiments();
        return;
      }
      comparePanel.hidden = false;
      experimentsPanel.hidden = true;
      comparePrompt.textContent = experiment.prompt;
      compareGrid.innerHTML = "";
      for (const candidate of experiment.candidates || []) {
        const card = document.createElement("div");
        card.className = "compare-card" + (candidate.isWinner ? " winner" : "");
        const heading = document.createElement("div");
        heading.className = "compare-card-title";
        heading.textContent = (candidate.isWinner ? "★ " : "") + candidate.title
          + (candidate.running ? " · " + i18n.running : "")
          + (candidate.totalTokens ? " · " + formatTokens(candidate.totalTokens) : "");
        const body = document.createElement("div");
        body.className = "compare-card-body";
        body.textContent = candidate.lastAssistant || i18n.noAssistantYet;
        const actions = document.createElement("div");
        actions.className = "compare-card-actions";
        const open = document.createElement("button");
        open.type = "button";
        open.textContent = i18n.openCandidate;
        open.addEventListener("click", () => {
          vscode.postMessage({ type: "openConversation", id: candidate.id });
        });
        actions.appendChild(open);
        if (!candidate.running) {
          const winner = document.createElement("button");
          winner.type = "button";
          winner.textContent = i18n.pickWinner;
          winner.addEventListener("click", () => {
            vscode.postMessage({ type: "pickBestOfNWinner", id: candidate.id });
          });
          actions.appendChild(winner);
        }
        card.append(heading, body, actions);
        compareGrid.appendChild(card);
      }
    }

    function requestContextPreview() {
      clearTimeout(contextEstimateTimer);
      contextEstimateTimer = setTimeout(() => {
        const consumed = consumeLeadingSlashCommand(prompt.value.trim());
        vscode.postMessage({
          type: "estimateContext",
          prompt: consumed.text || prompt.value,
          profile: consumed.profile || runProfile,
          includeProjectMemory,
          attachContext: attach,
          path: ctxLabel.textContent || undefined,
          files: selectedFiles.map((file) => file.path),
          skills: selectedSkills.slice(),
          commandId: consumed.commandId,
        });
      }, 160);
    }

    function renderContextPreview(chips) {
      contextPreviewRow.innerHTML = "";
      if (!chips || chips.length === 0) {
        contextPreviewRow.hidden = true;
        return;
      }
      contextPreviewRow.hidden = false;
      for (const chip of chips) {
        const node = document.createElement("span");
        node.className = "preview-chip";
        node.textContent = chip.label;
        contextPreviewRow.appendChild(node);
      }
    }

    function renderTasks() {
      taskList.innerHTML = "";
      const searching = conversationSearchQuery.trim().length > 0;
      tasks.hidden = allConversations.length === 0 && !searching;
      taskEmpty.hidden = allConversations.length > 0 || !searching;
      const items = tasksExpanded ? allConversations : allConversations.slice(0, 5);
      for (const conv of items) {
        const row = document.createElement("div");
        row.className = "task-row"
          + (conv.running ? " running" : "")
          + (conv.pinned ? " pinned" : "");
        row.title = conv.title;

        const title = document.createElement("span");
        title.className = "task-title";
        title.textContent = conv.title;

        const meta = document.createElement("span");
        meta.className = "task-meta";
        const tokens = document.createElement("span");
        tokens.className = "task-tokens";
        if (conv.totalTokens > 0) {
          tokens.textContent = formatTokens(conv.totalTokens);
          tokens.title = formatTokens(conv.totalTokens) + " " + i18n.tokensLabel;
        }
        const time = document.createElement("span");
        time.className = "task-time";
        time.textContent = conv.running
          ? "● " + i18n.running
          : conv.queued
            ? "◷ " + i18n.queuedTask
            : relTime(conv.updatedAt);
        meta.append(tokens, time);

        const actions = document.createElement("span");
        actions.className = "task-actions";

        const pin = document.createElement("button");
        pin.className = "task-action";
        pin.type = "button";
        pin.textContent = conv.pinned ? "★" : "☆";
        pin.title = conv.pinned ? i18n.unpinConversation : i18n.pinConversation;
        pin.addEventListener("click", (event) => {
          event.stopPropagation();
          vscode.postMessage({ type: "pinConversation", id: conv.id, pinned: !conv.pinned });
        });

        const exp = document.createElement("button");
        exp.className = "task-action";
        exp.type = "button";
        exp.textContent = "⇪";
        exp.title = i18n.exportConversation;
        exp.addEventListener("click", (event) => {
          event.stopPropagation();
          vscode.postMessage({ type: "exportConversation", id: conv.id, format: "markdown" });
        });

        const del = document.createElement("button");
        del.className = "task-action task-delete";
        del.type = "button";
        del.textContent = "×";
        del.title = i18n.deleteConversation;
        del.addEventListener("click", (event) => {
          event.stopPropagation();
          vscode.postMessage({ type: "deleteConversation", id: conv.id });
        });

        if (conv.experimentGroupId && !conv.running) {
          const winner = document.createElement("button");
          winner.className = "task-action";
          winner.type = "button";
          winner.textContent = "✓";
          winner.title = i18n.pickWinner;
          winner.addEventListener("click", (event) => {
            event.stopPropagation();
            vscode.postMessage({ type: "pickBestOfNWinner", id: conv.id });
          });
          actions.appendChild(winner);
        }
        actions.append(pin, exp, del);
        row.append(title, meta, actions);
        row.addEventListener("click", () => vscode.postMessage({ type: "openConversation", id: conv.id }));
        taskList.appendChild(row);
      }
      viewAll.hidden = tasksExpanded || allConversations.length <= 5;
      viewAll.textContent = i18n.showAll + " (" + allConversations.length + ")";
    }

    function renderParallelBar() {
      parallelBar.hidden = parallelTasks.length === 0;
      parallelBarTitle.textContent = i18n.parallelAgents;
      parallelBarCount.textContent = activeChatRuns + "/" + maximumChatRuns;
      startParallelAgentButton.hidden = activeChatRuns === 0;
      startParallelAgentButton.disabled = activeChatRuns >= maximumChatRuns;
      startParallelAgentButton.title = startParallelAgentButton.disabled
        ? i18n.parallelLimitReached + " (" + activeChatRuns + "/" + maximumChatRuns + ")"
        : i18n.launchParallelAgent;
      parallelTaskList.innerHTML = "";

      for (const task of parallelTasks) {
        const chip = document.createElement("div");
        chip.className = "parallel-task " + task.status + (task.active ? " active" : "");

        const main = document.createElement("button");
        main.className = "parallel-task-main";
        main.type = "button";
        main.title = i18n.switchTask + ": " + task.title;
        main.setAttribute("aria-label", main.title);

        const taskStatus = document.createElement("span");
        taskStatus.className = "parallel-task-status";
        const taskStatusLabel = task.status === "running"
          ? i18n.running
          : task.status === "queued"
            ? i18n.queuedTask
            : task.status === "error"
              ? i18n.failedTask
              : task.status === "stopped"
                ? i18n.stoppedTask
                : i18n.completedTask;
        taskStatus.title = taskStatusLabel;
        if (task.status === "running") {
          const spinner = document.createElement("span");
          spinner.className = "running-spinner";
          taskStatus.appendChild(spinner);
        } else if (task.status === "queued") {
          taskStatus.textContent = "◷";
        } else if (task.status === "error") {
          taskStatus.textContent = "!";
        } else if (task.status === "stopped") {
          taskStatus.textContent = "■";
        } else {
          taskStatus.textContent = "✓";
        }

        const title = document.createElement("span");
        title.className = "parallel-task-title";
        title.textContent = task.title;

        main.append(taskStatus, title);
        if (Number(task.queueCount) > 0) {
          const queued = document.createElement("span");
          queued.className = "parallel-task-queue-count";
          queued.textContent = "+" + task.queueCount;
          queued.title = task.queueCount + " " + i18n.queuedTask;
          main.appendChild(queued);
        }
        main.addEventListener("click", () => {
          vscode.postMessage({ type: "openConversation", id: task.id });
        });

        chip.appendChild(main);
        if (task.status === "running" || task.status === "queued") {
          const stop = document.createElement("button");
          stop.className = "parallel-task-stop";
          stop.type = "button";
          stop.textContent = "×";
          stop.title = task.status === "running" ? i18n.stopTask : i18n.removeQueuedTask;
          stop.setAttribute("aria-label", stop.title + ": " + task.title);
          stop.addEventListener("click", (event) => {
            event.stopPropagation();
            vscode.postMessage({ type: "cancelConversation", id: task.id });
          });
          chip.appendChild(stop);
        }
        parallelTaskList.appendChild(chip);
      }
    }

    function clearMessages() {
      messages.innerHTML = "";
      assistantNode = undefined;
      assistantRaw = "";
      activeProgress = undefined;
      followOutput = true;
      scroller.scrollTop = 0;
    }

    function showHome(convs, query) {
      view = "home";
      setRunningState(false);
      if (convs) {
        allConversations = convs;
        tasksExpanded = false;
      }
      if (typeof query === "string" && taskSearch.value !== query) {
        conversationSearchQuery = query;
        taskSearch.value = query;
      }
      clearMessages();
      home.style.display = "flex";
      messages.style.display = "none";
      renderUsagePanel();
      renderExperiments();
      renderTasks();
    }

    function showChat() {
      view = "chat";
      home.style.display = "none";
      messages.style.display = "flex";
    }

    function setRunningState(value) {
      running = value;
      if (value) {
        startRunningSound();
        runningIndicator.hidden = false;
        sendButton.classList.add("running");
        sendButton.title = i18n.stop;
        runningActions.hidden = false;
        status.textContent = i18n.running + "…"
          + (activeChatRuns > 1 ? " · " + activeChatRuns + " " + i18n.activeAgents : "");
      } else {
        stopRunningSound();
        runningIndicator.hidden = true;
        sendButton.classList.remove("running");
        sendButton.title = i18n.send;
        runningActions.hidden = true;
        status.textContent = sandboxUnavailable
          ? sandboxStatusForMode(approvalSelect.value)
          : i18n.connected;
      }
    }

    function setAttach(value) {
      attach = value;
      updateProfileChip();
      editorChip.hidden = !attach;
      if (attach) vscode.postMessage({ type: "getContext" });
      requestContextPreview();
    }

    function setIncludeProjectMemory(value) {
      includeProjectMemory = value;
      memoryChip.setAttribute("aria-pressed", String(value));
      memoryChip.title = value ? i18n.projectMemoryOn : i18n.projectMemoryOff;
      memoryChipLabel.textContent = i18n.projectMemory;
    }

    function setApprovalMode(mode) {
      approvalSelect.value = mode;
      // On platforms without a local sandbox, isolation is never available
      // regardless of the selected mode, so keep the warning state sticky.
      sandboxUnavailable = !sandboxSupported;
      const descriptions = {
        "safe-worktree": i18n.safeWorktreeDescription,
        "auto-review": i18n.autoReviewDescription,
        "full-access": i18n.fullAccessDescription,
      };
      approvalSelect.title = descriptions[mode] || i18n.approvalMode;
      updateSandboxBanner();
      if (!running && !sandboxSupported) {
        status.textContent = sandboxStatusForMode(mode);
      }
    }

    function sandboxStatusForMode(mode) {
      if (mode === "safe-worktree") return i18n.safeModeStatus;
      if (mode === "full-access") return i18n.fullAccessStatus;
      return i18n.sandboxUnavailable;
    }

    function updateSandboxBanner() {
      if (!sandboxBanner) return;
      sandboxBanner.hidden = sandboxSupported;
      if (sandboxBannerText) {
        sandboxBannerText.textContent = approvalSelect.value === "safe-worktree"
          ? i18n.sandboxBannerSafeText
          : i18n.sandboxBannerDirectText;
      }
    }

    function updateContextChip(label) {
      if (label) {
        ctxLabel.textContent = label;
        ctxLabel.classList.remove("none");
      } else {
        ctxLabel.textContent = i18n.noActiveFile;
        ctxLabel.classList.add("none");
      }
    }

    function activeMention() {
      const caret = prompt.selectionStart;
      const beforeCaret = prompt.value.slice(0, caret);
      const match = /(^|\\s)@([^\\s@]*)$/.exec(beforeCaret);
      if (!match) return undefined;
      return {
        start: caret - match[2].length - 1,
        end: caret,
        query: match[2],
      };
    }

    function activeSlashCommand() {
      const caret = prompt.selectionStart;
      const beforeCaret = prompt.value.slice(0, caret);
      const match = /(^|\\s)\\/([\\w-]*)$/.exec(beforeCaret);
      if (!match) return undefined;
      return {
        start: caret - match[2].length - 1,
        end: caret,
        query: match[2].toLowerCase(),
      };
    }

    function closeFilePicker() {
      filePicker.hidden = true;
      filePicker.innerHTML = "";
      fileResults = [];
      selectedFileIndex = 0;
      mentionRange = undefined;
    }

    function closeSlashPicker() {
      slashPicker.hidden = true;
      slashPicker.innerHTML = "";
      slashResults = [];
      selectedSlashIndex = 0;
      slashRange = undefined;
    }

    function requestFileResults() {
      const mention = activeMention();
      if (!mention) {
        closeFilePicker();
        return;
      }
      closeSlashPicker();
      mentionRange = mention;
      selectedFileIndex = 0;
      fileRequestId += 1;
      vscode.postMessage({
        type: "searchFiles",
        query: mention.query,
        requestId: fileRequestId,
      });
    }

    function requestSlashResults() {
      if (activeMention()) {
        closeSlashPicker();
        return;
      }
      const slash = activeSlashCommand();
      if (!slash) {
        closeSlashPicker();
        return;
      }
      closeFilePicker();
      slashRange = slash;
      slashResults = slashCommands().filter((command) =>
        command.aliases.some((alias) => alias.startsWith(slash.query))
          || command.label.toLowerCase().startsWith(slash.query),
      );
      selectedSlashIndex = 0;
      renderSlashResults();
    }

    function renderSlashResults() {
      slashPicker.innerHTML = "";
      if (slashResults.length === 0) {
        const empty = document.createElement("div");
        empty.className = "file-empty";
        empty.textContent = i18n.noMatchingCommands;
        slashPicker.appendChild(empty);
        slashPicker.hidden = false;
        return;
      }

      selectedSlashIndex = Math.max(0, Math.min(selectedSlashIndex, slashResults.length - 1));
      slashResults.forEach((command, index) => {
        const row = document.createElement("button");
        row.className = "file-result" + (index === selectedSlashIndex ? " selected" : "");
        row.type = "button";
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", index === selectedSlashIndex ? "true" : "false");
        row.title = "/" + command.id;

        const icon = document.createElement("span");
        icon.textContent = command.icon;
        const label = document.createElement("span");
        label.className = "file-result-label";
        label.textContent = "/" + command.id;
        const description = document.createElement("span");
        description.className = "file-result-path";
        description.textContent = command.description;
        row.append(icon, label, description);
        row.addEventListener("mousedown", (event) => event.preventDefault());
        row.addEventListener("click", () => selectSlashCommand(command));
        slashPicker.appendChild(row);
      });
      slashPicker.hidden = false;
      slashPicker.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
    }

    function selectSlashCommand(command) {
      if (command.bestOfN) {
        const before = slashRange ? prompt.value.slice(0, slashRange.start) : "";
        const after = slashRange ? prompt.value.slice(slashRange.end) : prompt.value;
        prompt.value = before + "/compare " + after.replace(/^\\s+/, "");
        const caret = before.length + "/compare ".length;
        prompt.selectionStart = prompt.selectionEnd = caret;
        closeSlashPicker();
        autoGrow();
        prompt.focus();
        return;
      }
      if (command.commandId) {
        const before = slashRange ? prompt.value.slice(0, slashRange.start) : "";
        const after = slashRange ? prompt.value.slice(slashRange.end) : prompt.value;
        prompt.value = before + "/" + command.commandId + " " + after.replace(/^\\s+/, "");
        const caret = before.length + command.commandId.length + 2;
        prompt.selectionStart = prompt.selectionEnd = caret;
        closeSlashPicker();
        autoGrow();
        prompt.focus();
        return;
      }
      if (slashRange) {
        prompt.value = prompt.value.slice(0, slashRange.start) + prompt.value.slice(slashRange.end);
        prompt.selectionStart = prompt.selectionEnd = slashRange.start;
      }
      selectRunProfile(command.profile);
      closeSlashPicker();
      autoGrow();
      prompt.focus();
    }

    function updateComposerSuggestions() {
      if (activeMention()) {
        requestFileResults();
        return;
      }
      closeFilePicker();
      requestSlashResults();
    }

    function renderFileResults() {
      filePicker.innerHTML = "";
      if (fileResults.length === 0) {
        const empty = document.createElement("div");
        empty.className = "file-empty";
        empty.textContent = i18n.noMatchingFiles;
        filePicker.appendChild(empty);
        filePicker.hidden = false;
        return;
      }

      selectedFileIndex = Math.max(0, Math.min(selectedFileIndex, fileResults.length - 1));
      fileResults.forEach((file, index) => {
        const row = document.createElement("button");
        row.className = "file-result" + (index === selectedFileIndex ? " selected" : "");
        row.type = "button";
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", index === selectedFileIndex ? "true" : "false");
        row.title = file.path;

        const icon = document.createElement("span");
        icon.textContent = "@";
        const label = document.createElement("span");
        label.className = "file-result-label";
        label.textContent = file.label;
        const directory = document.createElement("span");
        directory.className = "file-result-path";
        directory.textContent = file.description;
        row.append(icon, label, directory);
        row.addEventListener("mousedown", (event) => event.preventDefault());
        row.addEventListener("click", () => selectFile(file));
        filePicker.appendChild(row);
      });
      filePicker.hidden = false;
      filePicker.querySelector(".selected")?.scrollIntoView({ block: "nearest" });
    }

    function selectFile(file) {
      if (!selectedFiles.some((selected) => selected.path === file.path)) {
        selectedFiles.push(file);
      }
      if (mentionRange) {
        prompt.value = prompt.value.slice(0, mentionRange.start) + prompt.value.slice(mentionRange.end);
        prompt.selectionStart = prompt.selectionEnd = mentionRange.start;
      }
      renderMentionChips();
      closeFilePicker();
      autoGrow();
      prompt.focus();
    }

    function removeSelectedFile(filePath) {
      selectedFiles = selectedFiles.filter((file) => file.path !== filePath);
      renderMentionChips();
      prompt.focus();
    }

    function renderMentionChips() {
      mentionRow.innerHTML = "";
      mentionRow.hidden = selectedFiles.length === 0;
      for (const file of selectedFiles) {
        const chip = document.createElement("span");
        chip.className = "mention-chip";
        chip.title = file.path;

        const label = document.createElement("span");
        label.className = "mention-chip-label";
        label.textContent = "@" + file.path;
        const remove = document.createElement("button");
        remove.className = "mention-remove";
        remove.type = "button";
        remove.textContent = "×";
        remove.title = i18n.removeReference;
        remove.addEventListener("click", () => removeSelectedFile(file.path));
        chip.append(label, remove);
        mentionRow.appendChild(chip);
      }
      requestContextPreview();
    }

    function addTransferValue(references, value) {
      if (!value) return;
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            if (typeof entry === "string") references.push(entry);
          }
          return;
        }
      } catch {
        // URI lists and absolute paths are commonly plain text rather than JSON.
      }
      for (const entry of value.split(/\\r?\\n/)) {
        const trimmed = entry.trim();
        if (trimmed && !trimmed.startsWith("#")) references.push(trimmed);
      }
    }

    function isUriTransferType(type) {
      const lower = String(type || "").toLowerCase();
      return lower.includes("uri-list")
        || lower === "codefiles"
        || lower === "resourceurls"
        || lower.includes("code.uri");
    }

    function isFileDrag(transfer) {
      if (!transfer) return false;
      const types = Array.from(transfer.types || []).map((type) => String(type).toLowerCase());
      return (transfer.files?.length || 0) > 0
        || Array.from(transfer.items || []).some((item) => item.kind === "file")
        || types.includes("files")
        || types.some(isUriTransferType);
    }

    function transferredFiles(transfer) {
      const files = [];
      const seen = new Set();
      const addFile = (file) => {
        if (!file) return;
        const key = [file.name, file.type, file.size, file.lastModified].join("\\n");
        if (seen.has(key)) return;
        seen.add(key);
        files.push(file);
      };
      for (const file of Array.from(transfer?.files || [])) addFile(file);
      for (const item of Array.from(transfer?.items || [])) {
        if (item.kind === "file") addFile(item.getAsFile());
      }
      return files;
    }

    function transferFileReferences(transfer, includePlainText) {
      const references = [];
      if (!transfer) return references;

      for (const file of transferredFiles(transfer)) {
        const filePath = file.path || file.webkitRelativePath;
        if (filePath) references.push(filePath);
      }

      const types = Array.from(transfer.types || []);
      const tried = new Set();
      for (const type of types) {
        if (!isUriTransferType(type)) continue;
        addTransferValue(references, transfer.getData(type));
        tried.add(type.toLowerCase());
      }

      // Some hosts omit MIME types from \`types\` even when getData still works on drop.
      for (const type of [
        "text/uri-list",
        "application/vnd.code.uri-list",
        "CodeFiles",
        "ResourceURLs",
        "codefiles",
        "resourceurls",
      ]) {
        if (tried.has(type.toLowerCase())) continue;
        try {
          const data = transfer.getData(type);
          if (data) addTransferValue(references, data);
        } catch {
          // Unsupported MIME types throw in some webview hosts.
        }
      }

      if (includePlainText && references.length === 0) {
        const plain = transfer.getData("text/plain").trim();
        if (
          plain.toLowerCase().startsWith("file:")
          || /^[a-zA-Z]:[\\\\/]/.test(plain)
          || /[\\\\/]/.test(plain)
        ) {
          addTransferValue(references, plain);
        }
      }
      return [...new Set(references)];
    }

    function fallbackFileName(file, index) {
      const original = String(file.name || "").trim();
      if (original) return original;
      const extension = {
        "image/avif": "avif",
        "image/bmp": "bmp",
        "image/gif": "gif",
        "image/heic": "heic",
        "image/heif": "heif",
        "image/jfif": "jfif",
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/svg+xml": "svg",
        "image/tiff": "tiff",
        "image/webp": "webp",
        "image/x-icon": "ico",
      }[String(file.type || "").toLowerCase()] || "bin";
      return "clipboard-image-" + String(index + 1) + "." + extension;
    }

    async function transferFileUploads(transfer) {
      const uploads = [];
      const files = transferredFiles(transfer).slice(0, 20);
      for (const [index, file] of files.entries()) {
        if (file.path || file.webkitRelativePath) continue;
        if (file.size > ${MAX_DROPPED_FILE_BYTES}) continue;
        try {
          uploads.push({
            name: fallbackFileName(file, index),
            data: new Uint8Array(await file.arrayBuffer()),
          });
        } catch {
          // The host may expose metadata without allowing the file contents to be read.
        }
      }
      return uploads;
    }

    function setDragActive(active) {
      composerCard.classList.toggle("drag-active", active);
    }

    async function resolveTransferredFiles(transfer, includePlainText, failureText) {
      const references = transferFileReferences(transfer, includePlainText);
      const uploads = references.length === 0
        ? await transferFileUploads(transfer)
        : [];
      if (references.length === 0 && uploads.length === 0) {
        status.textContent = failureText;
        return;
      }
      attachmentRequestId += 1;
      vscode.postMessage({
        type: "resolveAttachments",
        requestId: attachmentRequestId,
        references,
        uploads,
      });
    }

    function isNearBottom() {
      return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 48;
    }

    function scrollToBottom(force = false) {
      if (!force && !followOutput) return;
      followOutput = true;
      scroller.scrollTop = scroller.scrollHeight;
    }

    function indexedFileReference(raw) {
      const location = /(:\\d+(?::\\d+)?)$/.exec(raw);
      const suffix = location ? location[1] : "";
      let filePart = suffix ? raw.slice(0, -suffix.length) : raw;

      while (filePart) {
        const normalized = filePart.replaceAll("\\\\", "/").replace(/^\\.\\//, "");
        const lower = normalized.toLowerCase();
        const hasDirectory = normalized.includes("/");
        if (workspacePaths.has(lower) || (!hasDirectory && workspaceBasenames.has(lower))) {
          return {
            display: filePart + suffix,
            reference: normalized + suffix,
          };
        }
        if (!filePart.endsWith(".")) break;
        filePart = filePart.slice(0, -1);
      }
      return undefined;
    }

    function linkifyWorkspaceFiles(root) {
      if (workspacePaths.size === 0) return;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const textNodes = [];
      while (walker.nextNode()) {
        const parent = walker.currentNode.parentElement;
        if (!parent || parent.closest("a, pre, button, .files, .user-attachments, .copy-btn")) continue;
        textNodes.push(walker.currentNode);
      }

      const fileToken = /[\\p{L}\\p{N}_.@+\\\\/-]+(?::\\d+(?::\\d+)?)?/gu;
      for (const textNode of textNodes) {
        const text = textNode.nodeValue || "";
        const fragment = document.createDocumentFragment();
        let lastIndex = 0;
        let linked = false;
        fileToken.lastIndex = 0;
        for (const match of text.matchAll(fileToken)) {
          const resolved = indexedFileReference(match[0]);
          if (!resolved || match.index === undefined) continue;
          const start = match.index;
          const end = start + resolved.display.length;
          fragment.appendChild(document.createTextNode(text.slice(lastIndex, start)));
          const link = document.createElement("a");
          link.href = "#";
          link.className = "workspace-file-link";
          link.dataset.workspaceFile = resolved.reference;
          link.title = i18n.openFile + ": " + resolved.reference;
          link.textContent = resolved.display;
          fragment.appendChild(link);
          lastIndex = end;
          linked = true;
        }
        if (linked) {
          fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
          textNode.parentNode?.replaceChild(fragment, textNode);
        }
      }
    }

    const COPY_SVG = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="7" height="8" rx="1"/><path d="M10.5 5.5V4.5a1 1 0 0 0-1-1h-5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h1"/></svg>';

    function createCopyButton(kind, label) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "copy-btn " + (kind === "code" ? "code-copy" : "message-copy");
      btn.dataset.copy = kind;
      btn.setAttribute("aria-label", label);
      btn.title = label;
      btn.innerHTML = COPY_SVG;
      return btn;
    }

    function messageBody(messageNode) {
      let body = messageNode.querySelector(":scope > .message-body");
      if (!body) {
        body = document.createElement("div");
        body.className = "message-body";
        const copyBtn = messageNode.querySelector(":scope > .message-copy");
        if (copyBtn) {
          copyBtn.before(body);
        } else {
          messageNode.appendChild(body);
        }
      }
      return body;
    }

    function ensureMessageCopy(messageNode) {
      if (messageNode.querySelector(":scope > .message-copy")) return;
      messageNode.appendChild(createCopyButton("message", i18n.copyMessage));
    }

    function enhanceCodeBlocks(root) {
      for (const pre of root.querySelectorAll("pre")) {
        if (pre.parentElement?.classList.contains("code-block")) continue;
        const wrap = document.createElement("div");
        wrap.className = "code-block";
        pre.replaceWith(wrap);
        wrap.append(createCopyButton("code", i18n.copyCode), pre);
      }
    }

    async function writeClipboard(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.cssText = "position:fixed;left:-9999px;top:0";
        document.body.appendChild(ta);
        ta.select();
        let ok = false;
        try {
          ok = document.execCommand("copy");
        } catch {
          ok = false;
        }
        ta.remove();
        return ok;
      }
    }

    function flashCopied(btn) {
      const prevLabel = btn.getAttribute("aria-label") || "";
      btn.classList.add("copied");
      btn.setAttribute("aria-label", i18n.copied);
      btn.title = i18n.copied;
      clearTimeout(btn._copyTimer);
      btn._copyTimer = setTimeout(() => {
        btn.classList.remove("copied");
        btn.setAttribute("aria-label", prevLabel);
        btn.title = prevLabel;
      }, 1200);
    }

    function copyTextForButton(btn) {
      if (btn.dataset.copy === "code") {
        return btn.closest(".code-block")?.querySelector("pre")?.innerText ?? "";
      }
      const message = btn.closest(".message");
      const body = message?.querySelector(":scope > .message-body");
      return body?.innerText?.trim() ?? "";
    }

    function renderMarkdown(messageNode, raw) {
      const body = messageBody(messageNode);
      body.innerHTML = DOMPurify.sanitize(marked.parse(raw));
      linkifyWorkspaceFiles(body);
      enhanceCodeBlocks(body);
      ensureMessageCopy(messageNode);
    }

    function addUserMessage(text, attachments = []) {
      const node = document.createElement("div");
      node.className = "message user";
      const body = document.createElement("div");
      body.className = "message-body";
      body.textContent = text;
      node.appendChild(body);
      linkifyWorkspaceFiles(body);
      if (attachments.length > 0) {
        const attachmentsNode = document.createElement("div");
        attachmentsNode.className = "user-attachments";
        for (const file of attachments) {
          const chip = document.createElement("button");
          chip.className = "user-attachment";
          chip.type = "button";
          chip.textContent = "@" + (file.label || file.path);
          chip.title = i18n.openFile + ": " + file.path;
          chip.addEventListener("click", () => vscode.postMessage({ type: "openFile", path: file.path }));
          attachmentsNode.appendChild(chip);
        }
        node.appendChild(attachmentsNode);
      }
      ensureMessageCopy(node);
      messages.appendChild(node);
      scrollToBottom();
      return node;
    }

    function progressSummary(state, count) {
      const label = state === "running"
        ? i18n.progressRunning
        : state === "stopped"
          ? i18n.progressStopped
          : state === "error"
            ? i18n.progressFailed
            : i18n.progressCompleted;
      return count > 0 ? label + " · " + count + " " + i18n.progressStep : label;
    }

    function setProgressRow(panel, step) {
      panel.empty?.remove();
      panel.empty = undefined;
      let row = panel.rows.get(step.id);
      if (!row) {
        const node = document.createElement("div");
        const statusNode = document.createElement("span");
        statusNode.className = "progress-status";
        const textNode = document.createElement("span");
        textNode.className = "progress-text";
        node.append(statusNode, textNode);
        panel.list.appendChild(node);
        row = { node, statusNode, textNode };
        panel.rows.set(step.id, row);
      }
      row.node.className = "progress-item " + step.status;
      row.statusNode.textContent = step.status === "completed"
        ? "✓"
        : step.status === "error" ? "!" : step.status === "stopped" ? "■" : "";
      row.textNode.textContent = step.text;
      panel.summaryText.textContent = progressSummary(panel.state, panel.rows.size);
    }

    function createProgressPanel(steps = [], state = "running") {
      const node = document.createElement("details");
      node.className = "chat-progress" + (state === "running" ? " running" : "");
      node.open = state === "running" || state === "error" || state === "stopped";
      const summary = document.createElement("summary");
      const spinner = document.createElement("span");
      spinner.className = "progress-spinner";
      spinner.setAttribute("aria-hidden", "true");
      const summaryText = document.createElement("span");
      summaryText.textContent = progressSummary(state, steps.length);
      summary.append(spinner, summaryText);
      const list = document.createElement("div");
      list.className = "progress-list";
      const panel = { node, summaryText, list, rows: new Map(), state, empty: undefined };
      node.append(summary, list);
      if (steps.length === 0) {
        const empty = document.createElement("div");
        empty.className = "progress-empty";
        empty.textContent = i18n.progressPreparing;
        list.appendChild(empty);
        panel.empty = empty;
      } else {
        for (const step of steps) setProgressRow(panel, step);
      }
      return panel;
    }

    function beginProgress() {
      if (view !== "chat" || !assistantNode) return;
      activeProgress = createProgressPanel();
      assistantNode.before(activeProgress.node);
      scrollToBottom();
    }

    function updateProgress(data) {
      if (view !== "chat") return;
      if (!activeProgress) beginProgress();
      if (!activeProgress) return;
      setProgressRow(activeProgress, {
        id: data.callId || data.text,
        text: data.text,
        status: data.status || "running",
      });
      scrollToBottom();
    }

    function finishProgress(state) {
      if (!activeProgress) return;
      activeProgress.state = state;
      activeProgress.node.classList.remove("running");
      for (const row of activeProgress.rows.values()) {
        if (row.node.classList.contains("running")) {
          row.node.className = "progress-item " + (state === "completed" ? "completed" : state);
          row.statusNode.textContent = state === "completed" ? "✓" : state === "stopped" ? "■" : "!";
        }
      }
      activeProgress.summaryText.textContent = progressSummary(state, activeProgress.rows.size);
      activeProgress.node.open = state !== "completed";
    }

    function addAssistantMessage(
      raw,
      isError = false,
      files = [],
      progress = [],
      progressState = "completed",
    ) {
      const node = document.createElement("div");
      node.className = "message assistant" + (isError ? " error" : "");
      if (raw) {
        renderMarkdown(node, raw);
      } else {
        messageBody(node);
        ensureMessageCopy(node);
      }
      if (progress.length > 0) {
        messages.appendChild(createProgressPanel(progress, progressState).node);
      }
      messages.appendChild(node);
      for (const file of files) addFileChip(node, file.path, file.label);
      scrollToBottom();
      return node;
    }

    function addFileChip(messageNode, filePath, label) {
      let filesNode = messageNode.nextElementSibling;
      if (!filesNode || !filesNode.classList.contains("files")) {
        filesNode = document.createElement("div");
        filesNode.className = "files";
        messageNode.after(filesNode);
      }
      const chip = document.createElement("button");
      chip.className = "file-chip";
      chip.type = "button";
      chip.textContent = label;
      chip.title = i18n.showDiff + ": " + filePath;
      chip.addEventListener("click", () => vscode.postMessage({ type: "openDiff", path: filePath }));
      filesNode.appendChild(chip);
    }

    function autoGrow() {
      prompt.style.height = "auto";
      prompt.style.height = Math.min(prompt.scrollHeight, 200) + "px";
    }

    function renderQueue() {
      queueRow.innerHTML = "";
      queueRow.hidden = queuedMessages.length === 0;
      if (queuedMessages.length === 0) return;

      const heading = document.createElement("div");
      heading.className = "queue-heading";
      heading.textContent = i18n.queuedMessages + " (" + queuedMessages.length + ")";
      queueRow.appendChild(heading);
      for (const item of queuedMessages) {
        const row = document.createElement("div");
        row.className = "queue-item " + (item.kind === "interrupt" ? "interrupt" : "queued");

        const kind = document.createElement("span");
        kind.className = "queue-kind";
        kind.textContent = item.kind === "interrupt" ? i18n.interruptQueued : i18n.queued;
        row.appendChild(kind);

        const text = document.createElement("span");
        text.className = "queue-text";
        text.textContent = item.prompt;
        text.title = item.prompt;
        row.appendChild(text);

        const remove = document.createElement("button");
        remove.className = "queue-remove";
        remove.type = "button";
        remove.textContent = "×";
        remove.title = i18n.removeQueued;
        remove.addEventListener("click", () => {
          vscode.postMessage({ type: "removeQueuedMessage", id: item.id });
        });
        row.appendChild(remove);
        queueRow.appendChild(row);
      }
    }

    function messagePayload(type, text, files, commandId) {
      return {
        type,
        prompt: text,
        attachContext: attach,
        files: files.map((file) => file.path),
        modelId: selectedModelId,
        modelParams: selectedModelDefinition()
          ? paramsForModel(selectedModelDefinition())
          : [],
        profile: runProfile,
        skills: selectedSkills.slice(),
        commandId,
        includeProjectMemory,
      };
    }

    function clearComposerMessage() {
      prompt.value = "";
      selectedFiles = [];
      renderMentionChips();
      closeFilePicker();
      closeSlashPicker();
      autoGrow();
    }

    function ensureRunningAudioContext() {
      if (runningAudioContext) return runningAudioContext;
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return undefined;
      runningAudioContext = new AudioContextClass();
      return runningAudioContext;
    }

    function primeRunningSound() {
      if (!runningSoundEnabled && !completionSoundEnabled && !errorSoundEnabled) return;
      const audio = ensureRunningAudioContext();
      if (audio?.state === "suspended") {
        void audio.resume().catch(() => {});
      }
    }

    function scheduleRunningSound(delay = 5000) {
      if (!running || !runningSoundEnabled || runningSoundTimer) return;
      runningSoundTimer = setTimeout(() => {
        runningSoundTimer = undefined;
        playRunningSound();
      }, delay);
    }

    function playRunningSound() {
      if (!running || !runningSoundEnabled) return;
      const audio = ensureRunningAudioContext();
      if (!audio) return;

      const playPulse = () => {
        if (!running || !runningSoundEnabled || audio.state !== "running") return;
        const now = audio.currentTime;
        const playTone = (frequency, start, duration, volume) => {
          const oscillator = audio.createOscillator();
          const gain = audio.createGain();
          const voice = { oscillator, gain };
          oscillator.type = "sine";
          oscillator.frequency.setValueAtTime(frequency, start);
          gain.gain.setValueAtTime(0.0001, start);
          gain.gain.exponentialRampToValueAtTime(volume, start + 0.16);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
          oscillator.connect(gain);
          gain.connect(audio.destination);
          oscillator.addEventListener("ended", () => {
            runningSoundVoices.delete(voice);
            oscillator.disconnect();
            gain.disconnect();
          }, { once: true });
          runningSoundVoices.add(voice);
          oscillator.start(start);
          oscillator.stop(start + duration + 0.01);
        };
        playTone(261.63, now, 0.5, 0.025);
        playTone(329.63, now + 0.16, 0.65, 0.019);
      };

      if (audio.state === "suspended") {
        void audio.resume().then(playPulse).catch(() => {});
      } else {
        playPulse();
      }
      scheduleRunningSound();
    }

    function startRunningSound() {
      if (!runningSoundEnabled) return;
      primeRunningSound();
      playRunningSound();
    }

    function stopRunningSound() {
      if (runningSoundTimer) {
        clearTimeout(runningSoundTimer);
        runningSoundTimer = undefined;
      }
      for (const voice of runningSoundVoices) {
        try {
          voice.oscillator.stop();
        } catch {
          // The oscillator may already have ended between iteration and stop().
        }
        voice.oscillator.disconnect();
        voice.gain.disconnect();
      }
      runningSoundVoices.clear();
    }

    function playCompletionSound() {
      if (!completionSoundEnabled) return;
      const audio = ensureRunningAudioContext();
      if (!audio) return;

      const playChime = () => {
        if (!completionSoundEnabled || audio.state !== "running") return;
        const now = audio.currentTime;
        const playTone = (frequency, start, duration, volume) => {
          const oscillator = audio.createOscillator();
          const gain = audio.createGain();
          oscillator.type = "sine";
          oscillator.frequency.setValueAtTime(frequency, start);
          gain.gain.setValueAtTime(0.0001, start);
          gain.gain.exponentialRampToValueAtTime(volume, start + 0.03);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
          oscillator.connect(gain);
          gain.connect(audio.destination);
          oscillator.addEventListener("ended", () => {
            oscillator.disconnect();
            gain.disconnect();
          }, { once: true });
          oscillator.start(start);
          oscillator.stop(start + duration + 0.01);
        };
        playTone(392, now, 0.3, 0.025);
        playTone(523.25, now + 0.14, 0.34, 0.022);
        playTone(659.25, now + 0.3, 0.4, 0.019);
      };

      if (audio.state === "suspended") {
        void audio.resume().then(playChime).catch(() => {});
      } else {
        playChime();
      }
    }

    function playErrorSound() {
      if (!errorSoundEnabled) return;
      const audio = ensureRunningAudioContext();
      if (!audio) return;

      const playAlert = () => {
        if (!errorSoundEnabled || audio.state !== "running") return;
        const now = audio.currentTime;
        const playTone = (frequency, start, duration, volume) => {
          const oscillator = audio.createOscillator();
          const gain = audio.createGain();
          oscillator.type = "sine";
          oscillator.frequency.setValueAtTime(frequency, start);
          gain.gain.setValueAtTime(0.0001, start);
          gain.gain.exponentialRampToValueAtTime(volume, start + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
          oscillator.connect(gain);
          gain.connect(audio.destination);
          oscillator.addEventListener("ended", () => {
            oscillator.disconnect();
            gain.disconnect();
          }, { once: true });
          oscillator.start(start);
          oscillator.stop(start + duration + 0.01);
        };
        playTone(415.3, now, 0.28, 0.028);
        playTone(311.13, now + 0.16, 0.3, 0.026);
        playTone(233.08, now + 0.34, 0.42, 0.024);
      };

      if (audio.state === "suspended") {
        void audio.resume().then(playAlert).catch(() => {});
      } else {
        playAlert();
      }
    }

    document.addEventListener("pointerdown", primeRunningSound, { once: true });
    document.addEventListener("keydown", primeRunningSound, { once: true });
    scroller.addEventListener("scroll", () => {
      followOutput = isNearBottom();
    }, { passive: true });

    function submitMessage(action = "send") {
      const consumed = consumeLeadingSlashCommand(prompt.value.trim());
      if (consumed.profile) {
        runProfile = consumed.profile;
        updateProfileChip();
      }
      const text = consumed.text;
      if (!text && !consumed.commandId) {
        if (consumed.profile) {
          prompt.value = "";
          closeSlashPicker();
          autoGrow();
        }
        return;
      }
      const files = selectedFiles.slice();
      const displayText = consumed.bestOfN
        ? (text ? "/compare " + text : "/compare")
        : consumed.commandId
          ? (text ? "/" + consumed.commandId + " " + text : "/" + consumed.commandId)
          : text;

      if (consumed.bestOfN) {
        if (!text) {
          return;
        }
        showChat();
        followOutput = true;
        addUserMessage(displayText, files);
        assistantRaw = "";
        assistantNode = addAssistantMessage("");
        clearComposerMessage();
        primeRunningSound();
        vscode.postMessage(messagePayload("startBestOfN", text, files));
        return;
      }

      if (running) {
        const type = action === "interrupt" ? "interruptMessage" : "queueMessage";
        clearComposerMessage();
        vscode.postMessage(messagePayload(type, text, files, consumed.commandId));
        prompt.focus();
        return;
      }

      showChat();
      followOutput = true;
      addUserMessage(displayText, files);
      assistantRaw = "";
      assistantNode = addAssistantMessage("");
      clearComposerMessage();
      primeRunningSound();
      vscode.postMessage(messagePayload("send", text, files, consumed.commandId));
    }

    sendButton.addEventListener("click", () => {
      if (running) {
        vscode.postMessage({ type: "cancel" });
      } else {
        submitMessage();
      }
    });
    queueButton.addEventListener("click", () => submitMessage("queue"));
    interruptButton.addEventListener("click", () => submitMessage("interrupt"));
    newChatButton.addEventListener("click", () => vscode.postMessage({ type: "newChat" }));
    startParallelAgentButton.addEventListener("click", () => {
      if (!startParallelAgentButton.disabled) {
        vscode.postMessage({ type: "newChat" });
      }
    });
    historyButton.addEventListener("click", () => vscode.postMessage({ type: "showHome" }));
    featureSettingsButton.addEventListener("click", () => vscode.postMessage({ type: "openSettings" }));
    soundButton.addEventListener("click", () => setSoundMenuOpen(soundMenu.hidden));
    notificationToggle.addEventListener("change", () => {
      vscode.postMessage({
        type: "setAlertSetting",
        setting: "notifyOnComplete",
        enabled: notificationToggle.checked,
      });
    });
    runningSoundToggle.addEventListener("change", () => {
      if (webviewSoundPlayback) {
        runningSoundEnabled = runningSoundToggle.checked;
        if (runningSoundEnabled && running) {
          startRunningSound();
        } else {
          stopRunningSound();
        }
      }
      vscode.postMessage({
        type: "setAlertSetting",
        setting: "playSoundWhileRunning",
        enabled: runningSoundToggle.checked,
      });
    });
    completionSoundToggle.addEventListener("change", () => {
      if (webviewSoundPlayback) {
        completionSoundEnabled = completionSoundToggle.checked;
        if (completionSoundEnabled) primeRunningSound();
      }
      vscode.postMessage({
        type: "setAlertSetting",
        setting: "playSoundOnComplete",
        enabled: completionSoundToggle.checked,
      });
    });
    errorSoundToggle.addEventListener("change", () => {
      if (webviewSoundPlayback) {
        errorSoundEnabled = errorSoundToggle.checked;
        if (errorSoundEnabled) primeRunningSound();
      }
      vscode.postMessage({
        type: "setAlertSetting",
        setting: "playSoundOnError",
        enabled: errorSoundToggle.checked,
      });
    });
    viewAll.addEventListener("click", () => {
      tasksExpanded = true;
      renderTasks();
    });
    taskSearch.addEventListener("input", () => {
      conversationSearchQuery = taskSearch.value;
      clearTimeout(conversationSearchTimer);
      conversationSearchTimer = setTimeout(() => {
        vscode.postMessage({ type: "searchConversations", query: conversationSearchQuery });
      }, 180);
    });
    attachButton.addEventListener("click", () => {
      if (addMenu.hidden) {
        openAddMenu();
      } else {
        closeAddMenu();
      }
    });
    profileChip.addEventListener("click", openAddMenu);
    ctxRemove.addEventListener("click", () => setAttach(false));
    compareClose.addEventListener("click", () => {
      renderCompare(null);
    });
    memoryChip.addEventListener("click", () => {
      setIncludeProjectMemory(!includeProjectMemory);
      requestContextPreview();
    });
    setIncludeProjectMemory(true);
    approvalSelect.addEventListener("change", () => {
      setApprovalMode(approvalSelect.value);
      vscode.postMessage({ type: "selectApprovalMode", approvalMode: approvalSelect.value });
    });
    if (sandboxBannerLearnMore) {
      sandboxBannerLearnMore.addEventListener("click", () => {
        vscode.postMessage({ type: "sandboxLearnMore" });
      });
    }
    modelButton.addEventListener("click", () => {
      if (modelPicker.hidden) {
        openModelPicker();
      } else {
        closeModelPicker();
      }
    });
    modelSearch.addEventListener("input", renderModelList);
    window.addEventListener("resize", positionModelPicker);
    window.addEventListener("blur", () => {
      closeModelPicker();
      closeAddMenu();
      setSoundMenuOpen(false);
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        closeModelPicker();
        closeAddMenu();
        setSoundMenuOpen(false);
      }
    });
    document.addEventListener("pointerdown", (event) => {
      if (!modelPicker.hidden && !document.querySelector(".model-control").contains(event.target)) {
        closeModelPicker();
      }
      if (!addMenu.hidden && !document.querySelector(".add-control").contains(event.target)) {
        closeAddMenu();
      }
      if (!soundMenu.hidden && !document.querySelector(".sound-control").contains(event.target)) {
        setSoundMenuOpen(false);
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !modelPicker.hidden) {
        event.preventDefault();
        closeModelPicker();
        modelButton.focus();
      } else if (event.key === "Escape" && !addMenu.hidden) {
        event.preventDefault();
        closeAddMenu();
        attachButton.focus();
      } else if (event.key === "Escape" && !soundMenu.hidden) {
        event.preventDefault();
        setSoundMenuOpen(false);
        soundButton.focus();
      }
    });
    document.getElementById("keyButton").addEventListener("click", () => vscode.postMessage({ type: "setApiKey" }));
    authChip.addEventListener("click", () => vscode.postMessage({ type: "setApiKey" }));
    document.getElementById("connectButton").addEventListener("click", () => vscode.postMessage({ type: "setApiKey" }));
    document.getElementById("dashboardButton").addEventListener("click", () => vscode.postMessage({ type: "openDashboard" }));
    workspaceLabel.addEventListener("click", () => {
      if (workspaceLabel.disabled || !workspaceLabel.classList.contains("selectable")) return;
      vscode.postMessage({ type: "pickWorkspaceFolder" });
    });
    messages.addEventListener("click", (event) => {
      const el = event.target instanceof Element ? event.target : null;
      const copyBtn = el?.closest("[data-copy]");
      if (copyBtn instanceof HTMLButtonElement) {
        event.preventDefault();
        const text = copyTextForButton(copyBtn);
        if (!text) return;
        void writeClipboard(text).then((ok) => {
          if (ok) flashCopied(copyBtn);
        });
        return;
      }

      const target = el?.closest("[data-workspace-file]");
      if (!(target instanceof HTMLElement) || !target.dataset.workspaceFile) return;
      event.preventDefault();
      vscode.postMessage({ type: "openReferencedFile", path: target.dataset.workspaceFile });
    });
    // VS Code disables webview pointer events during resource drags unless Shift is held.
    // Listen on document so the whole view accepts drops once Shift re-enables the webview.
    document.addEventListener("dragenter", (event) => {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      setDragActive(true);
    });
    document.addEventListener("dragover", (event) => {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setDragActive(true);
    });
    document.addEventListener("dragleave", (event) => {
      const related = event.relatedTarget;
      if (related instanceof Node && document.documentElement.contains(related)) return;
      setDragActive(false);
    });
    document.addEventListener("drop", (event) => {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      setDragActive(false);
      void resolveTransferredFiles(event.dataTransfer, true, i18n.dropFailed);
    });
    window.addEventListener("dragend", () => setDragActive(false));
    window.addEventListener("blur", () => setDragActive(false));
    let restorePromptOnWindowFocus = false;
    let promptFocusRestoreGeneration = 0;

    function schedulePromptFocusRestore() {
      restorePromptOnWindowFocus = true;
      const generation = ++promptFocusRestoreGeneration;
      const restore = () => {
        if (
          generation !== promptFocusRestoreGeneration
          || !restorePromptOnWindowFocus
          || !document.hasFocus()
          || document.activeElement === prompt
        ) {
          return;
        }
        prompt.focus({ preventScroll: true });
      };
      requestAnimationFrame(restore);
      // Typeless may return focus after its paste/input event has completed.
      // Retry across that hand-off instead of relying on a single animation frame.
      for (const delay of [50, 150, 350, 700, 1200, 2000]) {
        setTimeout(restore, delay);
      }
    }

    function cancelPromptFocusRestore() {
      restorePromptOnWindowFocus = false;
      promptFocusRestoreGeneration += 1;
    }

    // Dictation tools briefly move focus to a system-level voice bar. Remember
    // that the prompt was the target and restore its caret when the webview
    // becomes active again. Pointer interaction inside the webview cancels the
    // restoration so an intentional click never has its focus stolen.
    prompt.addEventListener("focus", () => {
      restorePromptOnWindowFocus = true;
    });
    prompt.addEventListener("blur", (event) => {
      if (event.relatedTarget instanceof Node && document.contains(event.relatedTarget)) {
        cancelPromptFocusRestore();
      } else {
        // Typeless can move focus outside the webview after the text has already
        // arrived, so start a fresh retry window from the actual focus loss.
        schedulePromptFocusRestore();
      }
    });
    document.addEventListener("pointerdown", (event) => {
      if (event.target !== prompt) cancelPromptFocusRestore();
    }, true);
    window.addEventListener("blur", () => {
      if (document.activeElement === prompt) restorePromptOnWindowFocus = true;
    });
    window.addEventListener("focus", () => {
      if (restorePromptOnWindowFocus) schedulePromptFocusRestore();
    });
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && restorePromptOnWindowFocus) schedulePromptFocusRestore();
    });
    prompt.addEventListener("paste", (event) => {
      // Voice tools like Typeless paste polished text. Prefer that over file-drag
      // heuristics, which can otherwise swallow the paste when clipboard also
      // advertises file/URI payloads.
      const plain = event.clipboardData?.getData("text/plain") ?? "";
      if (plain.length > 0) {
        schedulePromptFocusRestore();
        return;
      }
      if (!isFileDrag(event.clipboardData)) return;
      event.preventDefault();
      void resolveTransferredFiles(event.clipboardData, false, i18n.pasteFailed);
    });
    prompt.addEventListener("input", () => {
      autoGrow();
      updateComposerSuggestions();
      schedulePromptFocusRestore();
      requestContextPreview();
    });
    prompt.addEventListener("compositionend", () => {
      autoGrow();
      updateComposerSuggestions();
      requestContextPreview();
    });
    prompt.addEventListener("click", updateComposerSuggestions);
    prompt.addEventListener("keydown", (event) => {
      // Dictation / IME confirmation uses Enter and keyCode 229; never treat as send.
      if (event.isComposing || event.keyCode === 229) return;
      if (!filePicker.hidden) {
        if ((event.key === "ArrowDown" || event.key === "ArrowUp") && fileResults.length > 0) {
          event.preventDefault();
          const direction = event.key === "ArrowDown" ? 1 : -1;
          selectedFileIndex = (selectedFileIndex + direction + fileResults.length) % fileResults.length;
          renderFileResults();
          return;
        }
        if ((event.key === "Enter" || event.key === "Tab") && fileResults.length > 0) {
          event.preventDefault();
          selectFile(fileResults[selectedFileIndex]);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          closeFilePicker();
          return;
        }
      }
      if (!slashPicker.hidden) {
        if ((event.key === "ArrowDown" || event.key === "ArrowUp") && slashResults.length > 0) {
          event.preventDefault();
          const direction = event.key === "ArrowDown" ? 1 : -1;
          selectedSlashIndex = (selectedSlashIndex + direction + slashResults.length) % slashResults.length;
          renderSlashResults();
          return;
        }
        if ((event.key === "Enter" || event.key === "Tab") && slashResults.length > 0) {
          event.preventDefault();
          selectSlashCommand(slashResults[selectedSlashIndex]);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          closeSlashPicker();
          return;
        }
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (running && event.ctrlKey) {
          submitMessage("interrupt");
        } else if (running) {
          submitMessage("queue");
        } else {
          submitMessage();
        }
      }
    });

    window.addEventListener("message", ({ data }) => {
      switch (data.type) {
        case "authState":
          auth.style.display = data.configured ? "none" : "block";
          authChip.style.display = data.configured ? "none" : "inline-flex";
          status.textContent = data.configured ? i18n.connected : i18n.apiKeyMissing;
          break;
        case "authRequired":
          auth.style.display = "block";
          authChip.style.display = "inline-flex";
          break;
        case "notificationAndSoundSettings":
          notificationToggle.checked = data.notification === true;
          runningSoundToggle.checked = data.running === true;
          completionSoundToggle.checked = data.completion === true;
          errorSoundToggle.checked = data.error === true;
          webviewSoundPlayback = data.webviewPlayback === true;
          break;
        case "runningSoundSetting":
          runningSoundEnabled = data.enabled === true;
          if (runningSoundEnabled && running) {
            startRunningSound();
          } else {
            stopRunningSound();
          }
          break;
        case "completionSoundSetting":
          completionSoundEnabled = data.enabled === true;
          break;
        case "errorSoundSetting":
          errorSoundEnabled = data.enabled === true;
          break;
        case "workspace":
          if (data.name) workspaceLabel.textContent = data.name + " " + i18n.runningIn;
          const selectable = data.selectable === true;
          workspaceLabel.classList.toggle("selectable", selectable);
          workspaceLabel.disabled = !selectable;
          workspaceLabel.title = selectable ? i18n.selectWorkspace : "";
          workspaceLabel.setAttribute("aria-label", selectable
            ? (data.name ? data.name + " — " + i18n.selectWorkspace : i18n.selectWorkspace)
            : (data.name || i18n.localRun));
          break;
        case "workspaceFileIndex":
          workspacePaths = new Set((data.files || []).map((file) => file.toLowerCase()));
          workspaceBasenames = new Set(
            (data.files || []).map((file) => file.split(/[\\\\/]/).pop().toLowerCase()),
          );
          linkifyWorkspaceFiles(messages);
          break;
        case "contextInfo":
          if (attach) updateContextChip(data.label);
          break;
        case "fileResults":
          if (data.requestId !== fileRequestId || !activeMention()) break;
          fileResults = (data.files || []).filter(
            (file) => !selectedFiles.some((selected) => selected.path === file.path),
          );
          renderFileResults();
          break;
        case "resolvedAttachments":
          for (const file of data.files || []) {
            if (!selectedFiles.some((selected) => selected.path === file.path)) {
              selectedFiles.push(file);
            }
          }
          renderMentionChips();
          prompt.focus();
          break;
        case "integrations":
          availableSkills = data.skills || [];
          availableMcpServers = data.mcpServers || [];
          projectCommands = data.commands || [];
          selectedSkills = selectedSkills.filter((name) =>
            availableSkills.some((skill) => skill.name === name));
          updateProfileChip();
          if (!addMenu.hidden) renderMainAddMenu();
          break;
        case "models": {
          availableModels = data.models || [];
          modelParamState = data.savedParams || {};
          selectedModelId = data.selected || "auto";
          const selected = selectedModelDefinition();
          if (selected) paramsForModel(selected);
          updateModelButton();
          renderModelList();
          renderModelOptions();
          break;
        }
        case "modelSelected":
          selectedModelId = data.id || "auto";
          updateModelButton();
          break;
        case "approvalModeSelected":
          setApprovalMode(data.mode);
          break;
        case "sandboxSupport":
          sandboxSupported = data.supported !== false;
          if (!sandboxSupported) sandboxUnavailable = true;
          updateSandboxBanner();
          if (!running) {
            status.textContent = sandboxUnavailable
              ? sandboxStatusForMode(approvalSelect.value)
              : i18n.connected;
          }
          break;
        case "sandboxUnavailable":
          sandboxUnavailable = true;
          status.textContent = sandboxStatusForMode(approvalSelect.value);
          updateSandboxBanner();
          break;
        case "home":
          showHome(data.conversations, data.searchQuery);
          break;
        case "usageStats":
          usageSummary = data.summary || null;
          renderUsagePanel();
          if (view === "home") {
            renderTasks();
          }
          break;
        case "bestOfNExperiments":
          bestOfNExperiments = data.experiments || [];
          if (view === "home") {
            renderExperiments();
          }
          break;
        case "bestOfNCompare":
          view = "home";
          home.style.display = "flex";
          messages.style.display = "none";
          setRunningState(false);
          renderCompare(data.experiment);
          break;
        case "contextPreview":
          renderContextPreview(data.chips || []);
          break;
        case "newChat":
          setRunningState(false);
          clearMessages();
          showChat();
          prompt.focus();
          break;
        case "chat": {
          clearMessages();
          showChat();
          for (let entryIndex = 0; entryIndex < data.entries.length; entryIndex += 1) {
            const entry = data.entries[entryIndex];
            if (entry.role === "user") {
              const attachments = (entry.attachments || []).map((attachment) => {
                if (typeof attachment === "string") {
                  return {
                    path: attachment,
                    label: attachment.split(/[\\\\/]/).pop() || attachment,
                  };
                }
                return {
                  path: attachment.path,
                  label: attachment.label || attachment.path.split(/[\\\\/]/).pop() || attachment.path,
                };
              });
              addUserMessage(entry.text, attachments);
            } else {
              const files = (entry.files || []).map((p) => ({ path: p, label: p.split(/[\\\\/]/).pop() || p }));
              const live = data.running === true && entryIndex === data.entries.length - 1;
              if (live) {
                assistantRaw = entry.text || "";
                assistantNode = addAssistantMessage(assistantRaw, entry.error === true, files);
                activeProgress = createProgressPanel(entry.progress || [], "running");
                assistantNode.before(activeProgress.node);
              } else {
                addAssistantMessage(
                  entry.text,
                  entry.error === true,
                  files,
                  entry.progress || [],
                  entry.progressState || (entry.error === true ? "error" : "completed"),
                );
              }
            }
          }
          setRunningState(data.running === true);
          break;
        }
        case "queueState":
          queuedMessages = data.items || [];
          renderQueue();
          break;
        case "parallelState":
          activeChatRuns = Number(data.activeRuns) || 0;
          maximumChatRuns = Math.max(1, Number(data.maximumRuns) || 3);
          parallelTasks = Array.isArray(data.tasks) ? data.tasks : [];
          renderParallelBar();
          if (running) {
            status.textContent = i18n.running + "…"
              + (activeChatRuns > 1 ? " · " + activeChatRuns + " " + i18n.activeAgents : "");
          }
          break;
        case "queuedStarted": {
          showChat();
          const attachments = (data.files || []).map((file) => ({
            path: file,
            label: file.split(/[\\/]/).pop() || file,
          }));
          addUserMessage(data.prompt, attachments);
          assistantRaw = "";
          assistantNode = addAssistantMessage("");
          break;
        }
        case "started":
          setRunningState(true);
          beginProgress();
          break;
        case "toolStatus":
          status.textContent = i18n.running + ": " + data.text;
          updateProgress(data);
          break;
        case "contextAttached": {
          const nodes = messages.querySelectorAll(".user");
          const lastUser = nodes[nodes.length - 1];
          if (lastUser) {
            const note = document.createElement("div");
            note.className = "context-note";
            note.textContent = i18n.attached + ": " + data.label;
            lastUser.appendChild(note);
          }
          break;
        }
        case "chunk":
          if (view !== "chat") break;
          if (!assistantNode) assistantNode = addAssistantMessage("");
          assistantRaw += data.text;
          renderMarkdown(assistantNode, assistantRaw);
          scrollToBottom();
          break;
        case "fileEdited":
          if (view !== "chat") break;
          if (!assistantNode) assistantNode = addAssistantMessage("");
          addFileChip(assistantNode, data.path, data.label);
          break;
        case "error":
          finishProgress("error");
          stopRunningSound();
          playErrorSound();
          if (assistantNode && !assistantRaw) {
            messageBody(assistantNode).textContent = data.text;
            assistantNode.classList.add("error");
            ensureMessageCopy(assistantNode);
          } else {
            addAssistantMessage(data.text, true);
          }
          break;
        case "cancelled":
          finishProgress("stopped");
          if (assistantNode && !assistantRaw) {
            messageBody(assistantNode).textContent = i18n.stopped;
            ensureMessageCopy(assistantNode);
          }
          break;
        case "finished":
          finishProgress("completed");
          stopRunningSound();
          playCompletionSound();
          break;
        case "idle":
          setRunningState(false);
          assistantNode = undefined;
          assistantRaw = "";
          activeProgress = undefined;
          // A run can finish while the user is editing or using another view.
          // Only restore the caret when this webview still owns focus.
          if (document.hasFocus()) prompt.focus({ preventScroll: true });
          break;
      }
    });

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}
