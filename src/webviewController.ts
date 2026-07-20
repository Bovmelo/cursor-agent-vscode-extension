import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import {
  type HostToWebviewMessage,
  type WebviewMessageHandler,
  parseHostToWebviewMessage,
  parseWebviewMessage,
} from "./webviewMessages.js";

/** Owns the chat webview document and its bundled client-side UI. */
export class WebviewController {
  private view: vscode.WebviewView | undefined;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly isJapanese: boolean,
    private readonly supportsLocalSandbox: boolean,
    private readonly maxDroppedFileBytes: number,
  ) {}

  public attach(view: vscode.WebviewView, onDispose: () => void): void;
  public attach(
    view: vscode.WebviewView,
    onDispose: () => void,
    onMessage: WebviewMessageHandler,
  ): void;
  public attach(
    view: vscode.WebviewView,
    onDispose: () => void,
    onMessage?: WebviewMessageHandler,
  ): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    view.webview.html = this.getHtml(view.webview);
    const messageSubscription = onMessage
      ? view.webview.onDidReceiveMessage((message: unknown) => {
          const parsed = parseWebviewMessage(message);
          if (parsed) void onMessage(parsed);
        })
      : undefined;
    view.onDidDispose(() => {
      messageSubscription?.dispose();
      if (this.view === view) {
        this.view = undefined;
        onDispose();
      }
    });
  }

  public post(message: HostToWebviewMessage): Thenable<boolean> | undefined;
  public post(message: HostToWebviewMessage): Thenable<boolean> | undefined {
    const parsed = parseHostToWebviewMessage(message);
    return parsed ? this.view?.webview.postMessage(parsed) : undefined;
  }

  public get visible(): boolean {
    return this.view?.visible === true;
  }

  public get attached(): boolean {
    return this.view !== undefined;
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
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "webview.css"),
    );
    const clientUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "webview.js"),
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
          selectQueued: "並列実行の対象に選択",
          runQueuedParallel: "別Agentで並列実行",
          runSelectedParallel: "選択を並列実行",
          runSelectedParallelTitle: "選択したメッセージを別Agentで並列実行",
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
          dropFailed:
            "ドロップしたファイルを読み取れませんでした。Shiftを押しながらドロップしてください。",
          pasteFailed: "クリップボードの画像を読み取れませんでした。",
          attachmentResolveTimeout:
            "添付ファイルの準備に時間がかかっています。添付を保持したまま、もう一度送信してください。",
          attachedImagePrompt: "添付画像を確認してください。",
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
          sandboxBannerSafeText:
            "Windowsではサンドボックスが無効です。安全worktreeで編集を分離しますが、ホストのファイルシステムとネットワークはOSレベルで隔離されません。",
          sandboxBannerDirectText:
            "Windowsではサンドボックスが無効です。ファイルシステムとネットワークの隔離はなく、エージェントはワークスペースを直接変更できます。",
          sandboxBannerLearnMore: "詳細",
          sandboxBannerLabel: "サンドボックス警告",
          expandSandboxBanner: "サンドボックス警告を展開",
          collapseSandboxBanner: "サンドボックス警告を折りたたむ",
          copyCode: "コードをコピー",
          copyMessage: "メッセージをコピー",
          copied: "コピーしました",
          featureSettings: "AI機能の設定",
          moreMenu: "その他",
          expandParallel: "並列Agentを展開",
          collapseParallel: "並列Agentを折りたたむ",
          soundSettings: "通知と音の設定",
          completionNotification: "処理完了の通知",
          soundWhileRunning: "処理中の音",
          soundOnComplete: "完了時の音",
          soundOnError: "エラー時の音",
          usageTitle: "使用量",
          usageToday: "今日",
          usageWeek: "直近7日",
          usageMonth: "今月",
          usageChat: "チャット",
          usageSupervisor: "Supervisor",
          usageConversations: "会話合計",
          usageInlineAcceptance: "インライン補完採用率",
          searchConversations: "会話を検索",
          findInChat: "会話内を検索",
          findPlaceholder: "会話内を検索…",
          findPrev: "前へ",
          findNext: "次へ",
          findClose: "閉じる",
          findNoMatches: "一致なし",
          findMatchCount: "{current} / {total}",
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
          orchestrateDescription: "計画してサブタスクを並列実行し、結果を統合",
          orchestratorTitle: "オーケストレーション",
          orchestratorDetailTitle: "オーケストレーション詳細",
          orchestratorPhasePlanning: "計画中",
          orchestratorPhaseRunning: "実行中",
          orchestratorPhaseSynthesizing: "統合中",
          orchestratorPhaseCompleted: "完了",
          orchestratorPhaseFailed: "失敗",
          orchestratorPlanAgent: "計画",
          orchestratorSynthesisAgent: "統合",
          orchestratorOpenAgent: "開く",
          orchestratorFlowSubtasks: "サブタスク",
          orchestratorFlowWaiting: "待機中",
          orchestratorGroup: "Orchestrate",
          budgetLabel: "予算",
          monthlyBudgetLabel: "月間予算",
          estimatedCostLabel: "推定コスト",
          contextPreview: "送信コンテキスト",
          openCandidate: "開く",
          experimentsTitle: "比較実験",
          noAssistantYet: "まだ応答がありません",
          setupChecklistTitle: "セットアップ",
          setupChecklistDismiss: "閉じる",
          setupChecklistReopen: "セットアップチェックリストを表示",
          setupChecklistComplete: "完了",
          setupChecklistOptional: "任意",
          setupStepApiKey: "APIキー",
          setupStepApiKeyDesc: "Cursor Dashboard のユーザーAPIキーを VS Code に設定します。",
          setupStepWorkspaceTrust: "ワークスペースの信頼",
          setupStepWorkspaceTrustDesc:
            "Restricted Mode のままでは自律自動化が制限されます。信頼して続行してください。",
          setupStepGitWorkspace: "Git ワークスペース",
          setupStepGitWorkspaceDesc:
            "安全worktree・Supervisor・チェックポイントのため、Git リポジトリを開きます。",
          setupStepPermissions: "実行権限",
          setupStepPermissionsDesc:
            "＋メニューで実行権限モードを確認し、内容を把握したうえで確定してください。",
          setupStepGh: "GitHub CLI（任意）",
          setupStepGhDesc:
            "PR 作成と Supervisor の GitHub トリガーに gh が必要です。後でスキップもできます。",
          setupActionSetApiKey: "APIキーを設定",
          setupActionTrustWorkspace: "ワークスペースを信頼",
          setupActionOpenFolder: "フォルダーを開く",
          setupActionRefreshGit: "Git を再確認",
          setupActionReviewPermissions: "実行権限を確認",
          setupActionConfirmPermissions: "確認済みにする",
          setupActionCheckGh: "gh を確認",
          setupActionSkipGh: "スキップ",
          setupActionOpenGhSettings: "GitHub トリガー設定を開く",
          setupActionOpenDashboard: "Dashboardを開く",
          recoveryRetry: "再試行",
          recoveryExportDiagnostics: "診断を書き出す",
          recoveryOpenRunCenter: "Run Centerを開く",
          recoveryOpenLogs: "ログを開く",
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
          selectQueued: "Select for parallel run",
          runQueuedParallel: "Run as parallel agent",
          runSelectedParallel: "Run selected in parallel",
          runSelectedParallelTitle: "Run selected messages as parallel agents",
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
          attachmentResolveTimeout:
            "Attachment preparation is taking too long. Your draft and attachments are preserved; try sending again.",
          attachedImagePrompt: "Please look at the attached image(s).",
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
          sandboxBannerSafeText:
            "The Windows sandbox is unavailable. Safe worktree mode separates edits, but the host filesystem and network are not OS-isolated.",
          sandboxBannerDirectText:
            "The Windows sandbox is unavailable. There is no filesystem or network isolation, and the agent can modify your workspace directly.",
          sandboxBannerLearnMore: "Details",
          sandboxBannerLabel: "Sandbox warning",
          expandSandboxBanner: "Expand sandbox warning",
          collapseSandboxBanner: "Collapse sandbox warning",
          copyCode: "Copy code",
          copyMessage: "Copy message",
          copied: "Copied",
          featureSettings: "AI feature settings",
          moreMenu: "More",
          expandParallel: "Expand parallel agents",
          collapseParallel: "Collapse parallel agents",
          soundSettings: "Notification and sound settings",
          completionNotification: "Run completion notifications",
          soundWhileRunning: "While running",
          soundOnComplete: "On completion",
          soundOnError: "On error",
          usageTitle: "Usage",
          usageToday: "Today",
          usageWeek: "Last 7 days",
          usageMonth: "This month",
          usageChat: "Chat",
          usageSupervisor: "Supervisor",
          usageConversations: "All conversations",
          usageInlineAcceptance: "Inline completion acceptance",
          searchConversations: "Search conversations",
          findInChat: "Find in chat",
          findPlaceholder: "Find in chat…",
          findPrev: "Previous",
          findNext: "Next",
          findClose: "Close",
          findNoMatches: "No matches",
          findMatchCount: "{current} / {total}",
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
          orchestrateDescription: "Plan, run subtasks in parallel, then synthesize",
          orchestratorTitle: "Orchestration",
          orchestratorDetailTitle: "Orchestration detail",
          orchestratorPhasePlanning: "Planning",
          orchestratorPhaseRunning: "Running",
          orchestratorPhaseSynthesizing: "Synthesizing",
          orchestratorPhaseCompleted: "Completed",
          orchestratorPhaseFailed: "Failed",
          orchestratorPlanAgent: "Plan",
          orchestratorSynthesisAgent: "Synthesis",
          orchestratorOpenAgent: "Open",
          orchestratorFlowSubtasks: "Subtasks",
          orchestratorFlowWaiting: "Waiting",
          orchestratorGroup: "Orchestrate",
          budgetLabel: "Budget",
          monthlyBudgetLabel: "Monthly budget",
          estimatedCostLabel: "Estimated cost",
          contextPreview: "Send context",
          openCandidate: "Open",
          experimentsTitle: "Compare experiments",
          noAssistantYet: "No assistant reply yet",
          setupChecklistTitle: "Setup",
          setupChecklistDismiss: "Dismiss",
          setupChecklistReopen: "Show setup checklist",
          setupChecklistComplete: "Done",
          setupChecklistOptional: "Optional",
          setupStepApiKey: "API key",
          setupStepApiKeyDesc: "Generate a user API key in Cursor Dashboard and set it in VS Code.",
          setupStepWorkspaceTrust: "Workspace trust",
          setupStepWorkspaceTrustDesc:
            "Restricted Mode limits autonomous automation. Trust the workspace when you intend to use it.",
          setupStepGitWorkspace: "Git workspace",
          setupStepGitWorkspaceDesc:
            "Open a Git repository folder for Safe worktree, Supervisor, and checkpoints.",
          setupStepPermissions: "Execution permissions",
          setupStepPermissionsDesc:
            "Review the permission mode in the + menu, then confirm you have checked it.",
          setupStepGh: "GitHub CLI (optional)",
          setupStepGhDesc:
            "Needed for PR creation and Supervisor GitHub triggers. You can skip for now.",
          setupActionSetApiKey: "Set API key",
          setupActionTrustWorkspace: "Trust workspace",
          setupActionOpenFolder: "Open folder",
          setupActionRefreshGit: "Refresh Git",
          setupActionReviewPermissions: "Review permissions",
          setupActionConfirmPermissions: "I've reviewed",
          setupActionCheckGh: "Check gh",
          setupActionSkipGh: "Skip",
          setupActionOpenGhSettings: "Open GitHub trigger settings",
          setupActionOpenDashboard: "Open Dashboard",
          recoveryRetry: "Retry",
          recoveryExportDiagnostics: "Export diagnostics",
          recoveryOpenRunCenter: "Open Run Center",
          recoveryOpenLogs: "Open logs",
        };

    const clientConfig = JSON.stringify({
      i18n: ui,
      supportsLocalSandbox: SUPPORTS_LOCAL_SANDBOX,
      maxDroppedFileBytes: MAX_DROPPED_FILE_BYTES,
    }).replace(/</gu, "\\u003c");

    return /* html */ `<!doctype html>
<html lang="${this.isJapanese ? "ja" : "en"}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'nonce-${nonce}';"
  >
  <title>Cursor Agent</title>
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div class="header">
    <span class="brand">Cursor</span>
    <span class="spacer"></span>
    <div class="sandbox-control">
      <button id="sandboxBannerToggle" type="button" hidden aria-expanded="false" aria-controls="sandboxBanner" title="${ui.expandSandboxBanner}" aria-label="${ui.sandboxBannerLabel}">
        <svg class="sandbox-banner-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M8 1.6 1.8 4.3v3.4c0 3.6 2.5 5.9 6.2 7 3.7-1.1 6.2-3.4 6.2-7V4.3z"/>
          <path d="M8 5.6v3.1M8 10.7v.05"/>
        </svg>
      </button>
      <div id="sandboxBanner" role="alert" hidden>
        <span id="sandboxBannerText" class="sandbox-banner-text">${ui.sandboxBannerSafeText}</span>
        <button id="sandboxBannerLearnMore" class="sandbox-banner-link" type="button">${ui.sandboxBannerLearnMore}</button>
      </div>
    </div>
    <button id="findInChatButton" class="icon-btn" type="button" title="${ui.findInChat}" aria-label="${ui.findInChat}" hidden>
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="7" cy="7" r="4.2"/>
        <path d="M10.2 10.2 13.5 13.5"/>
      </svg>
    </button>
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
    <div class="more-control">
      <button id="moreButton" class="icon-btn" type="button" title="${ui.moreMenu}" aria-label="${ui.moreMenu}" aria-expanded="false">
        <svg viewBox="0 0 16 16" fill="currentColor">
          <circle cx="3.5" cy="8" r="1.3"/>
          <circle cx="8" cy="8" r="1.3"/>
          <circle cx="12.5" cy="8" r="1.3"/>
        </svg>
      </button>
      <div id="moreMenu" role="menu" aria-label="${ui.moreMenu}" hidden>
        <button id="featureSettingsButton" class="more-menu-item" type="button" role="menuitem">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="8" cy="8" r="2"/>
            <path d="M6.5 1.6h3l.45 1.9 1.55.9 1.9-.5 1.5 2.6-1.45 1.2v1.8l1.45 1.2-1.5 2.6-1.9-.5-1.55.9L9.5 14.4h-3l-.45-1.9-1.55-.9-1.9.5-1.5-2.6 1.45-1.2V7.8L1.6 6.6l1.5-2.6 1.9.5 1.55-.9z"/>
          </svg>
          <span>${ui.featureSettings}</span>
        </button>
        <div class="sound-control">
          <button id="soundButton" class="more-menu-item" type="button" role="menuitem" aria-expanded="false">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
              <path d="M2.5 6.2h2.3L8 3.5v9L4.8 9.8H2.5z"/>
              <path d="M10.5 5.5a3.2 3.2 0 0 1 0 5M12.3 3.7a5.7 5.7 0 0 1 0 8.6"/>
            </svg>
            <span>${ui.soundSettings}</span>
          </button>
          <div id="soundMenu" role="group" aria-label="${ui.soundSettings}" hidden>
            <div class="sound-menu-title">${ui.soundSettings}</div>
            <label class="sound-option"><input id="notificationToggle" type="checkbox"><span>${ui.completionNotification}</span></label>
            <label class="sound-option"><input id="runningSoundToggle" type="checkbox"><span>${ui.soundWhileRunning}</span></label>
            <label class="sound-option"><input id="completionSoundToggle" type="checkbox"><span>${ui.soundOnComplete}</span></label>
            <label class="sound-option"><input id="errorSoundToggle" type="checkbox"><span>${ui.soundOnError}</span></label>
          </div>
        </div>
        <div class="more-menu-separator"></div>
        <button id="showSetupChecklistButton" class="more-menu-item" type="button" role="menuitem">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3.5 3.5h9v9h-9z"/>
            <path d="M5.5 7l1.5 1.5L10.5 5"/>
          </svg>
          <span>${ui.setupChecklistReopen}</span>
        </button>
        <button id="keyButton" class="more-menu-item" type="button" role="menuitem">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="5" cy="8" r="3"/>
            <path d="M8 8h6M11 8v2M13.5 8v2"/>
          </svg>
          <span>${ui.setApiKey}</span>
        </button>
      </div>
    </div>
  </div>

  <div id="parallelBar" hidden>
    <button id="parallelBarToggle" class="parallel-bar-header" type="button" aria-expanded="false" title="${ui.expandParallel}">
      <span id="parallelBarTitle">${ui.parallelAgents}</span>
      <span id="parallelBarCount"></span>
      <span class="parallel-chevron" aria-hidden="true">▸</span>
    </button>
    <div id="parallelBarBody" hidden>
      <button id="startParallelAgentButton" type="button">
        <span class="parallel-launch-plus" aria-hidden="true">＋</span>
        <span>${ui.launchParallelAgent}</span>
      </button>
      <div id="parallelTaskList"></div>
    </div>
  </div>

  <div id="auth">
    <p>${ui.authMessage}</p>
    <div class="row">
      <button id="connectButton" type="button">${ui.setApiKey}</button>
      <button id="dashboardButton" class="secondary" type="button">${ui.openDashboard}</button>
    </div>
  </div>

  <div id="setupChecklist" hidden>
    <div id="setupChecklistHeader">
      <span id="setupChecklistTitle">${ui.setupChecklistTitle}</span>
      <button id="setupChecklistDismiss" type="button">${ui.setupChecklistDismiss}</button>
    </div>
    <div id="setupChecklistSteps"></div>
  </div>

  <div id="chatFindBar" hidden>
    <input id="chatFindInput" type="search" placeholder="${ui.findPlaceholder}" aria-label="${ui.findInChat}">
    <span id="chatFindCount" aria-live="polite" aria-atomic="true"></span>
    <button id="chatFindPrev" class="find-nav" type="button" title="${ui.findPrev}" aria-label="${ui.findPrev}">↑</button>
    <button id="chatFindNext" class="find-nav" type="button" title="${ui.findNext}" aria-label="${ui.findNext}">↓</button>
    <button id="chatFindClose" class="find-nav" type="button" title="${ui.findClose}" aria-label="${ui.findClose}">×</button>
  </div>

  <div id="scroller">
    <div id="messages" style="display: none;"></div>
    <div id="messageAnnouncer" class="sr-only" role="status" aria-live="polite" aria-atomic="true"></div>
    <div id="home">
      <div id="usagePanel" hidden>
        <div class="usage-title">${ui.usageTitle}</div>
        <div class="usage-grid">
          <div>${ui.usageToday}: <strong id="usageTodayTotal">0</strong></div>
          <div>${ui.usageWeek}: <strong id="usageWeekTotal">0</strong></div>
          <div>${ui.usageMonth}: <strong id="usageMonthTotal">0</strong></div>
          <div>${ui.usageChat}: <strong id="usageChatTotal">0</strong></div>
          <div>${ui.usageSupervisor}: <strong id="usageSupervisorTotal">0</strong></div>
          <div>${ui.usageConversations}: <strong id="usageConversationTotal">0</strong></div>
          <div>${ui.usageInlineAcceptance}: <strong id="usageInlineAcceptance">—</strong></div>
          <div>${ui.budgetLabel}: <strong id="usageBudgetTotal">—</strong></div>
          <div>${ui.monthlyBudgetLabel}: <strong id="usageMonthlyBudgetTotal">—</strong></div>
          <div>${ui.estimatedCostLabel}: <strong id="usageEstimatedCostTotal">—</strong></div>
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
      <div id="orchestratorPanel" hidden>
        <div class="tasks-title">${ui.orchestratorTitle}</div>
        <div id="orchestratorList"></div>
      </div>
      <div id="orchestratorDetailPanel" hidden>
        <div class="compare-header">
          <div class="tasks-title">${ui.orchestratorDetailTitle}</div>
          <button id="orchestratorClose" class="task-action" type="button" title="${ui.back}">×</button>
        </div>
        <div id="orchestratorPrompt" class="compare-prompt"></div>
        <div id="orchestratorPhaseStrip" class="orchestrator-phase-strip"></div>
        <div id="orchestratorError" class="orchestrator-error" hidden></div>
        <div id="orchestratorAgents" class="orchestrator-flow"></div>
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
      <div id="contextRow" hidden>
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
      <textarea id="prompt" role="combobox" placeholder="${ui.prompt}" aria-label="${ui.promptLabel}" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded="false" rows="2"></textarea>
      <div class="card-row">
        <div class="add-control">
          <button id="attachButton" class="round-btn" type="button" title="${ui.addContextTools} · ${ui.dropHelp}" aria-haspopup="menu" aria-controls="addMenu" aria-expanded="false">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6">
              <path d="M8 3v10M3 8h10"/>
            </svg>
          </button>
          <div id="addMenu" role="menu" aria-label="${ui.addContextTools}" hidden>
            <div id="addMenuContent"></div>
          </div>
        </div>
        <button id="profileChip" type="button" aria-label="${ui.standardProfile}" aria-haspopup="menu" aria-controls="addMenu" aria-expanded="false"></button>
        <button id="authChip" type="button" title="${ui.setApiKey}">${ui.apiKeyMissing}</button>
        <span class="spacer"></span>
        <select id="approvalSelect" aria-label="${ui.approvalMode}" aria-hidden="true" tabindex="-1">
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
    <span id="status" role="status" aria-live="polite" aria-atomic="true" aria-busy="false">${ui.checkingConnection}</span>
    <span class="footer-sep footer-version-sep" aria-hidden="true">·</span>
    <span id="extensionVersion" title="Extension version">v${extensionVersion}</span>
    <span id="runningIndicator" role="status" aria-live="polite" aria-atomic="true" hidden>
      <span class="running-spinner" aria-hidden="true"></span>
      <span>${ui.running}</span>
    </span>
  </div>

  <script nonce="${nonce}" src="${markedUri}"></script>
  <script nonce="${nonce}" src="${purifyUri}"></script>
  <script nonce="${nonce}">
    window.__cursorAgentWebviewConfig = Object.freeze(${clientConfig});
  </script>
  <script nonce="${nonce}" src="${clientUri}"></script>
</body>
</html>`;
  }
}
