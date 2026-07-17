import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import * as path from "node:path";
import {
  Agent,
  AgentBusyError,
  Cursor,
  CursorAgentError,
  type ModelParameterValue,
  type ModelSelection,
  type RunResult,
  type SDKImage,
} from "@cursor/sdk";
import * as vscode from "vscode";
import { AgentFactory } from "./agentFactory.js";
import { AttachmentService } from "./attachmentService.js";
import { ChatRuntime, type CursorAgent, type CursorRun } from "./chatRuntime.js";
import {
  type AttachedFileReference,
  type Conversation,
  type DroppedFileUpload,
  type EditorContextSnapshot,
  type QueuedMessage,
  type RunProfile,
  type TranscriptEntry,
  type ToolProgressEntry,
  type WorkspaceFileItem,
} from "./chatTypes.js";
import { ConversationStore, makeConversationTitle } from "./conversationStore.js";
import {
  ChangeSessionController,
  CursorAiCodeActionProvider,
  parseReviewFindings,
  runVerification,
  type ReviewFinding,
  type VerificationResult,
} from "./aiNative.js";
import {
  createBestOfNExperiment,
  experimentCandidates,
  pickWinner,
  type BestOfNExperiment,
} from "./bestOfN.js";
import { buildContextPreview } from "./contextEstimate.js";
import { generateCommitMessage, resolveRootUri } from "./generateCommitMessage.js";
import { createBranchCommitAndPullRequest } from "./gitWorkflow.js";
import { runConfiguredHooks } from "./hooks.js";
import {
  applyAiConflictResolution,
  applyIsolatedChanges,
  cleanupIsolatedWorktree,
  collectIsolatedChanges,
  mapWorktreePathToRoot,
  prepareAiConflictResolution,
  prepareIsolatedWorktree,
  type PreparedAiConflict,
  type IsolatedWorktreeSession,
} from "./isolatedWorktree.js";
import {
  detectBlockedProxyEnvironment,
  type BlockedProxyEnvironment,
} from "./networkEnvironment.js";
import {
  expandProjectCommand,
  loadProjectCommands,
  type ProjectCommand,
} from "./projectCommands.js";
import { RunningSoundController } from "./runningSound.js";
import {
  AiSupervisorController,
  type SupervisorTaskTarget,
} from "./supervisor.js";
import { SupervisorAgentRunner } from "./supervisorRunner.js";
import {
  addTokenUsage,
  recordUsage,
  summarizeUsage,
  USAGE_LEDGER_KEY,
  type StoredTokenUsage,
  type UsageLedger,
  type UsageSource,
  type UsageSummary,
} from "./usageStats.js";
import { pickWorkspaceFolder, resolveWorkspaceFolder, configurationFor, workspaceDisplayName, resolveAbsoluteInWorkspace, workspaceFolderFromUri, defaultWorkspaceFolder } from "./workspaceFolder.js";
import { WebviewController } from "./webviewController.js";
import {
  canStartAnotherParallelAgent,
  computeOverlappedMutationFlags,
  conversationRunState,
  defaultSafetyApprovalMode,
  enqueueChatMessage,
  isSafeRelativePath,
  parseWebviewMessage,
  removeQueuedMessages,
  shouldUseIsolatedWorktree,
  shouldCancelOnInterrupt,
  takeNextQueuedMessage,
  type SafetyApprovalMode,
} from "./safety.js";

const API_KEY_SECRET = "cursorSubscription.apiKey";
const CONVERSATIONS_KEY = "cursorSubscription.conversations";
const MODEL_KEY = "cursorSubscription.model";
const MODEL_PARAMS_KEY = "cursorSubscription.modelParams";
const APPROVAL_MODE_KEY = "cursorSubscription.approvalMode";
const SANDBOX_WARNING_ACK_KEY = "cursorSubscription.sandboxWarningAcknowledged";
const PARALLEL_EDIT_WARNING_KEY = "cursorSubscription.parallelEditWarningShown";
const BEST_OF_N_KEY = "cursorSubscription.bestOfNExperiments";
const VIEW_ID = "cursorSubscription.chatView";
const DEFAULT_MODEL = "auto";
const IS_JAPANESE = vscode.env.language.toLowerCase().startsWith("ja");
const MAX_DROPPED_FILE_BYTES = 20 * 1024 * 1024;
const MAX_EDITOR_GENERATION_CONTEXT = 60_000;
const WORKSPACE_INDEX_DEBOUNCE_MS = 300;
const SUPPORTS_LOCAL_SANDBOX = process.platform !== "win32";
type AiFeatureSetting =
  | "enableAiSupervisor"
  | "enableAutopilot"
  | "enableChangeSessions"
  | "previewGeneratedCode"
  | "enableDiagnosticQuickFixes"
  | "enableAiReview"
  | "enableVerification"
  | "enableDebugContext"
  | "enableProjectMemory"
  | "enableInlineCompletions";

function configuredAiFeatureEnabled(setting: AiFeatureSetting): boolean {
  const configuration = configurationFor("cursorSubscription");
  return configuration.get<boolean>("enableAiNativeFeatures", true)
    && configuration.get<boolean>(setting, setting !== "enableInlineCompletions");
}
type ApprovalMode = SafetyApprovalMode;

function localize(english: string, japanese: string): string {
  return IS_JAPANESE ? japanese : english;
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Cursor Agent");
  const runningSound = new RunningSoundController(context, output);
  const reviewDiagnostics = vscode.languages.createDiagnosticCollection("cursor-ai-review");
  const changeSessions = new ChangeSessionController(
    context.workspaceState,
    output,
    IS_JAPANESE,
    context.storageUri ?? context.globalStorageUri,
    () => configuredAiFeatureEnabled("enableChangeSessions"),
  );
  const supervisor = new AiSupervisorController(
    context.workspaceState,
    context.storageUri ?? context.globalStorageUri,
    output,
    IS_JAPANESE,
    () => configuredAiFeatureEnabled("enableAiSupervisor"),
  );
  const supervisorRunner = new SupervisorAgentRunner(context, output);
  const provider = new CursorChatProvider(
    context,
    output,
    runningSound,
    changeSessions,
    reviewDiagnostics,
  );
  supervisor.setExecutor(
    async (task, worktreePath, prompt) => {
      const outcome = await supervisorRunner.execute(task, worktreePath, prompt);
      if (outcome?.usage) {
        await provider.recordUsage("supervisor", outcome.usage);
      }
      return outcome;
    },
    () => supervisorRunner.isBusy(),
    () => supervisorRunner.cancel(),
  );
  const supervisorTree = vscode.window.createTreeView(
    "cursorSubscription.supervisorTasks",
    { treeDataProvider: supervisor },
  );
  supervisor.attachTreeView(supervisorTree);

  context.subscriptions.push(
    output,
    runningSound,
    changeSessions,
    supervisor,
    supervisorRunner,
    reviewDiagnostics,
    provider,
    supervisorTree,
    vscode.window.registerTreeDataProvider(
      "cursorSubscription.changeSessions",
      changeSessions,
    ),
    vscode.workspace.registerTextDocumentContentProvider(
      "cursor-supervisor-preview",
      supervisor,
    ),
    vscode.languages.registerCodeLensProvider(
      { scheme: "cursor-supervisor-preview" },
      supervisor,
    ),
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new CursorAiCodeActionProvider(
        IS_JAPANESE,
        () => configuredAiFeatureEnabled("enableDiagnosticQuickFixes"),
      ),
      { providedCodeActionKinds: CursorAiCodeActionProvider.providedCodeActionKinds },
    ),
    vscode.languages.registerInlineCompletionItemProvider(
      { scheme: "file" },
      {
        provideInlineCompletionItems: (document, position, inlineContext, token) =>
          provider.provideInlineCompletionItems(document, position, inlineContext, token),
      },
    ),
    vscode.workspace.registerTextDocumentContentProvider(
      "cursor-ai-preview",
      provider.previewContentProvider(),
    ),
    vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("cursorSubscription.openChat", async () => {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    }),
    vscode.commands.registerCommand("cursorSubscription.openSettings", () =>
      vscode.commands.executeCommand(
        "workbench.action.openSettings",
        "@ext:ark4ez.cursor-subscription-for-vscode",
      )),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("cursorSubscription.enableAiNativeFeatures")
        || event.affectsConfiguration("cursorSubscription.enableChangeSessions")
      ) {
        changeSessions.refresh();
      }
      if (
        event.affectsConfiguration("cursorSubscription.enableAiNativeFeatures")
        || event.affectsConfiguration("cursorSubscription.enableAiReview")
      ) {
        if (!configuredAiFeatureEnabled("enableAiReview")) {
          reviewDiagnostics.clear();
        }
      }
    }),
    vscode.commands.registerCommand("cursorSubscription.setApiKey", () =>
      provider.promptForApiKey(),
    ),
    vscode.commands.registerCommand("cursorSubscription.clearApiKey", () =>
      provider.clearApiKey(),
    ),
    vscode.commands.registerCommand("cursorSubscription.newChat", () => provider.newChat()),
    vscode.commands.registerTextEditorCommand(
      "cursorSubscription.generateCode",
      (editor) => provider.generateCode(editor),
    ),
    vscode.commands.registerTextEditorCommand(
      "cursorSubscription.explainSelection",
      (editor) => provider.explainSelection(editor),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.addFileToChat",
      (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        const selected = Array.isArray(uris) && uris.length > 0
          ? uris
          : uri
            ? [uri]
            : vscode.window.activeTextEditor
              ? [vscode.window.activeTextEditor.document.uri]
              : [];
        return provider.addFilesToChat(selected);
      },
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.generateCommitMessage",
      (arg?: unknown) =>
        generateCommitMessage(
          context,
          resolveRootUri(arg),
          () => provider.promptForApiKey(),
          output,
          () => runningSound.start(),
          () => runningSound.playCompletion(),
        ),
    ),
    vscode.commands.registerCommand("cursorSubscription.createPullRequest", () =>
      provider.createPullRequestFromWorkspace()),
    vscode.commands.registerCommand("cursorSubscription.runAutopilot", () =>
      provider.runAutopilot()),
    vscode.commands.registerCommand(
      "cursorSubscription.fixDiagnostics",
      (uri: vscode.Uri, range: vscode.Range, diagnostics: vscode.Diagnostic[]) =>
        provider.fixDiagnostics(uri, range, diagnostics),
    ),
    vscode.commands.registerCommand("cursorSubscription.reviewChanges", () =>
      provider.reviewWorkspaceChanges()),
    vscode.commands.registerCommand("cursorSubscription.clearReview", () =>
      reviewDiagnostics.clear()),
    vscode.commands.registerCommand("cursorSubscription.debugContext", () =>
      provider.analyzeDebugContext()),
    vscode.commands.registerCommand("cursorSubscription.refreshProjectMemory", () =>
      provider.refreshProjectMemory()),
    vscode.commands.registerCommand("cursorSubscription.verifyChanges", () =>
      provider.verifyCurrentChanges()),
    vscode.commands.registerCommand("cursorSubscription.revertLastSession", (sessionId?: string) =>
      provider.revertLastSession(sessionId)),
    vscode.commands.registerCommand(
      "cursorSubscription.openSessionFile",
      (sessionId: string, file: string) => provider.openSessionFile(sessionId, file),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.keepSessionEdit",
      (target: { sessionId?: string; file?: string }) =>
        provider.keepSessionEdit(target?.sessionId, target?.file),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.restoreSessionEdit",
      (target: { sessionId?: string; file?: string }) =>
        provider.restoreSessionEdit(target?.sessionId, target?.file),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.keepAllSessionEdits",
      (sessionId?: string) => provider.keepAllSessionEdits(sessionId),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.restoreAllSessionEdits",
      (sessionId?: string) => provider.restoreAllSessionEdits(sessionId),
    ),
    vscode.commands.registerCommand("cursorSubscription.chooseSupervisorMode", () =>
      supervisor.chooseMode()),
    vscode.commands.registerCommand("cursorSubscription.createSupervisorTask", () =>
      supervisor.createManualTask()),
    vscode.commands.registerCommand("cursorSubscription.scanSupervisorDiagnostics", () =>
      supervisor.scanDiagnostics()),
    vscode.commands.registerCommand(
      "cursorSubscription.runSupervisorTask",
      (target?: SupervisorTaskTarget | string) => supervisor.runTask(target),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.openSupervisorChange",
      (target?: SupervisorTaskTarget) => supervisor.openChange(target),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.showSupervisorChangeReason",
      (target?: SupervisorTaskTarget) => supervisor.showChangeReason(target),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.applySupervisorChange",
      (target?: SupervisorTaskTarget) => supervisor.applyChange(target),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.discardSupervisorChange",
      (target?: SupervisorTaskTarget) => supervisor.discardChange(target),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.applyAllSupervisorChanges",
      (target?: SupervisorTaskTarget | string) => supervisor.applyAll(target),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.discardAllSupervisorChanges",
      (target?: SupervisorTaskTarget | string) => supervisor.discardAll(target),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.dismissSupervisorTask",
      (target?: SupervisorTaskTarget | string) => supervisor.dismissTask(target),
    ),
  );
}

export function deactivate(): void {
  // CursorChatProvider is disposed through ExtensionContext subscriptions.
}

class CursorChatProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly conversationStore: ConversationStore;
  private readonly webviewController: WebviewController;
  private readonly agentFactory: AgentFactory;
  private readonly attachmentService: AttachmentService;
  private readonly chatRuntimes = new Map<string, ChatRuntime>();
  private showingHome = true;
  private workspaceFileCache: PromiseLike<WorkspaceFileItem[]> | undefined;
  private workspaceFileCacheKey: string | undefined;
  private workspaceIndexGeneration = 0;
  private workspaceIndexRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private sandboxWarningPromise: Promise<boolean> | undefined;
  private readonly messageQueue: QueuedMessage[] = [];
  private readonly drainingConversations = new Set<string>();
  private readonly parallelTaskParticipants = new Set<string>();
  private readonly retainedParallelTasks = new Map<
    string,
    "completed" | "stopped" | "error"
  >();
  private readonly viewedRetainedParallelTasks = new Set<string>();
  private webviewReady = false;
  private readonly pendingChatFiles: string[] = [];
  private readonly repairAttempts = new Map<string, number>();
  private readonly sessionDecisionQueues = new Map<string, Promise<void>>();
  private readonly verifyingSessions = new Set<string>();
  private inlineCompletionBusy = false;
  private inlineCompletionCache:
    | { key: string; value: vscode.InlineCompletionItem[] }
    | undefined;
  private readonly previewContents = new Map<string, string>();
  private projectCommands: ProjectCommand[] = [];
  private bestOfNExperiments: BestOfNExperiment[];
  /** Workspace folder chosen for a new chat before the conversation is created. */
  private draftWorkspaceFolderUri: string | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly runningSound: RunningSoundController,
    private readonly changeSessions: ChangeSessionController,
    private readonly reviewDiagnostics: vscode.DiagnosticCollection,
  ) {
    this.conversationStore = new ConversationStore(context.workspaceState, CONVERSATIONS_KEY);
    this.webviewController = new WebviewController(
      context,
      IS_JAPANESE,
      SUPPORTS_LOCAL_SANDBOX,
      MAX_DROPPED_FILE_BYTES,
    );
    this.agentFactory = new AgentFactory({
      supportsLocalSandbox: SUPPORTS_LOCAL_SANDBOX,
      isJapanese: IS_JAPANESE,
      selectedApprovalMode: () => this.selectedApprovalMode(),
      selectedModel: () => this.selectedModelSelection(),
      saveConversations: () => this.saveConversations(),
      notifySandboxUnavailable: () => this.post({ type: "sandboxUnavailable" }),
    });
    this.attachmentService = new AttachmentService(
      context,
      IS_JAPANESE,
      () => this.saveConversations(),
    );
    this.bestOfNExperiments = context.workspaceState.get<BestOfNExperiment[]>(BEST_OF_N_KEY, []);
  }

  private get conversations(): Conversation[] {
    return this.conversationStore.items;
  }

  private get activeId(): string | undefined {
    return this.conversationStore.activeId;
  }

  private set activeId(value: string | undefined) {
    this.conversationStore.activeId = value;
  }

  public async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.webviewReady = false;
    this.webviewController.attach(view, () => {
      this.webviewReady = false;
    });

    view.webview.onDidReceiveMessage(
      async (raw: unknown) => {
        const message = parseWebviewMessage(raw);
        if (!message) {
          return;
        }
        switch (message.type) {
          case "ready":
            this.webviewReady = true;
            this.post({ type: "modelSelected", id: this.selectedModel() });
            this.post({ type: "approvalModeSelected", mode: this.selectedApprovalMode() });
            this.post({ type: "sandboxSupport", supported: SUPPORTS_LOCAL_SANDBOX });
            this.postNotificationAndSoundSettings();
            this.postWorkspaceLabel();
            this.postView();
            this.postUsageStats();
            this.postParallelState();
            {
              const generation = this.workspaceIndexGeneration;
              await this.publishWorkspaceFileIndex(generation);
              await this.publishIntegrationIndex(generation);
            }
            await this.publishAuthState();
            await this.flushPendingChatFiles();
            if (!SUPPORTS_LOCAL_SANDBOX) {
              void this.ensureSandboxWarningAcknowledged().catch((error) => {
                this.output.appendLine(
                  `[${new Date().toISOString()}] Could not show the Windows sandbox warning: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                );
              });
            }
            break;
          case "send":
            if (typeof message.prompt === "string") {
              if (typeof message.modelId === "string") {
                await this.storeModelSelection(message.modelId, message.modelParams);
              }
              await this.send(
                message.prompt.trim(),
                message.attachContext === true,
                Array.isArray(message.files)
                  ? message.files.filter((file): file is string => typeof file === "string")
                  : [],
                this.isRunProfile(message.profile) ? message.profile : "agent",
                Array.isArray(message.skills)
                  ? message.skills.filter((skill): skill is string => typeof skill === "string")
                  : [],
                undefined,
                undefined,
                undefined,
                false,
                false,
                typeof message.commandId === "string" ? message.commandId : undefined,
                message.includeProjectMemory !== false,
              );
              await this.drainMessageQueue();
            }
            break;
          case "queueMessage":
          case "interruptMessage":
            if (typeof message.prompt === "string") {
              if (typeof message.modelId === "string") {
                await this.storeModelSelection(message.modelId, message.modelParams);
              }
              await this.enqueueMessage(
                message.prompt.trim(),
                message.attachContext === true,
                Array.isArray(message.files)
                  ? message.files.filter((file): file is string => typeof file === "string")
                  : [],
                this.isRunProfile(message.profile) ? message.profile : "agent",
                Array.isArray(message.skills)
                  ? message.skills.filter((skill): skill is string => typeof skill === "string")
                  : [],
                message.type === "interruptMessage",
                undefined,
                false,
                undefined,
                typeof message.commandId === "string" ? message.commandId : undefined,
                message.includeProjectMemory !== false,
              );
            }
            break;
          case "removeQueuedMessage":
            if (typeof message.id === "string") {
              this.removeQueuedMessage(message.id);
            }
            break;
          case "pickImages":
            await this.pickImages(
              typeof message.requestId === "number" ? message.requestId : 0,
            );
            break;
          case "openSkillsFolder":
            await this.openSkillsFolder();
            break;
          case "openMcpSettings":
            await this.openMcpSettings();
            break;
          case "searchFiles":
            await this.searchWorkspaceFiles(
              typeof message.query === "string" ? message.query : "",
              typeof message.requestId === "number" ? message.requestId : 0,
            );
            break;
          case "resolveAttachments":
            await this.resolveAttachmentReferences(
              Array.isArray(message.references)
                ? message.references.filter(
                    (reference): reference is string => typeof reference === "string",
                  )
                : [],
              typeof message.requestId === "number" ? message.requestId : 0,
              this.attachmentService.parseDroppedFileUploads(message.uploads),
            );
            break;
          case "cancel":
            await this.cancel();
            break;
          case "cancelConversation":
            if (typeof message.id === "string") {
              await this.cancelConversation(message.id);
            }
            break;
          case "newChat":
            await this.newChat();
            break;
          case "showHome":
            this.dismissViewedParallelTaskWhenLeaving();
            this.activeId = undefined;
            this.showingHome = true;
            this.draftWorkspaceFolderUri = undefined;
            this.postView();
            this.postWorkspaceLabel();
            break;
          case "openConversation":
            if (typeof message.id === "string") {
              await this.openConversation(message.id);
            }
            break;
          case "deleteConversation":
            if (typeof message.id === "string") {
              await this.deleteConversation(message.id);
            }
            break;
          case "pinConversation":
            if (typeof message.id === "string") {
              await this.pinConversation(
                message.id,
                typeof message.pinned === "boolean" ? message.pinned : undefined,
              );
            }
            break;
          case "exportConversation":
            if (typeof message.id === "string") {
              await this.exportConversation(
                message.id,
                message.format === "json" ? "json" : "markdown",
              );
            }
            break;
          case "searchConversations":
            this.showingHome = true;
            this.activeId = undefined;
            this.draftWorkspaceFolderUri = undefined;
            this.postView(typeof message.query === "string" ? message.query : "");
            this.postWorkspaceLabel();
            break;
          case "startBestOfN":
            if (typeof message.prompt === "string") {
              await this.startBestOfN(
                message.prompt.trim(),
                message.attachContext === true,
                Array.isArray(message.files)
                  ? message.files.filter((file): file is string => typeof file === "string")
                  : [],
                this.isRunProfile(message.profile) ? message.profile : "agent",
                Array.isArray(message.skills)
                  ? message.skills.filter((skill): skill is string => typeof skill === "string")
                  : [],
                message.includeProjectMemory !== false,
              );
            }
            break;
          case "pickBestOfNWinner":
            if (typeof message.id === "string") {
              await this.pickBestOfNWinner(message.id);
            }
            break;
          case "compareBestOfN":
            if (typeof message.id === "string") {
              this.showingHome = true;
              this.activeId = undefined;
              this.postBestOfNCompare(message.id);
            }
            break;
          case "estimateContext":
            this.post({
              type: "contextPreview",
              ...buildContextPreview({
                prompt: typeof message.prompt === "string" ? message.prompt : "",
                profile: this.isRunProfile(message.profile) ? message.profile : "agent",
                includeProjectMemory: message.includeProjectMemory !== false,
                attachContext: message.attachContext === true,
                contextLabel: typeof message.path === "string" ? message.path : undefined,
                files: Array.isArray(message.files)
                  ? message.files.filter((file): file is string => typeof file === "string")
                  : [],
                skills: Array.isArray(message.skills)
                  ? message.skills.filter((skill): skill is string => typeof skill === "string")
                  : [],
                commandId: typeof message.commandId === "string" ? message.commandId : undefined,
                commandBodyLength: this.projectCommands.find(
                  (command) => command.id === message.commandId,
                )?.body.length,
              }),
            });
            break;
          case "getContext":
            this.postContextInfo();
            break;
          case "selectModel":
            if (typeof message.modelId === "string") {
              await this.storeModelSelection(message.modelId, message.modelParams);
            }
            break;
          case "openDiff":
            if (typeof message.path === "string") {
              await this.openDiff(message.path);
            }
            break;
          case "sandboxLearnMore":
            await this.showSandboxLimitationDetails();
            break;
          case "selectApprovalMode":
            if (this.isApprovalMode(message.approvalMode)) {
              const currentMode = this.selectedApprovalMode();
              if (
                !SUPPORTS_LOCAL_SANDBOX
                && message.approvalMode === "auto-review"
                && currentMode === "safe-worktree"
              ) {
                const enableLabel = localize(
                  "Use the workspace directly",
                  "ワークスペースを直接使用",
                );
                const answer = await vscode.window.showWarningMessage(
                  localize(
                    "This disables Safe worktree mode. Auto-review remains enabled, but tools will run against your workspace directly without filesystem or network isolation.",
                    "安全worktreeモードを無効にします。自動レビューは維持されますが、ファイルシステムやネットワークの隔離なしで、ツールがワークスペースを直接操作します。",
                  ),
                  { modal: true },
                  enableLabel,
                );
                if (answer !== enableLabel) {
                  this.post({ type: "approvalModeSelected", mode: currentMode });
                  break;
                }
              }
              if (
                message.approvalMode === "full-access"
                && currentMode !== "full-access"
              ) {
                const enableLabel = localize("Enable full access", "フルアクセスを有効化");
                const answer = await vscode.window.showWarningMessage(
                  localize(
                    "Full access runs tools without auto-review or sandbox restrictions. Enable it?",
                    "フルアクセスでは、自動レビューやサンドボックスの制限なしでツールを実行します。有効にしますか？",
                  ),
                  { modal: true },
                  enableLabel,
                );
                if (answer !== enableLabel) {
                  this.post({
                    type: "approvalModeSelected",
                    mode: this.selectedApprovalMode(),
                  });
                  break;
                }
              }
              await this.context.globalState.update(APPROVAL_MODE_KEY, message.approvalMode);
              await this.cancelAllChats();
              await this.disposeAgent();
              this.post({ type: "approvalModeSelected", mode: message.approvalMode });
            }
            break;
          case "setAlertSetting":
            if (
              typeof message.enabled === "boolean"
              && (
                message.setting === "notifyOnComplete"
                || message.setting === "playSoundWhileRunning"
                || message.setting === "playSoundOnComplete"
                || message.setting === "playSoundOnError"
              )
            ) {
              await this.updateAlertSetting(message.setting, message.enabled);
              this.postNotificationAndSoundSettings();
            }
            break;
          case "openFile":
            if (typeof message.path === "string") {
              await this.openFile(message.path);
            }
            break;
          case "openReferencedFile":
            if (typeof message.path === "string") {
              await this.openReferencedFile(message.path);
            }
            break;
          case "setApiKey":
            await this.promptForApiKey();
            break;
          case "clearApiKey":
            await this.clearApiKey();
            break;
          case "openDashboard":
            await vscode.env.openExternal(vscode.Uri.parse("https://cursor.com/dashboard"));
            break;
          case "openSettings":
            await vscode.commands.executeCommand(
              "workbench.action.openSettings",
              "@ext:ark4ez.cursor-subscription-for-vscode",
            );
            break;
          case "pickWorkspaceFolder":
            await this.pickChatWorkspaceFolder();
            break;
        }
      },
      undefined,
      this.disposables,
    );

    const fileWatcher = vscode.workspace.createFileSystemWatcher("**/*");
    const invalidateWorkspaceFiles = (): void => {
      this.scheduleWorkspaceIndexRefresh();
    };
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.postContextInfo();
        // Follow the active editor only when no conversation/draft root is pinned.
        if (!this.activeConversation()?.workspaceFolderUri && !this.draftWorkspaceFolderUri) {
          this.postWorkspaceLabel();
        }
      }),
      vscode.window.onDidChangeTextEditorSelection(() => this.postContextInfo()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => invalidateWorkspaceFiles()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration("cursorSubscription.notifyOnComplete")
          || event.affectsConfiguration("cursorSubscription.playSoundWhileRunning")
          || event.affectsConfiguration("cursorSubscription.playSoundOnComplete")
          || event.affectsConfiguration("cursorSubscription.playSoundOnError")
        ) {
          this.postNotificationAndSoundSettings();
        }
        if (event.affectsConfiguration("cursorSubscription.maxParallelChatAgents")) {
          this.postParallelState();
          void this.drainMessageQueue();
        }
      }),
      fileWatcher,
      fileWatcher.onDidCreate(invalidateWorkspaceFiles),
      fileWatcher.onDidDelete(invalidateWorkspaceFiles),
    );
  }

  public async promptForApiKey(): Promise<void> {
    const apiKey = await vscode.window.showInputBox({
      title: "Cursor API Key",
      prompt: localize(
        "Enter the user API key generated from API Keys in Cursor Dashboard",
        "Cursor Dashboard の API Keys で発行したユーザーAPIキーを入力してください",
      ),
      password: true,
      ignoreFocusOut: true,
      placeHolder: "crsr_…",
      validateInput: (value) =>
        value.trim().length < 20
          ? localize("Enter a valid Cursor API key", "有効なCursor APIキーを入力してください")
          : undefined,
    });

    if (apiKey === undefined) {
      return;
    }

    await this.cancelAllChats();
    await this.disposeAgent();
    await this.context.secrets.store(API_KEY_SECRET, apiKey.trim());
    await this.publishAuthState();
    void vscode.window.showInformationMessage(localize(
      "The Cursor API key was stored securely.",
      "Cursor APIキーを安全に保存しました。",
    ));
  }

  public async clearApiKey(): Promise<void> {
    const existing = await this.context.secrets.get(API_KEY_SECRET);
    if (!existing) {
      return;
    }

    const deleteLabel = localize("Delete", "削除");
    const answer = await vscode.window.showWarningMessage(
      localize("Delete the stored Cursor API key?", "保存済みのCursor APIキーを削除しますか？"),
      { modal: true },
      deleteLabel,
    );
    if (answer !== deleteLabel) {
      return;
    }

    await this.cancelAllChats();
    await this.disposeAgent();
    await this.context.secrets.delete(API_KEY_SECRET);
    await this.publishAuthState();
  }

  public previewContentProvider(): vscode.TextDocumentContentProvider {
    return {
      provideTextDocumentContent: (uri) => this.previewContents.get(uri.toString()) ?? "",
    };
  }

  public async runAutopilot(): Promise<void> {
    if (!this.ensureFeatureEnabled("enableAutopilot", "Autopilot")) {
      return;
    }
    const goal = await vscode.window.showInputBox({
      title: localize("Cursor: Autopilot Change", "Cursor: Autopilot変更"),
      prompt: localize(
        "Describe the outcome. Cursor will investigate, edit, verify, and prepare the change for review.",
        "実現したい結果を指示してください。調査・編集・検証・レビュー準備まで実行します。",
      ),
      ignoreFocusOut: true,
    });
    if (!goal?.trim()) {
      return;
    }
    const reviewChanges = this.featureEnabled("enableChangeSessions");
    const automaticVerification = this.featureEnabled("enableVerification")
      && this.alertConfiguration().get<boolean>("autoVerify", true);
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    await this.send(
      [
        goal.trim(),
        "",
        "Run this as an autonomous change session.",
        "Investigate the repository, make the smallest coherent implementation, and review the resulting diff.",
        automaticVerification
          ? reviewChanges
            ? "Do not run final validation; the extension will run it after the user accepts the proposed file changes."
            : "Do not run final validation; the extension will run it after the edit finishes."
          : "Run the relevant validation before reporting completion.",
        "Do not stop after describing code: complete the change and report remaining risks.",
      ].join("\n"),
      true,
      [],
      "multitask",
      [],
      undefined,
      undefined,
      undefined,
      false,
      reviewChanges,
    );
    await this.drainMessageQueue();
  }

  public async fixDiagnostics(
    uri: vscode.Uri,
    range: vscode.Range,
    diagnostics: readonly vscode.Diagnostic[],
  ): Promise<void> {
    if (!this.ensureFeatureEnabled("enableDiagnosticQuickFixes", "AI Quick Fix")) {
      return;
    }
    const document = await vscode.workspace.openTextDocument(uri);
    const safeRange = document.validateRange(range);
    const editorContext: EditorContextSnapshot = {
      filePath: vscode.workspace.asRelativePath(uri),
      languageId: document.languageId,
      startLine: safeRange.start.line + 1,
      endLine: safeRange.end.line + 1,
      selectedText: document.getText(safeRange),
    };
    const details = diagnostics.slice(0, 20).map((diagnostic) => {
      const source = diagnostic.source ? ` [${diagnostic.source}]` : "";
      return `- L${diagnostic.range.start.line + 1}${source}: ${diagnostic.message}`;
    });
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    await this.enqueueMessage(
      [
        "Fix the following editor diagnostics. Inspect related code before editing, preserve intended behavior, and add or update tests when appropriate.",
        ...details,
      ].join("\n"),
      true,
      [],
      "agent",
      [],
      false,
      editorContext,
    );
  }

  public async reviewWorkspaceChanges(): Promise<void> {
    if (!this.ensureFeatureEnabled("enableAiReview", localize("AI review", "AIレビュー"))) {
      return;
    }
    const workspace = resolveWorkspaceFolder(vscode.window.activeTextEditor?.document.uri)
      ?? await pickWorkspaceFolder(
        localize("Select a workspace to review", "レビューするワークスペースを選択"),
      );
    if (!workspace || this.anyChatBusy()) {
      return;
    }
    const apiKey = await this.context.secrets.get(API_KEY_SECRET);
    if (!apiKey) {
      await this.promptForApiKey();
      return;
    }

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: localize("Reviewing workspace changes…", "作業ツリーの変更をレビュー中…"),
        },
        async () => {
        const result = await Agent.prompt(
          [
            "Review the current git working-tree diff for correctness, regressions, security, performance, and missing tests.",
            "Read the relevant surrounding code. Do not edit files.",
            "Return ONLY a JSON array. Each item must be:",
            '{"file":"relative/path","line":1,"endLine":1,"severity":"error|warning|info|hint","message":"concise finding","code":"optional stable id","suggestion":"specific fix"}',
            "Use exact 1-based line numbers from the current working tree. Return [] when there are no actionable findings.",
          ].join("\n"),
          {
            apiKey,
            model: this.selectedModelSelection(),
            name: "VS Code: AI Review",
            mode: "plan",
            local: { cwd: workspace.uri.fsPath, settingSources: [] },
          },
        );
        if (result.status !== "finished") {
          throw new Error(this.formatRunFailure(result));
        }
        const findings = parseReviewFindings(result.result ?? "[]");
        await this.publishReviewFindings(workspace, findings);
        this.changeSessions.setPhase(findings.length > 0 ? "review" : "complete");
        void vscode.window.showInformationMessage(localize(
          findings.length === 0
            ? "AI review found no actionable issues."
            : `AI review published ${findings.length} finding(s) in Problems.`,
          findings.length === 0
            ? "AIレビューで指摘は見つかりませんでした。"
            : `AIレビューの指摘${findings.length}件をProblemsに表示しました。`,
        ));
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[${new Date().toISOString()}] AI review failed: ${message}`);
      void vscode.window.showErrorMessage(localize(
        `AI review failed: ${message}`,
        `AIレビューに失敗しました: ${message}`,
      ));
    }
  }

  public async analyzeDebugContext(): Promise<void> {
    if (!this.ensureFeatureEnabled("enableDebugContext", localize("Debug analysis", "デバッグ解析"))) {
      return;
    }
    const editor = vscode.window.activeTextEditor;
    const session = vscode.debug.activeDebugSession;
    const diagnostics = editor
      ? vscode.languages.getDiagnostics(editor.document.uri)
      : [];
    const breakpoints = vscode.debug.breakpoints.map((breakpoint) => {
      if (breakpoint instanceof vscode.SourceBreakpoint) {
        return `${vscode.workspace.asRelativePath(breakpoint.location.uri)}:${breakpoint.location.range.start.line + 1}`;
      }
      return breakpoint instanceof vscode.FunctionBreakpoint
        ? breakpoint.functionName
        : "data breakpoint";
    });
    const prompt = [
      "Investigate the current debugging context. Identify the likely root cause, inspect relevant code, and propose or implement a focused fix when the evidence is sufficient.",
      session ? `Debug session: ${session.name} (${session.type})` : "Debug session: not currently running",
      breakpoints.length > 0 ? `Breakpoints: ${breakpoints.join(", ")}` : undefined,
      diagnostics.length > 0
        ? `Editor diagnostics:\n${diagnostics.map((item) => `- ${item.message}`).join("\n")}`
        : undefined,
    ].filter((line): line is string => Boolean(line)).join("\n");
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    await this.enqueueMessage(
      prompt,
      Boolean(editor),
      [],
      "agent",
      [],
      false,
      editor ? this.captureEditorContext(editor) : undefined,
    );
  }

  public async refreshProjectMemory(): Promise<void> {
    if (!this.ensureFeatureEnabled("enableProjectMemory", localize("Project memory", "プロジェクト記憶"))) {
      return;
    }
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    await this.send(
      [
        "Inspect this repository and create or update .cursor/project-memory.md.",
        "Keep it concise and evidence-based. Record architecture, important entry points, validation commands, conventions, generated files, and areas that require caution.",
        "Preserve user-authored rules in .cursor/rules.md and do not copy secrets or transient details.",
      ].join("\n"),
      false,
      [],
      "agent",
      [],
    );
  }

  public async verifyCurrentChanges(sessionId?: string): Promise<VerificationResult | undefined> {
    if (!this.ensureFeatureEnabled("enableVerification", localize("Verification", "検証"))) {
      return undefined;
    }
    const sessionRoot = sessionId
      ? this.changeSessions.snapshot(sessionId)?.root
      : this.changeSessions.snapshot()?.root;
    const workspace = (sessionRoot
      ? resolveWorkspaceFolder(vscode.Uri.file(sessionRoot))
      : undefined)
      ?? resolveWorkspaceFolder(vscode.window.activeTextEditor?.document.uri)
      ?? await pickWorkspaceFolder(
        localize("Select a workspace to verify", "検証するワークスペースを選択"),
      );
    if (!workspace) {
      return undefined;
    }
    const configuration = this.alertConfiguration();
    this.changeSessions.setPhase("verify", sessionId);
    const result = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: localize("Verifying changes…", "変更を検証中…"),
      },
      () => runVerification(
        workspace.uri.fsPath,
        configuration.get<string[]>("verificationCommands", []),
        this.output,
      ),
    );
    this.changeSessions.setVerification(result, sessionId);
    const summary = this.formatVerificationSummary(result);
    this.output.appendLine(summary);
    void vscode.window.showInformationMessage(summary);
    return result;
  }

  public async revertLastSession(sessionId?: string): Promise<void> {
    if (!this.ensureFeatureEnabled("enableChangeSessions", localize("AI change sessions", "AI変更セッション"))) {
      return;
    }
    if (!this.changeSessions.canRevert(sessionId)) {
      void vscode.window.showWarningMessage(localize(
        "This session cannot be safely reverted.",
        "このセッションは安全に元に戻せません。",
      ));
      return;
    }
    const revertLabel = localize("Revert session", "セッションを元に戻す");
    const answer = await vscode.window.showWarningMessage(
      localize(
        "Restore tracked files and move files created by the last AI session to the Trash?",
        "追跡済みファイルを復元し、直前のAIセッションが作成したファイルをゴミ箱へ移動しますか？",
      ),
      { modal: true },
      revertLabel,
    );
    if (answer !== revertLabel) {
      return;
    }
    const result = await this.changeSessions.revert(sessionId);
    void vscode.window.showInformationMessage(localize(
      `Reverted ${result.restored.length + result.removed.length} file(s).`,
      `${result.restored.length + result.removed.length}ファイルを元に戻しました。`,
    ));
  }

  public async openSessionFile(sessionId: string, file: string): Promise<void> {
    const baseline = await this.changeSessions.baselineContent(sessionId, file);
    let current = "";
    try {
      current = new TextDecoder().decode(
        await vscode.workspace.fs.readFile(vscode.Uri.file(file)),
      );
    } catch {
      // Deleted files are represented by an empty current document.
    }
    const previewId = randomUUID();
    const fileName = path.basename(file);
    const baselineUri = vscode.Uri.from({
      scheme: "cursor-ai-preview",
      path: `/${previewId}/baseline/${fileName}`,
    });
    const currentUri = vscode.Uri.from({
      scheme: "cursor-ai-preview",
      path: `/${previewId}/current/${fileName}`,
    });
    this.previewContents.set(baselineUri.toString(), baseline);
    this.previewContents.set(currentUri.toString(), current);
    await vscode.commands.executeCommand(
      "vscode.diff",
      baselineUri,
      currentUri,
      localize(`${fileName} ↔ AI change`, `${fileName} ↔ AI変更`),
      { preview: true },
    );
  }

  public async keepSessionEdit(sessionId?: string, file?: string): Promise<void> {
    if (!sessionId || !file) {
      return;
    }
    await this.runSessionDecision(sessionId, async () => {
      this.changeSessions.keep(file, sessionId);
      await this.verifyAfterPendingReview(sessionId);
    });
  }

  public async restoreSessionEdit(sessionId?: string, file?: string): Promise<void> {
    if (!sessionId || !file) {
      return;
    }
    await this.runSessionDecision(sessionId, async () => {
      await this.changeSessions.restoreFile(file, sessionId);
      await this.verifyAfterPendingReview(sessionId);
    });
  }

  public async keepAllSessionEdits(sessionId?: string): Promise<void> {
    const resolvedId = sessionId ?? this.changeSessions.snapshot()?.id;
    if (!resolvedId) {
      return;
    }
    await this.runSessionDecision(resolvedId, async () => {
      this.changeSessions.keepAll(resolvedId);
      await this.verifyAfterPendingReview(resolvedId);
    });
  }

  public async restoreAllSessionEdits(sessionId?: string): Promise<void> {
    const resolvedId = sessionId ?? this.changeSessions.snapshot()?.id;
    if (!resolvedId) {
      return;
    }
    await this.runSessionDecision(resolvedId, async () => {
      await this.changeSessions.restorePending(resolvedId);
      await this.verifyAfterPendingReview(resolvedId);
    });
  }

  public async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _inlineContext: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[]> {
    const enabled = this.featureEnabled("enableInlineCompletions");
    if (!enabled || this.inlineCompletionBusy || this.anyChatBusy() || document.uri.scheme !== "file") {
      return [];
    }
    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
    if (linePrefix.trim().length < 3) {
      return [];
    }
    const key = `${document.uri.toString()}:${document.version}:${position.line}:${position.character}`;
    if (this.inlineCompletionCache?.key === key) {
      return this.inlineCompletionCache.value;
    }
    const apiKey = await this.context.secrets.get(API_KEY_SECRET);
    const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!apiKey || !workspace || token.isCancellationRequested) {
      return [];
    }

    this.inlineCompletionBusy = true;
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 350));
      if (token.isCancellationRequested) {
        return [];
      }
      const offset = document.offsetAt(position);
      const source = document.getText();
      const before = source.slice(Math.max(0, offset - 6_000), offset);
      const after = source.slice(offset, Math.min(source.length, offset + 2_000));
      const result = await Agent.prompt(
        [
          "Complete code at the cursor. Return only the text to insert, without Markdown or explanation.",
          "Prefer a short, high-confidence continuation. Return an empty string if intent is unclear.",
          `File: ${vscode.workspace.asRelativePath(document.uri)}`,
          `Language: ${document.languageId}`,
          "<before>",
          before,
          "</before>",
          "<after>",
          after,
          "</after>",
        ].join("\n"),
        {
          apiKey,
          model: this.selectedModelSelection(),
          name: "VS Code: Inline Completion",
          mode: "plan",
          local: { cwd: workspace.uri.fsPath, settingSources: [] },
        },
      );
      if (result.status !== "finished" || token.isCancellationRequested) {
        return [];
      }
      const completion = this.cleanGeneratedCode(result.result ?? "");
      const value = completion ? [new vscode.InlineCompletionItem(completion)] : [];
      this.inlineCompletionCache = { key, value };
      return value;
    } catch (error) {
      this.output.appendLine(
        `[${new Date().toISOString()}] Inline completion failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    } finally {
      this.inlineCompletionBusy = false;
    }
  }

  public async generateCode(editor: vscode.TextEditor): Promise<void> {
    if (editor.document.uri.scheme !== "file") {
      void vscode.window.showInformationMessage(localize(
        "Save the file before generating code.",
        "コードを生成する前にファイルを保存してください。",
      ));
      return;
    }

    const selection = new vscode.Range(editor.selection.start, editor.selection.end);
    const selectedText = editor.document.getText(selection);
    if (selectedText.length > MAX_EDITOR_GENERATION_CONTEXT) {
      void vscode.window.showWarningMessage(localize(
        "The selected code is too large to generate safely. Select a smaller range.",
        "選択範囲が大きすぎるため、安全にコードを生成できません。範囲を小さくしてください。",
      ));
      return;
    }

    const instruction = await vscode.window.showInputBox({
      title: localize("Cursor: Generate Code", "Cursor: コードを生成"),
      prompt: selection.isEmpty
        ? localize(
            "Describe the code to insert at the cursor.",
            "カーソル位置に挿入するコードを指示してください。",
          )
        : localize(
            "Describe how the selected code should be changed.",
            "選択したコードをどのように変更するか指示してください。",
          ),
      ignoreFocusOut: true,
    });
    if (!instruction?.trim()) {
      return;
    }

    let apiKey = await this.context.secrets.get(API_KEY_SECRET);
    if (!apiKey) {
      await this.promptForApiKey();
      apiKey = await this.context.secrets.get(API_KEY_SECRET);
      if (!apiKey) {
        return;
      }
    }

    const blockedProxy = detectBlockedProxyEnvironment();
    if (blockedProxy) {
      void vscode.window.showErrorMessage(this.formatBlockedProxyError(blockedProxy));
      return;
    }

    const document = editor.document;
    const documentVersion = document.version;
    const relativePath = vscode.workspace.asRelativePath(document.uri);
    const cursorOffset = document.offsetAt(selection.start);
    const selectionEndOffset = document.offsetAt(selection.end);
    const surroundingBudget = Math.max(
      0,
      MAX_EDITOR_GENERATION_CONTEXT - selectedText.length,
    );
    const contextPerSide = Math.floor(surroundingBudget / 2);
    const beforeStartOffset = Math.max(
      0,
      cursorOffset - contextPerSide,
    );
    const afterEndOffset = Math.min(
      document.getText().length,
      selectionEndOffset + contextPerSide,
    );
    const beforeText = document.getText(
      new vscode.Range(document.positionAt(beforeStartOffset), selection.start),
    );
    const afterText = document.getText(
      new vscode.Range(selection.end, document.positionAt(afterEndOffset)),
    );
    const task = selection.isEmpty
      ? [
          "Generate code to insert at the cursor according to the user's instruction.",
          "Use the surrounding code for context.",
        ]
      : [
          "Generate replacement code for the selected range according to the user's instruction.",
          "Preserve behavior outside the selected range.",
        ];
    const prompt = [
      ...task,
      "Return ONLY the code to insert. Do not use Markdown fences and do not add explanations.",
      "",
      `File: ${relativePath}`,
      `Language: ${document.languageId}`,
      `Instruction: ${instruction.trim()}`,
      "",
      "Code before the target:",
      "<before>",
      beforeText,
      "</before>",
      selection.isEmpty ? undefined : "Selected code:",
      selection.isEmpty ? undefined : "<selection>",
      selection.isEmpty ? undefined : selectedText,
      selection.isEmpty ? undefined : "</selection>",
      "Code after the target:",
      "<after>",
      afterText,
      "</after>",
    ].filter((line): line is string => line !== undefined).join("\n");

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: localize("Generating code…", "コードを生成中…"),
          cancellable: false,
        },
        async () => {
          const result = await Agent.prompt(prompt, {
            apiKey,
            model: this.selectedModelSelection(),
            name: "VS Code: Generate Code",
            mode: "plan",
            local: {
              cwd:
                vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ??
                path.dirname(document.uri.fsPath),
              settingSources: [],
            },
          });

          if (result.status === "error") {
            throw new Error(this.formatRunFailure(result));
          }
          if (result.status === "cancelled") {
            return;
          }

          const generatedCode = this.cleanGeneratedCode(result.result ?? "");
          if (!generatedCode) {
            throw new Error(localize(
              "The model returned empty code.",
              "モデルから空のコードが返されました。",
            ));
          }

          const currentDocument =
            vscode.workspace.textDocuments.find(
              (candidate) => candidate.uri.toString() === document.uri.toString(),
            ) ?? await vscode.workspace.openTextDocument(document.uri);
          if (currentDocument.version !== documentVersion) {
            throw new Error(localize(
              "The file changed while code was being generated. Run the command again.",
              "コードの生成中にファイルが変更されました。もう一度実行してください。",
            ));
          }

          if (this.featureEnabled("previewGeneratedCode")) {
            const fullText = currentDocument.getText();
            const previewText = `${fullText.slice(0, currentDocument.offsetAt(selection.start))}${generatedCode}${fullText.slice(currentDocument.offsetAt(selection.end))}`;
            const previewUri = vscode.Uri.from({
              scheme: "cursor-ai-preview",
              path: `/${randomUUID()}/${path.basename(document.uri.fsPath)}`,
            });
            this.previewContents.set(previewUri.toString(), previewText);
            await vscode.commands.executeCommand(
              "vscode.diff",
              document.uri,
              previewUri,
              localize(
                `${path.basename(document.uri.fsPath)} ↔ Cursor preview`,
                `${path.basename(document.uri.fsPath)} ↔ Cursorプレビュー`,
              ),
              { preview: true },
            );
            const applyLabel = localize("Apply", "適用");
            const decision = await vscode.window.showInformationMessage(
              localize(
                "Review the generated diff, then apply or discard it.",
                "生成された差分を確認し、適用するか破棄してください。",
              ),
              { modal: true },
              applyLabel,
              localize("Discard", "破棄"),
            );
            if (decision !== applyLabel) {
              return;
            }
            if (currentDocument.version !== documentVersion) {
              throw new Error(localize(
                "The file changed while the preview was open. Generate the change again.",
                "プレビュー中にファイルが変更されました。再度生成してください。",
              ));
            }
          }

          const edit = new vscode.WorkspaceEdit();
          edit.replace(document.uri, selection, generatedCode);
          const applied = await vscode.workspace.applyEdit(edit);
          if (!applied) {
            throw new Error(localize(
              "Could not apply the generated code.",
              "生成したコードを適用できませんでした。",
            ));
          }

          const end = this.positionAfterText(selection.start, generatedCode);
          const updatedEditor = await vscode.window.showTextDocument(document.uri, {
            preview: false,
            viewColumn: editor.viewColumn,
          });
          updatedEditor.selection = new vscode.Selection(end, end);
          updatedEditor.revealRange(new vscode.Range(selection.start, end));
        },
      );
    } catch (error) {
      const message =
        error instanceof CursorAgentError
          ? localize(
              `Could not start code generation: ${error.message}`,
              `コード生成を開始できませんでした: ${error.message}`,
            )
          : error instanceof Error
            ? error.message
            : String(error);
      this.output.appendLine(
        `[${new Date().toISOString()}] Code generation error: ${message}`,
      );
      void vscode.window.showErrorMessage(message);
    }
  }

  public async explainSelection(editor: vscode.TextEditor): Promise<void> {
    if (editor.selection.isEmpty) {
      void vscode.window.showInformationMessage(localize(
        "Select the code you want Cursor to explain.",
        "Cursorに説明してほしいコードを選択してください。",
      ));
      return;
    }

    const editorContext = this.captureEditorContext(editor);
    if (!editorContext?.selectedText) {
      return;
    }
    if (editorContext.selectedText.length > MAX_EDITOR_GENERATION_CONTEXT) {
      void vscode.window.showWarningMessage(localize(
        "The selected code is too large to explain safely. Select a smaller range.",
        "選択範囲が大きすぎるため、安全に説明できません。範囲を小さくしてください。",
      ));
      return;
    }

    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    await this.enqueueMessage(
      localize(
        "Explain what the selected code does, how it works, and any important caveats.",
        "選択したコードが何をしているのか、どのように動作するのか、注意点も含めて説明してください。",
      ),
      true,
      [],
      "agent",
      [],
      false,
      editorContext,
    );
  }

  public async createPullRequestFromWorkspace(): Promise<void> {
    const workspace = await pickWorkspaceFolder(
      localize("Select the repository for the pull request", "PRを作成するリポジトリを選択"),
    );
    if (!workspace) {
      return;
    }
    const title = await vscode.window.showInputBox({
      prompt: localize("Pull request title", "プルリクエストのタイトル"),
      value: this.activeConversation()?.title || "Cursor agent changes",
    });
    if (!title?.trim()) {
      return;
    }
    await this.offerCreatePullRequest(workspace.uri.fsPath, title.trim(), [], true);
  }

  private async offerCreatePullRequest(
    root: string,
    title: string,
    files: string[],
    force = false,
  ): Promise<void> {
    if (
      !force
      && !this.alertConfiguration().get<boolean>("offerPullRequestAfterVerify", true)
    ) {
      return;
    }
    const createLabel = localize("Create branch & PR", "ブランチとPRを作成");
    const answer = await vscode.window.showInformationMessage(
      localize(
        "Create a branch, commit, and open a pull request with gh?",
        "ブランチを切ってコミットし、gh でプルリクエストを作成しますか？",
      ),
      createLabel,
    );
    if (answer !== createLabel) {
      return;
    }
    try {
      const relativeFiles = files
        .map((file) => path.relative(root, file).replaceAll("\\", "/"))
        .filter((file) => isSafeRelativePath(file));
      const result = await createBranchCommitAndPullRequest({
        root,
        title,
        files: relativeFiles.length > 0 ? relativeFiles : undefined,
        japanese: IS_JAPANESE,
      });
      const openLabel = localize("Open pull request", "PRを開く");
      const followUp = result.url
        ? await vscode.window.showInformationMessage(
          localize(
            `Created ${result.branch}`,
            `${result.branch} を作成しました`,
          ),
          openLabel,
        )
        : undefined;
      if (followUp === openLabel && result.url) {
        await vscode.env.openExternal(vscode.Uri.parse(result.url));
      }
    } catch (error) {
      void vscode.window.showErrorMessage(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  public async newChat(): Promise<void> {
    this.dismissViewedParallelTaskWhenLeaving();
    this.activeId = undefined;
    this.showingHome = false;
    this.draftWorkspaceFolderUri = defaultWorkspaceFolder(
      vscode.window.activeTextEditor?.document.uri,
    )?.uri.toString();
    this.post({ type: "newChat" });
    this.postWorkspaceLabel();
    this.postQueueState();
  }

  public async startBestOfN(
    prompt: string,
    attachContext: boolean,
    files: string[],
    profile: RunProfile,
    skills: string[],
    includeProjectMemory = true,
  ): Promise<void> {
    const trimmed = prompt.trim();
    if (!trimmed) {
      return;
    }
    const count = Math.max(
      2,
      Math.min(this.alertConfiguration().get<number>("bestOfNCount", 3), 5),
    );
    const maximumParallelAgents = Math.max(
      1,
      this.alertConfiguration().get<number>("maxParallelChatAgents", 3),
    );
    const availableSlots = maximumParallelAgents - this.activeRunCount();
    if (availableSlots < 2) {
      this.post({
        type: "error",
        text: localize(
          "Need at least 2 free parallel slots for best-of-N. Wait for runs to finish or raise maxParallelChatAgents.",
          "best-of-Nには空き並列スロットが2つ以上必要です。完了を待つか maxParallelChatAgents を増やしてください。",
        ),
      });
      return;
    }
    const runCount = Math.min(count, availableSlots);
    const conversationIds: string[] = [];
    const workspaceFolderUri = this.resolveChatWorkspace()?.uri.toString();
    for (let index = 0; index < runCount; index += 1) {
      const conversation: Conversation = {
        id: randomUUID(),
        title: makeConversationTitle(`[B${index + 1}] ${trimmed}`),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        workspaceFolderUri,
        transcript: [],
      };
      this.conversations.unshift(conversation);
      conversationIds.push(conversation.id);
    }
    const experiment = createBestOfNExperiment(trimmed, conversationIds);
    for (const conversationId of conversationIds) {
      const conversation = this.conversations.find((item) => item.id === conversationId);
      if (conversation) {
        conversation.experimentGroupId = experiment.id;
      }
    }
    this.bestOfNExperiments = [experiment, ...this.bestOfNExperiments].slice(0, 20);
    await this.context.workspaceState.update(BEST_OF_N_KEY, this.bestOfNExperiments);
    await this.saveConversations();

    this.activeId = conversationIds[0];
    this.showingHome = false;
    this.draftWorkspaceFolderUri = undefined;
    this.postView();
    this.postWorkspaceLabel();

    for (const conversationId of conversationIds) {
      await this.enqueueMessage(
        trimmed,
        attachContext,
        files,
        profile,
        skills,
        false,
        undefined,
        false,
        conversationId,
        undefined,
        includeProjectMemory,
      );
    }
    void vscode.window.showInformationMessage(
      localize(
        `Started best-of-${runCount}. Compare the parallel chats and pick a winner from history when ready.`,
        `best-of-${runCount}を開始しました。並列チャットを比較し、履歴から勝者を選べます。`,
      ),
    );
  }

  private async pickBestOfNWinner(conversationId: string): Promise<void> {
    const conversation = this.conversations.find((item) => item.id === conversationId);
    if (!conversation?.experimentGroupId) {
      return;
    }
    const index = this.bestOfNExperiments.findIndex(
      (item) => item.id === conversation.experimentGroupId,
    );
    if (index < 0) {
      return;
    }
    const experiment = pickWinner(this.bestOfNExperiments[index], conversationId);
    this.bestOfNExperiments[index] = experiment;
    conversation.pinned = true;
    await this.context.workspaceState.update(BEST_OF_N_KEY, this.bestOfNExperiments);
    await this.saveConversations();
    const discardLabel = localize("Delete losing runs", "敗者の会話を削除");
    const answer = await vscode.window.showInformationMessage(
      localize(
        `Pinned the winning conversation from best-of-N.`,
        `best-of-Nの勝者会話をピン留めしました。`,
      ),
      discardLabel,
    );
    if (answer === discardLabel) {
      for (const loserId of experiment.conversationIds) {
        if (loserId !== conversationId) {
          await this.deleteConversation(loserId);
        }
      }
    }
    if (this.showingHome && !this.activeId) {
      this.postView();
    }
  }

  private postBestOfNCompare(experimentId: string): void {
    const experiment = this.bestOfNExperiments.find((item) => item.id === experimentId);
    if (!experiment) {
      return;
    }
    const runningIds = new Set(
      this.conversations
        .filter((conversation) => this.isConversationBusy(conversation.id))
        .map((conversation) => conversation.id),
    );
    this.post({
      type: "bestOfNCompare",
      experiment: {
        id: experiment.id,
        prompt: experiment.prompt,
        createdAt: experiment.createdAt,
        winnerId: experiment.winnerId,
        candidates: experimentCandidates(experiment, this.conversations, runningIds),
      },
    });
  }

  private postExperimentSummaries(): void {
    const runningIds = new Set(
      this.conversations
        .filter((conversation) => this.isConversationBusy(conversation.id))
        .map((conversation) => conversation.id),
    );
    const experiments = this.bestOfNExperiments
      .filter((experiment) =>
        experiment.conversationIds.some((id) =>
          this.conversations.some((conversation) => conversation.id === id)
        )
      )
      .slice(0, 10)
      .map((experiment) => ({
        id: experiment.id,
        prompt: experiment.prompt,
        createdAt: experiment.createdAt,
        winnerId: experiment.winnerId,
        candidateCount: experimentCandidates(experiment, this.conversations, runningIds).length,
      }));
    this.post({ type: "bestOfNExperiments", experiments });
  }

  public async addFilesToChat(uris: vscode.Uri[]): Promise<void> {
    const references: string[] = [];
    for (const uri of uris) {
      if (uri.scheme !== "file") {
        continue;
      }
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.File) !== 0) {
          references.push(uri.fsPath);
        }
      } catch {
        // Skip missing or inaccessible paths.
      }
    }

    if (references.length === 0) {
      void vscode.window.showWarningMessage(localize(
        "No files could be added to chat.",
        "チャットに追加できるファイルがありませんでした。",
      ));
      return;
    }

    this.pendingChatFiles.push(...references);
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    await this.flushPendingChatFiles();
  }

  private async flushPendingChatFiles(): Promise<void> {
    if (!this.webviewReady || this.pendingChatFiles.length === 0) {
      return;
    }
    const references = this.pendingChatFiles.splice(0);
    await this.resolveAttachmentReferences(references, Date.now());
  }

  private dismissViewedParallelTaskWhenLeaving(nextConversationId?: string): void {
    const previousId = this.activeId;
    if (
      previousId
      && previousId !== nextConversationId
      && this.retainedParallelTasks.has(previousId)
      && this.viewedRetainedParallelTasks.has(previousId)
    ) {
      this.retainedParallelTasks.delete(previousId);
      this.viewedRetainedParallelTasks.delete(previousId);
    }
  }

  private retainFinishedParallelTask(
    conversationId: string,
    status: "completed" | "stopped" | "error",
  ): void {
    if (!this.parallelTaskParticipants.delete(conversationId)) {
      return;
    }
    this.retainedParallelTasks.set(conversationId, status);
    if (this.activeId === conversationId) {
      this.viewedRetainedParallelTasks.add(conversationId);
    }
  }

  private async openConversation(id: string): Promise<void> {
    const conversation = this.conversations.find((c) => c.id === id);
    if (!conversation) {
      return;
    }
    this.dismissViewedParallelTaskWhenLeaving(id);
    this.activeId = id;
    this.showingHome = false;
    this.draftWorkspaceFolderUri = undefined;
    if (this.retainedParallelTasks.has(id)) {
      this.viewedRetainedParallelTasks.add(id);
    }
    this.postView();
    this.postWorkspaceLabel();
  }

  private async deleteConversation(id: string): Promise<void> {
    const deletedConversation = this.conversations.find((c) => c.id === id);
    const wasActive = this.activeId === id;
    await this.cancelConversation(id);
    await this.disposeAgent(id);
    for (let index = this.messageQueue.length - 1; index >= 0; index -= 1) {
      if (this.messageQueue[index].conversationId === id) {
        this.messageQueue.splice(index, 1);
      }
    }
    this.conversationStore.remove(id);
    this.parallelTaskParticipants.delete(id);
    this.retainedParallelTasks.delete(id);
    this.viewedRetainedParallelTasks.delete(id);
    if (wasActive) {
      this.showingHome = true;
    }
    if (deletedConversation?.attachmentRoot) {
      const storageRoot = path.resolve(this.context.globalStorageUri.fsPath);
      const attachmentRoot = path.resolve(deletedConversation.attachmentRoot);
      const relative = path.relative(storageRoot, attachmentRoot);
      if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
        try {
          await vscode.workspace.fs.delete(vscode.Uri.file(attachmentRoot), { recursive: true });
        } catch {
          // The managed attachment copy may already have been removed.
        }
      }
    }
    await this.saveConversations();
    if (!this.activeId) {
      this.postView();
    }
  }

  public async dispose(): Promise<void> {
    this.workspaceIndexGeneration += 1;
    if (this.workspaceIndexRefreshTimer) {
      clearTimeout(this.workspaceIndexRefreshTimer);
      this.workspaceIndexRefreshTimer = undefined;
    }
    await this.cancelAllChats();
    await this.disposeAgent();
    await this.attachmentService.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
  }

  private selectedModel(): string {
    return this.context.globalState.get<string>(MODEL_KEY, DEFAULT_MODEL);
  }

  private cleanGeneratedCode(raw: string): string {
    const trimmed = raw.trim();
    const fenced = trimmed.match(/^```(?:[^\r\n]*)\r?\n([\s\S]*?)\r?\n```$/);
    if (fenced) {
      return fenced[1];
    }
    return raw
      .replace(/^(?:\r?\n)+/, "")
      .replace(/(?:\r?\n)+$/, "");
  }

  private positionAfterText(start: vscode.Position, text: string): vscode.Position {
    const lines = text.split(/\r?\n/);
    return lines.length === 1
      ? start.translate(0, lines[0].length)
      : new vscode.Position(start.line + lines.length - 1, lines.at(-1)?.length ?? 0);
  }

  private async publishReviewFindings(
    workspace: vscode.WorkspaceFolder,
    findings: readonly ReviewFinding[],
  ): Promise<void> {
    this.reviewDiagnostics.clear();
    const grouped = new Map<string, vscode.Diagnostic[]>();
    const severityMap: Record<ReviewFinding["severity"], vscode.DiagnosticSeverity> = {
      error: vscode.DiagnosticSeverity.Error,
      warning: vscode.DiagnosticSeverity.Warning,
      info: vscode.DiagnosticSeverity.Information,
      hint: vscode.DiagnosticSeverity.Hint,
    };
    const root = path.resolve(workspace.uri.fsPath);
    for (const finding of findings) {
      const absolute = path.resolve(root, finding.file);
      const relative = path.relative(root, absolute);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        continue;
      }
      let document: vscode.TextDocument;
      try {
        document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
      } catch {
        continue;
      }
      const startLine = Math.max(0, Math.min(document.lineCount - 1, finding.line - 1));
      const endLine = Math.max(
        startLine,
        Math.min(document.lineCount - 1, (finding.endLine ?? finding.line) - 1),
      );
      const range = new vscode.Range(
        new vscode.Position(startLine, 0),
        document.lineAt(endLine).range.end,
      );
      const message = finding.suggestion
        ? `${finding.message}\nSuggestion: ${finding.suggestion}`
        : finding.message;
      const diagnostic = new vscode.Diagnostic(range, message, severityMap[finding.severity]);
      diagnostic.source = "Cursor AI Review";
      diagnostic.code = finding.code;
      const key = document.uri.toString();
      const entries = grouped.get(key) ?? [];
      entries.push(diagnostic);
      grouped.set(key, entries);
    }
    for (const [uri, diagnostics] of grouped) {
      this.reviewDiagnostics.set(vscode.Uri.parse(uri), diagnostics);
    }
  }

  private formatVerificationSummary(result: VerificationResult): string {
    if (result.skipped) {
      return localize(
        "Verification skipped: no configured or detected commands.",
        "検証をスキップしました: 実行できるコマンドが見つかりません。",
      );
    }
    const passed = result.steps.filter((step) => step.success).length;
    return result.success
      ? localize(
          `Verification passed (${passed}/${result.steps.length}).`,
          `検証に成功しました (${passed}/${result.steps.length})。`,
        )
      : localize(
          `Verification failed (${passed}/${result.steps.length}). See Cursor Agent output for details.`,
          `検証に失敗しました (${passed}/${result.steps.length})。詳細はCursor Agent出力を確認してください。`,
        );
  }

  private captureEditorContext(editor: vscode.TextEditor): EditorContextSnapshot | undefined {
    if (editor.document.uri.scheme !== "file") {
      return undefined;
    }
    const selection = editor.selection;
    return {
      filePath: vscode.workspace.asRelativePath(editor.document.uri),
      languageId: editor.document.languageId,
      startLine: selection.isEmpty ? undefined : selection.start.line + 1,
      endLine: selection.isEmpty ? undefined : selection.end.line + 1,
      selectedText: selection.isEmpty
        ? undefined
        : editor.document.getText(selection),
    };
  }

  private storedModelParams(): Record<string, ModelParameterValue[]> {
    return this.context.globalState.get<Record<string, ModelParameterValue[]>>(
      MODEL_PARAMS_KEY,
      {},
    );
  }

  private async storeModelSelection(
    modelId: string,
    rawParams: { id?: unknown; value?: unknown }[] | undefined,
  ): Promise<void> {
    const params = Array.isArray(rawParams)
      ? rawParams
          .filter(
            (param): param is { id: string; value: string } =>
              typeof param.id === "string" && typeof param.value === "string",
          )
          .map(({ id, value }) => ({ id, value }))
      : [];
    const allParams = this.storedModelParams();
    allParams[modelId] = params;
    await Promise.all([
      this.context.globalState.update(MODEL_KEY, modelId),
      this.context.globalState.update(MODEL_PARAMS_KEY, allParams),
    ]);
  }

  private selectedModelSelection(): ModelSelection {
    const id = this.selectedModel();
    const params = this.storedModelParams()[id];
    return { id, params: params?.length ? params : undefined };
  }

  private isApprovalMode(value: unknown): value is ApprovalMode {
    return value === "safe-worktree"
      || value === "auto-review"
      || value === "full-access";
  }

  private selectedApprovalMode(): ApprovalMode {
    const fallback = defaultSafetyApprovalMode(SUPPORTS_LOCAL_SANDBOX);
    const stored = this.context.globalState.get<string>(APPROVAL_MODE_KEY, fallback);
    if (SUPPORTS_LOCAL_SANDBOX && stored === "safe-worktree") {
      return "auto-review";
    }
    return this.isApprovalMode(stored) ? stored : fallback;
  }

  private ensureSandboxWarningAcknowledged(): Promise<boolean> {
    if (SUPPORTS_LOCAL_SANDBOX) {
      return Promise.resolve(true);
    }
    if (this.context.globalState.get<boolean>(SANDBOX_WARNING_ACK_KEY, false)) {
      return Promise.resolve(true);
    }
    this.sandboxWarningPromise ??= (async () => {
      const acknowledgeLabel = localize("I understand", "理解しました");
      const answer = await vscode.window.showWarningMessage(
        localize(
          "Windows does not support Cursor's local sandbox. Safe worktree mode is enabled by default to keep agent edits away from your active workspace until the run completes, but the host filesystem and network are not OS-isolated.",
          "WindowsではCursorのローカルサンドボックスを利用できません。エージェントの編集を実行完了まで作業中のワークスペースから分離する安全worktreeモードが既定で有効ですが、ホストのファイルシステムとネットワークはOSレベルで隔離されません。",
        ),
        { modal: true },
        acknowledgeLabel,
      );
      if (answer !== acknowledgeLabel) {
        return false;
      }
      await this.context.globalState.update(SANDBOX_WARNING_ACK_KEY, true);
      return true;
    })().finally(() => {
      this.sandboxWarningPromise = undefined;
    });
    return this.sandboxWarningPromise;
  }

  private isRunProfile(value: unknown): value is RunProfile {
    return value === "agent"
      || value === "plan"
      || value === "multitask";
  }

  private activeConversation(): Conversation | undefined {
    return this.conversationStore.active();
  }

  private runtimeFor(conversationId: string): ChatRuntime {
    let runtime = this.chatRuntimes.get(conversationId);
    if (!runtime) {
      runtime = new ChatRuntime();
      this.chatRuntimes.set(conversationId, runtime);
    }
    return runtime;
  }

  private isConversationBusy(conversationId: string | undefined): boolean {
    return Boolean(conversationId && this.chatRuntimes.get(conversationId)?.busy);
  }

  private activeRunCount(): number {
    return [...this.chatRuntimes.values()].filter((runtime) => runtime.busy).length;
  }

  private anyChatBusy(): boolean {
    return this.activeRunCount() > 0;
  }

  private conversationSummaries(query = ""): Array<{
    id: string;
    title: string;
    updatedAt: number;
    running: boolean;
    queued: boolean;
    pinned: boolean;
    totalTokens: number;
    experimentGroupId?: string;
  }> {
    const normalized = query.trim().toLowerCase();
    return [...this.conversations]
      .filter((conversation) => {
        if (!normalized) {
          return true;
        }
        if (conversation.title.toLowerCase().includes(normalized)) {
          return true;
        }
        return conversation.transcript.some((entry) =>
          entry.text.toLowerCase().includes(normalized)
        );
      })
      .sort((a, b) => {
        if (Boolean(a.pinned) !== Boolean(b.pinned)) {
          return a.pinned ? -1 : 1;
        }
        return b.updatedAt - a.updatedAt;
      })
      .map(({ id, title, updatedAt, pinned, tokenUsage, experimentGroupId }) => ({
        id,
        title,
        updatedAt,
        running: this.isConversationBusy(id),
        queued: this.messageQueue.some((item) => item.conversationId === id),
        pinned: pinned === true,
        totalTokens: tokenUsage?.totalTokens ?? 0,
        experimentGroupId,
      }));
  }

  private async saveConversations(): Promise<void> {
    await this.conversationStore.save();
    this.postUsageStats();
  }

  public async recordUsage(source: UsageSource, usage: StoredTokenUsage): Promise<void> {
    const ledger = this.context.workspaceState.get<UsageLedger>(USAGE_LEDGER_KEY);
    await this.context.workspaceState.update(
      USAGE_LEDGER_KEY,
      recordUsage(ledger, source, usage),
    );
    this.postUsageStats();
  }

  private usageSummary(): UsageSummary {
    return summarizeUsage(
      this.conversations,
      this.context.workspaceState.get<UsageLedger>(USAGE_LEDGER_KEY),
    );
  }

  private postUsageStats(): void {
    this.post({ type: "usageStats", summary: this.usageSummary() });
  }

  private postView(searchQuery = ""): void {
    const active = this.activeConversation();
    if (active) {
      const runtime = this.chatRuntimes.get(active.id);
      const entries = [...active.transcript];
      if (runtime?.live) {
        entries.push(runtime.live.userEntry, {
          role: "assistant",
          text: runtime.live.assistantText,
          files: [...runtime.live.editedFiles],
          progress: [...runtime.live.progressSteps.values()],
          progressState: runtime.live.progressState,
        });
      }
      this.post({ type: "chat", entries, running: runtime?.busy === true });
    } else if (this.showingHome) {
      this.post({
        type: "home",
        conversations: this.conversationSummaries(searchQuery),
        searchQuery,
      });
      this.postUsageStats();
      this.postExperimentSummaries();
    } else {
      this.post({ type: "newChat" });
    }
    this.postQueueState();
  }

  private async pinConversation(id: string, pinned?: boolean): Promise<void> {
    const conversation = this.conversations.find((item) => item.id === id);
    if (!conversation) {
      return;
    }
    conversation.pinned = pinned ?? !conversation.pinned;
    conversation.updatedAt = Date.now();
    await this.saveConversations();
    if (this.showingHome && !this.activeId) {
      this.postView();
    }
  }

  private async exportConversation(id: string, format: "markdown" | "json" = "markdown"): Promise<void> {
    const conversation = this.conversations.find((item) => item.id === id);
    if (!conversation) {
      return;
    }
    const defaultName = conversation.title
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
      .slice(0, 60) || "conversation";
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`${defaultName}.${format === "json" ? "json" : "md"}`),
      filters: format === "json"
        ? { JSON: ["json"] }
        : { Markdown: ["md"] } satisfies Record<string, string[]>,
    });
    if (!target) {
      return;
    }
    const body = format === "json"
      ? Buffer.from(JSON.stringify({
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        pinned: conversation.pinned === true,
        tokenUsage: conversation.tokenUsage,
        transcript: conversation.transcript,
      }, null, 2), "utf8")
      : Buffer.from(this.conversationToMarkdown(conversation), "utf8");
    await vscode.workspace.fs.writeFile(target, body);
    void vscode.window.showInformationMessage(
      localize(
        `Exported conversation to ${target.fsPath}`,
        `会話を書き出しました: ${target.fsPath}`,
      ),
    );
  }

  private conversationToMarkdown(conversation: Conversation): string {
    const lines = [
      `# ${conversation.title}`,
      "",
      `- Created: ${new Date(conversation.createdAt).toISOString()}`,
      `- Updated: ${new Date(conversation.updatedAt).toISOString()}`,
      `- Tokens: ${conversation.tokenUsage?.totalTokens ?? 0}`,
      "",
    ];
    for (const entry of conversation.transcript) {
      lines.push(`## ${entry.role === "user" ? "User" : "Assistant"}`);
      lines.push("");
      lines.push(entry.text);
      lines.push("");
      if (entry.files?.length) {
        lines.push("Edited files:");
        for (const file of entry.files) {
          lines.push(`- ${file}`);
        }
        lines.push("");
      }
    }
    return lines.join("\n");
  }

  private ensureConversation(prompt: string): Conversation {
    const existing = this.activeConversation();
    if (existing) {
      return existing;
    }
    const workspace = this.resolveChatWorkspace();
    const conversation = this.conversationStore.create(
      prompt,
      workspace?.uri.toString(),
    );
    this.draftWorkspaceFolderUri = undefined;
    this.showingHome = false;
    return conversation;
  }

  private resolveChatWorkspace(
    conversation?: Conversation,
  ): vscode.WorkspaceFolder | undefined {
    const target = conversation ?? this.activeConversation();
    if (target?.workspaceFolderUri) {
      const matched = workspaceFolderFromUri(target.workspaceFolderUri);
      if (matched) {
        return matched;
      }
    }
    if (!target && this.draftWorkspaceFolderUri) {
      const draft = workspaceFolderFromUri(this.draftWorkspaceFolderUri);
      if (draft) {
        return draft;
      }
    }
    return defaultWorkspaceFolder(vscode.window.activeTextEditor?.document.uri);
  }

  private async bindConversationWorkspace(
    conversation: Conversation,
  ): Promise<vscode.WorkspaceFolder | undefined> {
    const workspace = this.resolveChatWorkspace(conversation);
    if (!workspace) {
      return undefined;
    }
    const uri = workspace.uri.toString();
    if (conversation.workspaceFolderUri !== uri) {
      conversation.workspaceFolderUri = uri;
      conversation.updatedAt = Date.now();
      await this.saveConversations();
    }
    return workspace;
  }

  private postWorkspaceLabel(): void {
    const conversation = this.activeConversation();
    const workspace = this.resolveChatWorkspace(conversation);
    const folders = vscode.workspace.workspaceFolders ?? [];
    this.post({
      type: "workspace",
      name: workspace?.name ?? workspaceDisplayName(),
      selectable: folders.length > 1,
      path: workspace?.uri.fsPath,
    });
  }

  private async pickChatWorkspaceFolder(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length <= 1) {
      return;
    }
    const conversation = this.activeConversation();
    if (conversation && this.isConversationBusy(conversation.id)) {
      void vscode.window.showWarningMessage(localize(
        "Stop the current agent run before changing the workspace folder.",
        "ワークスペースを変更する前に、実行中のAgentを停止してください。",
      ));
      return;
    }
    const picked = await pickWorkspaceFolder(
      localize(
        "Select a workspace folder for this chat",
        "このチャットのワークスペースを選択",
      ),
    );
    if (!picked) {
      return;
    }
    if (conversation) {
      conversation.workspaceFolderUri = picked.uri.toString();
      conversation.updatedAt = Date.now();
      await this.saveConversations();
      await this.disposeAgent(conversation.id);
    } else {
      this.draftWorkspaceFolderUri = picked.uri.toString();
    }
    this.postWorkspaceLabel();
  }

  private postIfActive(conversationId: string, message: Record<string, unknown>): void {
    if (this.activeId === conversationId) {
      this.post(message);
    }
  }

  private postQueueState(): void {
    const conversationId = this.activeId;
    const items = conversationId
      ? this.messageQueue
          .filter((item) => item.conversationId === conversationId)
          .map(({ id, prompt, kind }) => ({ id, prompt, kind }))
      : [];
    this.post({ type: "queueState", items });
    this.postParallelState();
  }

  private postParallelState(): void {
    const queueCounts = new Map<string, number>();
    for (const item of this.messageQueue) {
      queueCounts.set(item.conversationId, (queueCounts.get(item.conversationId) ?? 0) + 1);
    }
    const liveTaskIds = this.conversations
      .filter((conversation) => (
        this.isConversationBusy(conversation.id)
        || (queueCounts.get(conversation.id) ?? 0) > 0
      ))
      .map((conversation) => conversation.id);
    if (liveTaskIds.length > 1) {
      for (const conversationId of liveTaskIds) {
        this.parallelTaskParticipants.add(conversationId);
      }
    }
    const tasks = this.conversations
      .map((conversation) => {
        const running = this.isConversationBusy(conversation.id);
        const queueCount = queueCounts.get(conversation.id) ?? 0;
        const retainedStatus = this.retainedParallelTasks.get(conversation.id);
        const status = conversationRunState({
          busy: running,
          pendingCancel: this.chatRuntimes.get(conversation.id)?.pendingCancel === true,
          queueCount,
        }) === "cancelling"
          ? "running"
          : running
            ? "running"
            : queueCount > 0
              ? "queued"
              : retainedStatus;
        return {
          id: conversation.id,
          title: conversation.title,
          status,
          queueCount,
          active: this.activeId === conversation.id,
          updatedAt: conversation.updatedAt,
          visible: status !== undefined,
        };
      })
      .filter((task) => task.visible)
      .sort((a, b) => {
        const statusOrder: Record<string, number> = {
          running: 0,
          queued: 1,
          error: 2,
          stopped: 3,
          completed: 4,
        };
        const order = statusOrder[a.status ?? "completed"] - statusOrder[b.status ?? "completed"];
        if (order !== 0) {
          return order;
        }
        return b.updatedAt - a.updatedAt;
      })
      .map(({ visible: _visible, updatedAt: _updatedAt, ...task }) => task);
    this.post({
      type: "parallelState",
      activeRuns: this.activeRunCount(),
      maximumRuns: this.alertConfiguration().get<number>("maxParallelChatAgents", 3),
      activeConversationId: this.activeId,
      tasks,
    });
  }

  private postNotificationAndSoundSettings(): void {
    const configuration = this.alertConfiguration();
    const notificationConfigured = configuration.get<boolean>("notifyOnComplete", true);
    const runningConfigured = configuration.get<boolean>("playSoundWhileRunning", true);
    const completionConfigured = configuration.get<boolean>("playSoundOnComplete", true);
    const errorConfigured = configuration.get<boolean>("playSoundOnError", true);
    const enabled = runningConfigured && process.platform !== "win32";
    const completionEnabled = completionConfigured && process.platform !== "win32";
    const errorEnabled = errorConfigured && process.platform !== "win32";
    this.post({
      type: "notificationAndSoundSettings",
      notification: notificationConfigured,
      running: runningConfigured,
      completion: completionConfigured,
      error: errorConfigured,
      webviewPlayback: process.platform !== "win32",
    });
    this.post({ type: "runningSoundSetting", enabled });
    this.post({ type: "completionSoundSetting", enabled: completionEnabled });
    this.post({ type: "errorSoundSetting", enabled: errorEnabled });
  }

  private alertConfiguration(): vscode.WorkspaceConfiguration {
    return configurationFor("cursorSubscription");
  }

  private featureEnabled(setting: AiFeatureSetting): boolean {
    return configuredAiFeatureEnabled(setting);
  }

  private ensureFeatureEnabled(setting: AiFeatureSetting, featureName: string): boolean {
    if (this.featureEnabled(setting)) {
      return true;
    }
    const openLabel = localize("Open settings", "設定を開く");
    void vscode.window.showInformationMessage(
      localize(
        `${featureName} is disabled in Cursor Subscription settings.`,
        `${featureName}はCursor Subscriptionの設定で無効になっています。`,
      ),
      openLabel,
    ).then((answer) => {
      if (answer === openLabel) {
        void vscode.commands.executeCommand("cursorSubscription.openSettings");
      }
    });
    return false;
  }

  private async updateAlertSetting(setting: string, enabled: boolean): Promise<void> {
    const configuration = this.alertConfiguration();
    const inspected = configuration.inspect<boolean>(setting);
    const target = inspected?.workspaceFolderValue !== undefined
      ? vscode.ConfigurationTarget.WorkspaceFolder
      : inspected?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await configuration.update(setting, enabled, target);
  }

  private async enqueueMessage(
    prompt: string,
    attachContext: boolean,
    files: string[],
    profile: RunProfile,
    skills: string[],
    interrupt: boolean,
    editorContext?: EditorContextSnapshot,
    internalRepair = false,
    targetConversationId?: string,
    commandId?: string,
    includeProjectMemory = true,
  ): Promise<void> {
    if (!prompt && !commandId) {
      return;
    }

    const conversationId = targetConversationId ?? this.activeId;
    if (!conversationId) {
      await this.send(
        prompt,
        attachContext,
        files,
        profile,
        skills,
        undefined,
        undefined,
        editorContext,
        internalRepair,
        false,
        commandId,
        includeProjectMemory,
      );
      await this.drainMessageQueue();
      return;
    }

    const item: QueuedMessage = {
      id: randomUUID(),
      conversationId,
      prompt,
      attachContext,
      files,
      profile,
      skills,
      model: this.selectedModelSelection(),
      kind: interrupt ? "interrupt" : "queued",
      editorContext,
      internalRepair: internalRepair || undefined,
      commandId,
      includeProjectMemory,
    };
    this.messageQueue.splice(
      0,
      this.messageQueue.length,
      ...enqueueChatMessage(this.messageQueue, item),
    );
    this.postQueueState();

    if (shouldCancelOnInterrupt(this.isConversationBusy(conversationId), item.kind)) {
      await this.cancelConversation(conversationId, false);
    }
    if (!this.isConversationBusy(conversationId)) {
      await this.drainMessageQueue(conversationId);
    }
  }

  private removeQueuedMessage(id: string): void {
    const next = removeQueuedMessages(this.messageQueue, (item) => item.id === id);
    if (next.length === this.messageQueue.length) {
      return;
    }
    this.messageQueue.splice(0, this.messageQueue.length, ...next as QueuedMessage[]);
    this.postQueueState();
  }

  private async drainMessageQueue(conversationId?: string): Promise<void> {
    if (!conversationId) {
      const conversationIds = [...new Set(this.messageQueue.map((item) => item.conversationId))];
      await Promise.all(conversationIds.map((id) => this.drainMessageQueue(id)));
      return;
    }
    if (
      this.drainingConversations.has(conversationId)
      || this.isConversationBusy(conversationId)
    ) {
      return;
    }
    this.drainingConversations.add(conversationId);
    try {
      while (!this.isConversationBusy(conversationId)) {
        const maximumParallelAgents = this.alertConfiguration()
          .get<number>("maxParallelChatAgents", 3);
        if (this.activeRunCount() >= Math.max(1, maximumParallelAgents)) {
          break;
        }
        const index = this.messageQueue.findIndex((item) => item.conversationId === conversationId);
        if (index < 0) {
          break;
        }
        const [item] = this.messageQueue.splice(index, 1);
        const conversation = this.conversations.find(
          (candidate) => candidate.id === item.conversationId,
        );
        this.postQueueState();
        if (!conversation) {
          continue;
        }
        this.postIfActive(item.conversationId, {
          type: "queuedStarted",
          prompt: item.prompt,
          files: item.files,
          kind: item.kind,
        });
        await this.send(
          item.prompt,
          item.attachContext,
          item.files,
          item.profile,
          item.skills,
          item.conversationId,
          item.model,
          item.editorContext,
          item.internalRepair === true,
          false,
          item.commandId,
          item.includeProjectMemory !== false,
        );
      }
    } finally {
      this.drainingConversations.delete(conversationId);
    }
  }

  private async send(
    prompt: string,
    attachContext: boolean,
    requestedFiles: string[],
    profile: RunProfile,
    requestedSkills: string[],
    targetConversationId?: string,
    modelSelection?: ModelSelection,
    editorContext?: EditorContextSnapshot,
    continueSession = false,
    reviewEdits = false,
    commandId?: string,
    includeProjectMemory = true,
  ): Promise<void> {
    const projectCommand = commandId
      ? this.projectCommands.find((command) => command.id === commandId)
      : undefined;
    const effectivePrompt = projectCommand
      ? expandProjectCommand(projectCommand, prompt)
      : prompt;
    if (!effectivePrompt) {
      return;
    }

    if (!SUPPORTS_LOCAL_SANDBOX && !await this.ensureSandboxWarningAcknowledged()) {
      this.post({
        type: "error",
        text: localize(
          "Acknowledge the Windows sandbox warning before starting an agent run.",
          "エージェントを実行する前に、Windowsのサンドボックス警告を確認してください。",
        ),
      });
      return;
    }

    const apiKey = await this.context.secrets.get(API_KEY_SECRET);
    if (!apiKey) {
      this.post({ type: "authRequired" });
      await this.promptForApiKey();
      return;
    }

    let conversation = targetConversationId
      ? this.conversations.find((candidate) => candidate.id === targetConversationId)
      : this.activeConversation();
    if (!conversation && targetConversationId) {
      return;
    }

    let workspace = conversation
      ? await this.bindConversationWorkspace(conversation)
      : this.resolveChatWorkspace();
    if (!workspace) {
      this.post({
        type: "error",
        text: localize(
          "Open a folder before running Cursor Agent.",
          "Cursor Agentを実行するには、先にフォルダーを開いてください。",
        ),
      });
      return;
    }

    if (!conversation) {
      conversation = this.ensureConversation(effectivePrompt);
      workspace = await this.bindConversationWorkspace(conversation) ?? workspace;
    }
    if (this.activeId === conversation.id) {
      this.postWorkspaceLabel();
    }

    const conversationId = conversation.id;
    const runtime = this.runtimeFor(conversationId);
    if (runtime.busy) {
      return;
    }
    const maximumParallelAgents = this.alertConfiguration()
      .get<number>("maxParallelChatAgents", 3);
    if (this.activeRunCount() >= Math.max(1, maximumParallelAgents)) {
      this.postIfActive(conversationId, {
        type: "error",
        text: localize(
          `The parallel chat-agent limit (${maximumParallelAgents}) has been reached. Wait for a run to finish or increase cursorSubscription.maxParallelChatAgents.`,
          `並列チャットAgentの上限（${maximumParallelAgents}）に達しました。完了を待つか、cursorSubscription.maxParallelChatAgents を増やしてください。`,
        ),
      });
      return;
    }
    // Reserve this conversation synchronously so a fast double-submit cannot
    // create two root runs for the same agent while attachments are prepared.
    this.retainedParallelTasks.delete(conversationId);
    this.viewedRetainedParallelTasks.delete(conversationId);
    runtime.busy = true;
    runtime.pendingCancel = false;
    runtime.mutating = profile !== "plan";
    // Count peers after reserving so two near-simultaneous launches cannot
    // both miss each other and share the live workspace.
    const mutatingRuntimes = [...this.chatRuntimes.entries()]
      .filter(([, candidate]) => candidate.busy && candidate.mutating)
      .map(([id, candidate]) => ({
        id,
        busy: candidate.busy,
        mutating: candidate.mutating,
      }));
    const overlapFlags = computeOverlappedMutationFlags(
      mutatingRuntimes,
      conversationId,
      runtime.mutating,
    );
    runtime.overlappedMutation = overlapFlags.get(conversationId) === true;
    const useIsolatedWorktree = shouldUseIsolatedWorktree({
      approvalMode: this.selectedApprovalMode(),
      mutating: runtime.mutating,
      overlappedMutation: runtime.overlappedMutation,
      sandboxSupported: SUPPORTS_LOCAL_SANDBOX,
    });
    runtime.isolationKind = useIsolatedWorktree
      ? (!SUPPORTS_LOCAL_SANDBOX && this.selectedApprovalMode() === "safe-worktree"
        ? "windows-safe"
        : "parallel")
      : undefined;
    if (runtime.overlappedMutation) {
      for (const [id, flag] of overlapFlags) {
        if (flag && id !== conversationId) {
          const peer = this.chatRuntimes.get(id);
          if (peer) {
            peer.overlappedMutation = true;
          }
        }
      }
      if (!this.context.workspaceState.get<boolean>(PARALLEL_EDIT_WARNING_KEY, false)) {
        void this.context.workspaceState.update(PARALLEL_EDIT_WARNING_KEY, true);
        void vscode.window.showWarningMessage(localize(
          "Additional parallel chat agents run in an isolated worktree. Their edits apply after the run finishes, with clean concurrent changes merged automatically.",
          "追加の並列チャットAgentは隔離worktreeで実行されます。編集は実行完了後に適用され、競合しない並行変更は自動マージされます。",
        ));
      }
    }
    this.postParallelState();
    let attachmentReferences: AttachedFileReference[] = [];
    let composed = effectivePrompt;
    let contextLabel: string | undefined;
    let images: SDKImage[] = [];
    let changeSessionId = continueSession ? runtime.changeSessionId : undefined;
    const storageRoot = this.context.storageUri ?? this.context.globalStorageUri;
    try {
      if (useIsolatedWorktree) {
        if (runtime.isolatedWorktree) {
          await cleanupIsolatedWorktree(
            runtime.isolatedWorktree,
            storageRoot,
            (message) => this.output.appendLine(message),
          );
          runtime.isolatedWorktree = undefined;
        }
        runtime.isolatedWorktree = await prepareIsolatedWorktree({
          id: `${conversationId.slice(0, 8)}-${randomUUID().slice(0, 8)}`,
          root: workspace.uri.fsPath,
          storageRoot,
          worktreesHomeSegment: runtime.isolationKind === "windows-safe"
            ? ".cursor-safe-chat/worktrees"
            : ".cursor-parallel-chat/worktrees",
          baselinesFolder: runtime.isolationKind === "windows-safe"
            ? "safe-chat-baselines"
            : "parallel-chat-baselines",
          pathEscapeLabel: runtime.isolationKind === "windows-safe"
            ? "safe chat"
            : "parallel chat",
          onLog: (message) => this.output.appendLine(message),
        });
      }
      const attachedFiles = await this.attachmentService.resolveAttachedFiles(requestedFiles, workspace);
      attachmentReferences = await this.attachmentService.stageExternalAttachments(
        attachedFiles,
        workspace,
        conversation,
      );
      ({ composed, contextLabel } = this.composePrompt(
        effectivePrompt,
        attachContext,
        attachmentReferences,
        profile,
        requestedSkills,
        editorContext,
        includeProjectMemory,
      ));
      images = await this.attachmentService.loadAttachedImages(attachedFiles, workspace);
      if (
        profile !== "plan"
        && !continueSession
        && this.featureEnabled("enableChangeSessions")
      ) {
        await runConfiguredHooks(
          "preEdit",
          runtime.isolatedWorktree?.worktreePath ?? workspace.uri.fsPath,
          this.output,
        );
        changeSessionId = (await this.changeSessions.begin(effectivePrompt, workspace.uri.fsPath)).id;
        runtime.changeSessionId = changeSessionId;
        this.repairAttempts.set(conversationId, 0);
      }
    } catch (error) {
      if (runtime.isolatedWorktree) {
        await cleanupIsolatedWorktree(
          runtime.isolatedWorktree,
          storageRoot,
          (message) => this.output.appendLine(message),
        );
        runtime.isolatedWorktree = undefined;
      }
      runtime.busy = false;
      runtime.pendingCancel = false;
      runtime.mutating = false;
      runtime.overlappedMutation = false;
      runtime.isolationKind = undefined;
      this.retainFinishedParallelTask(conversationId, "error");
      this.postParallelState();
      this.postIfActive(conversationId, {
        type: "error",
        text: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const runningSound = this.runningSound.start();
    this.postIfActive(conversationId, {
      type: "started",
      activeRuns: this.activeRunCount(),
    });
    if (contextLabel) {
      this.postIfActive(conversationId, { type: "contextAttached", label: contextLabel });
    }

    const displayPrompt = projectCommand
      ? (prompt.trim()
        ? `/${projectCommand.id} ${prompt.trim()}`
        : `/${projectCommand.id}`)
      : prompt;
    const userEntry: TranscriptEntry = {
      role: "user",
      text: contextLabel
        ? `${displayPrompt}\n\n[${localize("Attached", "添付")}: ${contextLabel}]`
        : displayPrompt,
      attachments: attachmentReferences.length > 0
        ? attachmentReferences.map((reference) => ({
            path: reference.agentPath,
            label: path.basename(reference.displayPath) || path.basename(reference.agentPath),
          }))
        : undefined,
    };
    let assistantText = "";
    const editedFiles = new Set<string>();
    const progressSteps = new Map<string, ToolProgressEntry>();
    let failed = false;
    let progressState: "completed" | "stopped" | "error" = "completed";
    let verificationResult: VerificationResult | undefined;
    runtime.live = {
      userEntry,
      assistantText,
      editedFiles,
      progressSteps,
      progressState,
    };
    if (runtime.isolatedWorktree) {
      const isolationNote = runtime.isolationKind === "windows-safe"
        ? localize(
            "Windows Safe mode: edits stay in a detached worktree until this run finishes, then apply with conflict checks. Host filesystem and network access are not OS-sandboxed.",
            "Windows安全モード: 編集は実行完了まで分離worktreeに留まり、競合確認後に適用されます。ホストのファイルシステムとネットワークはOSレベルで隔離されません。",
          )
        : localize(
            "Isolated parallel run: edits stay in a worktree until this run finishes, then apply with automatic merging of non-overlapping changes.",
            "隔離並列実行: 編集は完了までworktreeに留まり、重ならない並行変更を自動マージして適用します。",
          );
      assistantText = `${isolationNote}\n\n`;
      runtime.live.assistantText = assistantText;
      this.postIfActive(conversationId, { type: "chunk", text: assistantText });
    }

    try {
      const blockedProxy = detectBlockedProxyEnvironment();
      if (blockedProxy) {
        const text = this.formatBlockedProxyError(blockedProxy);
        this.output.appendLine(
          `[${new Date().toISOString()}] Run blocked before SDK connection: ${blockedProxy.variable}=${blockedProxy.address}`,
        );
        throw new Error(text);
      }

      const workspaceRoot = workspace.uri.fsPath;
      const cwd = runtime.isolatedWorktree?.worktreePath ?? workspaceRoot;
      const agentRoots = [cwd, conversation.attachmentRoot].filter(
        (root): root is string => typeof root === "string",
      );
      const rootsKey = agentRoots.map((root) => path.resolve(root).toLowerCase()).join("\n");
      if (
        !runtime.agent
        || runtime.rootsKey !== rootsKey
      ) {
        await this.disposeAgent(conversationId);
        runtime.agent = await this.createOrResumeAgent(
          apiKey,
          agentRoots,
          workspace.name,
          conversation,
        );
        runtime.rootsKey = rootsKey;
      }

      const runMessage = images.length > 0 ? { text: composed, images } : composed;
      const runOptions = {
        model: modelSelection ?? this.selectedModelSelection(),
        mode: profile === "plan" ? "plan" as const : "agent" as const,
      };
      let run: CursorRun;
      try {
        run = await runtime.agent.send(runMessage, runOptions);
      } catch (error) {
        if (!this.isAgentBusyError(error)) {
          throw error;
        }
        this.output.appendLine(
          `[${new Date().toISOString()}] Recovering stale active run for agent ${runtime.agent.agentId}.`,
        );
        await this.recoverBusyAgent(
          runtime,
          apiKey,
          agentRoots,
          workspace.name,
          conversation,
          cwd,
          rootsKey,
        );
        if (!runtime.agent) {
          throw new Error(localize("The chat agent is unavailable.", "チャットAgentを利用できません。"));
        }
        run = await runtime.agent.send(runMessage, runOptions);
      }
      runtime.run = run;
      if (
        runtime.pendingCancel
        && run.supports("cancel")
      ) {
        runtime.pendingCancel = false;
        await run.cancel();
      }

      const eventStream = run.stream();
      const resultPromise = run.wait();
      const terminalSignal = resultPromise.then(async (result) => {
        // Give the stream a short grace period to deliver its final message.
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        return { type: "result" as const, result };
      });
      let result: RunResult | undefined;
      while (!result) {
        const outcome = await Promise.race([
          eventStream.next().then(
            (next) => ({ type: "event" as const, next }),
            (error: unknown) => ({ type: "streamError" as const, error }),
          ),
          terminalSignal,
        ]);
        if (outcome.type === "result") {
          result = outcome.result;
          this.output.appendLine(
            `[${new Date().toISOString()}] Run ${run.id} reached ${result.status} before its event stream closed; finalizing from the run result.`,
          );
          void eventStream.return(undefined).catch(() => {});
          break;
        }
        if (outcome.type === "streamError") {
          throw outcome.error;
        }
        if (outcome.next.done) {
          break;
        }
        const event = outcome.next.value;
        if (event.type === "assistant") {
          for (const block of event.message.content) {
            if (block.type === "text" && block.text) {
              assistantText += block.text;
              if (runtime.live) {
                runtime.live.assistantText = assistantText;
              }
              this.postIfActive(conversationId, { type: "chunk", text: block.text });
            }
          }
        } else if (event.type === "tool_call") {
          this.handleToolEvent(
            event,
            cwd,
            editedFiles,
            progressSteps,
            conversationId,
            changeSessionId,
            runtime.isolatedWorktree,
          );
        }
      }

      result ??= await resultPromise;
      if (
        result.status === "finished"
        && editedFiles.size > 0
        && profile !== "plan"
        && runtime.isolatedWorktree
      ) {
        try {
          await runConfiguredHooks(
            "postEdit",
            runtime.isolatedWorktree.worktreePath,
            this.output,
          );
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          this.postIfActive(conversationId, { type: "error", text });
        }
      }
      if (runtime.isolatedWorktree && result.status === "finished") {
        const session = runtime.isolatedWorktree;
        const safeModeIsolation = runtime.isolationKind === "windows-safe";
        const isolationPathLabel = safeModeIsolation ? "safe chat" : "parallel chat";
        const baselineLabel = safeModeIsolation ? "safe-chat" : "parallel-chat";
        const changes = await collectIsolatedChanges(session, storageRoot, {
          pathEscapeLabel: isolationPathLabel,
          missingBaselineMessage: (relative) => localize(
            `The ${baselineLabel} baseline for ${relative} is unavailable.`,
            `${relative} の隔離チャットベースラインを利用できません。`,
          ),
        });
        const { applied, merged, conflicts } = await applyIsolatedChanges(
          session,
          storageRoot,
          changes,
          {
            pathEscapeLabel: isolationPathLabel,
            unavailableMessage: localize(
              "The isolated worktree is unavailable.",
              "隔離worktreeを利用できません。",
            ),
            conflictMessage: localize(
              "The workspace file changed after the isolated agent started. Review and merge it manually.",
              "隔離Agent開始後にワークスペースのファイルが変更されています。手動で確認してマージしてください。",
            ),
            missingBaselineMessage: (relative) => localize(
              `The ${baselineLabel} baseline for ${relative} is unavailable.`,
              `${relative} の隔離チャットベースラインを利用できません。`,
            ),
            autoMerge: runtime.overlappedMutation,
          },
        );
        editedFiles.clear();
        for (const relative of applied) {
          const absolute = path.join(workspaceRoot, relative);
          editedFiles.add(absolute);
          if (changeSessionId) {
            this.changeSessions.noteFile(absolute, changeSessionId);
          }
          this.postIfActive(conversationId, {
            type: "fileEdited",
            path: absolute,
            label: vscode.workspace.asRelativePath(absolute),
          });
        }
        if (merged.length > 0) {
          const mergeSummary = localize(
            `${merged.length} concurrently edited file(s) were merged automatically:\n${
              merged.map((relative) => `- ${relative}`).join("\n")
            }`,
            `${merged.length}件の並行編集ファイルを自動マージしました:\n${
              merged.map((relative) => `- ${relative}`).join("\n")
            }`,
          );
          assistantText = assistantText
            ? `${assistantText}\n\n${mergeSummary}`
            : mergeSummary;
          if (runtime.live) {
            runtime.live.assistantText = assistantText;
          }
          this.postIfActive(conversationId, { type: "chunk", text: `\n\n${mergeSummary}` });
        }
        let remainingConflicts = conflicts;
        if (conflicts.length > 0 && runtime.agent) {
          const resolution = await this.offerAiConflictResolution({
            runtime,
            conversation,
            conversationId,
            session,
            storageRoot,
            conflicts,
            originalPrompt: effectivePrompt,
            priorAssistantText: assistantText,
            model: runOptions.model,
            pathEscapeLabel: isolationPathLabel,
            missingBaselineMessage: (relative) => localize(
              `The ${baselineLabel} baseline for ${relative} is unavailable.`,
              `${relative} の隔離チャットベースラインを利用できません。`,
            ),
            progressSteps,
          });
          remainingConflicts = resolution.unresolved;
          if (resolution.text) {
            assistantText = assistantText
              ? `${assistantText}\n\n${resolution.text}`
              : resolution.text;
            if (runtime.live) {
              runtime.live.assistantText = assistantText;
            }
          }
          for (const relative of resolution.resolved) {
            const absolute = path.join(workspaceRoot, relative);
            editedFiles.add(absolute);
            if (changeSessionId) {
              this.changeSessions.noteFile(absolute, changeSessionId);
            }
            this.postIfActive(conversationId, {
              type: "fileEdited",
              path: absolute,
              label: vscode.workspace.asRelativePath(absolute),
            });
          }
        }
        if (remainingConflicts.length > 0) {
          const conflictSummary = localize(
            `${remainingConflicts.length} file(s) remain unresolved and were not applied:\n${
              remainingConflicts.map((item) => `- ${item.relative}: ${item.error}`).join("\n")
            }`,
            `${remainingConflicts.length}ファイルの競合が未解決のため適用しませんでした:\n${
              remainingConflicts.map((item) => `- ${item.relative}: ${item.error}`).join("\n")
            }`,
          );
          void vscode.window.showWarningMessage(localize(
            `${remainingConflicts.length} file(s) still have unresolved conflicts and were not applied.`,
            `${remainingConflicts.length}ファイルの競合が未解決のため適用しませんでした。`,
          ));
          assistantText = assistantText
            ? `${assistantText}\n\n${conflictSummary}`
            : conflictSummary;
          if (runtime.live) {
            runtime.live.assistantText = assistantText;
          }
          this.postIfActive(conversationId, { type: "chunk", text: `\n\n${conflictSummary}` });
        }
      } else if (
        profile !== "plan"
        && changeSessionId
        && !runtime.isolatedWorktree
      ) {
        const changedFiles = await this.changeSessions.detectChangedFiles(
          [...editedFiles],
          changeSessionId,
          runtime.overlappedMutation,
        );
        editedFiles.clear();
        for (const changedFile of changedFiles) {
          editedFiles.add(changedFile);
          this.changeSessions.noteFile(changedFile, changeSessionId);
        }
      }
      if (result.usage) {
        conversation.tokenUsage = addTokenUsage(conversation.tokenUsage, result.usage);
        await this.recordUsage("chat", result.usage);
      }
      if (result.status === "error") {
        failed = true;
        progressState = "error";
        const errorText = this.formatRunFailure(result);
        this.output.appendLine(
          `[${new Date().toISOString()}] Run ${result.id} failed: ${result.error?.code ?? "unknown"} ${result.error?.message ?? ""}`.trim(),
        );
        this.postIfActive(conversationId, {
          type: "error",
          text: errorText,
        });
        assistantText = assistantText
          ? `${assistantText}\n\n${errorText}`
          : errorText;
      } else if (result.status === "cancelled") {
        progressState = "stopped";
        if (runtime.live) {
          runtime.live.progressState = progressState;
        }
        this.postIfActive(conversationId, { type: "cancelled" });
        if (!assistantText) {
          assistantText = localize("(Stopped)", "（停止しました）");
        }
      } else {
        this.postIfActive(conversationId, { type: "finished" });
      }

      if (
        result.status === "finished"
        && editedFiles.size > 0
        && profile !== "plan"
        && !runtime.isolatedWorktree
      ) {
        try {
          await runConfiguredHooks("postEdit", workspace.uri.fsPath, this.output);
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          this.postIfActive(conversationId, { type: "error", text });
        }
      }

      if (result.status === "finished" && reviewEdits && editedFiles.size > 0) {
        await this.changeSessions.markPending([...editedFiles], changeSessionId);
        await this.reviewAutopilotEdits(changeSessionId);
        const identity = (file: string) => process.platform === "win32"
          ? path.resolve(file).toLowerCase()
          : path.resolve(file);
        const keptFiles = new Set(this.changeSessions.keptFiles(changeSessionId).map(identity));
        for (const file of editedFiles) {
          if (!keptFiles.has(identity(file))) {
            editedFiles.delete(file);
          }
        }
      }
      const hasPendingReview = changeSessionId
        ? this.changeSessions.pendingFiles(changeSessionId).length > 0
        : false;

      if (
        result.status === "finished"
        && editedFiles.size > 0
        && !hasPendingReview
        && this.featureEnabled("enableVerification")
        && this.alertConfiguration().get<boolean>("autoVerify", true)
      ) {
        if (changeSessionId) {
          this.changeSessions.setPhase("verify", changeSessionId);
        }
        const verificationStep: ToolProgressEntry = {
          id: `verification-${run.id}`,
          text: localize("Running automatic verification", "自動検証を実行"),
          status: "running",
        };
        progressSteps.set(verificationStep.id, verificationStep);
        this.postIfActive(conversationId, {
          type: "toolStatus",
          callId: verificationStep.id,
          text: verificationStep.text,
          status: "running",
        });
        verificationResult = await runVerification(
          workspace.uri.fsPath,
          this.alertConfiguration().get<string[]>("verificationCommands", []),
          this.output,
        );
        if (changeSessionId) {
          this.changeSessions.setVerification(verificationResult, changeSessionId);
        }
        verificationStep.status = verificationResult.success ? "completed" : "error";
        this.postIfActive(conversationId, {
          type: "toolStatus",
          callId: verificationStep.id,
          text: this.formatVerificationSummary(verificationResult),
          status: verificationStep.status,
        });
        assistantText = `${assistantText}\n\n${this.formatVerificationSummary(verificationResult)}`.trim();

        if (verificationResult.success) {
          void this.offerCreatePullRequest(
            workspace.uri.fsPath,
            conversation.title,
            [...editedFiles],
          );
        }

        const autoRepair = this.featureEnabled("enableVerification")
          && this.alertConfiguration().get<boolean>("autoRepair", false);
        const maxAttempts = this.alertConfiguration().get<number>("maxAutoRepairAttempts", 1);
        const attempts = this.repairAttempts.get(conversationId) ?? 0;
        if (!verificationResult.success && autoRepair && attempts < maxAttempts) {
          this.repairAttempts.set(conversationId, attempts + 1);
          const failures = verificationResult.steps
            .filter((step) => !step.success)
            .map((step) => `$ ${step.command}\n${step.output}`)
            .join("\n\n");
          await this.enqueueMessage(
            [
              `Automatic verification failed (repair attempt ${attempts + 1}/${maxAttempts}).`,
              "Diagnose the failure, make the smallest correction, and leave the workspace in a verified state.",
              "",
              failures,
            ].join("\n"),
            false,
            [],
            "agent",
            [],
            false,
            undefined,
            true,
            conversationId,
          );
        }
      } else if (result.status === "finished" && profile !== "plan") {
        if (changeSessionId) {
          this.changeSessions.setPhase(
            editedFiles.size === 0 && !hasPendingReview ? "complete" : "review",
            changeSessionId,
          );
        }
      }
    } catch (error) {
      failed = true;
      progressState = "error";
      if (runtime.live) {
        runtime.live.progressState = progressState;
      }
      this.output.appendLine(
        `[${new Date().toISOString()}] Cursor Agent error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      const text =
        error instanceof CursorAgentError
          ? localize(
              `Could not start the connection to Cursor: ${error.message}`,
              `Cursorへの接続を開始できませんでした: ${error.message}`,
            )
          : error instanceof Error
            ? error.message
            : String(error);
      this.postIfActive(conversationId, { type: "error", text });
      if (!assistantText) {
        assistantText = text;
      }
    } finally {
      runningSound.dispose();
      if (progressState === "completed") {
        this.runningSound.playCompletion();
      } else if (progressState === "error") {
        this.runningSound.playError();
      }
      if (runtime.live) {
        runtime.live.assistantText = assistantText;
        runtime.live.progressState = progressState;
      }
      runtime.run = undefined;

      const isolated = runtime.isolatedWorktree;
      runtime.isolatedWorktree = undefined;
      if (isolated) {
        const agent = runtime.agent;
        runtime.agent = undefined;
        runtime.rootsKey = undefined;
        if (agent) {
          try {
            await agent[Symbol.asyncDispose]();
          } catch (error) {
            this.output.appendLine(
              `[${new Date().toISOString()}] Failed to dispose isolated agent: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
        await cleanupIsolatedWorktree(
          isolated,
          storageRoot,
          (message) => this.output.appendLine(message),
        );
      }

      runtime.busy = false;
      runtime.pendingCancel = false;
      runtime.isolationKind = undefined;
      this.retainFinishedParallelTask(conversationId, progressState);
      this.postParallelState();
      this.postIfActive(conversationId, {
        type: "idle",
        activeRuns: this.activeRunCount(),
      });

      if (profile !== "plan") {
        if (progressState === "error" && changeSessionId) {
          this.changeSessions.setPhase("failed", changeSessionId);
        } else if (progressState === "stopped" && changeSessionId) {
          this.changeSessions.setPhase("stopped", changeSessionId);
        } else if (
          changeSessionId
          && !verificationResult
          && this.changeSessions.snapshot(changeSessionId)?.phase !== "complete"
        ) {
          this.changeSessions.setPhase("review", changeSessionId);
        }
      }

      const storedProgress = [...progressSteps.values()].map((step): ToolProgressEntry =>
        step.status === "running"
          ? {
              ...step,
              status: progressState === "completed" ? "completed" : progressState,
            }
          : step,
      );

      conversation.transcript.push(userEntry, {
        role: "assistant",
        text: assistantText,
        error: failed || undefined,
        files: editedFiles.size > 0 ? [...editedFiles] : undefined,
        progress: storedProgress.length > 0 ? storedProgress : undefined,
        progressState: storedProgress.length > 0 ? progressState : undefined,
      });
      conversation.updatedAt = Date.now();
      runtime.live = undefined;
      runtime.mutating = false;
      runtime.overlappedMutation = false;
      await this.saveConversations();
      if (!this.conversations.some((candidate) => candidate.id === conversationId)) {
        this.chatRuntimes.delete(conversationId);
      }
      if (this.showingHome) {
        this.postView();
      }
      this.notifyRunComplete(conversation, progressState);
      setTimeout(() => void this.drainMessageQueue(), 0);
    }
  }

  private async reviewAutopilotEdits(sessionId?: string): Promise<void> {
    const session = this.changeSessions.snapshot(sessionId);
    if (!session) {
      return;
    }
    const keepLabel = localize("Keep", "保持");
    const restoreLabel = localize("Restore", "復元");
    const keepAllLabel = localize("Keep all", "すべて保持");
    const restoreAllLabel = localize("Restore all", "すべて復元");

    for (const file of this.changeSessions.pendingFiles(session.id)) {
      await this.openSessionFile(session.id, file);
      const actions = this.changeSessions.canRestoreFile(file, session.id)
        ? this.changeSessions.canRestorePending(session.id)
          ? [keepLabel, restoreLabel, keepAllLabel, restoreAllLabel]
          : [keepLabel, restoreLabel, keepAllLabel]
        : [keepLabel, keepAllLabel];
      const decision = await vscode.window.showInformationMessage(
        localize(
          `Review ${vscode.workspace.asRelativePath(file)} and keep or restore the AI change.`,
          `${vscode.workspace.asRelativePath(file)} の差分を確認し、AI変更を保持または復元してください。`,
        ),
        { modal: true },
        ...actions,
      );
      if (decision === keepLabel) {
        this.changeSessions.keep(file, session.id);
      } else if (decision === restoreLabel) {
        await this.changeSessions.restoreFile(file, session.id);
      } else if (decision === keepAllLabel) {
        this.changeSessions.keepAll(session.id);
        break;
      } else if (decision === restoreAllLabel) {
        await this.changeSessions.restorePending(session.id);
        break;
      } else {
        break;
      }
    }

    const pending = this.changeSessions.pendingFiles(session.id).length;
    if (pending > 0) {
      void vscode.window.showInformationMessage(localize(
        `${pending} AI-edited file(s) remain pending. Resolve them in the AI Change Session view before verification.`,
        `${pending}件のAI編集が確認待ちです。検証前にAI変更セッションビューで確定してください。`,
      ));
    }
  }

  private async verifyAfterPendingReview(sessionId: string): Promise<void> {
    const current = this.changeSessions.snapshot(sessionId);
    if (
      !current
      || this.changeSessions.pendingFiles(sessionId).length > 0
      || this.verifyingSessions.has(sessionId)
    ) {
      return;
    }
    if (this.changeSessions.keptFiles(sessionId).length === 0) {
      this.changeSessions.setPhase("complete", sessionId);
      return;
    }
    if (
      this.featureEnabled("enableVerification")
      && this.alertConfiguration().get<boolean>("autoVerify", true)
    ) {
      this.verifyingSessions.add(sessionId);
      try {
        await this.verifyCurrentChanges(sessionId);
      } finally {
        this.verifyingSessions.delete(sessionId);
      }
    } else {
      this.changeSessions.setPhase("review", sessionId);
    }
  }

  private async runSessionDecision(
    sessionId: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previous = this.sessionDecisionQueues.get(sessionId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(operation);
    this.sessionDecisionQueues.set(sessionId, next);
    try {
      await next;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(
        `[${new Date().toISOString()}] Could not resolve AI change decision: ${message}`,
      );
      void vscode.window.showErrorMessage(message);
    } finally {
      if (this.sessionDecisionQueues.get(sessionId) === next) {
        this.sessionDecisionQueues.delete(sessionId);
      }
    }
  }

  private notifyRunComplete(
    conversation: Conversation,
    progressState: "completed" | "stopped" | "error",
  ): void {
    if (progressState === "stopped") {
      return;
    }

    const enabled = vscode.workspace
      .getConfiguration("cursorSubscription")
      .get<boolean>("notifyOnComplete", true);
    if (!enabled) {
      return;
    }

    // Avoid noise when the user is already watching the chat.
    if (this.webviewController.visible && vscode.window.state.focused) {
      return;
    }

    const openLabel = localize("Open Chat", "チャットを開く");
    const title = conversation.title || localize("Chat", "チャット");
    const message =
      progressState === "error"
        ? localize(
            `Cursor Agent failed: ${title}`,
            `Cursor Agentが失敗しました: ${title}`,
          )
        : localize(
            `Cursor Agent finished: ${title}`,
            `Cursor Agentが完了しました: ${title}`,
          );

    const show =
      progressState === "error"
        ? vscode.window.showErrorMessage(message, openLabel)
        : vscode.window.showInformationMessage(message, openLabel);

    void show.then(async (answer) => {
      if (answer !== openLabel) {
        return;
      }
      await this.openConversation(conversation.id);
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    });
  }

  private currentContextLabel(): string | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") {
      return undefined;
    }
    const relative = vscode.workspace.asRelativePath(editor.document.uri);
    if (editor.selection.isEmpty) {
      return relative;
    }
    return `${relative} L${editor.selection.start.line + 1}-L${editor.selection.end.line + 1}`;
  }

  private formatRunFailure(result: RunResult): string {
    const rawDetail = result.error?.message?.trim();
    const detail = rawDetail?.replace(/^\[[^\]]+\]\s*/, "");
    const searchable = `${result.error?.code ?? ""} ${detail ?? ""}`.toLowerCase();
    let summary: string;

    const blockedProxy = detectBlockedProxyEnvironment();
    if (blockedProxy) {
      return [
        this.formatBlockedProxyError(blockedProxy),
        `Run: ${result.id}`,
      ].join("\n");
    }

    if (
      /exchange.*fetch failed|failed to connect.*exchange|network|unavailable|connection (?:failed|stalled)(?: repeatedly)?/.test(
        searchable,
      )
    ) {
      summary = localize(
        "Could not connect to Cursor's authentication server. Check the network, VPN, or proxy, then try again.",
        "Cursorの認証サーバーに接続できませんでした。ネットワーク、VPN、プロキシを確認して再試行してください。",
      );
    } else if (/invalid api key|unauthenticated|unauthorized|401/.test(searchable)) {
      summary = localize(
        "The Cursor API key was rejected. Set a valid user API key and try again.",
        "Cursor APIキーが拒否されました。有効なユーザーAPIキーを設定して再試行してください。",
      );
    } else if (/rate.?limit|too many requests|429|usage limit/.test(searchable)) {
      summary = localize(
        "Cursor's usage or rate limit was reached. Wait and try again, or check the Cursor dashboard.",
        "Cursorの利用上限またはレート制限に達しました。時間をおいて再試行するか、Cursor Dashboardを確認してください。",
      );
    } else if (/model|unsupported.*parameter|invalid.*parameter/.test(searchable)) {
      summary = localize(
        "The selected model or one of its options could not be used. Change the model settings and try again.",
        "選択したモデルまたはオプションを利用できませんでした。モデル設定を変更して再試行してください。",
      );
    } else if (/agent.*busy|active run|conflict/.test(searchable)) {
      summary = localize(
        "The agent already has an active run. Stop it or wait for it to finish, then try again.",
        "エージェントで別の処理が実行中です。停止するか完了を待ってから再試行してください。",
      );
    } else {
      summary = localize(
        "Cursor Agent could not complete the run.",
        "Cursor Agentが処理を完了できませんでした。",
      );
    }

    return [
      summary,
      detail ? `${localize("Details", "詳細")}: ${detail}` : undefined,
      result.error?.code
        ? `${localize("Error code", "エラーコード")}: ${result.error.code}`
        : undefined,
      `Run: ${result.id}`,
    ].filter((line): line is string => Boolean(line)).join("\n");
  }

  private formatBlockedProxyError(proxy: BlockedProxyEnvironment): string {
    return localize(
      [
        "Cursor Agent network access is blocked by the current VS Code process.",
        `Details: ${proxy.variable} points to the blocked loopback address ${proxy.address}.`,
        "Fully quit VS Code and reopen it normally, outside the restricted or sandboxed launcher.",
      ].join("\n"),
      [
        "現在のVS CodeプロセスではCursor Agentのネットワーク接続が遮断されています。",
        `詳細: ${proxy.variable} が遮断用ループバックアドレス ${proxy.address} を参照しています。`,
        "VS Codeをすべて終了し、制限環境やサンドボックス経由ではなく通常の方法で起動し直してください。",
      ].join("\n"),
    );
  }

  private postContextInfo(): void {
    this.post({ type: "contextInfo", label: this.currentContextLabel() ?? null });
  }

  private composePrompt(
    prompt: string,
    attachContext: boolean,
    attachedFiles: AttachedFileReference[],
    profile: RunProfile,
    requestedSkills: string[],
    editorContext?: EditorContextSnapshot,
    includeProjectMemory = true,
  ): { composed: string; contextLabel?: string } {
    const profileInstruction: Partial<Record<RunProfile, string>> = {
      plan: "Create a concrete implementation plan. Do not edit files or run mutating commands.",
      multitask: "Split independent work into parallel workstreams and delegate them to the available specialist subagents when useful. Integrate and verify their results.",
    };
    const skills = [...new Set(requestedSkills)]
      .filter((skill) => skill.length > 0 && skill.length <= 80)
      .slice(0, 10);
    const memoryInstruction = includeProjectMemory
      && this.featureEnabled("enableProjectMemory")
      && this.alertConfiguration().get<boolean>("includeProjectMemory", true)
      ? "If .cursor/rules.md or .cursor/project-memory.md exists, read and follow the relevant project guidance before acting. Never write secrets to project memory."
      : undefined;
    const intentReference = [
      profileInstruction[profile],
      memoryInstruction,
      skills.length > 0
        ? "Use these Cursor skills for this request when applicable: " + skills.join(", ") + "."
        : undefined,
    ].filter((line): line is string => Boolean(line)).join("\n");
    const effectivePrompt = intentReference ? intentReference + "\n\n" + prompt : prompt;
    const fileReference = attachedFiles.length > 0
      ? [
          "The user explicitly attached these files. Read them as needed before responding:",
          ...attachedFiles.map((file) => file.external
            ? `- ${file.displayPath} (read-only staged copy: ${file.agentPath})`
            : `- ${file.agentPath}`),
          "Do not edit read-only staged copies. They represent files outside the main workspace.",
          "",
        ].join("\n")
      : "";
    if (!attachContext) {
      return {
        composed: fileReference ? `${fileReference}${effectivePrompt}` : effectivePrompt,
      };
    }

    if (editorContext) {
      if (editorContext.selectedText === undefined) {
        return {
          composed: `${fileReference}${localize("Target file", "対象ファイル")}: ${editorContext.filePath}\n\n${effectivePrompt}`,
          contextLabel: editorContext.filePath,
        };
      }

      const startLine = editorContext.startLine ?? 1;
      const endLine = editorContext.endLine ?? startLine;
      return {
        composed: [
          fileReference.trimEnd(),
          `${localize("Target file", "対象ファイル")}: ${editorContext.filePath} (L${startLine}-L${endLine})`,
          `${localize("Selection", "選択範囲")}:`,
          `\`\`\`${editorContext.languageId}`,
          editorContext.selectedText,
          "```",
          "",
          effectivePrompt,
        ].filter(Boolean).join("\n"),
        contextLabel: `${editorContext.filePath} L${startLine}-L${endLine}`,
      };
    }

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") {
      return {
        composed: fileReference ? `${fileReference}${effectivePrompt}` : effectivePrompt,
      };
    }

    const relative = vscode.workspace.asRelativePath(editor.document.uri);
    const selection = editor.selection;
    if (selection.isEmpty) {
      return {
        composed: `${fileReference}${localize("Target file", "対象ファイル")}: ${relative}\n\n${effectivePrompt}`,
        contextLabel: relative,
      };
    }

    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;
    const selectedText = editor.document.getText(selection);
    return {
      composed: [
        fileReference.trimEnd(),
        `${localize("Target file", "対象ファイル")}: ${relative} (L${startLine}-L${endLine})`,
        `${localize("Selection", "選択範囲")}:`,
        "```",
        selectedText,
        "```",
        "",
        effectivePrompt,
      ].filter(Boolean).join("\n"),
      contextLabel: `${relative} L${startLine}-L${endLine}`,
    };
  }

  private async searchWorkspaceFiles(query: string, requestId: number): Promise<void> {
    const normalizedQuery = query.trim().toLowerCase().replaceAll("\\", "/");
    const workspaceFiles = await this.getWorkspaceFiles();
    const files = workspaceFiles
      .filter((file) => !normalizedQuery || file.path.toLowerCase().includes(normalizedQuery))
      .sort((a, b) =>
        this.fileMatchScore(a, normalizedQuery) - this.fileMatchScore(b, normalizedQuery)
        || a.path.localeCompare(b.path),
      )
      .slice(0, 12);

    this.post({ type: "fileResults", requestId, files });
  }

  private scheduleWorkspaceIndexRefresh(): void {
    const generation = ++this.workspaceIndexGeneration;
    this.workspaceFileCache = undefined;
    this.workspaceFileCacheKey = undefined;
    if (this.workspaceIndexRefreshTimer) {
      clearTimeout(this.workspaceIndexRefreshTimer);
    }
    this.workspaceIndexRefreshTimer = setTimeout(() => {
      this.workspaceIndexRefreshTimer = undefined;
      void Promise.all([
        this.publishWorkspaceFileIndex(generation),
        this.publishIntegrationIndex(generation),
      ]);
      this.postWorkspaceLabel();
    }, WORKSPACE_INDEX_DEBOUNCE_MS);
  }

  private getWorkspaceFiles(generation?: number): PromiseLike<WorkspaceFileItem[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const cacheKey = folders.map((folder) => folder.uri.toString()).join("|");
    if (!this.workspaceFileCache || this.workspaceFileCacheKey !== cacheKey) {
      this.workspaceFileCacheKey = cacheKey;
      this.workspaceFileCache = (async () => {
        const items: WorkspaceFileItem[] = [];
        for (const workspace of folders) {
          const uris = await vscode.workspace.findFiles(
            new vscode.RelativePattern(workspace, "**/*"),
            "**/{.git,node_modules,out,dist,build,coverage}/**",
            5000,
          );
          if (generation !== undefined && generation !== this.workspaceIndexGeneration) {
            return [];
          }
          for (const uri of uris) {
            const relative = vscode.workspace.asRelativePath(uri, true).replaceAll("\\", "/");
            const directory = path.posix.dirname(relative);
            items.push({
              path: relative,
              label: path.posix.basename(relative),
              description: directory === "." ? "" : directory,
            });
          }
        }
        return items;
      })();
    }
    return this.workspaceFileCache!;
  }

  private async publishWorkspaceFileIndex(
    generation = this.workspaceIndexGeneration,
  ): Promise<void> {
    if (generation !== this.workspaceIndexGeneration) {
      return;
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      this.post({ type: "workspaceFileIndex", files: [] });
      return;
    }
    const files = await this.getWorkspaceFiles(generation);
    if (generation !== this.workspaceIndexGeneration) {
      return;
    }
    this.post({ type: "workspaceFileIndex", files: files.map((file) => file.path) });
  }

  private fileMatchScore(file: WorkspaceFileItem, query: string): number {
    if (!query) {
      return file.path.split("/").length;
    }
    const label = file.label.toLowerCase();
    const fullPath = file.path.toLowerCase();
    if (label === query) return 0;
    if (label.startsWith(query)) return 1;
    if (label.includes(query)) return 2;
    if (fullPath.startsWith(query)) return 3;
    return 4 + fullPath.indexOf(query) / Math.max(fullPath.length, 1);
  }

  private async pickImages(requestId: number): Promise<void> {
    const files = await this.attachmentService.pickImages();
    if (files.length > 0) {
      await this.resolveAttachmentReferences(files, requestId);
    }
  }

  private async resolveAttachmentReferences(
    references: string[],
    requestId: number,
    uploads: DroppedFileUpload[] = [],
  ): Promise<void> {
    const workspace = resolveWorkspaceFolder() ?? vscode.workspace.workspaceFolders?.[0];
    if (!workspace && (vscode.workspace.workspaceFolders?.length ?? 0) === 0) {
      this.post({ type: "resolvedAttachments", requestId, files: [] });
      void vscode.window.showWarningMessage(localize(
        "Open a workspace folder to attach dropped files.",
        "ドロップしたファイルを添付するには、ワークスペースフォルダーを開いてください。",
      ));
      return;
    }

    const preferred = workspace;
    const workspaceFiles = await this.getWorkspaceFiles();
    const resolved = new Map<string, WorkspaceFileItem>();
    let rejected = 0;

    for (const upload of uploads) {
      try {
        const item = await this.attachmentService.stageDroppedFileUpload(upload);
        if (item) {
          resolved.set(item.path, item);
        } else {
          rejected += 1;
        }
      } catch {
        rejected += 1;
      }
    }

    for (const rawReference of [...new Set(references)].slice(0, 20)) {
      const reference = rawReference.trim();
      if (!reference) {
        continue;
      }

      let candidatePath: string;
      try {
        candidatePath = reference.toLowerCase().startsWith("file:")
          ? vscode.Uri.parse(reference).fsPath
          : reference;
      } catch {
        rejected += 1;
        continue;
      }

      const isAbsolute = path.isAbsolute(candidatePath);
      const hasDirectory = candidatePath.includes("/") || candidatePath.includes("\\");
      const absolute = resolveAbsoluteInWorkspace(candidatePath, preferred);
      let item: WorkspaceFileItem | undefined;

      if (absolute) {
        try {
          const stat = await vscode.workspace.fs.stat(vscode.Uri.file(absolute));
          if ((stat.type & vscode.FileType.File) !== 0) {
            const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(absolute));
            const normalized = (folder
              ? vscode.workspace.asRelativePath(vscode.Uri.file(absolute), true)
              : absolute).replaceAll("\\", "/");
            const directory = path.posix.dirname(normalized);
            item = {
              path: normalized,
              label: path.posix.basename(normalized),
              description: directory === "." ? "" : directory,
            };
          }
        } catch {
          // A name-only clipboard entry can still be resolved from the workspace index.
        }
      }

      if (!item && !isAbsolute && !hasDirectory) {
        const matches = workspaceFiles.filter(
          (file) => file.label.toLowerCase() === candidatePath.toLowerCase(),
        );
        if (matches.length === 1) {
          item = matches[0];
        } else if (matches.length > 1) {
          item = await vscode.window.showQuickPick(matches, {
            placeHolder: localize(
              `Select the file meant by ${candidatePath}`,
              `${candidatePath} に対応するファイルを選択してください`,
            ),
          });
        }
      }

      if (item) {
        resolved.set(item.path, item);
      } else {
        rejected += 1;
      }
    }

    this.post({
      type: "resolvedAttachments",
      requestId,
      files: [...resolved.values()],
    });
    if (rejected > 0) {
      void vscode.window.showWarningMessage(localize(
        `${rejected} file(s) could not be attached because they were unavailable or no longer exist.`,
        `${rejected}件のファイルを添付できませんでした。ファイルが利用できないか、既に存在しない可能性があります。`,
      ));
    }
  }

  private createOrResumeAgent(
    apiKey: string,
    roots: string[],
    workspaceName: string,
    conversation: Conversation,
  ): Promise<CursorAgent> {
    return this.agentFactory.createOrResume({ apiKey, roots, workspaceName, conversation });
  }

  private async showSandboxLimitationDetails(): Promise<void> {
    const learnMore = localize("Open docs", "ドキュメントを開く");
    const answer = await vscode.window.showInformationMessage(
      localize(
        "Local sandboxing is unavailable in this environment (for example on Windows). Safe worktree mode keeps normal agent edits away from the active workspace until completion and Auto-review still classifies risky actions. This is not an OS security boundary: tools can still access the host filesystem and network.",
        "この環境（例: Windows）ではローカルサンドボックスを利用できません。安全worktreeモードでは通常のエージェント編集を完了まで作業中のワークスペースから分離し、自動レビューも危険な操作を分類します。ただしOSのセキュリティ境界ではなく、ツールはホストのファイルシステムとネットワークへアクセスできます。",
      ),
      learnMore,
    );
    if (answer === learnMore) {
      await vscode.env.openExternal(vscode.Uri.parse("https://cursor.com/docs"));
    }
  }

  private async offerAiConflictResolution(input: {
    runtime: ChatRuntime;
    conversation: Conversation;
    conversationId: string;
    session: IsolatedWorktreeSession;
    storageRoot: vscode.Uri;
    conflicts: Array<{ relative: string; error: string }>;
    originalPrompt: string;
    priorAssistantText: string;
    model?: ModelSelection;
    pathEscapeLabel: string;
    missingBaselineMessage: (relative: string) => string;
    progressSteps: Map<string, ToolProgressEntry>;
  }): Promise<{
    resolved: string[];
    unresolved: Array<{ relative: string; error: string }>;
    text: string;
  }> {
    const prepared: PreparedAiConflict[] = [];
    const unresolved: Array<{ relative: string; error: string }> = [];
    const originalByPath = new Map(
      input.conflicts.map((conflict) => [conflict.relative, conflict]),
    );
    for (const conflict of input.conflicts) {
      try {
        const candidate = await prepareAiConflictResolution(
          input.session,
          input.storageRoot,
          conflict.relative,
          {
            pathEscapeLabel: input.pathEscapeLabel,
            missingBaselineMessage: input.missingBaselineMessage,
          },
        );
        if (candidate) {
          prepared.push(candidate);
        } else {
          unresolved.push({
            relative: conflict.relative,
            error: localize(
              "AI resolution is available only for textual modify/modify conflicts.",
              "AI解決はテキストの変更対変更の競合でのみ利用できます。",
            ),
          });
        }
      } catch (error) {
        unresolved.push({
          relative: conflict.relative,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (prepared.length === 0 || !input.runtime.agent) {
      return { resolved: [], unresolved, text: "" };
    }

    const resolveLabel = localize("Resolve with AI", "AIで解決");
    const leaveLabel = localize("Leave unresolved", "未解決のまま残す");
    const answer = await vscode.window.showWarningMessage(
      localize(
        `${prepared.length} overlapping file conflict(s) can be sent back to the agent. Let AI infer both edits' intent and propose a resolution?`,
        `${prepared.length}件の重複競合をAgentへ戻せます。AIに双方の編集意図を推測させて解決しますか？`,
      ),
      {
        modal: true,
        detail: localize(
          "Only the listed files can be applied. This uses additional Cursor plan quota, and each workspace file is checked again before the AI result is written.",
          "一覧のファイルだけが適用対象です。Cursorの利用枠を追加で消費し、AI結果を書き込む直前に各ファイルの再変更も確認します。",
        ),
      },
      resolveLabel,
      leaveLabel,
    );
    if (answer !== resolveLabel) {
      return { resolved: [], unresolved: [...input.conflicts], text: "" };
    }

    const intro = localize(
      `AI conflict resolution started for ${prepared.length} file(s).`,
      `${prepared.length}ファイルのAI競合解決を開始しました。`,
    );
    let text = `${intro}\n\n`;
    const syncLiveText = (): void => {
      if (input.runtime.live) {
        input.runtime.live.assistantText = input.priorAssistantText
          ? `${input.priorAssistantText}\n\n${text}`
          : text;
      }
    };
    syncLiveText();
    this.postIfActive(input.conversationId, { type: "chunk", text: `\n\n${text}` });
    const listedFiles = prepared.map((candidate) => `- ${candidate.relative}`).join("\n");
    const prompt = [
      "Resolve the overlapping three-way merge conflicts in the files listed below.",
      "Each file contains standard conflict markers. `workspace` is the other agent or user's current edit; `parallel-agent` is your proposed edit.",
      "Infer the intent of both sides, preserve compatible behavior from both, and remove every conflict marker.",
      "Edit only the listed conflicted files. Do not commit, delete files, or modify unrelated files.",
      "After editing, re-read each listed file and ensure no conflict markers remain.",
      "",
      "Original request for this agent:",
      input.originalPrompt,
      "",
      "Conflicted files:",
      listedFiles,
    ].join("\n");

    try {
      const resolutionRun = await input.runtime.agent.send(prompt, {
        model: input.model,
        mode: "agent",
      });
      input.runtime.run = resolutionRun;
      const resolutionEditedFiles = new Set<string>();
      const eventStream = resolutionRun.stream();
      const resultPromise = resolutionRun.wait();
      const terminalSignal = resultPromise.then(async (result) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        return { type: "result" as const, result };
      });
      let result: RunResult | undefined;
      while (!result) {
        const outcome = await Promise.race([
          eventStream.next().then(
            (next) => ({ type: "event" as const, next }),
            (error: unknown) => ({ type: "streamError" as const, error }),
          ),
          terminalSignal,
        ]);
        if (outcome.type === "result") {
          result = outcome.result;
          void eventStream.return(undefined).catch(() => {});
          break;
        }
        if (outcome.type === "streamError") {
          throw outcome.error;
        }
        if (outcome.next.done) {
          break;
        }
        const event = outcome.next.value;
        if (event.type === "assistant") {
          for (const block of event.message.content) {
            if (block.type === "text" && block.text) {
              text += block.text;
              syncLiveText();
              this.postIfActive(input.conversationId, { type: "chunk", text: block.text });
            }
          }
        } else if (event.type === "tool_call") {
          this.handleToolEvent(
            event,
            input.session.worktreePath,
            resolutionEditedFiles,
            input.progressSteps,
            input.conversationId,
            undefined,
            input.session,
            false,
          );
        }
      }
      result ??= await resultPromise;
      if (result.usage) {
        input.conversation.tokenUsage = addTokenUsage(
          input.conversation.tokenUsage,
          result.usage,
        );
        await this.recordUsage("chat", result.usage);
      }
      if (result.status !== "finished") {
        const error = result.status === "error"
          ? this.formatRunFailure(result)
          : localize("AI conflict resolution was stopped.", "AI競合解決を停止しました。");
        for (const candidate of prepared) {
          unresolved.push({ relative: candidate.relative, error });
        }
        const summary = localize(
          "AI conflict resolution did not finish; no AI resolution was applied.",
          "AI競合解決が完了しなかったため、AIの解決結果は適用していません。",
        );
        text = `${text}\n\n${summary}`.trim();
        syncLiveText();
        this.postIfActive(input.conversationId, { type: "chunk", text: `\n\n${summary}` });
        return { resolved: [], unresolved, text };
      }

      const resolved: string[] = [];
      for (const candidate of prepared) {
        try {
          await applyAiConflictResolution(input.session, candidate, {
            pathEscapeLabel: input.pathEscapeLabel,
            changedMessage: localize(
              "The workspace file changed again while AI was resolving it.",
              "AI解決中にワークスペースのファイルが再変更されました。",
            ),
            markersMessage: localize(
              "AI left conflict markers in the file.",
              "AIがファイル内に競合マーカーを残しました。",
            ),
          });
          resolved.push(candidate.relative);
        } catch (error) {
          unresolved.push({
            relative: candidate.relative,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      const summary = localize(
        `AI resolved and safely applied ${resolved.length}/${prepared.length} file conflict(s).`,
        `AIが${prepared.length}件中${resolved.length}件の競合を解決し、安全確認後に適用しました。`,
      );
      text = `${text}\n\n${summary}`.trim();
      syncLiveText();
      this.postIfActive(input.conversationId, { type: "chunk", text: `\n\n${summary}` });
      return { resolved, unresolved, text };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const candidate of prepared) {
        const original = originalByPath.get(candidate.relative);
        unresolved.push({
          relative: candidate.relative,
          error: original ? `${original.error} AI: ${message}` : message,
        });
      }
      const summary = localize(
        `AI conflict resolution failed: ${message}`,
        `AI競合解決に失敗しました: ${message}`,
      );
      text = `${text}\n\n${summary}`.trim();
      syncLiveText();
      this.postIfActive(input.conversationId, { type: "chunk", text: `\n\n${summary}` });
      return { resolved: [], unresolved, text };
    }
  }

  private handleToolEvent(
    event: unknown,
    cwd: string,
    editedFiles: Set<string>,
    progressSteps: Map<string, ToolProgressEntry>,
    conversationId: string,
    changeSessionId?: string,
    isolatedWorktree?: IsolatedWorktreeSession,
    reportEdits = true,
  ): void {
    const tool = event as {
      call_id?: string;
      name?: string;
      status?: "running" | "completed" | "error";
      args?: unknown;
    };
    if (typeof tool.name !== "string") {
      return;
    }
    if (changeSessionId) {
      this.changeSessions.noteTool(tool.name, changeSessionId);
    }

    const id = typeof tool.call_id === "string"
      ? tool.call_id
      : `${tool.name}-${progressSteps.size}`;
    const status = tool.status ?? "running";
    const text = this.describeToolProgress(tool.name, tool.args, cwd, isolatedWorktree);
    const step: ToolProgressEntry = { id, text, status };
    progressSteps.set(id, step);
    this.postIfActive(conversationId, {
      type: "toolStatus",
      callId: id,
      text,
      status,
    });

    if (!reportEdits || !/edit|write|apply.?patch/i.test(tool.name)) {
      return;
    }

    for (const filePath of extractFilePaths(tool.args)) {
      const absolute = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
      if (!editedFiles.has(absolute)) {
        editedFiles.add(absolute);
        const displayPath = isolatedWorktree
          ? mapWorktreePathToRoot(absolute, isolatedWorktree)
          : absolute;
        if (changeSessionId && !isolatedWorktree) {
          this.changeSessions.noteFile(displayPath, changeSessionId);
        }
        this.postIfActive(conversationId, {
          type: "fileEdited",
          path: displayPath,
          label: vscode.workspace.asRelativePath(displayPath),
        });
      }
    }
  }

  private describeToolProgress(
    toolName: string,
    args: unknown,
    cwd: string,
    isolatedWorktree?: IsolatedWorktreeSession,
  ): string {
    const lower = toolName.toLowerCase();
    let action: string;
    if (/edit|write|apply.?patch/.test(lower)) {
      action = localize("Editing file", "ファイルを編集");
    } else if (/read|open.?file/.test(lower)) {
      action = localize("Reading file", "ファイルを読み取り");
    } else if (/grep|search|find|glob/.test(lower)) {
      action = localize("Searching", "検索");
    } else if (/shell|terminal|command|exec|run/.test(lower)) {
      action = localize("Running command", "コマンドを実行");
    } else if (/subagent|agent/.test(lower)) {
      action = localize("Running subagent", "サブエージェントを実行");
    } else if (/web|browser|fetch/.test(lower)) {
      action = localize("Accessing the web", "Webへアクセス");
    } else {
      action = toolName.replaceAll("_", " ");
    }

    const filePath = extractFilePaths(args)[0];
    if (filePath) {
      const absolute = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
      const displayPath = isolatedWorktree
        ? mapWorktreePathToRoot(absolute, isolatedWorktree)
        : absolute;
      return `${action}: ${vscode.workspace.asRelativePath(displayPath)}`;
    }

    if (args && typeof args === "object" && /shell|terminal|command|exec|run/.test(lower)) {
      const record = args as Record<string, unknown>;
      const command = [record.command, record.cmd, record.script]
        .find((value): value is string => typeof value === "string" && value.length > 0);
      if (command) {
        const compact = command.replace(/\s+/g, " ").trim();
        return `${action}: ${compact.length > 90 ? `${compact.slice(0, 87)}…` : compact}`;
      }
    }

    return action;
  }

  private async openDiff(filePath: string): Promise<void> {
    const uri = vscode.Uri.file(filePath);
    try {
      await vscode.commands.executeCommand("git.openChange", uri);
    } catch {
      await vscode.window.showTextDocument(uri, { preview: true });
    }
  }

  private async openFile(filePath: string): Promise<void> {
    const absolute = resolveAbsoluteInWorkspace(
      filePath,
      resolveWorkspaceFolder(),
    );
    if (!absolute) {
      return;
    }
    let uri = vscode.Uri.file(absolute);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      const recovered = await this.attachmentService.recoverStoredAttachment(
        filePath,
        this.conversations,
        this.activeId,
      );
      if (recovered) {
        uri = recovered;
      } else {
        void vscode.window.showWarningMessage(localize(
          `Could not open file: ${filePath}`,
          `ファイルを開けませんでした: ${filePath}`,
        ));
        return;
      }
    }

    try {
      await vscode.commands.executeCommand("vscode.open", uri);
    } catch {
      void vscode.window.showWarningMessage(localize(
        `Could not open file: ${filePath}`,
        `ファイルを開けませんでした: ${filePath}`,
      ));
    }
  }

  private async openReferencedFile(reference: string): Promise<void> {
    if ((vscode.workspace.workspaceFolders?.length ?? 0) === 0) {
      return;
    }

    const match = /^(.*?)(?::(\d+)(?::\d+)?)?$/.exec(reference.trim());
    const requestedPath = (match?.[1] ?? reference).replaceAll("\\", "/");
    const line = match?.[2] ? Math.max(0, Number(match[2]) - 1) : undefined;
    let candidates: vscode.Uri[] = [];

    const exactAbsolute = resolveAbsoluteInWorkspace(
      requestedPath,
      resolveWorkspaceFolder(),
    );
    if (exactAbsolute && requestedPath.includes("/")) {
      try {
        const uri = vscode.Uri.file(exactAbsolute);
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.File) !== 0) {
          candidates = [uri];
        }
      } catch {
        // Fall back to matching by the displayed file name.
      }
    }

    if (candidates.length === 0) {
      const fileName = path.posix.basename(requestedPath).toLowerCase();
      const files = await this.getWorkspaceFiles();
      for (const file of files.filter((item) => item.label.toLowerCase() === fileName)) {
        const absolute = resolveAbsoluteInWorkspace(file.path);
        if (absolute) {
          candidates.push(vscode.Uri.file(absolute));
        }
      }
    }

    if (candidates.length === 0) {
      void vscode.window.showWarningMessage(localize(
        `No workspace file matches: ${requestedPath}`,
        `一致するワークスペースファイルがありません: ${requestedPath}`,
      ));
      return;
    }

    let selected = candidates[0];
    if (candidates.length > 1) {
      const picked = await vscode.window.showQuickPick(
        candidates.map((uri) => {
          const relative = vscode.workspace.asRelativePath(uri, true).replaceAll("\\", "/");
          return {
            label: path.posix.basename(relative),
            description: path.posix.dirname(relative),
            uri,
          };
        }),
        {
          placeHolder: localize(
            `Select the file meant by ${requestedPath}`,
            `${requestedPath} に対応するファイルを選択してください`,
          ),
        },
      );
      if (!picked) {
        return;
      }
      selected = picked.uri;
    }

    const document = await vscode.workspace.openTextDocument(selected);
    const selection = line === undefined
      ? undefined
      : new vscode.Range(
          new vscode.Position(Math.min(line, Math.max(0, document.lineCount - 1)), 0),
          new vscode.Position(Math.min(line, Math.max(0, document.lineCount - 1)), 0),
        );
    await vscode.window.showTextDocument(document, { preview: true, selection });
  }

  private async cancel(clearQueue = true): Promise<void> {
    if (this.activeId) {
      await this.cancelConversation(this.activeId, clearQueue);
    }
  }

  private async cancelConversation(
    conversationId: string,
    clearQueue = true,
  ): Promise<void> {
    if (clearQueue) {
      const next = removeQueuedMessages(
        this.messageQueue,
        (item) => item.conversationId === conversationId,
      );
      this.messageQueue.splice(0, this.messageQueue.length, ...next as QueuedMessage[]);
      this.postQueueState();
    }
    const runtime = this.chatRuntimes.get(conversationId);
    const run = runtime?.run;
    if (!run || !run.supports("cancel")) {
      if (runtime?.busy) {
        runtime.pendingCancel = true;
      }
      return;
    }
    await run.cancel();
  }

  private async cancelAllChats(clearQueues = true): Promise<void> {
    const conversationIds = [...this.chatRuntimes.keys()];
    await Promise.all(conversationIds.map((id) => this.cancelConversation(id, clearQueues)));
  }

  private async disposeAgent(conversationId?: string): Promise<void> {
    const entries = conversationId
      ? [[conversationId, this.chatRuntimes.get(conversationId)] as const]
      : [...this.chatRuntimes.entries()];
    for (const [id, runtime] of entries) {
      if (!runtime) {
        continue;
      }
      const agent = runtime.agent;
      runtime.agent = undefined;
      runtime.rootsKey = undefined;
      if (agent) {
        await agent[Symbol.asyncDispose]();
      }
      if (!runtime.busy) {
        this.chatRuntimes.delete(id);
      }
    }
  }

  private isAgentBusyError(error: unknown): boolean {
    return error instanceof AgentBusyError
      || (error instanceof Error && /already has active run/i.test(error.message));
  }

  private async recoverBusyAgent(
    runtime: ChatRuntime,
    apiKey: string,
    agentRoots: string[],
    workspaceName: string,
    conversation: Conversation,
    cwd: string,
    rootsKey: string,
  ): Promise<void> {
    const agent = runtime.agent;
    const agentId = agent?.agentId ?? conversation.agentId;
    if (agent && agentId) {
      try {
        const runs = await Agent.listRuns(agentId, { runtime: "local", cwd });
        const activeRun = [...runs.items].reverse().find(
          (candidate) => candidate.status === "running",
        );
        if (activeRun) {
          await Agent.cancelRun(activeRun.id, { runtime: "local", cwd });
          await agent.reload();
          return;
        }
      } catch (error) {
        this.output.appendLine(
          `[${new Date().toISOString()}] Could not cancel stale run for agent ${agentId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    await this.disposeAgent(conversation.id);
    conversation.agentId = undefined;
    runtime.agent = await this.createOrResumeAgent(
      apiKey,
      agentRoots,
      workspaceName,
      conversation,
    );
    runtime.rootsKey = rootsKey;
  }

  private async publishIntegrationIndex(
    generation = this.workspaceIndexGeneration,
  ): Promise<void> {
    if (generation !== this.workspaceIndexGeneration) {
      return;
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      const projectCommands = await loadProjectCommands();
      if (generation !== this.workspaceIndexGeneration) {
        return;
      }
      this.projectCommands = projectCommands;
      this.post({
        type: "integrations",
        skills: [],
        mcpServers: [],
        commands: this.projectCommands.map(({ id, label, description, source }) => ({
          id,
          label,
          description,
          source,
        })),
      });
      return;
    }

    const skillsByName = new Map<string, { name: string; description?: string }>();
    for (const workspace of folders) {
      try {
        const skillUris = await vscode.workspace.findFiles(
          new vscode.RelativePattern(workspace, ".cursor/skills/**/SKILL.md"),
          "**/node_modules/**",
          100,
        );
        if (generation !== this.workspaceIndexGeneration) {
          return;
        }
        for (const uri of skillUris) {
          const bytes = await vscode.workspace.fs.readFile(uri);
          if (generation !== this.workspaceIndexGeneration) {
            return;
          }
          const source = Buffer.from(bytes).toString("utf8", 0, 8192);
          const fallbackName = path.basename(path.dirname(uri.fsPath));
          const name = /^name:\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(source)?.[1]?.trim()
            ?? fallbackName;
          const description = /^description:\s*["']?([^"'\r\n]+)["']?\s*$/m
            .exec(source)?.[1]?.trim();
          if (!skillsByName.has(name)) {
            skillsByName.set(name, { name, description });
          }
        }
      } catch {
        // An unavailable skills folder is equivalent to an empty list.
      }
    }

    const mcpServers = new Set<string>();
    for (const workspace of folders) {
      const mcpUri = vscode.Uri.joinPath(workspace.uri, ".cursor", "mcp.json");
      try {
        const bytes = await vscode.workspace.fs.readFile(mcpUri);
        if (generation !== this.workspaceIndexGeneration) {
          return;
        }
        const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
        if (parsed && typeof parsed === "object" && "mcpServers" in parsed) {
          const servers = (parsed as { mcpServers?: unknown }).mcpServers;
          if (servers && typeof servers === "object" && !Array.isArray(servers)) {
            for (const name of Object.keys(servers)) {
              mcpServers.add(name);
            }
          }
        }
      } catch {
        // Invalid JSON is left for the editor to surface when the user opens it.
      }
    }

    const projectCommands = await loadProjectCommands(folders);
    if (generation !== this.workspaceIndexGeneration) {
      return;
    }
    this.projectCommands = projectCommands;
    this.post({
      type: "integrations",
      skills: [...skillsByName.values()].sort((a, b) => a.name.localeCompare(b.name)),
      mcpServers: [...mcpServers].sort((a, b) => a.localeCompare(b)),
      commands: this.projectCommands.map(({ id, label, description, source }) => ({
        id,
        label,
        description,
        source,
      })),
    });
  }

  private async openSkillsFolder(): Promise<void> {
    const workspace = resolveWorkspaceFolder()
      ?? await pickWorkspaceFolder(
        localize("Select a workspace for Skills", "Skills用のワークスペースを選択"),
      );
    if (!workspace) {
      return;
    }
    const uri = vscode.Uri.joinPath(workspace.uri, ".cursor", "skills");
    await vscode.workspace.fs.createDirectory(uri);
    await vscode.commands.executeCommand("revealInExplorer", uri);
  }

  private async openMcpSettings(): Promise<void> {
    const workspace = resolveWorkspaceFolder()
      ?? await pickWorkspaceFolder(
        localize("Select a workspace for MCP settings", "MCP設定用のワークスペースを選択"),
      );
    if (!workspace) {
      return;
    }
    const directory = vscode.Uri.joinPath(workspace.uri, ".cursor");
    const uri = vscode.Uri.joinPath(directory, "mcp.json");
    await vscode.workspace.fs.createDirectory(directory);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      await vscode.workspace.fs.writeFile(
        uri,
        Buffer.from('{\n  "mcpServers": {}\n}\n', "utf8"),
      );
    }
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
  }

  private async publishAuthState(): Promise<void> {
    const apiKey = await this.context.secrets.get(API_KEY_SECRET);
    this.post({ type: "authState", configured: Boolean(apiKey) });
    if (apiKey) {
      void this.publishModels(apiKey);
    }
  }

  private async publishModels(apiKey: string): Promise<void> {
    let models: {
      id: string;
      label: string;
      description?: string;
      parameters: {
        id: string;
        label: string;
        values: { value: string; label: string }[];
      }[];
      variants: {
        label: string;
        description?: string;
        isDefault: boolean;
        params: ModelParameterValue[];
      }[];
    }[] = [];
    try {
      const blockedProxy = detectBlockedProxyEnvironment();
      if (blockedProxy) {
        this.output.appendLine(
          `[${new Date().toISOString()}] Model refresh skipped: ${blockedProxy.variable}=${blockedProxy.address}`,
        );
        throw new Error(this.formatBlockedProxyError(blockedProxy));
      }
      const list = await Cursor.models.list({ apiKey });
      models = list.map((model) => {
        return {
          id: model.id,
          label: model.displayName ?? model.id,
          description: model.description,
          parameters: (model.parameters ?? []).map((parameter) => ({
            id: parameter.id,
            label: parameter.displayName ?? parameter.id,
            values: parameter.values.map((value) => ({
              value: value.value,
              label: value.displayName ?? value.value,
            })),
          })),
          variants: (model.variants ?? []).map((variant) => ({
            label: variant.displayName,
            description: variant.description,
            isDefault: variant.isDefault === true,
            params: variant.params,
          })),
        };
      });
    } catch {
      models = [{
        id: "composer-2.5",
        label: "composer-2.5",
        parameters: [],
        variants: [],
      }];
    }

    const seenIds = new Set<string>();
    models = models.filter((model) => {
      if (seenIds.has(model.id)) {
        return false;
      }
      seenIds.add(model.id);
      return true;
    });

    const hasAuto = models.some(
      (model) =>
        model.id.toLowerCase() === DEFAULT_MODEL ||
        model.label.trim().toLowerCase() === DEFAULT_MODEL,
    );
    if (!hasAuto) {
      models.unshift({
        id: DEFAULT_MODEL,
        label: "Auto",
        parameters: [],
        variants: [],
      });
    }
    this.post({
      type: "models",
      models,
      selected: this.selectedModel(),
      savedParams: this.storedModelParams(),
    });
  }

  private post(message: Record<string, unknown>): void {
    void this.webviewController.post(message);
  }

}

function extractFilePaths(args: unknown): string[] {
  if (!args || typeof args !== "object") {
    return [];
  }

  const record = args as Record<string, unknown>;
  const keys = [
    "path",
    "file_path",
    "filePath",
    "target_file",
    "targetFile",
    "absolute_path",
    "absolutePath",
  ];

  const paths: string[] = [];
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) {
      paths.push(value);
    }
  }
  return paths;
}
