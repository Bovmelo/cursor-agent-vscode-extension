import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import * as path from "node:path";
import {
  Agent,
  AgentBusyError,
  Cursor,
  CursorAgentError,
  type AgentDefinition,
  type LocalAgentOptions,
  type ModelParameterValue,
  type ModelSelection,
  type RunResult,
  type SDKImage,
  type TokenUsage,
} from "@cursor/sdk";
import * as vscode from "vscode";
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
import { pickWorkspaceFolder, resolveWorkspaceFolder, configurationFor, workspaceDisplayName, resolveAbsoluteInWorkspace } from "./workspaceFolder.js";

const API_KEY_SECRET = "cursorSubscription.apiKey";
const CONVERSATIONS_KEY = "cursorSubscription.conversations";
const MODEL_KEY = "cursorSubscription.model";
const MODEL_PARAMS_KEY = "cursorSubscription.modelParams";
const APPROVAL_MODE_KEY = "cursorSubscription.approvalMode";
const PARALLEL_EDIT_WARNING_KEY = "cursorSubscription.parallelEditWarningShown";
const BEST_OF_N_KEY = "cursorSubscription.bestOfNExperiments";
const VIEW_ID = "cursorSubscription.chatView";
const DEFAULT_MODEL = "auto";
const TITLE_MAX_LENGTH = 40;
const IS_JAPANESE = vscode.env.language.toLowerCase().startsWith("ja");
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_DROPPED_FILE_BYTES = 20 * 1024 * 1024;
const MAX_EDITOR_GENERATION_CONTEXT = 60_000;
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
const IMAGE_FORMATS: Record<string, { mimeType: string; vision: boolean }> = {
  ".avif": { mimeType: "image/avif", vision: false },
  ".bmp": { mimeType: "image/bmp", vision: false },
  ".gif": { mimeType: "image/gif", vision: true },
  ".heic": { mimeType: "image/heic", vision: false },
  ".heif": { mimeType: "image/heif", vision: false },
  ".ico": { mimeType: "image/x-icon", vision: false },
  ".jfif": { mimeType: "image/jpeg", vision: true },
  ".jpeg": { mimeType: "image/jpeg", vision: true },
  ".jpg": { mimeType: "image/jpeg", vision: true },
  ".png": { mimeType: "image/png", vision: true },
  ".svg": { mimeType: "image/svg+xml", vision: false },
  ".tif": { mimeType: "image/tiff", vision: false },
  ".tiff": { mimeType: "image/tiff", vision: false },
  ".webp": { mimeType: "image/webp", vision: true },
};
const IMAGE_FILE_EXTENSIONS = Object.keys(IMAGE_FORMATS).map((extension) =>
  extension.slice(1)
);

type ApprovalMode = "auto-review" | "full-access";
type RunProfile = "agent" | "plan" | "multitask";

function localize(english: string, japanese: string): string {
  return IS_JAPANESE ? japanese : english;
}

type CursorAgent = Awaited<ReturnType<typeof Agent.create>>;
type CursorRun = Awaited<ReturnType<CursorAgent["send"]>>;

interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  error?: boolean;
  files?: string[];
  attachments?: Array<string | TranscriptAttachment>;
  progress?: ToolProgressEntry[];
  progressState?: "completed" | "stopped" | "error";
}

interface TranscriptAttachment {
  path: string;
  label: string;
}

interface ToolProgressEntry {
  id: string;
  text: string;
  status: "running" | "completed" | "error" | "stopped";
}

interface WorkspaceFileItem {
  path: string;
  label: string;
  description: string;
}

interface DroppedFileUpload {
  name: string;
  data: Uint8Array;
}

interface AttachedFileReference {
  displayPath: string;
  agentPath: string;
  external: boolean;
}

interface EditorContextSnapshot {
  filePath: string;
  languageId: string;
  startLine?: number;
  endLine?: number;
  selectedText?: string;
}

interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  agentId?: string;
  attachmentRoot?: string;
  pinned?: boolean;
  experimentGroupId?: string;
  tokenUsage?: TokenUsage;
  transcript: TranscriptEntry[];
}

interface QueuedMessage {
  id: string;
  conversationId: string;
  prompt: string;
  attachContext: boolean;
  files: string[];
  profile: RunProfile;
  skills: string[];
  model: ModelSelection;
  kind: "queued" | "interrupt";
  editorContext?: EditorContextSnapshot;
  internalRepair?: boolean;
  commandId?: string;
  includeProjectMemory?: boolean;
}

interface LiveChatRun {
  userEntry: TranscriptEntry;
  assistantText: string;
  editedFiles: Set<string>;
  progressSteps: Map<string, ToolProgressEntry>;
  progressState: "completed" | "stopped" | "error";
}

interface ChatRuntime {
  agent?: CursorAgent;
  run?: CursorRun;
  rootsKey?: string;
  busy: boolean;
  pendingCancel: boolean;
  mutating: boolean;
  overlappedMutation: boolean;
  changeSessionId?: string;
  live?: LiveChatRun;
}

function makeTitle(prompt: string): string {
  const firstLine = prompt.split("\n", 1)[0].trim();
  return firstLine.length > TITLE_MAX_LENGTH
    ? `${firstLine.slice(0, TITLE_MAX_LENGTH)}…`
    : firstLine;
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
  private view: vscode.WebviewView | undefined;
  private readonly chatRuntimes = new Map<string, ChatRuntime>();
  private conversations: Conversation[];
  private activeId: string | undefined;
  private showingHome = true;
  private workspaceFileCache: PromiseLike<WorkspaceFileItem[]> | undefined;
  private workspaceFileCacheKey: string | undefined;
  private sandboxFallbackApproved = false;
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
  private pendingAttachmentRoot: Promise<vscode.Uri> | undefined;
  private readonly pendingAttachmentLabels = new Map<string, string>();
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

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly runningSound: RunningSoundController,
    private readonly changeSessions: ChangeSessionController,
    private readonly reviewDiagnostics: vscode.DiagnosticCollection,
  ) {
    this.conversations = context.workspaceState.get<Conversation[]>(CONVERSATIONS_KEY, []);
    this.bestOfNExperiments = context.workspaceState.get<BestOfNExperiment[]>(BEST_OF_N_KEY, []);
  }

  public async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    this.webviewReady = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    view.webview.html = this.getHtml(view.webview);
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
        this.webviewReady = false;
      }
    });

    view.webview.onDidReceiveMessage(
      async (message: {
        type?: string;
        prompt?: string;
        attachContext?: boolean;
        files?: string[];
        references?: string[];
        query?: string;
        requestId?: number;
        modelId?: string;
        modelParams?: { id?: unknown; value?: unknown }[];
        profile?: string;
        skills?: string[];
        commandId?: string;
        includeProjectMemory?: boolean;
        approvalMode?: string;
        setting?: string;
        enabled?: boolean;
        path?: string;
        id?: string;
        uploads?: { name?: unknown; data?: unknown }[];
        pinned?: boolean;
        format?: string;
      }) => {
        switch (message.type) {
          case "ready":
            this.webviewReady = true;
            this.post({ type: "modelSelected", id: this.selectedModel() });
            this.post({ type: "approvalModeSelected", mode: this.selectedApprovalMode() });
            this.postNotificationAndSoundSettings();
            this.post({ type: "workspace", name: workspaceDisplayName() });
            this.postView();
            this.postUsageStats();
            this.postParallelState();
            await this.publishWorkspaceFileIndex();
            await this.publishIntegrationIndex();
            await this.publishAuthState();
            await this.flushPendingChatFiles();
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
              this.parseDroppedFileUploads(message.uploads),
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
            this.postView();
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
            this.postView(typeof message.query === "string" ? message.query : "");
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
          case "selectApprovalMode":
            if (this.isApprovalMode(message.approvalMode)) {
              if (
                message.approvalMode === "full-access"
                && this.selectedApprovalMode() !== "full-access"
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
        }
      },
      undefined,
      this.disposables,
    );

    const fileWatcher = vscode.workspace.createFileSystemWatcher("**/*");
    const invalidateWorkspaceFiles = (): void => {
      this.workspaceFileCache = undefined;
      this.workspaceFileCacheKey = undefined;
      void this.publishWorkspaceFileIndex();
      void this.publishIntegrationIndex();
      this.post({ type: "workspace", name: workspaceDisplayName() });
    };
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.postContextInfo();
        this.post({ type: "workspace", name: workspaceDisplayName() });
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
        .filter((file) => file && !file.startsWith("..") && !path.isAbsolute(file));
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
    this.post({ type: "newChat" });
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
    for (let index = 0; index < runCount; index += 1) {
      const conversation: Conversation = {
        id: randomUUID(),
        title: makeTitle(`[B${index + 1}] ${trimmed}`),
        createdAt: Date.now(),
        updatedAt: Date.now(),
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
    this.postView();

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
    if (this.retainedParallelTasks.has(id)) {
      this.viewedRetainedParallelTasks.add(id);
    }
    this.postView();
  }

  private async deleteConversation(id: string): Promise<void> {
    const deletedConversation = this.conversations.find((c) => c.id === id);
    await this.cancelConversation(id);
    await this.disposeAgent(id);
    for (let index = this.messageQueue.length - 1; index >= 0; index -= 1) {
      if (this.messageQueue[index].conversationId === id) {
        this.messageQueue.splice(index, 1);
      }
    }
    this.conversations = this.conversations.filter((c) => c.id !== id);
    this.parallelTaskParticipants.delete(id);
    this.retainedParallelTasks.delete(id);
    this.viewedRetainedParallelTasks.delete(id);
    if (this.activeId === id) {
      this.activeId = undefined;
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
    await this.cancelAllChats();
    await this.disposeAgent();
    if (this.pendingAttachmentRoot) {
      try {
        const root = await this.pendingAttachmentRoot;
        await vscode.workspace.fs.delete(root, { recursive: true });
      } catch {
        // Pending dropped files may already have been removed.
      }
    }
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
    return value === "auto-review" || value === "full-access";
  }

  private selectedApprovalMode(): ApprovalMode {
    const stored = this.context.globalState.get<string>(APPROVAL_MODE_KEY, "auto-review");
    return this.isApprovalMode(stored) ? stored : "auto-review";
  }

  private isRunProfile(value: unknown): value is RunProfile {
    return value === "agent"
      || value === "plan"
      || value === "multitask";
  }

  private activeConversation(): Conversation | undefined {
    return this.conversations.find((c) => c.id === this.activeId);
  }

  private runtimeFor(conversationId: string): ChatRuntime {
    let runtime = this.chatRuntimes.get(conversationId);
    if (!runtime) {
      runtime = {
        busy: false,
        pendingCancel: false,
        mutating: false,
        overlappedMutation: false,
      };
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
    await this.context.workspaceState.update(CONVERSATIONS_KEY, this.conversations);
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
    const conversation: Conversation = {
      id: randomUUID(),
      title: makeTitle(prompt),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      transcript: [],
    };
    this.conversations.unshift(conversation);
    this.activeId = conversation.id;
    this.showingHome = false;
    return conversation;
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
        const status = running
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
    if (interrupt) {
      this.messageQueue.unshift(item);
    } else {
      this.messageQueue.push(item);
    }
    this.postQueueState();

    if (interrupt) {
      if (this.isConversationBusy(conversationId)) {
        await this.cancelConversation(conversationId, false);
      }
    }
    if (!this.isConversationBusy(conversationId)) {
      await this.drainMessageQueue(conversationId);
    }
  }

  private removeQueuedMessage(id: string): void {
    const index = this.messageQueue.findIndex((item) => item.id === id);
    if (index < 0) {
      return;
    }
    this.messageQueue.splice(index, 1);
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

    const workspace = resolveWorkspaceFolder(
      vscode.window.activeTextEditor?.document.uri,
    ) ?? vscode.workspace.workspaceFolders?.[0];
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

    const apiKey = await this.context.secrets.get(API_KEY_SECRET);
    if (!apiKey) {
      this.post({ type: "authRequired" });
      await this.promptForApiKey();
      return;
    }

    const conversation = targetConversationId
      ? this.conversations.find((candidate) => candidate.id === targetConversationId)
      : this.ensureConversation(effectivePrompt);
    if (!conversation) {
      return;
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
    const mutatingRuntimes = [...this.chatRuntimes.values()].filter(
      (candidate) => candidate.busy && candidate.mutating,
    );
    this.retainedParallelTasks.delete(conversationId);
    this.viewedRetainedParallelTasks.delete(conversationId);
    runtime.busy = true;
    runtime.pendingCancel = false;
    runtime.mutating = profile !== "plan";
    runtime.overlappedMutation = runtime.mutating && mutatingRuntimes.length > 0;
    if (runtime.overlappedMutation) {
      for (const candidate of mutatingRuntimes) {
        candidate.overlappedMutation = true;
      }
      if (!this.context.workspaceState.get<boolean>(PARALLEL_EDIT_WARNING_KEY, false)) {
        void this.context.workspaceState.update(PARALLEL_EDIT_WARNING_KEY, true);
        void vscode.window.showWarningMessage(localize(
          "Parallel chat agents share the current workspace. Give them separate files or scopes to avoid edit conflicts.",
          "並列チャットAgentは現在のワークスペースを共有します。編集競合を避けるため、別々のファイルまたは担当範囲を指定してください。",
        ));
      }
    }
    this.postParallelState();
    let attachmentReferences: AttachedFileReference[] = [];
    let composed = effectivePrompt;
    let contextLabel: string | undefined;
    let images: SDKImage[] = [];
    let changeSessionId = continueSession ? runtime.changeSessionId : undefined;
    try {
      const attachedFiles = await this.resolveAttachedFiles(requestedFiles, workspace);
      attachmentReferences = await this.stageExternalAttachments(
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
      images = await this.loadAttachedImages(attachedFiles, workspace);
      if (
        profile !== "plan"
        && !continueSession
        && this.featureEnabled("enableChangeSessions")
      ) {
        await runConfiguredHooks("preEdit", workspace.uri.fsPath, this.output);
        changeSessionId = (await this.changeSessions.begin(effectivePrompt, workspace.uri.fsPath)).id;
        runtime.changeSessionId = changeSessionId;
        this.repairAttempts.set(conversationId, 0);
      }
    } catch (error) {
      runtime.busy = false;
      runtime.pendingCancel = false;
      runtime.mutating = false;
      runtime.overlappedMutation = false;
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

    try {
      const blockedProxy = detectBlockedProxyEnvironment();
      if (blockedProxy) {
        const text = this.formatBlockedProxyError(blockedProxy);
        this.output.appendLine(
          `[${new Date().toISOString()}] Run blocked before SDK connection: ${blockedProxy.variable}=${blockedProxy.address}`,
        );
        throw new Error(text);
      }

      const cwd = workspace.uri.fsPath;
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
          );
        }
      }

      result ??= await resultPromise;
      if (
        profile !== "plan"
        && changeSessionId
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

      if (result.status === "finished" && editedFiles.size > 0 && profile !== "plan") {
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
      runtime.busy = false;
      runtime.pendingCancel = false;
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
    if (this.view?.visible && vscode.window.state.focused) {
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

  private getWorkspaceFiles(): PromiseLike<WorkspaceFileItem[]> {
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

  private async publishWorkspaceFileIndex(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      this.post({ type: "workspaceFileIndex", files: [] });
      return;
    }
    const files = await this.getWorkspaceFiles();
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

  private async resolveAttachedFiles(
    requestedFiles: string[],
    workspace: vscode.WorkspaceFolder,
  ): Promise<string[]> {
    const unique = [...new Set(requestedFiles)].slice(0, 20);
    const resolved: string[] = [];

    for (const requested of unique) {
      const absolute = resolveAbsoluteInWorkspace(requested, workspace);
      if (!absolute) {
        continue;
      }
      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.file(absolute));
        if ((stat.type & vscode.FileType.File) === 0) {
          continue;
        }
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(absolute));
        resolved.push(
          (folder
            ? vscode.workspace.asRelativePath(vscode.Uri.file(absolute), true)
            : absolute).replaceAll("\\", "/"),
        );
      } catch {
        // Ignore stale or invalid file selections.
      }
    }
    return resolved;
  }

  private async loadAttachedImages(
    files: string[],
    workspace: vscode.WorkspaceFolder,
  ): Promise<SDKImage[]> {
    const images: SDKImage[] = [];
    let skippedLargeImages = 0;
    for (const file of files) {
      const format = IMAGE_FORMATS[path.extname(file).toLowerCase()];
      if (!format?.vision || images.length >= 8) {
        continue;
      }
      const absolute = resolveAbsoluteInWorkspace(file, workspace);
      if (!absolute) {
        continue;
      }
      try {
        const uri = vscode.Uri.file(absolute);
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_IMAGE_BYTES) {
          skippedLargeImages += 1;
          continue;
        }
        const data = await vscode.workspace.fs.readFile(uri);
        images.push({
          data: Buffer.from(data).toString("base64"),
          mimeType: format.mimeType,
        });
      } catch {
        // Invalid or stale attachments are already omitted from the file list.
      }
    }
    if (skippedLargeImages > 0) {
      void vscode.window.showWarningMessage(localize(
        String(skippedLargeImages) + " image(s) exceeded the 20 MB image limit and were attached as files only.",
        String(skippedLargeImages) + "件の画像が20 MBの上限を超えたため、ファイル参照としてのみ添付しました。",
      ));
    }
    return images;
  }

  private async pickImages(requestId: number): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      title: localize("Attach images", "画像を添付"),
      filters: {
        [localize("Images", "画像")]: IMAGE_FILE_EXTENSIONS,
      },
    });
    if (!uris?.length) {
      return;
    }
    await this.resolveAttachmentReferences(uris.map((uri) => uri.fsPath), requestId);
  }

  private parseDroppedFileUploads(
    uploads: { name?: unknown; data?: unknown }[] | undefined,
  ): DroppedFileUpload[] {
    if (!Array.isArray(uploads)) {
      return [];
    }

    const parsed: DroppedFileUpload[] = [];
    for (const upload of uploads.slice(0, 20)) {
      if (typeof upload?.name !== "string") {
        continue;
      }
      let data: Uint8Array | undefined;
      if (upload.data instanceof Uint8Array) {
        data = upload.data;
      } else if (upload.data instanceof ArrayBuffer) {
        data = new Uint8Array(upload.data);
      } else if (
        Array.isArray(upload.data)
        && upload.data.every(
          (value) => Number.isInteger(value) && value >= 0 && value <= 255,
        )
      ) {
        data = Uint8Array.from(upload.data);
      }
      if (data) {
        parsed.push({ name: upload.name, data });
      }
    }
    return parsed;
  }

  private ensurePendingAttachmentRoot(): Promise<vscode.Uri> {
    if (!this.pendingAttachmentRoot) {
      this.pendingAttachmentRoot = (async () => {
        const root = vscode.Uri.joinPath(
          this.context.globalStorageUri,
          "pending-attachments",
        );
        try {
          await vscode.workspace.fs.delete(root, { recursive: true });
        } catch {
          // There may be no stale pending attachment directory yet.
        }
        await vscode.workspace.fs.createDirectory(root);
        return root;
      })();
    }
    return this.pendingAttachmentRoot;
  }

  private async stageDroppedFileUpload(
    upload: DroppedFileUpload,
  ): Promise<WorkspaceFileItem | undefined> {
    if (upload.data.byteLength > MAX_DROPPED_FILE_BYTES) {
      return undefined;
    }

    const originalName = path.basename(upload.name.trim());
    const safeName = originalName
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "")
      || "attachment";
    const hash = createHash("sha256")
      .update(upload.data)
      .digest("hex")
      .slice(0, 12);
    const root = await this.ensurePendingAttachmentRoot();
    const uri = vscode.Uri.joinPath(root, `${hash}-${safeName}`);
    await vscode.workspace.fs.writeFile(uri, upload.data);
    const normalized = uri.fsPath.replaceAll("\\", "/");
    this.pendingAttachmentLabels.set(path.resolve(uri.fsPath).toLowerCase(), safeName);
    return {
      path: normalized,
      label: safeName,
      description: path.posix.dirname(normalized),
    };
  }

  private async stageExternalAttachments(
    files: string[],
    workspace: vscode.WorkspaceFolder,
    conversation: Conversation,
  ): Promise<AttachedFileReference[]> {
    const root = path.resolve(workspace.uri.fsPath);
    const references: AttachedFileReference[] = [];
    let attachmentRootUri: vscode.Uri | undefined;

    for (const file of files) {
      if (!path.isAbsolute(file)) {
        references.push({ displayPath: file, agentPath: file, external: false });
        continue;
      }

      const absolute = path.resolve(file);
      const relative = path.relative(root, absolute);
      const isInWorkspace = relative
        && !relative.startsWith("..")
        && !path.isAbsolute(relative);
      if (isInWorkspace) {
        const normalized = relative.replaceAll("\\", "/");
        references.push({ displayPath: normalized, agentPath: normalized, external: false });
        continue;
      }

      attachmentRootUri ??= vscode.Uri.joinPath(
        this.context.globalStorageUri,
        "attachments",
        conversation.id,
      );
      await vscode.workspace.fs.createDirectory(attachmentRootUri);
      const hash = createHash("sha256").update(absolute).digest("hex").slice(0, 12);
      const stagedUri = vscode.Uri.joinPath(
        attachmentRootUri,
        `${hash}-${path.basename(absolute)}`,
      );
      await vscode.workspace.fs.copy(vscode.Uri.file(absolute), stagedUri, { overwrite: true });
      const pendingLabel = this.pendingAttachmentLabels.get(absolute.toLowerCase());
      references.push({
        displayPath: pendingLabel ?? absolute.replaceAll("\\", "/"),
        agentPath: stagedUri.fsPath.replaceAll("\\", "/"),
        external: true,
      });
    }

    if (attachmentRootUri) {
      conversation.attachmentRoot = attachmentRootUri.fsPath;
      await this.saveConversations();
    }
    return references;
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
        const item = await this.stageDroppedFileUpload(upload);
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

  private async createOrResumeAgent(
    apiKey: string,
    roots: string[],
    workspaceName: string,
    conversation: Conversation,
  ): Promise<CursorAgent> {
    const cwd = roots.length === 1 ? roots[0] : roots;
    const approvalMode = this.selectedApprovalMode();
    const local: LocalAgentOptions = {
      cwd,
      autoReview: approvalMode === "auto-review",
      sandboxOptions: {
        enabled: SUPPORTS_LOCAL_SANDBOX && approvalMode !== "full-access",
      },
      settingSources: ["all"],
    };
    if (approvalMode === "auto-review" && !SUPPORTS_LOCAL_SANDBOX) {
      this.post({ type: "sandboxUnavailable" });
    }
    const agents = this.builtInSubagents();
    const connect = async (localOptions: LocalAgentOptions): Promise<CursorAgent> => {
      if (conversation.agentId) {
        try {
          return await Agent.resume(conversation.agentId, {
            apiKey,
            local: localOptions,
            agents,
          });
        } catch (error) {
          if (this.isSandboxUnavailableError(error)) {
            throw error;
          }
          // 保存済みエージェントが復元できない場合は新規作成にフォールバック。
          conversation.agentId = undefined;
        }
      }

      const agent = await Agent.create({
        apiKey,
        model: this.selectedModelSelection(),
        local: localOptions,
        agents,
        name: `VS Code: ${workspaceName}`,
      });
      conversation.agentId = agent.agentId;
      await this.saveConversations();
      return agent;
    };

    try {
      return await connect(local);
    } catch (error) {
      if (!local.sandboxOptions?.enabled || !this.isSandboxUnavailableError(error)) {
        throw error;
      }

      if (!this.sandboxFallbackApproved) {
        const continueLabel = localize("Run without sandbox", "サンドボックスなしで実行");
        const detail = localize(
          "This environment does not support Cursor's local sandbox. Continuing disables filesystem and network isolation, but Auto-review remains enabled.",
          "この環境はCursorのローカルサンドボックスに対応していません。続行するとファイルとネットワークの隔離はなくなりますが、自動レビューは維持されます。",
        );
        const answer = await vscode.window.showWarningMessage(
          detail,
          { modal: true },
          continueLabel,
        );
        if (answer !== continueLabel) {
          throw new Error(localize(
            "Run cancelled because local sandboxing is unavailable.",
            "ローカルサンドボックスを利用できないため、実行をキャンセルしました。",
          ));
        }
        this.sandboxFallbackApproved = true;
      }

      this.post({ type: "sandboxUnavailable" });
      return connect({
        ...local,
        sandboxOptions: { enabled: false },
      });
    }
  }

  private isSandboxUnavailableError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("sandboxing is not supported in this environment")
      || message.includes("Local SDK sandboxing was requested");
  }

  private builtInSubagents(): Record<string, AgentDefinition> {
    return {
      researcher: {
        description: "Read-only specialist for gathering codebase evidence and comparing approaches.",
        prompt: "Investigate the assigned question. Read relevant files, gather concise evidence, and report findings. Do not edit files.",
        model: "inherit",
      },
      implementer: {
        description: "Implementation specialist for a clearly scoped independent code change.",
        prompt: "Implement only the assigned scope, preserve unrelated work, and run focused validation. Report changed files and results.",
        model: "inherit",
      },
      reviewer: {
        description: "Review specialist for correctness, regressions, security, and missing validation.",
        prompt: "Review the assigned work with evidence. Do not edit files unless explicitly instructed. Report actionable issues by priority.",
        model: "inherit",
      },
    };
  }

  private handleToolEvent(
    event: unknown,
    cwd: string,
    editedFiles: Set<string>,
    progressSteps: Map<string, ToolProgressEntry>,
    conversationId: string,
    changeSessionId?: string,
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
    const text = this.describeToolProgress(tool.name, tool.args, cwd);
    const step: ToolProgressEntry = { id, text, status };
    progressSteps.set(id, step);
    this.postIfActive(conversationId, {
      type: "toolStatus",
      callId: id,
      text,
      status,
    });

    if (!/edit|write|apply.?patch/i.test(tool.name)) {
      return;
    }

    for (const filePath of extractFilePaths(tool.args)) {
      const absolute = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
      if (!editedFiles.has(absolute)) {
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
  }

  private describeToolProgress(toolName: string, args: unknown, cwd: string): string {
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
      return `${action}: ${vscode.workspace.asRelativePath(absolute)}`;
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
      const recovered = await this.recoverStoredAttachment(filePath);
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

  private async recoverStoredAttachment(filePath: string): Promise<vscode.Uri | undefined> {
    const missingName = path.basename(filePath);
    if (!missingName) {
      return undefined;
    }

    const active = this.activeId
      ? this.conversations.find((conversation) => conversation.id === this.activeId)
      : undefined;
    const conversations = [
      ...(active ? [active] : []),
      ...this.conversations.filter((conversation) => conversation !== active),
    ];

    for (const conversation of conversations) {
      if (!conversation.attachmentRoot) {
        continue;
      }
      const root = vscode.Uri.file(conversation.attachmentRoot);
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(root);
      } catch {
        continue;
      }
      const lowerName = missingName.toLowerCase();
      const match = entries.find(([name, type]) =>
        (type & vscode.FileType.File) !== 0
        && (
          name.toLowerCase() === lowerName
          || name.toLowerCase().endsWith(`-${lowerName}`)
        )
      );
      if (!match) {
        continue;
      }

      const recovered = vscode.Uri.joinPath(root, match[0]);
      const recoveredPath = recovered.fsPath.replaceAll("\\", "/");
      const label = missingName.replace(/^[0-9a-f]{12}-/i, "");
      let changed = false;
      for (const entry of conversation.transcript) {
        if (!entry.attachments) {
          continue;
        }
        entry.attachments = entry.attachments.map((attachment) => {
          const attachmentPath = typeof attachment === "string"
            ? attachment
            : attachment.path;
          if (path.resolve(attachmentPath).toLowerCase() !== path.resolve(filePath).toLowerCase()) {
            return attachment;
          }
          changed = true;
          return { path: recoveredPath, label };
        });
      }
      if (changed) {
        await this.saveConversations();
      }
      return recovered;
    }
    return undefined;
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
      for (let index = this.messageQueue.length - 1; index >= 0; index -= 1) {
        if (this.messageQueue[index].conversationId === conversationId) {
          this.messageQueue.splice(index, 1);
        }
      }
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

  private async publishIntegrationIndex(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      this.projectCommands = await loadProjectCommands();
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
        for (const uri of skillUris) {
          const bytes = await vscode.workspace.fs.readFile(uri);
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

    this.projectCommands = await loadProjectCommands(folders);
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
    void this.view?.webview.postMessage(message);
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString("base64");
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
    const ui = IS_JAPANESE
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
          autoReview: "自動レビュー",
          autoReviewDescription: SUPPORTS_LOCAL_SANDBOX
            ? "危険な可能性がある操作を自動判定し、サンドボックスを使用します"
            : "危険な可能性がある操作を自動判定します（この環境ではサンドボックス非対応）",
          fullAccess: "フルアクセス",
          fullAccessDescription: "確認とサンドボックスなしで実行します",
          sandboxUnavailable: "サンドボックスなし・自動レビュー有効",
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
          autoReview: "Auto-review",
          autoReviewDescription: SUPPORTS_LOCAL_SANDBOX
            ? "Classify potentially unsafe actions and use the sandbox"
            : "Classify potentially unsafe actions (sandbox unavailable in this environment)",
          fullAccess: "Full access",
          fullAccessDescription: "Run without review or sandbox restrictions",
          sandboxUnavailable: "No sandbox · Auto-review enabled",
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
<html lang="${IS_JAPANESE ? "ja" : "en"}">
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
    <span id="workspaceLabel">${ui.localRun}</span>
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
        status.textContent = sandboxUnavailable ? i18n.sandboxUnavailable : i18n.connected;
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
      sandboxUnavailable = false;
      const descriptions = {
        "auto-review": i18n.autoReviewDescription,
        "full-access": i18n.fullAccessDescription,
      };
      approvalSelect.title = descriptions[mode] || i18n.approvalMode;
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
        case "sandboxUnavailable":
          sandboxUnavailable = true;
          status.textContent = i18n.sandboxUnavailable;
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
