import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import { appendFile, mkdir } from "node:fs/promises";
import * as path from "node:path";
import {
  Agent,
  AgentBusyError,
  Cursor,
  CursorAgentError,
  type McpServerConfig,
  type ModelParameterValue,
  type ModelSelection,
  type RunResult,
  type SDKImage,
  type SettingSource,
} from "@cursor/sdk";
import * as vscode from "vscode";
import { AgentFactory } from "./agentFactory.js";
import { AttachmentService } from "./attachmentService.js";
import { normalizeAttachedFilePath } from "./attachmentUtils.js";
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
  buildChangeCourtPrompt,
  formatChangeCourtMarkdown,
  parseChangeCourtReview,
  type ChangeCourtFileEvidence,
} from "./changeCourt.js";
import {
  analyzeFailureTimeMachine,
  formatFailureTimeMachineMarkdown,
} from "./failureTimeMachine.js";
import { buildAutoRepairPrompt } from "./autoRepair.js";
import {
  buildBestOfNJudgePrompt,
  createBestOfNExperiment,
  experimentCandidates,
  parseBestOfNWinnerVerdict,
  pickWinner,
  selectBestOfNWinner,
  shouldAbortBestOfNAutoSelect,
  type BestOfNCandidateEvidence,
  type BestOfNExperiment,
} from "./bestOfN.js";
import { buildContextPreview } from "./contextEstimate.js";
import { generateCommitMessage, resolveRootUri } from "./generateCommitMessage.js";
import { getGitApi } from "./gitApi.js";
import {
  checkoutPreservedPullRequestBranch,
  createBranchCommitAndPullRequest,
  PullRequestCreationError,
  pullRequestRecoveryActionLabel,
  pullRequestRecoveryActions,
  retryPullRequestCreation,
} from "./gitWorkflow.js";
import { listGhIssues } from "./githubIssues.js";
import {
  buildPendingPipelinePr,
  buildPipelineGoalFromIssue,
  buildPipelineGoalFromTodo,
  buildPipelinePullRequestBody,
  buildTaskPipelinePrompt,
} from "./taskPipeline.js";
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
  type IsolatedChange,
  type IsolatedWorktreeSession,
} from "./isolatedWorktree.js";
import {
  detectBlockedProxyEnvironment,
  type BlockedProxyEnvironment,
} from "./networkEnvironment.js";
import {
  expandProjectCommand,
  filterEnabledProjectCommands,
  loadProjectCommands,
  type ProjectCommand,
} from "./projectCommands.js";
import { isLocalRuntimeWriteCancelled } from "./pureUtils.js";
import { RunningSoundController } from "./runningSound.js";
import {
  isRunPreparationError,
  RunPreparationError,
  waitForRunPreparation,
} from "./runPreparation.js";
import {
  AiSupervisorController,
  type SupervisorTask,
  type SupervisorTaskTarget,
} from "./supervisor.js";
import { SupervisorAgentRunner } from "./supervisorRunner.js";
import {
  AUDIT_LOG_KEY,
  appendAuditEntry,
  formatAuditLogMarkdown,
  type AuditAction,
  type AuditEntry,
} from "./auditLog.js";
import { IntegrationCatalogController } from "./integrationCatalogView.js";
import {
  unwrapWorkspaceNode,
  WorkspaceSidebarController,
  WORKSPACE_TREE_VIEW_ID,
} from "./workspaceSidebar.js";
import { INTEGRATION_TOGGLE_KEY, type IntegrationToggleState } from "./integrationCatalog.js";
import { integrationToggleId, isWorkspaceIntegrationEnabled, legacyIntegrationToggleId } from "./integrationToggles.js";
import {
  agentSendBoundaryMatches,
  filterRequestedSkillsForWorkspaceTrust,
  isPromptCommandAllowedForWorkspaceTrust,
  projectSettingSourcesForWorkspaceTrust,
  resumableAgentIdForWorkspaceTrust,
  resolveAgentIntegrationPolicy,
  shouldUseWorkspacePromptIntegrations,
  workspaceTrustSnapshotMatches,
  workspaceTrustIntegrationKey,
  workspaceIntegrationSelection,
} from "./integrationPolicy.js";
import {
  buildOrchestratorDetail,
  buildOrchestratorPlanPrompt,
  buildSynthesisPrompt,
  classifyOrchestratorPlanResponse,
  createOrchestratorExperiment,
  extractSubagentName,
  formatTranscriptForHandoff,
  launchOrchestratorSubtasks,
  markSubtaskConversation,
  markSubtaskLaunch,
  markSubtaskStatus,
  orchestratorFinalResultLinks,
  orchestratorSummaries,
  prepareOrchestratorResume,
  resolveOrchestratorPlan,
  type OrchestratorActivity,
  type OrchestratorExperiment,
} from "./orchestrator.js";
import { createExcludedPathMatcher } from "./sensitivePaths.js";
import { scanTodoAiComments } from "./todoScanner.js";
import {
  createExecutionPlan,
  parseExecutionPlanSteps,
  type ExecutionPlan,
} from "./executionPlan.js";
import {
  addTokenUsage,
  budgetSnapshot,
  estimatedMonthlyCostSnapshot,
  formatTokenCount,
  monthlyBudgetSnapshot,
  monthKey,
  recordUsage,
  summarizeUsage,
  dayKey,
  USAGE_LEDGER_KEY,
  type StoredTokenUsage,
  type UsageLedger,
  type UsageSource,
  type UsageSummary,
} from "./usageStats.js";
import {
  pickWorkspaceFolder,
  resolveWorkspaceFolder,
  configurationFor,
  workspaceDisplayName,
  resolveAbsoluteInWorkspace,
  resolveAbsoluteInWorkspaceResolved,
  workspaceFolderFromUri,
  defaultWorkspaceFolder,
} from "./workspaceFolder.js";
import { WebviewController } from "./webviewController.js";
import type { HostToWebviewMessage, RecoveryActionId } from "./webviewMessages.js";
import { PromptFocusHandoff } from "./promptFocusHandoff.js";
import { cleanupOrphanedManagedWorktrees } from "./worktreeLifecycle.js";
import { ApplyQueue, FileOwnershipCoordinator } from "./parallelOwnership.js";
import { AuditTimelineController } from "./auditTimeline.js";
import { BackgroundJobsController } from "./backgroundJobs.js";
import type { BackgroundJob } from "./backgroundJobTypes.js";
import { RunCenterTreeDataProvider } from "./runCenter.js";
import {
  inlineCompletionAcceptanceRate,
  sanitizeInlineCompletion,
  shouldRequestInlineCompletion,
  type InlineCompletionStats,
} from "./inlineCompletion.js";
import {
  availableParallelSlots,
  canStartAnotherParallelAgent,
  conversationRunState,
  enqueueChatMessage,
  normalizeMaxParallelAgents,
  queuedConversationIds,
  removeQueuedMessages,
  requeueUnstartedMessage,
  requeueUnstartedMessages,
  selectParallelLaunchCandidates,
  shouldCancelOnInterrupt,
  takeNextQueuedMessage,
  takeParallelLaunchBatch,
} from "./chatSendQueue.js";
import {
  computeOverlappedMutationFlags,
  defaultSafetyApprovalMode,
  isSafeRelativePath,
  shouldMigrateToSafeWorktree,
  shouldUseIsolatedWorktree,
  safeResolvePathResolved,
  type SafetyApprovalMode,
} from "./safety.js";
import { runExecutableCommand } from "./shellCommand.js";
import { githubCliEnv } from "./shellEnv.js";
import {
  currentExecutionProfileLabel,
  matchExecutionProfile,
  type ExecutionProfileId,
  type ExecutionProfileSettingValue,
} from "./executionProfiles.js";
import { type DiagnosticsBundle } from "./diagnosticsBundle.js";
import {
  summarizeBackgroundJobs,
  summarizeRunCenter,
  summarizeSupervisorTasks,
} from "./diagnosticsCollectors.js";
import {
  buildConfigurationSnapshot,
  buildRecentAuditSnapshot,
  buildRecentRunsFromConversations,
  configurationKeysForDiagnostics,
} from "./diagnosticsCollect.js";
import {
  conversationSummaries as buildConversationSummaries,
  conversationToMarkdown as formatConversationMarkdown,
  findConversationForRetry,
} from "./conversationUi.js";
import { buildSetupChecklistState, type SetupChecklistState } from "./setupChecklistState.js";
import { buildRunCenterHostSnapshot } from "./runCenterSnapshot.js";
import { WorkflowController } from "./workflowController.js";
import { DiagnosticsController } from "./diagnosticsController.js";
import {
  RunCenterCoordinator,
  type BackgroundChangeSnapshot,
} from "./runCenterCoordinator.js";
import type { RunCenterState } from "./runCenterModel.js";
import { AsyncLifecycle, ExtensionDeactivation } from "./asyncLifecycle.js";

const API_KEY_SECRET = "cursorSubscription.apiKey";
const CONVERSATIONS_KEY = "cursorSubscription.conversations";
const MODEL_KEY = "cursorSubscription.model";
const MODEL_PARAMS_KEY = "cursorSubscription.modelParams";
const APPROVAL_MODE_KEY = "cursorSubscription.approvalMode";
const SANDBOX_WARNING_ACK_KEY = "cursorSubscription.sandboxWarningAcknowledged";
const WINDOWS_SAFE_MODE_MIGRATION_KEY = "cursorSubscription.windowsSafeModeDefaultAppliedV1";
const PARALLEL_EDIT_WARNING_KEY = "cursorSubscription.parallelEditWarningShown";
const BEST_OF_N_KEY = "cursorSubscription.bestOfNExperiments";
const ORCHESTRATOR_KEY = "cursorSubscription.orchestratorExperiments";
const EXECUTION_PLANS_KEY = "cursorSubscription.executionPlans";
const UNTRUSTED_WORKSPACE_WARNING_KEY = "cursorSubscription.untrustedWorkspaceWarningShown";
const SETUP_CHECKLIST_DISMISSED_KEY = "cursorSubscription.setupChecklistDismissed";
const SETUP_CHECKLIST_PERMISSIONS_CONFIRMED_KEY =
  "cursorSubscription.setupChecklistPermissionsConfirmed";
const SETUP_CHECKLIST_GH_SKIPPED_KEY = "cursorSubscription.setupChecklistGhSkipped";
const EXECUTION_PROFILE_KEY = "cursorSubscription.executionProfile";
const BUDGET_WARNED_KEY_PREFIX = "cursorSubscription.budgetWarned";
const MAX_INLINE_COMPLETION_CACHE = 32;
const INLINE_COMPLETION_STATS_KEY = "cursorSubscription.inlineCompletionStats";
const VIEW_ID = "cursorSubscription.chatView";
const E2E_MARKER = "CURSOR_SUBSCRIPTION_E2E";
const E2E_WEBVIEW_STATE_COMMAND = "cursorSubscription.__e2e.webviewState";
const E2E_SETUP_CHECKLIST_COMMAND = "cursorSubscription.__e2e.setupChecklistState";
const E2E_RUN_CENTER_SNAPSHOT_COMMAND = "cursorSubscription.__e2e.runCenterSnapshot";
const E2E_EXPORT_DIAGNOSTICS_DRY_RUN_COMMAND = "cursorSubscription.__e2e.exportDiagnosticsDryRun";
const E2E_RETRY_LAST_RUN_PROBE_COMMAND = "cursorSubscription.__e2e.retryLastRunProbe";
const RUN_FAILURE_RECOVERY_ACTIONS = ["retry", "diagnostics", "runCenter"] as const satisfies readonly RecoveryActionId[];
const DEFAULT_MODEL = "auto";
const IS_JAPANESE = vscode.env.language.toLowerCase().startsWith("ja");
const MAX_DROPPED_FILE_BYTES = 20 * 1024 * 1024;
const MAX_EDITOR_GENERATION_CONTEXT = 60_000;
const WORKSPACE_INDEX_DEBOUNCE_MS = 300;
const SHUTDOWN_CLEANUP_TIMEOUT_MS = 5_000;
const SUPPORTS_LOCAL_SANDBOX = process.platform !== "win32";
const extensionDeactivation = new ExtensionDeactivation();
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
  return (
    configuration.get<boolean>("enableAiNativeFeatures", true) &&
    configuration.get<boolean>(setting, setting !== "enableInlineCompletions")
  );
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
  const sharedApplyQueue = new ApplyQueue();
  const sharedFileOwnership = new FileOwnershipCoordinator();
  const supervisor = new AiSupervisorController(
    context.workspaceState,
    context.storageUri ?? context.globalStorageUri,
    output,
    IS_JAPANESE,
    () => configuredAiFeatureEnabled("enableAiSupervisor"),
  );
  supervisor.setApplyCoordination(sharedApplyQueue, sharedFileOwnership);
  const supervisorRunner = new SupervisorAgentRunner(context, output);
  const provider = new CursorChatProvider(
    context,
    output,
    runningSound,
    changeSessions,
    reviewDiagnostics,
  );
  extensionDeactivation.setActive(provider);
  provider.setApplyCoordination(sharedApplyQueue, sharedFileOwnership);
  const auditTimeline = new AuditTimelineController(context.workspaceState, IS_JAPANESE);
  provider.setAuditTimeline(auditTimeline);
  const backgroundJobs = new BackgroundJobsController(
    context,
    output,
    IS_JAPANESE,
    (job, changes) => provider.applyBackgroundJob(job, changes),
    (job, action) =>
      provider.recordAudit({
        action,
        summary: `${action === "background.cancel" ? "Cancelled" : "Discarded"} background job: ${job.title}`,
      }),
  );
  provider.setCredentialRevocationHandlers({
    cancelBackgroundJobs: () => backgroundJobs.cancelAllRunning(),
    cancelSupervisor: () => supervisorRunner.cancel(),
  });
  const cleanupChatWorktrees = (folder: vscode.WorkspaceFolder): void => {
    void cleanupOrphanedManagedWorktrees(
      folder.uri.fsPath,
      [".cursor-safe-chat/worktrees", ".cursor-parallel-chat/worktrees"],
      (message) => output.appendLine(message),
    )
      .then((removed) => {
        if (removed.length > 0) {
          output.appendLine(
            `[${new Date().toISOString()}] Removed ${removed.length} orphaned chat worktree(s).`,
          );
        }
      })
      .catch((error) => {
        output.appendLine(
          `[${new Date().toISOString()}] Could not inspect orphaned chat worktrees: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  };
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    cleanupChatWorktrees(folder);
  }
  const orphanCleanupSubscription = vscode.workspace.onDidChangeWorkspaceFolders((event) => {
    for (const folder of event.added) {
      cleanupChatWorktrees(folder);
    }
  });
  supervisor.setExecutor(
    async (task, worktreePath, prompt) => {
      const outcome = await supervisorRunner.execute(task, worktreePath, prompt);
      if (outcome?.usage) {
        await provider.recordUsage("supervisor", outcome.usage);
      }
      return outcome;
    },
    () => supervisorRunner.isAtCapacity(),
    (taskId) => supervisorRunner.cancel(taskId),
  );
  const integrations = new IntegrationCatalogController(context.workspaceState, IS_JAPANESE);
  const runCenter = new RunCenterTreeDataProvider(IS_JAPANESE);
  provider.setRunCenter(runCenter);
  provider.setRunCenterSources({
    backgroundJobs: () =>
      backgroundJobs.snapshots().map((job) => ({
        ...job,
        changes: backgroundJobs.changeSummaries(job.id)?.map((change) => ({
          relative: change.relative,
          kind: change.kind,
          added: change.added,
          deleted: change.deleted,
        })),
      })),
    supervisorTasks: () => supervisor.snapshots(),
  });
  provider.setDiagnosticsSources({
    backgroundJobs: () => backgroundJobs.snapshots(),
    supervisorTasks: () => supervisor.snapshots(),
    runCenter: () => runCenter.snapshot,
    auditSharedLogError: () => auditTimeline.getSharedLogError(),
  });
  const runCenterBackgroundSubscription = backgroundJobs.onDidChangeTreeData(() =>
    provider.refreshRunCenterView(),
  );
  const runCenterSupervisorSubscription = supervisor.onDidChangeTreeData(() =>
    provider.refreshRunCenterView(),
  );
  const workspaceSidebar = new WorkspaceSidebarController(IS_JAPANESE, {
    runCenter,
    sessions: changeSessions,
    inbox: supervisor,
    integrations,
    background: backgroundJobs,
    audit: auditTimeline,
  });
  const workspaceTree = vscode.window.createTreeView(WORKSPACE_TREE_VIEW_ID, {
    treeDataProvider: workspaceSidebar,
  });
  workspaceSidebar.attachTreeView(workspaceTree);
  supervisor.attachTreeView(workspaceTree);
  supervisor.setAuditSink((event) => {
    void provider.recordAudit(event);
  });
  if (
    !vscode.workspace.isTrusted &&
    !context.workspaceState.get<boolean>(UNTRUSTED_WORKSPACE_WARNING_KEY, false)
  ) {
    void context.workspaceState.update(UNTRUSTED_WORKSPACE_WARNING_KEY, true);
    void vscode.window.showInformationMessage(
      localize(
        "This workspace is not trusted. Autonomous Supervisor, auto-apply, auto-repair, hooks, verification, and similar automation are restricted until you trust the workspace.",
        "このワークスペースは信頼されていません。ワークスペースを信頼するまで、Autonomous Supervisor、自動適用、自動修復、フック、検証などの自動化は制限されます。",
      ),
    );
  }

  const requireTrustedWorkspace = <T>(
    englishWarning: string,
    japaneseWarning: string,
    action: () => T,
  ): T | "workspace-trust-required" => {
    if (vscode.workspace.isTrusted) {
      return action();
    }
    void vscode.window.showWarningMessage(localize(englishWarning, japaneseWarning));
    return "workspace-trust-required";
  };

  context.subscriptions.push(
    output,
    runningSound,
    changeSessions,
    supervisor,
    supervisorRunner,
    reviewDiagnostics,
    provider,
    auditTimeline,
    backgroundJobs,
    workspaceSidebar,
    workspaceTree,
    integrations,
    runCenter,
    runCenterBackgroundSubscription,
    runCenterSupervisorSubscription,
    orphanCleanupSubscription,
    vscode.workspace.registerTextDocumentContentProvider("cursor-supervisor-preview", supervisor),
    vscode.workspace.registerTextDocumentContentProvider(
      "cursor-background-preview",
      backgroundJobs,
    ),
    vscode.languages.registerCodeLensProvider({ scheme: "cursor-supervisor-preview" }, supervisor),
    vscode.languages.registerCodeActionsProvider(
      { scheme: "file" },
      new CursorAiCodeActionProvider(IS_JAPANESE, () =>
        configuredAiFeatureEnabled("enableDiagnosticQuickFixes"),
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
      ),
    ),
    vscode.commands.registerCommand("cursorSubscription.chooseWorkflow", () =>
      provider.chooseWorkflow(),
    ),
    vscode.commands.registerCommand("cursorSubscription.chooseExecutionProfile", async () => {
      await provider.chooseExecutionProfile();
    }),
    vscode.commands.registerCommand("cursorSubscription.openOutput", () => output.show(true)),
    vscode.commands.registerCommand("cursorSubscription.exportDiagnostics", () =>
      provider.exportDiagnostics(),
    ),
    vscode.commands.registerCommand("cursorSubscription.retryLastRun", () =>
      provider.retryLastRun(),
    ),
    vscode.commands.registerCommand("cursorSubscription.startBackgroundJob", () =>
      requireTrustedWorkspace(
        "Background agents require a trusted workspace.",
        "バックグラウンドAgentには信頼済みワークスペースが必要です。",
        () => backgroundJobs.create(),
      ),
    ),
    vscode.commands.registerCommand("cursorSubscription.refreshBackgroundJobs", () =>
      backgroundJobs.refresh(),
    ),
    vscode.commands.registerCommand("cursorSubscription.focusWorkspaceSessions", () =>
      workspaceSidebar.focusGroup("sessions"),
    ),
    vscode.commands.registerCommand("cursorSubscription.openRunCenter", () =>
      workspaceSidebar.focusGroup("runCenter"),
    ),
    vscode.commands.registerCommand("cursorSubscription.focusWorkspaceInbox", () =>
      workspaceSidebar.focusGroup("inbox"),
    ),
    vscode.commands.registerCommand("cursorSubscription.applyBackgroundJob", (target) =>
      backgroundJobs.apply(unwrapWorkspaceNode(target)),
    ),
    vscode.commands.registerCommand("cursorSubscription.cancelBackgroundJob", (target) =>
      backgroundJobs.cancel(unwrapWorkspaceNode(target)),
    ),
    vscode.commands.registerCommand("cursorSubscription.cleanupAppliedBackgroundJob", (target) =>
      backgroundJobs.cleanupApplied(unwrapWorkspaceNode(target)),
    ),
    vscode.commands.registerCommand("cursorSubscription.discardBackgroundJob", (target) =>
      backgroundJobs.discard(unwrapWorkspaceNode(target)),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.openBackgroundChange",
      (target) => backgroundJobs.openChange(unwrapWorkspaceNode(target)),
    ),
    vscode.commands.registerCommand("cursorSubscription.refreshAuditTimeline", () =>
      auditTimeline.refresh(),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.openAuditFile",
      async (entry: AuditEntry, file: string) => provider.openAuditFile(entry, file),
    ),
    vscode.commands.registerCommand("cursorSubscription.inlineCompletionAccepted", () =>
      provider.noteInlineCompletionAccepted(),
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration("cursorSubscription.enableAiNativeFeatures") ||
        event.affectsConfiguration("cursorSubscription.enableChangeSessions")
      ) {
        changeSessions.refresh();
      }
      if (
        event.affectsConfiguration("cursorSubscription.enableAiNativeFeatures") ||
        event.affectsConfiguration("cursorSubscription.enableAiReview")
      ) {
        if (!configuredAiFeatureEnabled("enableAiReview")) {
          reviewDiagnostics.clear();
        }
      }
    }),
    vscode.commands.registerCommand("cursorSubscription.setApiKey", () =>
      provider.promptForApiKey(),
    ),
    vscode.commands.registerCommand("cursorSubscription.clearApiKey", () => provider.clearApiKey()),
    vscode.commands.registerCommand("cursorSubscription.showSetupChecklist", () =>
      provider.showSetupChecklist(),
    ),
    vscode.commands.registerCommand("cursorSubscription.newChat", () => provider.newChat()),
    vscode.commands.registerCommand("cursorSubscription.findInChat", () => provider.findInChat()),
    vscode.commands.registerTextEditorCommand("cursorSubscription.generateCode", (editor) =>
      provider.generateCode(editor),
    ),
    vscode.commands.registerTextEditorCommand("cursorSubscription.explainSelection", (editor) =>
      provider.explainSelection(editor),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.addFileToChat",
      (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
        const selected =
          Array.isArray(uris) && uris.length > 0
            ? uris
            : uri
              ? [uri]
              : vscode.window.activeTextEditor
                ? [vscode.window.activeTextEditor.document.uri]
                : [];
        return provider.addFilesToChat(selected);
      },
    ),
    vscode.commands.registerCommand("cursorSubscription.generateCommitMessage", (arg?: unknown) =>
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
      requireTrustedWorkspace(
        "Creating a pull request requires a trusted workspace.",
        "プルリクエストを作成するには、信頼済みワークスペースが必要です。",
        () => provider.createPullRequestFromWorkspace(),
      ),
    ),
    vscode.commands.registerCommand("cursorSubscription.runAutopilot", () =>
      provider.runAutopilot(),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.fixDiagnostics",
      (uri: vscode.Uri, range: vscode.Range, diagnostics: vscode.Diagnostic[]) =>
        provider.fixDiagnostics(uri, range, diagnostics),
    ),
    vscode.commands.registerCommand("cursorSubscription.reviewChanges", () =>
      provider.reviewWorkspaceChanges(),
    ),
    vscode.commands.registerCommand("cursorSubscription.clearReview", () =>
      reviewDiagnostics.clear(),
    ),
    vscode.commands.registerCommand("cursorSubscription.debugContext", () =>
      provider.analyzeDebugContext(),
    ),
    vscode.commands.registerCommand("cursorSubscription.refreshProjectMemory", () =>
      provider.refreshProjectMemory(),
    ),
    vscode.commands.registerCommand("cursorSubscription.verifyChanges", () =>
      provider.verifyCurrentChanges(),
    ),
    vscode.commands.registerCommand("cursorSubscription.revertLastSession", (sessionId?: string) =>
      provider.revertLastSession(sessionId),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.openSessionFile",
      (sessionId: string, file: string) => provider.openSessionFile(sessionId, file),
    ),
    vscode.commands.registerCommand("cursorSubscription.keepSessionEdit", (target: unknown) => {
      const node = unwrapWorkspaceNode<{ sessionId?: string; file?: string }>(target);
      return provider.keepSessionEdit(node?.sessionId, node?.file);
    }),
    vscode.commands.registerCommand("cursorSubscription.restoreSessionEdit", (target: unknown) => {
      const node = unwrapWorkspaceNode<{ sessionId?: string; file?: string }>(target);
      return provider.restoreSessionEdit(node?.sessionId, node?.file);
    }),
    vscode.commands.registerCommand(
      "cursorSubscription.keepAllSessionEdits",
      (sessionId?: string) => provider.keepAllSessionEdits(sessionId),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.restoreAllSessionEdits",
      (sessionId?: string) => provider.restoreAllSessionEdits(sessionId),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.compareChangeSessions",
      (sessionId?: string) => provider.compareChangeSessions(sessionId),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.compareSessionContents",
      (sessionId?: string) => provider.compareSessionContents(sessionId),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.reviewChangeSession",
      (sessionId?: string) => provider.reviewChangeSession(sessionId),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.openFailureTimeMachine",
      (sessionId?: string) => provider.openFailureTimeMachine(sessionId),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.reverifyChangeSession",
      (sessionId?: string) => provider.reverifyChangeSession(sessionId),
    ),
    vscode.commands.registerCommand("cursorSubscription.chooseSupervisorMode", () =>
      supervisor.chooseMode(),
    ),
    vscode.commands.registerCommand("cursorSubscription.createSupervisorTask", () =>
      supervisor.createManualTask(),
    ),
    vscode.commands.registerCommand("cursorSubscription.scanSupervisorDiagnostics", () =>
      supervisor.scanDiagnostics(),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.runSupervisorTask",
      (target?: SupervisorTaskTarget | string) => supervisor.runTask(unwrapWorkspaceNode(target)),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.openSupervisorChange",
      (target?: SupervisorTaskTarget) => supervisor.openChange(unwrapWorkspaceNode(target)),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.showSupervisorChangeReason",
      (target?: SupervisorTaskTarget) => supervisor.showChangeReason(unwrapWorkspaceNode(target)),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.applySupervisorChange",
      (target?: SupervisorTaskTarget) => supervisor.applyChange(unwrapWorkspaceNode(target)),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.discardSupervisorChange",
      (target?: SupervisorTaskTarget) => supervisor.discardChange(unwrapWorkspaceNode(target)),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.applyAllSupervisorChanges",
      (target?: SupervisorTaskTarget | string) => supervisor.applyAll(unwrapWorkspaceNode(target)),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.discardAllSupervisorChanges",
      (target?: SupervisorTaskTarget | string) =>
        supervisor.discardAll(unwrapWorkspaceNode(target)),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.dismissSupervisorTask",
      (target?: SupervisorTaskTarget | string) =>
        supervisor.dismissTask(unwrapWorkspaceNode(target)),
    ),
    vscode.commands.registerCommand("cursorSubscription.runTaskPipeline", () =>
      requireTrustedWorkspace(
        "The task pipeline requires a trusted workspace.",
        "タスクパイプラインには信頼済みワークスペースが必要です。",
        () => provider.runTaskPipeline(),
      ),
    ),
    vscode.commands.registerCommand("cursorSubscription.executeLastPlan", () =>
      provider.executeLastPlan(),
    ),
    vscode.commands.registerCommand("cursorSubscription.exportAuditLog", () =>
      provider.exportAuditLog(),
    ),
    vscode.commands.registerCommand("cursorSubscription.refreshIntegrations", async () => {
      await integrations.refresh();
      await provider.refreshIntegrationIndex();
    }),
    vscode.commands.registerCommand("cursorSubscription.previewIntegration", (target?: unknown) =>
      integrations.preview(unwrapWorkspaceNode(target)),
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.enableIntegration",
      async (target?: unknown) => {
        await integrations.toggle(unwrapWorkspaceNode(target), true);
        await provider.refreshIntegrationIndex();
      },
    ),
    vscode.commands.registerCommand(
      "cursorSubscription.disableIntegration",
      async (target?: unknown) => {
        await integrations.toggle(unwrapWorkspaceNode(target), false);
        await Promise.all([backgroundJobs.cancelAllRunning(), supervisorRunner.cancel()]);
        await provider.refreshIntegrationIndex();
      },
    ),
    vscode.commands.registerCommand("cursorSubscription.openIntegration", (target?: unknown) =>
      integrations.open(unwrapWorkspaceNode(target)),
    ),
    vscode.commands.registerCommand("cursorSubscription.scanSupervisorTodos", () =>
      supervisor.scanTodos(),
    ),
    vscode.commands.registerCommand("cursorSubscription.scanSupervisorGitHub", () =>
      requireTrustedWorkspace(
        "GitHub Supervisor scans require a trusted workspace.",
        "GitHub Supervisorスキャンには信頼済みワークスペースが必要です。",
        () => supervisor.scanGitHubSignals(),
      ),
    ),
  );

  provider.publishExecutionProfileState();

  if (
    process.env[E2E_MARKER] === "1" &&
    context.extensionMode !== vscode.ExtensionMode.Production
  ) {
    context.subscriptions.push(
      vscode.commands.registerCommand(E2E_WEBVIEW_STATE_COMMAND, () => provider.e2eWebviewState()),
      vscode.commands.registerCommand(E2E_SETUP_CHECKLIST_COMMAND, () =>
        provider.e2eSetupChecklistState(),
      ),
      vscode.commands.registerCommand(E2E_RUN_CENTER_SNAPSHOT_COMMAND, () =>
        provider.e2eRunCenterSnapshot(),
      ),
      vscode.commands.registerCommand(E2E_EXPORT_DIAGNOSTICS_DRY_RUN_COMMAND, () =>
        provider.e2eExportDiagnosticsDryRun(),
      ),
      vscode.commands.registerCommand(E2E_RETRY_LAST_RUN_PROBE_COMMAND, () =>
        provider.e2eRetryLastRunProbe(),
      ),
    );
  }
}

export function deactivate(): Promise<void> {
  return extensionDeactivation.deactivate();
}

class CursorChatProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly lifecycle = new AsyncLifecycle();
  private readonly conversationStore: ConversationStore;
  private readonly webviewController: WebviewController;
  private readonly promptFocusHandoff = new PromptFocusHandoff();
  private readonly agentFactory: AgentFactory;
  private readonly attachmentService: AttachmentService;
  private readonly workflowController: WorkflowController;
  private readonly diagnosticsController: DiagnosticsController<vscode.Uri>;
  private readonly runCenterCoordinator = new RunCenterCoordinator(IS_JAPANESE);
  private readonly chatRuntimes = new Map<string, ChatRuntime>();
  private readonly activeSendOperations = new Set<Promise<void>>();
  private readonly pendingPreparationOperations = new Set<Promise<void>>();
  private showingHome = true;
  private workspaceFileCache: PromiseLike<WorkspaceFileItem[]> | undefined;
  private workspaceFileCacheKey: string | undefined;
  private workspaceIndexGeneration = 0;
  private workspaceIndexRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  private sandboxWarningPromise: Promise<boolean> | undefined;
  private windowsSafeModeMigrationPromise: Promise<void> | undefined;
  private readonly messageQueue: QueuedMessage[] = [];
  private readonly drainingConversations = new Set<string>();
  private readonly parallelTaskParticipants = new Set<string>();
  private readonly retainedParallelTasks = new Map<string, "completed" | "stopped" | "error">();
  private readonly viewedRetainedParallelTasks = new Set<string>();
  private webviewReady = false;
  private readonly pendingChatFiles: string[] = [];
  private readonly repairAttempts = new Map<string, number>();
  private readonly sessionDecisionQueues = new Map<string, Promise<void>>();
  private readonly verifyingSessions = new Set<string>();
  private readonly suppressPullRequestOffers = new Set<string>();
  private readonly inlineCompletionCache = new Map<string, string>();
  private readonly inlineCompletionInFlight = new Map<string, Promise<string>>();
  private readonly inlineCompletionGeneration = new Map<string, number>();
  private fileOwnership = new FileOwnershipCoordinator();
  private parallelApplyQueue = new ApplyQueue();
  private auditTimeline?: AuditTimelineController;
  private runCenter?: RunCenterTreeDataProvider;
  private runCenterSources?: {
    backgroundJobs: () => readonly (BackgroundJob & {
      changes?: readonly BackgroundChangeSnapshot[];
    })[];
    supervisorTasks: () => readonly SupervisorTask[];
  };
  private diagnosticsSources?: {
    backgroundJobs: () => readonly BackgroundJob[];
    supervisorTasks: () => readonly SupervisorTask[];
    runCenter: () => RunCenterState;
    auditSharedLogError: () => string | undefined;
  };
  private lastSetupChecklistState?: SetupChecklistState;
  private executionProfileStatusBar?: vscode.StatusBarItem;
  private auditWriteQueue: Promise<void> = Promise.resolve();
  private readonly previewContents = new Map<string, string>();
  private projectCommands: ProjectCommand[] = [];
  private readonly skillIntegrationIdsByName = new Map<string, {
    id: string;
    legacyId: string;
    folderUri: string;
  }[]>();
  private readonly planArtifactRetries = new Map<string, number>();
  private bestOfNExperiments: BestOfNExperiment[];
  private readonly bestOfNArtifacts = new Map<
    string,
    {
      session: IsolatedWorktreeSession;
      changes: IsolatedChange[];
      root: string;
      verification?: VerificationResult;
    }
  >();
  private readonly bestOfNAutoSelectInFlight = new Set<string>();
  private orchestratorExperiments: OrchestratorExperiment[];
  private orchestratorUpdateChain: Promise<void> = Promise.resolve();
  private credentialRevocation?: {
    cancelBackgroundJobs: () => Promise<void>;
    cancelSupervisor: () => Promise<void>;
  };
  /** Live tool activity for orchestrator-linked conversations (conversationId → activity). */
  private readonly orchestratorActivityByConversationId = new Map<string, OrchestratorActivity>();
  private executionPlans: ExecutionPlan[];
  private pendingPipelinePr:
    { title: string; body: string; root: string; files: string[] } | undefined;
  /** Workspace folder chosen for a new chat before the conversation is created. */
  private draftWorkspaceFolderUri: string | undefined;
  private ghCliAvailabilityCache: { value: boolean; at: number } | undefined;

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
    this.disposables.push(
      vscode.window.onDidChangeWindowState((state) => {
        if (
          this.promptFocusHandoff.hostWindowFocusChanged(
            state.focused,
            this.webviewController.visible,
          )
        ) {
          this.post({ type: "hostWindowFocused" });
        }
      }),
    );
    this.agentFactory = new AgentFactory({
      supportsLocalSandbox: SUPPORTS_LOCAL_SANDBOX,
      isJapanese: IS_JAPANESE,
      selectedApprovalMode: () => this.selectedApprovalMode(),
      selectedModel: () => this.selectedModelSelection(),
      saveConversations: () => this.saveConversations(),
      notifySandboxUnavailable: () => this.post({ type: "sandboxUnavailable" }),
    });
    this.attachmentService = new AttachmentService(context, IS_JAPANESE, () =>
      this.saveConversations(),
    );
    void this.attachmentService
      .cleanupOrphanedAttachments(this.conversations)
      .then((removed) => {
        if (removed.length > 0) {
          this.output.appendLine(
            `[${new Date().toISOString()}] Removed ${removed.length} orphaned attachment root(s).`,
          );
        }
      })
      .catch((error) => {
        this.output.appendLine(
          `[${new Date().toISOString()}] Could not clean orphaned attachments: ${String(error)}`,
        );
      });
    this.workflowController = new WorkflowController({
      japanese: IS_JAPANESE,
      supportsLocalSandbox: SUPPORTS_LOCAL_SANDBOX,
      isWorkspaceTrusted: () => vscode.workspace.isTrusted,
      hasWorkspaceFolders: () => Boolean(vscode.workspace.workspaceFolders?.length),
      currentExecutionProfile: () =>
        this.context.workspaceState.get<ExecutionProfileId>(EXECUTION_PROFILE_KEY),
      pickWorkflow: async (items, options) => vscode.window.showQuickPick([...items], options),
      pickExecutionProfile: async (items, options) =>
        vscode.window.showQuickPick([...items], options),
      showWarningMessage: async (message, options, actions) =>
        vscode.window.showWarningMessage(message, options, ...actions),
      showInformationMessage: (message) => vscode.window.showInformationMessage(message),
      executeCommand: async (command, ...args) => vscode.commands.executeCommand(command, ...args),
      updateConfiguration: async (key, value, target) => {
        await vscode.workspace
          .getConfiguration("cursorSubscription")
          .update(
            key,
            value,
            target === "workspace"
              ? vscode.ConfigurationTarget.Workspace
              : vscode.ConfigurationTarget.Global,
          );
      },
      updateSelectedExecutionProfile: async (id) =>
        this.context.workspaceState.update(EXECUTION_PROFILE_KEY, id),
      updateApprovalMode: async (mode) => this.context.globalState.update(APPROVAL_MODE_KEY, mode),
      markPermissionsConfirmed: async () =>
        this.context.workspaceState.update(SETUP_CHECKLIST_PERMISSIONS_CONFIRMED_KEY, true),
      cancelAllChats: () => this.cancelAllChats(),
      disposeAgent: () => this.disposeAgent(),
      approvalModeSelected: (mode) => this.post({ type: "approvalModeSelected", mode }),
      refreshNotificationAndSoundSettings: () => this.postNotificationAndSoundSettings(),
      publishSetupChecklistState: () => this.publishSetupChecklistState(),
    });
    this.diagnosticsController = new DiagnosticsController<vscode.Uri>({
      japanese: IS_JAPANESE,
      collectBundle: () => this.collectDiagnosticsBundle(),
      chooseExportTarget: async (options) =>
        vscode.window.showSaveDialog({
          defaultUri: vscode.Uri.file(options.defaultFileName),
          filters: Object.fromEntries(
            Object.entries(options.filters).map(([label, extensions]) => [label, [...extensions]]),
          ),
        }),
      writeText: async (target, content) =>
        vscode.workspace.fs.writeFile(target, Buffer.from(content, "utf8")),
      targetPath: (target) => target.fsPath,
      showInformationMessage: async (message, actions) =>
        vscode.window.showInformationMessage(message, ...actions),
      openTarget: async (target) => {
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
      },
    });
    this.bestOfNExperiments = context.workspaceState.get<BestOfNExperiment[]>(BEST_OF_N_KEY, []);
    this.orchestratorExperiments = context.workspaceState.get<OrchestratorExperiment[]>(
      ORCHESTRATOR_KEY,
      [],
    );
    this.executionPlans = context.workspaceState.get<ExecutionPlan[]>(EXECUTION_PLANS_KEY, []);
    this.disposables.push(this.changeSessions.onDidChangeTreeData(() => this.refreshRunCenter()));
  }

  public setApplyCoordination(
    applyQueue: ApplyQueue,
    fileOwnership: FileOwnershipCoordinator,
  ): void {
    this.parallelApplyQueue = applyQueue;
    this.fileOwnership = fileOwnership;
  }

  public setAuditTimeline(timeline: AuditTimelineController): void {
    this.auditTimeline = timeline;
  }

  public setRunCenter(runCenter: RunCenterTreeDataProvider): void {
    this.runCenter = runCenter;
    this.refreshRunCenter();
  }

  public setRunCenterSources(sources: {
    backgroundJobs: () => readonly (BackgroundJob & {
      changes?: readonly BackgroundChangeSnapshot[];
    })[];
    supervisorTasks: () => readonly SupervisorTask[];
  }): void {
    this.runCenterSources = sources;
    this.refreshRunCenter();
  }

  public setDiagnosticsSources(sources: {
    backgroundJobs: () => readonly BackgroundJob[];
    supervisorTasks: () => readonly SupervisorTask[];
    runCenter: () => RunCenterState;
    auditSharedLogError: () => string | undefined;
  }): void {
    this.diagnosticsSources = sources;
  }

  public refreshRunCenterView(): void {
    this.refreshRunCenter();
  }

  public setCredentialRevocationHandlers(handlers: {
    cancelBackgroundJobs: () => Promise<void>;
    cancelSupervisor: () => Promise<void>;
  }): void {
    this.credentialRevocation = handlers;
  }

  public async chooseWorkflow(): Promise<void> {
    await this.workflowController.chooseWorkflow();
  }

  public async chooseExecutionProfile(): Promise<void> {
    await this.workflowController.chooseExecutionProfile();
    this.publishExecutionProfileState();
  }

  public async retryLastRun(): Promise<void> {
    const target = findConversationForRetry(this.conversations, this.activeId);
    if (!target) {
      void vscode.window.showInformationMessage(
        localize(
          "There is no previous prompt to retry.",
          "再試行できる直前のプロンプトはありません。",
        ),
      );
      return;
    }
    this.activeId = target.conversation.id;
    this.showingHome = false;
    await this.send(
      target.lastUserPrompt.text,
      false,
      target.lastUserPrompt.files ?? [],
      "agent",
      [],
    );
    await this.drainMessageQueue();
  }

  public async exportDiagnostics(): Promise<void> {
    await this.diagnosticsController.exportDiagnostics();
  }

  private async collectDiagnosticsBundle(): Promise<DiagnosticsBundle> {
    const [apiKey, gitReady, ghAvailable] = await Promise.all([
      this.context.secrets.get(API_KEY_SECRET),
      this.hasGitWorkspace(),
      this.detectGhCli(true),
    ]);
    const blockedProxy = detectBlockedProxyEnvironment();
    const configuration = vscode.workspace.getConfiguration("cursorSubscription");
    const settings: Record<string, ExecutionProfileSettingValue | undefined> = {};
    for (const key of configurationKeysForDiagnostics()) {
      settings[key] = configuration.get(key) as ExecutionProfileSettingValue | undefined;
    }
    const approvalMode = this.selectedApprovalMode();
    const storedProfile = this.context.workspaceState.get<string>(EXECUTION_PROFILE_KEY);
    const profileMatch = matchExecutionProfile({
      settings: Object.fromEntries(
        Object.entries(settings).filter(
          (entry): entry is [string, ExecutionProfileSettingValue] => entry[1] !== undefined,
        ),
      ),
      approvalMode,
      supportsLocalSandbox: SUPPORTS_LOCAL_SANDBOX,
    });
    const version = String(
      (this.context.extension.packageJSON as { version?: unknown }).version ?? "unknown",
    );
    const backgroundJobs = this.diagnosticsSources?.backgroundJobs() ?? [];
    const supervisorTasks = this.diagnosticsSources?.supervisorTasks() ?? [];
    const runCenterState = this.diagnosticsSources?.runCenter();
    const auditSharedLogError = this.diagnosticsSources?.auditSharedLogError();
    return {
      generatedAt: new Date().toISOString(),
      extensionVersion: version,
      vscodeVersion: vscode.version,
      platform: process.platform,
      architecture: process.arch,
      language: vscode.env.language,
      workspaceTrusted: vscode.workspace.isTrusted,
      workspaceCount: vscode.workspace.workspaceFolders?.length ?? 0,
      approvalMode,
      executionProfile: storedProfile,
      selectedModel: this.selectedModel(),
      checks: [
        {
          label: "Cursor API key",
          status: apiKey ? "ok" : "error",
          detail: apiKey ? "Configured in SecretStorage" : "Not configured",
        },
        { label: "Workspace trust", status: vscode.workspace.isTrusted ? "ok" : "warning" },
        { label: "Git workspace", status: gitReady ? "ok" : "warning" },
        { label: "GitHub CLI", status: ghAvailable ? "ok" : "warning" },
        {
          label: "Proxy environment",
          status: blockedProxy ? "error" : "ok",
          detail: blockedProxy ? `${blockedProxy.variable}=${blockedProxy.address}` : undefined,
        },
      ],
      recentRuns: buildRecentRunsFromConversations(this.conversations),
      recentAudit: buildRecentAuditSnapshot(
        this.context.workspaceState.get<AuditEntry[]>(AUDIT_LOG_KEY, []),
      ),
      recentBackgroundJobs: summarizeBackgroundJobs(backgroundJobs),
      runCenter: runCenterState ? summarizeRunCenter(runCenterState) : undefined,
      recentSupervisorTasks: summarizeSupervisorTasks(supervisorTasks),
      auditSharedLogError,
      profileMatch,
      configurationSnapshot: buildConfigurationSnapshot(settings, [
        { label: "approvalMode", status: "ok", detail: approvalMode },
        {
          label: "executionProfile",
          status: "ok",
          detail: storedProfile ?? "custom",
        },
      ]),
    };
  }

  public e2eWebviewState(): { attached: boolean; ready: boolean } {
    return {
      attached: this.webviewController.attached,
      ready: this.webviewReady,
    };
  }

  public async e2eSetupChecklistState(): Promise<SetupChecklistState> {
    if (this.lastSetupChecklistState) {
      return this.lastSetupChecklistState;
    }
    return this.buildCurrentSetupChecklistState();
  }

  public e2eRunCenterSnapshot(): RunCenterState | undefined {
    return this.runCenter?.snapshot;
  }

  public async e2eExportDiagnosticsDryRun(): Promise<DiagnosticsBundle> {
    return this.collectDiagnosticsBundle();
  }

  public e2eRetryLastRunProbe(): {
    wouldCallSend: boolean;
    conversationId?: string;
    promptLength?: number;
  } {
    const target = findConversationForRetry(this.conversations, this.activeId);
    if (!target) {
      return { wouldCallSend: false };
    }
    return {
      wouldCallSend: true,
      conversationId: target.conversation.id,
      promptLength: target.lastUserPrompt.text.length,
    };
  }

  public publishExecutionProfileState(): void {
    const stored = this.context.workspaceState.get<ExecutionProfileId>(EXECUTION_PROFILE_KEY);
    const configuration = vscode.workspace.getConfiguration("cursorSubscription");
    const settings: Record<string, ExecutionProfileSettingValue> = {};
    for (const key of configurationKeysForDiagnostics()) {
      const value = configuration.get(key);
      if (
        typeof value === "boolean" ||
        typeof value === "number" ||
        typeof value === "string"
      ) {
        settings[key] = value;
      }
    }
    const matched = matchExecutionProfile({
      settings,
      approvalMode: this.selectedApprovalMode(),
      supportsLocalSandbox: SUPPORTS_LOCAL_SANDBOX,
    });
    const profileId = stored ?? matched;
    const label = currentExecutionProfileLabel(profileId, IS_JAPANESE);
    if (!this.executionProfileStatusBar) {
      this.executionProfileStatusBar = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        50,
      );
      this.executionProfileStatusBar.command = "cursorSubscription.chooseExecutionProfile";
      this.disposables.push(this.executionProfileStatusBar);
    }
    this.executionProfileStatusBar.text = `$(shield) ${label}`;
    this.executionProfileStatusBar.tooltip = localize(
      "Cursor execution profile — click to change",
      "Cursor実行プロファイル — クリックで変更",
    );
    this.executionProfileStatusBar.show();
    if (this.webviewReady) {
      this.post({
        type: "executionProfileState",
        profileId,
        label,
      });
    }
  }

  private async withOrchestratorLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.orchestratorUpdateChain.then(fn);
    this.orchestratorUpdateChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
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
    this.webviewController.attach(
      view,
      () => {
        this.webviewReady = false;
        this.promptFocusHandoff.reset();
      },
      async (message) => {
        switch (message.type) {
          case "promptDictationHotkey":
            this.promptFocusHandoff.dictationHotkeyStarted(
              message.occurredAt ?? Date.now(),
              vscode.window.state.focused,
              this.webviewController.visible,
            );
            break;
          case "ready":
            this.webviewReady = true;
            await this.ensureWindowsSafeModeMigrated();
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
            await this.publishSetupChecklistState();
            this.publishExecutionProfileState();
            await this.flushPendingChatFiles();
            // Chat queues are in-memory. Rebuild pending orchestration launches
            // from persisted experiment state after an extension-host restart.
            void this.resumePendingOrchestratorSubtasks();
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
              const sendFiles = Array.isArray(message.files)
                ? message.files.filter((file): file is string => typeof file === "string")
                : [];
              const sendPrompt =
                message.prompt.trim() ||
                (sendFiles.length > 0
                  ? localize(
                      "Please look at the attached image(s).",
                      "添付画像を確認してください。",
                    )
                  : "");
              await this.send(
                sendPrompt,
                message.attachContext === true,
                sendFiles,
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
          case "launchQueuedParallel":
            await this.launchQueuedMessagesParallel(
              Array.isArray(message.ids) && message.ids.length > 0
                ? message.ids
                : typeof message.id === "string"
                  ? [message.id]
                  : [],
            );
            break;
          case "pickImages":
            await this.pickImages(typeof message.requestId === "number" ? message.requestId : 0);
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
          case "startOrchestrate":
            if (typeof message.prompt === "string") {
              await this.startOrchestrate(
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
          case "openOrchestrator":
            if (typeof message.id === "string") {
              this.showingHome = true;
              this.activeId = undefined;
              this.postOrchestratorDetail(message.id);
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
          case "openExternal":
            if (typeof message.path === "string") {
              const url = message.path.trim();
              if (/^https?:\/\//i.test(url)) {
                const openLabel = localize("Open", "開く");
                const answer = await vscode.window.showWarningMessage(
                  localize(
                    `Open this external link?\n${url}`,
                    `この外部リンクを開きますか？\n${url}`,
                  ),
                  { modal: true },
                  openLabel,
                );
                if (answer === openLabel) {
                  await vscode.env.openExternal(vscode.Uri.parse(url));
                }
              }
            }
            break;
          case "sandboxLearnMore":
            await this.showSandboxLimitationDetails();
            break;
          case "selectApprovalMode":
            if (this.isApprovalMode(message.approvalMode)) {
              const currentMode = this.selectedApprovalMode();
              if (
                !SUPPORTS_LOCAL_SANDBOX &&
                message.approvalMode === "auto-review" &&
                currentMode === "safe-worktree"
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
              if (message.approvalMode === "full-access" && currentMode !== "full-access") {
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
              await this.context.workspaceState.update(
                SETUP_CHECKLIST_PERMISSIONS_CONFIRMED_KEY,
                true,
              );
              await this.cancelAllChats();
              await this.disposeAgent();
              this.post({ type: "approvalModeSelected", mode: message.approvalMode });
              await this.publishSetupChecklistState();
            }
            break;
          case "setAlertSetting":
            if (
              typeof message.enabled === "boolean" &&
              (message.setting === "notifyOnComplete" ||
                message.setting === "playSoundWhileRunning" ||
                message.setting === "playSoundOnComplete" ||
                message.setting === "playSoundOnError")
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
          case "dismissSetupChecklist":
            await this.context.workspaceState.update(SETUP_CHECKLIST_DISMISSED_KEY, true);
            await this.publishSetupChecklistState();
            break;
          case "showSetupChecklist":
            await this.showSetupChecklist();
            break;
          case "confirmSetupChecklistStep":
            if (typeof message.id === "string") {
              await this.confirmSetupChecklistStep(message.id);
            }
            break;
          case "setupChecklistAction":
            if (typeof message.id === "string") {
              await this.runSetupChecklistAction(message.id);
            }
            break;
          case "runRecoveryAction":
            await this.handleRecoveryAction(message.action);
            break;
        }
      },
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
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        invalidateWorkspaceFiles();
        void this.publishSetupChecklistState();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        invalidateWorkspaceFiles();
        void this.publishSetupChecklistState();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration("cursorSubscription.notifyOnComplete") ||
          event.affectsConfiguration("cursorSubscription.playSoundWhileRunning") ||
          event.affectsConfiguration("cursorSubscription.playSoundOnComplete") ||
          event.affectsConfiguration("cursorSubscription.playSoundOnError")
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
      fileWatcher.onDidChange(invalidateWorkspaceFiles),
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

    if (apiKey === undefined || this.lifecycle.isDisposing) {
      return;
    }

    await this.cancelAllChats();
    if (this.lifecycle.isDisposing) {
      return;
    }
    await this.disposeAgent();
    if (this.lifecycle.isDisposing) {
      return;
    }
    await this.context.secrets.store(API_KEY_SECRET, apiKey.trim());
    if (this.lifecycle.isDisposing) {
      return;
    }
    await this.revokeStoredCredentials();
    if (this.lifecycle.isDisposing) {
      return;
    }
    await this.publishAuthState();
    if (this.lifecycle.isDisposing) {
      return;
    }
    await this.publishSetupChecklistState();
    if (this.lifecycle.isDisposing) {
      return;
    }
    void vscode.window.showInformationMessage(
      localize("The Cursor API key was stored securely.", "Cursor APIキーを安全に保存しました。"),
    );
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
    await this.revokeStoredCredentials();
    await this.publishAuthState();
    await this.publishSetupChecklistState();
  }

  private async revokeStoredCredentials(): Promise<void> {
    if (this.credentialRevocation) {
      await this.credentialRevocation.cancelBackgroundJobs();
      await this.credentialRevocation.cancelSupervisor();
    }
    for (const conversation of this.conversations) {
      conversation.agentId = undefined;
    }
    await this.saveConversations();
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
    const automaticVerification =
      this.featureEnabled("enableVerification") &&
      this.alertConfiguration().get<boolean>("autoVerify", true);
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

  public async recordAudit(event: {
    action: AuditAction;
    summary: string;
    details?: string;
    files?: string[];
    taskId?: string;
    sessionId?: string;
  }): Promise<void> {
    const entries = this.context.workspaceState.get<AuditEntry[]>(AUDIT_LOG_KEY);
    const nextEntries = appendAuditEntry(entries, event);
    await this.context.workspaceState.update(AUDIT_LOG_KEY, nextEntries);
    this.auditTimeline?.refresh();
    const added = nextEntries[0];
    if (added) {
      this.auditWriteQueue = this.auditWriteQueue
        .then(async () => {
          await this.appendSharedAuditEntry(added);
          this.auditTimeline?.setSharedLogError(undefined);
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          this.auditTimeline?.setSharedLogError(message);
          this.output.appendLine(
            `[${new Date().toISOString()}] Could not append shared audit log: ${message}`,
          );
        });
      await this.auditWriteQueue;
    }
  }

  private async appendSharedAuditEntry(entry: AuditEntry): Promise<void> {
    const workspace = this.resolveChatWorkspace() ?? defaultWorkspaceFolder();
    if (!workspace) {
      return;
    }
    const configuration = vscode.workspace.getConfiguration("cursorSubscription", workspace.uri);
    if (!configuration.get<boolean>("auditSharedLogEnabled", false)) {
      return;
    }
    const configuredPath = configuration.get<string>(
      "auditSharedLogPath",
      ".cursor/ai-audit-log.jsonl",
    );
    if (!configuredPath || path.isAbsolute(configuredPath)) {
      throw new Error("cursorSubscription.auditSharedLogPath must be workspace-relative.");
    }
    const target = await safeResolvePathResolved(workspace.uri.fsPath, configuredPath);
    await mkdir(path.dirname(target), { recursive: true });
    await appendFile(target, `${JSON.stringify(entry)}\n`, "utf8");
  }

  public async openAuditFile(_entry: AuditEntry, file: string): Promise<void> {
    const workspace = this.resolveChatWorkspace() ?? defaultWorkspaceFolder();
    const absolute = await resolveAbsoluteInWorkspaceResolved(file, workspace);
    if (!absolute || !vscode.workspace.getWorkspaceFolder(vscode.Uri.file(absolute))) {
      void vscode.window.showWarningMessage(
        localize(
          "The audit entry points outside the open workspace and was not opened.",
          "監査エントリがワークスペース外を指しているため開きませんでした。",
        ),
      );
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
      await vscode.window.showTextDocument(document, { preview: true });
    } catch {
      void vscode.window.showWarningMessage(
        localize(
          `Audit file is no longer available: ${file}`,
          `監査対象ファイルは現在利用できません: ${file}`,
        ),
      );
    }
  }

  public async applyBackgroundJob(
    job: BackgroundJob,
    changes: readonly IsolatedChange[],
  ): Promise<void> {
    const storageRoot = vscode.Uri.file(job.storageRoot);
    const changeSession = this.featureEnabled("enableChangeSessions")
      ? await this.changeSessions.begin(job.prompt, job.workspaceRoot)
      : undefined;
    const result = await this.parallelApplyQueue.run(async () => {
      const lease = await this.fileOwnership.acquire(`background:${job.id}`, [
        path.join(job.workspaceRoot, ".cursor-parallel-workspace-owner"),
        ...changes.map((change) => path.join(job.workspaceRoot, change.relative)),
      ]);
      try {
        return await applyIsolatedChanges(job.session, storageRoot, changes, {
          pathEscapeLabel: "background agent",
          unavailableMessage: localize(
            "The background worktree is unavailable.",
            "バックグラウンドworktreeを利用できません。",
          ),
          conflictMessage: localize(
            "The workspace changed while the background agent was running.",
            "バックグラウンドAgentの実行中にワークスペースが変更されました。",
          ),
          missingBaselineMessage: (relative) =>
            `Background baseline is unavailable for ${relative}.`,
          autoMerge: false,
        });
      } finally {
        lease.release();
      }
    });
    if (result.conflicts.length > 0) {
      throw new Error(
        localize(
          `${result.conflicts.length} background change(s) still conflict. The isolated result was preserved.`,
          `${result.conflicts.length}件のバックグラウンド変更が競合しています。隔離結果は保持されました。`,
        ),
      );
    }
    const appliedFiles = result.applied.map((relative) => path.join(job.workspaceRoot, relative));
    if (changeSession) {
      await this.changeSessions.markPending(appliedFiles, changeSession.id);
      this.changeSessions.keepAll(changeSession.id);
      const verification = await runVerification(
        job.workspaceRoot,
        vscode.workspace
          .getConfiguration("cursorSubscription")
          .get<string[]>("verificationCommands", []),
        this.output,
      );
      this.changeSessions.setVerification(verification, changeSession.id);
    }
    if (job.usage) {
      await this.recordUsage("chat", job.usage);
    }
    await this.recordAudit({
      action: "background.apply",
      summary: `Applied background job: ${job.title}`,
      details: job.assistantText,
      files: result.applied,
      sessionId: changeSession?.id,
    });
    void vscode.window.showInformationMessage(
      localize(
        `Applied ${result.applied.length} background change(s).`,
        `${result.applied.length}件のバックグラウンド変更を適用しました。`,
      ),
    );
  }

  public async exportAuditLog(): Promise<void> {
    const entries = this.context.workspaceState.get<AuditEntry[]>(AUDIT_LOG_KEY, []);
    const markdown = formatAuditLogMarkdown(entries);
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file("ai-audit-log.md"),
      filters: { Markdown: ["md"] },
    });
    if (!target) {
      return;
    }
    await vscode.workspace.fs.writeFile(target, Buffer.from(markdown, "utf8"));
    void vscode.window.showInformationMessage(
      localize(
        `Exported audit log to ${target.fsPath}`,
        `監査ログを書き出しました: ${target.fsPath}`,
      ),
    );
  }

  public async runTaskPipeline(): Promise<void> {
    if (!this.ensureFeatureEnabled("enableAutopilot", "Autopilot")) {
      return;
    }
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(
        localize(
          "The task pipeline requires a trusted workspace.",
          "タスクパイプラインには信頼済みワークスペースが必要です。",
        ),
      );
      return;
    }
    const workspace =
      this.resolveChatWorkspace() ??
      (await pickWorkspaceFolder(
        localize(
          "Select a workspace for the task pipeline",
          "タスクパイプラインのワークスペースを選択",
        ),
      ));
    if (!workspace) {
      return;
    }

    const source = await vscode.window.showQuickPick(
      [
        {
          label: localize("GitHub Issue (gh)", "GitHub Issue (gh)"),
          description: localize(
            "Pick an open issue from gh issue list",
            "gh issue list から未解決Issueを選択",
          ),
          id: "gh" as const,
        },
        {
          label: localize("Active editor TODO(ai)", "アクティブエディタの TODO(ai)"),
          description: localize(
            "Resolve a TODO(ai): comment in the active file",
            "アクティブファイルの TODO(ai): を解決",
          ),
          id: "todo" as const,
        },
        {
          label: localize("Free text", "自由入力"),
          description: localize(
            "Describe the pipeline goal manually",
            "パイプラインの目標を手入力",
          ),
          id: "text" as const,
        },
      ],
      {
        title: localize("Cursor: Run Task Pipeline", "Cursor: タスクパイプラインを実行"),
        placeHolder: localize("Choose a task source", "タスクの取得元を選択"),
      },
    );
    if (!source) {
      return;
    }

    let goal = "";
    let pipelineTitle = "";
    if (source.id === "gh") {
      const issues = await listGhIssues(workspace.uri.fsPath);
      if (issues.length === 0) {
        void vscode.window.showWarningMessage(
          localize(
            "No GitHub issues were found. Install gh, authenticate, and run from a git repository.",
            "GitHub Issueが見つかりませんでした。gh をインストール・認証し、git リポジトリから実行してください。",
          ),
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(
        issues.map((issue) => ({
          label: `#${issue.number} ${issue.title}`,
          description: issue.url,
          issue,
        })),
        {
          title: localize("Select a GitHub issue", "GitHub Issueを選択"),
          matchOnDescription: true,
        },
      );
      if (!picked) {
        return;
      }
      pipelineTitle = picked.issue.title;
      goal = buildPipelineGoalFromIssue(picked.issue);
    } else if (source.id === "todo") {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.uri.scheme !== "file") {
        void vscode.window.showWarningMessage(
          localize(
            "Open a file in the editor to scan TODO(ai) comments.",
            "TODO(ai) を検出するには、エディタでファイルを開いてください。",
          ),
        );
        return;
      }
      const matches = scanTodoAiComments(editor.document.getText());
      if (matches.length === 0) {
        void vscode.window.showWarningMessage(
          localize(
            "No TODO(ai): comments were found in the active editor.",
            "アクティブエディタに TODO(ai): コメントは見つかりませんでした。",
          ),
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(
        matches.map((match) => ({
          label: match.text,
          description: match.detail,
          match,
        })),
        { title: localize("Select a TODO(ai)", "TODO(ai) を選択") },
      );
      if (!picked) {
        return;
      }
      const fromTodo = buildPipelineGoalFromTodo({
        relativePath: vscode.workspace.asRelativePath(editor.document.uri),
        line: picked.match.line,
        text: picked.match.text,
      });
      pipelineTitle = fromTodo.title;
      goal = fromTodo.goal;
    } else {
      const text = await vscode.window.showInputBox({
        title: localize("Cursor: Run Task Pipeline", "Cursor: タスクパイプラインを実行"),
        prompt: localize(
          "Describe the outcome for the pipeline run.",
          "パイプライン実行の目標を入力してください。",
        ),
        ignoreFocusOut: true,
      });
      if (!text?.trim()) {
        return;
      }
      pipelineTitle = text.trim();
      goal = text.trim();
    }

    const pipelineAutoKeep = this.alertConfiguration().get<boolean>("pipelineAutoKeep", false);
    const reviewChanges = pipelineAutoKeep ? false : this.featureEnabled("enableChangeSessions");
    const automaticVerification =
      this.featureEnabled("enableVerification") &&
      this.alertConfiguration().get<boolean>("autoVerify", true);
    this.pendingPipelinePr = buildPendingPipelinePr({
      pipelineAutoKeep,
      title: pipelineTitle,
      body: goal,
      root: workspace.uri.fsPath,
    });

    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    await this.send(
      buildTaskPipelinePrompt({
        goal,
        automaticVerification,
        reviewChanges,
      }),
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

  public async executeLastPlan(): Promise<void> {
    const plan = this.executionPlans.find(
      (candidate) => candidate.status === "pending" || candidate.status === "failed",
    );
    if (!plan) {
      void vscode.window.showInformationMessage(
        localize(
          "No executable Plan artifact is available. Run a chat with the Plan profile first.",
          "実行可能なPlan成果物がありません。先にPlanプロファイルでチャットを実行してください。",
        ),
      );
      return;
    }
    await this.executePlan(plan.id);
  }

  private async captureExecutionPlan(
    prompt: string,
    conversationId: string,
    assistantText: string,
  ): Promise<void> {
    if (
      this.orchestratorExperiments.some(
        (experiment) => experiment.planConversationId === conversationId,
      )
    ) {
      return;
    }
    let steps = parseExecutionPlanSteps(assistantText);
    let usedFallback = false;
    if (steps.length === 0) {
      const retries = this.planArtifactRetries.get(conversationId) ?? 0;
      if (retries < 1) {
        this.planArtifactRetries.set(conversationId, retries + 1);
        await this.enqueueMessage(
          [
            "Your previous Plan response omitted the required machine-readable steps.",
            "Return only a JSON array inside <CURSOR_EXECUTION_PLAN>...</CURSOR_EXECUTION_PLAN>.",
            'Each item must be {"title":"short title","prompt":"complete standalone implementation instruction"}.',
            "Do not edit files.",
          ].join("\n"),
          false,
          [],
          "plan",
          [],
          false,
          undefined,
          false,
          conversationId,
        );
        return;
      }
      steps = [{ title: "Execute request", prompt }];
      usedFallback = true;
    }
    this.planArtifactRetries.delete(conversationId);
    const plan = createExecutionPlan(prompt, conversationId, steps);
    this.executionPlans = [plan, ...this.executionPlans].slice(0, 20);
    await this.persistExecutionPlans();
    if (usedFallback) {
      void vscode.window.showWarningMessage(
        localize(
          "The planner omitted executable JSON twice. Continuing with the original request as one checkpointed step.",
          "プランナーが2回続けて実行用JSONを返さなかったため、元の依頼を1件のチェックポイント付きステップとして続行します。",
        ),
      );
    }
    const executeLabel = localize("Execute steps", "ステップを実行");
    const answer = await vscode.window.showInformationMessage(
      localize(
        `Plan contains ${steps.length} step(s). Execute them sequentially with a change-session checkpoint per step?`,
        `Planに${steps.length}ステップあります。各ステップに変更セッションのチェックポイントを作成して順番に実行しますか？`,
      ),
      executeLabel,
    );
    if (answer === executeLabel) {
      void this.executePlan(plan.id);
    }
  }

  private async executePlan(planId: string): Promise<void> {
    const plan = this.executionPlans.find((candidate) => candidate.id === planId);
    const source = plan
      ? this.conversations.find((conversation) => conversation.id === plan.sourceConversationId)
      : undefined;
    const workspace = source ? this.resolveChatWorkspace(source) : undefined;
    if (!plan || !workspace || plan.status === "running" || plan.status === "completed") {
      return;
    }
    plan.status = "running";
    await this.persistExecutionPlans();
    await this.recordAudit({
      action: "plan.start",
      summary: `Started ${plan.steps.length}-step execution plan`,
      details: plan.prompt,
    });

    for (let index = 0; index < plan.steps.length; index += 1) {
      const step = plan.steps[index];
      if (step.status === "completed") {
        continue;
      }
      step.status = "running";
      step.error = undefined;
      await this.persistExecutionPlans();
      const conversation: Conversation = {
        id: randomUUID(),
        title: makeConversationTitle(`[Plan ${index + 1}/${plan.steps.length}] ${step.title}`),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        workspaceFolderUri: workspace.uri.toString(),
        transcript: [],
      };
      this.conversations.unshift(conversation);
      await this.saveConversations();
      this.suppressPullRequestOffers.add(conversation.id);
      try {
        await this.send(
          [
            step.prompt,
            "",
            `Execute step ${index + 1} of ${plan.steps.length}: ${step.title}`,
            "Complete only this step, preserve prior completed steps, and leave the workspace verified.",
            "A change-session checkpoint is created before this step so failures can be restored independently.",
          ].join("\n"),
          true,
          [],
          "multitask",
          [],
          conversation.id,
          undefined,
          undefined,
          false,
          false,
        );
      } finally {
        this.suppressPullRequestOffers.delete(conversation.id);
      }
      const runtime = this.chatRuntimes.get(conversation.id);
      step.checkpointSessionId = runtime?.changeSessionId;
      const lastAssistant = [...conversation.transcript]
        .reverse()
        .find((entry) => entry.role === "assistant");
      const session = step.checkpointSessionId
        ? this.changeSessions.snapshot(step.checkpointSessionId)
        : undefined;
      if (
        lastAssistant?.error ||
        session?.phase === "failed" ||
        session?.verification?.success === false
      ) {
        step.status = "failed";
        step.error =
          lastAssistant?.text.slice(0, 1_000) ??
          localize("Step verification failed.", "ステップの検証に失敗しました。");
        plan.status = "failed";
        await this.recordAudit({
          action: "plan.step",
          summary: `Plan step failed: ${step.title}`,
          details: step.error,
          sessionId: step.checkpointSessionId,
        });
        await this.persistExecutionPlans();
        void vscode.window.showWarningMessage(
          localize(
            `Plan stopped at step ${index + 1}: ${step.title}`,
            `Planはステップ${index + 1}「${step.title}」で停止しました。`,
          ),
        );
        return;
      }
      step.status = "completed";
      await this.recordAudit({
        action: "plan.step",
        summary: `Completed plan step ${index + 1}/${plan.steps.length}: ${step.title}`,
        sessionId: step.checkpointSessionId,
      });
      await this.persistExecutionPlans();
    }
    plan.status = "completed";
    await this.persistExecutionPlans();
    await this.recordAudit({
      action: "plan.complete",
      summary: `Completed ${plan.steps.length}-step execution plan`,
    });
    void vscode.window.showInformationMessage(
      localize(
        `Completed all ${plan.steps.length} Plan steps with per-step checkpoints.`,
        `Planの全${plan.steps.length}ステップを、ステップごとのチェックポイント付きで完了しました。`,
      ),
    );
  }

  private async persistExecutionPlans(): Promise<void> {
    await this.context.workspaceState.update(EXECUTION_PLANS_KEY, this.executionPlans);
  }

  public async startOrchestrate(
    prompt: string,
    attachContext: boolean,
    files: string[],
    _profile: RunProfile,
    skills: string[],
    includeProjectMemory = true,
  ): Promise<void> {
    const trimmed = prompt.trim();
    if (!trimmed) {
      return;
    }

    const source = this.activeConversation();
    const handoffEnabled = this.alertConfiguration().get<boolean>(
      "orchestrateHandoffConversation",
      true,
    );
    let sourceConversationId: string | undefined;
    let sourceTranscriptExcerpt: string | undefined;
    if (
      handoffEnabled &&
      source &&
      !source.orchestratorExperimentId &&
      source.transcript.length > 0
    ) {
      const excerpt = formatTranscriptForHandoff(source.transcript);
      if (excerpt) {
        sourceConversationId = source.id;
        sourceTranscriptExcerpt = excerpt;
      }
    }

    const experiment = createOrchestratorExperiment(trimmed, {
      sourceConversationId,
      sourceTranscriptExcerpt,
    });
    const workspaceFolderUri = this.resolveChatWorkspace()?.uri.toString();
    const planConversation: Conversation = {
      id: randomUUID(),
      title: makeConversationTitle(`[Plan] ${trimmed}`),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      workspaceFolderUri,
      orchestratorExperimentId: experiment.id,
      orchestratorRole: "plan",
      transcript: [],
    };
    experiment.planConversationId = planConversation.id;
    this.conversations.unshift(planConversation);
    this.orchestratorExperiments = [experiment, ...this.orchestratorExperiments].slice(0, 20);
    // Persist the conversation first. A crash after this write leaves only an
    // unreferenced conversation; the inverse order leaves planning stuck on a
    // conversation id that never reached storage.
    await this.saveConversations();
    await this.saveOrchestratorExperiments();

    this.activeId = planConversation.id;
    this.showingHome = false;
    this.draftWorkspaceFolderUri = undefined;
    this.postView();
    this.postWorkspaceLabel();

    const planPrompt = buildOrchestratorPlanPrompt(
      trimmed,
      false,
      experiment.sourceTranscriptExcerpt,
    );

    await this.enqueueMessage(
      planPrompt,
      attachContext,
      files,
      "plan",
      skills,
      false,
      undefined,
      false,
      planConversation.id,
      undefined,
      includeProjectMemory,
    );
    void vscode.window.showInformationMessage(
      localize(
        "Orchestrator planning started. Subtasks will launch when the plan finishes.",
        "オーケストレーターの計画を開始しました。計画完了後にサブタスクを起動します。",
      ),
    );
  }

  private async saveOrchestratorExperiments(): Promise<void> {
    await this.context.workspaceState.update(ORCHESTRATOR_KEY, this.orchestratorExperiments);
    this.postOrchestratorState();
  }

  private busyConversationIds(): Set<string> {
    return new Set(
      this.conversations
        .filter((conversation) => this.isConversationBusy(conversation.id))
        .map((conversation) => conversation.id),
    );
  }

  private postOrchestratorState(): void {
    const experiments = orchestratorSummaries(this.orchestratorExperiments)
      .filter((summary) => {
        const experiment = this.orchestratorExperiments.find((item) => item.id === summary.id);
        if (!experiment) {
          return false;
        }
        const conversationIds = [
          experiment.planConversationId,
          experiment.synthesisConversationId,
          ...experiment.subtasks.map((subtask) => subtask.conversationId),
        ].filter((id): id is string => typeof id === "string");
        return (
          conversationIds.some((id) =>
            this.conversations.some((conversation) => conversation.id === id),
          ) ||
          summary.status === "planning" ||
          summary.status === "running" ||
          summary.status === "synthesizing"
        );
      })
      .slice(0, 10);
    this.post({ type: "orchestratorExperiments", experiments });
  }

  private postOrchestratorDetail(experimentId: string): void {
    const experiment = this.orchestratorExperiments.find((item) => item.id === experimentId);
    if (!experiment) {
      return;
    }
    this.post({
      type: "orchestratorDetail",
      experiment: buildOrchestratorDetail(
        experiment,
        this.busyConversationIds(),
        this.orchestratorActivityByConversationId,
        new Set(this.conversations.map((conversation) => conversation.id)),
      ),
    });
  }

  private resolveOrchestratorActivityTarget(conversationId: string):
    | {
        experimentId: string;
        role: "plan" | "subtask" | "synthesis";
        subtaskId?: string;
      }
    | undefined {
    const conversation = this.conversations.find((item) => item.id === conversationId);
    if (!conversation?.orchestratorExperimentId || !conversation.orchestratorRole) {
      return undefined;
    }
    const experiment = this.orchestratorExperiments.find(
      (item) => item.id === conversation.orchestratorExperimentId,
    );
    const subtaskId =
      conversation.orchestratorRole === "subtask"
        ? experiment?.subtasks.find((subtask) => subtask.conversationId === conversationId)?.id
        : undefined;
    return {
      experimentId: conversation.orchestratorExperimentId,
      role: conversation.orchestratorRole,
      subtaskId,
    };
  }

  private postOrchestratorActivity(
    conversationId: string,
    activity: OrchestratorActivity | null,
  ): void {
    if (activity) {
      this.orchestratorActivityByConversationId.set(conversationId, activity);
    } else {
      this.orchestratorActivityByConversationId.delete(conversationId);
    }
    const target = this.resolveOrchestratorActivityTarget(conversationId);
    if (!target) {
      return;
    }
    this.post({
      type: "orchestratorActivity",
      experimentId: target.experimentId,
      conversationId,
      role: target.role,
      subtaskId: target.subtaskId,
      activity,
    });
  }

  private clearOrchestratorActivity(conversationId: string): void {
    if (
      !this.orchestratorActivityByConversationId.has(conversationId) &&
      !this.resolveOrchestratorActivityTarget(conversationId)
    ) {
      return;
    }
    this.postOrchestratorActivity(conversationId, null);
  }

  private async resumePendingOrchestratorSubtasks(): Promise<void> {
    const pending = await this.withOrchestratorLock(async () => {
      const conversationExists = (conversationId: string): boolean =>
        this.conversations.some((candidate) => candidate.id === conversationId);
      const isBusy = (conversationId: string): boolean => this.isConversationBusy(conversationId);
      const isQueued = (conversationId: string): boolean =>
        this.messageQueue.some((item) => item.conversationId === conversationId);

      const prepared = prepareOrchestratorResume(this.orchestratorExperiments, {
        conversationExists,
        isBusy,
        isQueued,
        planResponseOutcome: (conversationId, expectedResponseCount) => {
          const conversation = this.conversations.find(
            (candidate) => candidate.id === conversationId,
          );
          // The expected count is relative to this conversation, so a
          // replacement conversation does not need responses that only
          // existed in its missing predecessor.
          return classifyOrchestratorPlanResponse(
            conversation?.transcript ?? [],
            expectedResponseCount,
          );
        },
      });
      this.orchestratorExperiments = prepared.experiments;

      const launches = [...prepared.launches];
      let createdConversation = false;
      for (const experimentId of prepared.needsPlanConversation) {
        const index = this.orchestratorExperiments.findIndex(
          (experiment) => experiment.id === experimentId,
        );
        if (index < 0) {
          continue;
        }
        let experiment = this.orchestratorExperiments[index];
        if (
          experiment.status !== "planning"
          || (
            experiment.planConversationId
            && conversationExists(experiment.planConversationId)
          )
        ) {
          continue;
        }
        const workspaceFolderUri = this.resolveChatWorkspace()?.uri.toString();
        const planConversation: Conversation = {
          id: randomUUID(),
          title: makeConversationTitle(`[Plan] ${experiment.prompt}`),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          workspaceFolderUri,
          orchestratorExperimentId: experiment.id,
          orchestratorRole: "plan",
          transcript: [],
        };
        this.conversations.unshift(planConversation);
        experiment = {
          ...experiment,
          planConversationId: planConversation.id,
          // The replacement transcript starts empty. Account for completed
          // attempts that belonged to the missing conversation so the active
          // retry is reconciled after its first persisted response.
          planResponseBaseline: Math.max(0, (experiment.planAttempts ?? 1) - 1),
        };
        this.orchestratorExperiments[index] = experiment;
        createdConversation = true;
        launches.push({
          prompt: buildOrchestratorPlanPrompt(
            experiment.prompt,
            (experiment.planAttempts ?? 1) > 1,
            experiment.sourceTranscriptExcerpt,
          ),
          conversationId: planConversation.id,
          kind: "plan",
        });
      }
      for (const experimentId of prepared.needsSynthesisConversation) {
        const index = this.orchestratorExperiments.findIndex(
          (experiment) => experiment.id === experimentId,
        );
        if (index < 0) {
          continue;
        }
        let experiment = this.orchestratorExperiments[index];
        if (experiment.status !== "synthesizing" || experiment.synthesisConversationId) {
          continue;
        }
        const workspaceFolderUri = this.resolveChatWorkspace()?.uri.toString();
        const synthesisConversation: Conversation = {
          id: randomUUID(),
          title: makeConversationTitle(`[Synthesis] ${experiment.prompt}`),
          createdAt: Date.now(),
          updatedAt: Date.now(),
          workspaceFolderUri,
          orchestratorExperimentId: experiment.id,
          orchestratorRole: "synthesis",
          transcript: [],
        };
        this.conversations.unshift(synthesisConversation);
        experiment = {
          ...experiment,
          synthesisConversationId: synthesisConversation.id,
        };
        this.orchestratorExperiments[index] = experiment;
        createdConversation = true;
        launches.push({
          prompt: buildSynthesisPrompt(experiment),
          conversationId: synthesisConversation.id,
          kind: "synthesis",
        });
      }

      if (createdConversation) {
        // Write the materialized conversation before publishing its id from
        // the experiment record, making restart repair crash-safe as well.
        await this.saveConversations();
      }
      await this.saveOrchestratorExperiments();
      return {
        launches,
        completedPlans: prepared.completedPlans,
        terminalPlans: prepared.terminalPlans,
      };
    });
    for (const terminal of pending.terminalPlans) {
      await this.handleOrchestratorConversationComplete(
        terminal.conversationId,
        terminal.progressState,
        terminal.assistantText,
      );
    }
    for (const completed of pending.completedPlans) {
      await this.handleOrchestratorConversationComplete(
        completed.conversationId,
        "completed",
        completed.assistantText,
      );
    }
    for (const launch of pending.launches) {
      this.deferOrchestratorMessage(
        launch.prompt,
        launch.kind === "plan" ? "plan" : "agent",
        launch.conversationId,
      );
    }
  }

  private deferOrchestratorMessage(
    prompt: string,
    profile: RunProfile,
    conversationId: string,
  ): void {
    this.lifecycle.defer(() => {
      void this.enqueueMessage(
        prompt,
        false,
        [],
        profile,
        [],
        false,
        undefined,
        false,
        conversationId,
      ).catch((error) => {
        this.output.appendLine(
          `[${new Date().toISOString()}] Could not enqueue orchestrator task: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    });
  }

  private async markOrchestratorSubtaskRunning(conversationId: string): Promise<void> {
    await this.withOrchestratorLock(async () => {
      const index = this.orchestratorExperiments.findIndex(
        (experiment) =>
          experiment.status === "running" &&
          experiment.subtasks.some(
            (subtask) => subtask.conversationId === conversationId && subtask.status === "pending",
          ),
      );
      if (index < 0) {
        return;
      }
      this.orchestratorExperiments[index] = markSubtaskLaunch(
        this.orchestratorExperiments[index],
        conversationId,
        "running",
      );
      await this.saveOrchestratorExperiments();
    });
  }

  private touchInlineCompletionCache(key: string, value: string): string {
    if (this.inlineCompletionCache.has(key)) {
      this.inlineCompletionCache.delete(key);
    }
    this.inlineCompletionCache.set(key, value);
    while (this.inlineCompletionCache.size > MAX_INLINE_COMPLETION_CACHE) {
      const oldest = this.inlineCompletionCache.keys().next().value;
      if (oldest) {
        this.inlineCompletionCache.delete(oldest);
      } else {
        break;
      }
    }
    return value;
  }

  private async ensureTokenBudgetAllows(): Promise<boolean> {
    const configuration = this.alertConfiguration();
    const dailyBudget = configuration.get<number>("dailyTokenBudget", 0);
    const monthlyBudget = configuration.get<number>("monthlyTokenBudget", 0);
    const monthlyCostLimit = configuration.get<number>("monthlyCostLimitUsd", 0);
    const blendedRate = configuration.get<number>("estimatedCostPerMillionTokensUsd", 0);
    const ledger = this.context.workspaceState.get<UsageLedger>(USAGE_LEDGER_KEY);
    const checks = [
      {
        id: `daily.${dayKey()}`,
        snapshot: budgetSnapshot(ledger, dailyBudget),
        warning: (used: number, budget: number, ratio: number) =>
          localize(
            `Daily token budget is ${Math.round(ratio * 100)}% used (${formatTokenCount(used)}/${formatTokenCount(budget)}).`,
            `1日のトークン予算を ${Math.round(ratio * 100)}% 使用しています（${formatTokenCount(used)}/${formatTokenCount(budget)}）。`,
          ),
        exceeded: (used: number, budget: number) =>
          localize(
            `Daily token budget exceeded (${formatTokenCount(used)}/${formatTokenCount(budget)}). Continue anyway?`,
            `1日のトークン予算を超過しました（${formatTokenCount(used)}/${formatTokenCount(budget)}）。続行しますか？`,
          ),
      },
      {
        id: `monthly.${monthKey()}`,
        snapshot: monthlyBudgetSnapshot(ledger, monthlyBudget),
        warning: (used: number, budget: number, ratio: number) =>
          localize(
            `Monthly token budget is ${Math.round(ratio * 100)}% used (${formatTokenCount(used)}/${formatTokenCount(budget)}).`,
            `月間トークン予算を ${Math.round(ratio * 100)}% 使用しています（${formatTokenCount(used)}/${formatTokenCount(budget)}）。`,
          ),
        exceeded: (used: number, budget: number) =>
          localize(
            `Monthly token budget exceeded (${formatTokenCount(used)}/${formatTokenCount(budget)}). Continue anyway?`,
            `月間トークン予算を超過しました（${formatTokenCount(used)}/${formatTokenCount(budget)}）。続行しますか？`,
          ),
      },
      {
        id: `cost.${monthKey()}`,
        snapshot: estimatedMonthlyCostSnapshot(ledger, monthlyCostLimit, blendedRate),
        warning: (used: number, budget: number, ratio: number) =>
          localize(
            `Estimated monthly cost is ${Math.round(ratio * 100)}% of the limit ($${used.toFixed(2)}/$${budget.toFixed(2)}).`,
            `推定月間コストが上限の${Math.round(ratio * 100)}%です（$${used.toFixed(2)}/$${budget.toFixed(2)}）。`,
          ),
        exceeded: (used: number, budget: number) =>
          localize(
            `Estimated monthly cost limit exceeded ($${used.toFixed(2)}/$${budget.toFixed(2)}). Continue anyway?`,
            `推定月間コスト上限を超過しました（$${used.toFixed(2)}/$${budget.toFixed(2)}）。続行しますか？`,
          ),
      },
    ];
    for (const check of checks) {
      const snapshot = check.snapshot;
      if (!snapshot) {
        continue;
      }
      if (snapshot.status === "warning") {
        const warnedKey = `${BUDGET_WARNED_KEY_PREFIX}.${check.id}`;
        if (!this.context.workspaceState.get<boolean>(warnedKey, false)) {
          await this.context.workspaceState.update(warnedKey, true);
          void vscode.window.showWarningMessage(
            check.warning(snapshot.used, snapshot.budget, snapshot.ratio),
          );
        }
      }
      if (snapshot.status !== "exceeded") {
        continue;
      }
      const continueLabel = localize("Continue", "続行");
      const cancelLabel = localize("Cancel", "キャンセル");
      const answer = await vscode.window.showWarningMessage(
        check.exceeded(snapshot.used, snapshot.budget),
        { modal: true },
        continueLabel,
        cancelLabel,
      );
      if (answer !== continueLabel) {
        return false;
      }
    }
    return true;
  }

  private async handleOrchestratorConversationComplete(
    conversationId: string,
    progressState: "completed" | "stopped" | "error",
    assistantText: string,
  ): Promise<void> {
    return this.withOrchestratorLock(async () => {
      const planIndex = this.orchestratorExperiments.findIndex(
        (experiment) =>
          experiment.planConversationId === conversationId && experiment.status === "planning",
      );
      if (planIndex >= 0) {
        let experiment = this.orchestratorExperiments[planIndex];
        if (progressState !== "completed") {
          experiment = {
            ...experiment,
            status: "failed",
            error: progressState === "stopped" ? "Planning was stopped." : "Planning failed.",
          };
          this.orchestratorExperiments[planIndex] = experiment;
          await this.saveOrchestratorExperiments();
          return;
        }
        const resolution = resolveOrchestratorPlan(experiment, assistantText);
        experiment = resolution.experiment;
        if (resolution.kind === "retry") {
          this.orchestratorExperiments[planIndex] = experiment;
          await this.saveOrchestratorExperiments();
          this.deferOrchestratorMessage(resolution.prompt, "plan", conversationId);
          return;
        }
        if (resolution.usedFallback) {
          void vscode.window.showWarningMessage(
            localize(
              "The planner omitted the subtask JSON twice. Continuing with the original request as one execution task.",
              "プランナーが2回続けてサブタスクJSONを返さなかったため、元の依頼を1件の実行タスクとして続行します。",
            ),
          );
        }
        if (experiment.status === "failed") {
          this.orchestratorExperiments[planIndex] = experiment;
          await this.saveOrchestratorExperiments();
          void vscode.window.showWarningMessage(
            localize(
              experiment.error ?? "Orchestrator planning produced no subtasks.",
              experiment.error ?? "オーケストレーターの計画でサブタスクが生成されませんでした。",
            ),
          );
          return;
        }
        const workspaceFolderUri = this.resolveChatWorkspace()?.uri.toString();
        const launches: Array<{ conversationId: string; prompt: string }> = [];
        for (const subtask of experiment.subtasks) {
          const conversation: Conversation = {
            id: randomUUID(),
            title: makeConversationTitle(`[${subtask.title}] ${experiment.prompt}`),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            workspaceFolderUri,
            orchestratorExperimentId: experiment.id,
            orchestratorRole: "subtask",
            transcript: [],
          };
          this.conversations.unshift(conversation);
          experiment = markSubtaskConversation(experiment, subtask.id, conversation.id);
          launches.push({ conversationId: conversation.id, prompt: subtask.prompt });
        }
        const maximumParallelAgents = this.alertConfiguration().get<number>(
          "maxParallelChatAgents",
          3,
        );
        const availableParallelAgents = Math.max(
          0,
          Math.max(1, maximumParallelAgents) - this.activeRunCount(),
        );
        await launchOrchestratorSubtasks(
          launches,
          async () => {
            this.orchestratorExperiments[planIndex] = experiment;
            await this.saveOrchestratorExperiments();
            await this.saveConversations();
          },
          async (launch) => {
            this.deferOrchestratorMessage(launch.prompt, "agent", launch.conversationId);
            // If capacity is exhausted, enqueueMessage retains this pending
            // subtask in the normal chat queue until a slot becomes free.
          },
          Math.max(1, availableParallelAgents),
        );
        return;
      }

      const subtaskIndex = this.orchestratorExperiments.findIndex(
        (experiment) =>
          experiment.status === "running" &&
          experiment.subtasks.some((subtask) => subtask.conversationId === conversationId),
      );
      if (subtaskIndex >= 0) {
        const conversation = this.conversations.find((item) => item.id === conversationId);
        const lastAssistant = conversation
          ? [...conversation.transcript].reverse().find((entry) => entry.role === "assistant")
          : undefined;
        const summary = (assistantText || lastAssistant?.text || "").trim();
        let experiment = markSubtaskStatus(
          this.orchestratorExperiments[subtaskIndex],
          conversationId,
          progressState === "completed" ? "completed" : "failed",
          {
            summary: summary || undefined,
            changedFiles: lastAssistant?.files,
          },
        );
        if (experiment.status === "failed") {
          this.orchestratorExperiments[subtaskIndex] = experiment;
          await this.saveOrchestratorExperiments();
          void vscode.window.showWarningMessage(
            localize(
              experiment.error ?? "All subtasks failed.",
              experiment.error ?? "すべてのサブタスクが失敗しました。",
            ),
          );
          return;
        }
        if (experiment.status === "synthesizing") {
          if (experiment.synthesisConversationId) {
            this.orchestratorExperiments[subtaskIndex] = experiment;
            await this.saveOrchestratorExperiments();
            return;
          }
          const workspaceFolderUri = this.resolveChatWorkspace()?.uri.toString();
          const synthesisConversation: Conversation = {
            id: randomUUID(),
            title: makeConversationTitle(`[Synthesis] ${experiment.prompt}`),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            workspaceFolderUri,
            orchestratorExperimentId: experiment.id,
            orchestratorRole: "synthesis",
            transcript: [],
          };
          this.conversations.unshift(synthesisConversation);
          experiment = {
            ...experiment,
            synthesisConversationId: synthesisConversation.id,
          };
          this.orchestratorExperiments[subtaskIndex] = experiment;
          await this.saveOrchestratorExperiments();
          await this.saveConversations();
          this.deferOrchestratorMessage(
            buildSynthesisPrompt(experiment),
            "agent",
            synthesisConversation.id,
          );
          return;
        }
        this.orchestratorExperiments[subtaskIndex] = experiment;
        await this.saveOrchestratorExperiments();
        return;
      }

      const synthesisIndex = this.orchestratorExperiments.findIndex(
        (experiment) =>
          experiment.synthesisConversationId === conversationId &&
          experiment.status === "synthesizing",
      );
      if (synthesisIndex >= 0) {
        this.orchestratorExperiments[synthesisIndex] = {
          ...this.orchestratorExperiments[synthesisIndex],
          status: progressState === "completed" ? "completed" : "failed",
          error:
            progressState === "completed"
              ? undefined
              : progressState === "stopped"
                ? "Synthesis was stopped."
                : "Synthesis failed.",
        };
        await this.saveOrchestratorExperiments();
      }
    });
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
    const workspace =
      resolveWorkspaceFolder(vscode.window.activeTextEditor?.document.uri) ??
      (await pickWorkspaceFolder(
        localize("Select a workspace to review", "レビューするワークスペースを選択"),
      ));
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
          void vscode.window.showInformationMessage(
            localize(
              findings.length === 0
                ? "AI review found no actionable issues."
                : `AI review published ${findings.length} finding(s) in Problems.`,
              findings.length === 0
                ? "AIレビューで指摘は見つかりませんでした。"
                : `AIレビューの指摘${findings.length}件をProblemsに表示しました。`,
            ),
          );
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[${new Date().toISOString()}] AI review failed: ${message}`);
      void vscode.window.showErrorMessage(
        localize(`AI review failed: ${message}`, `AIレビューに失敗しました: ${message}`),
      );
    }
  }

  public async reviewChangeSession(sessionId?: string): Promise<void> {
    if (!this.ensureFeatureEnabled("enableAiReview", localize("Change Court", "変更の法廷"))) {
      return;
    }
    const session = this.changeSessions.snapshot(sessionId);
    if (!session || session.files.length === 0) {
      void vscode.window.showInformationMessage(
        localize(
          "There is no AI change session to review.",
          "審査できるAI変更セッションがありません。",
        ),
      );
      return;
    }
    if (this.anyChatBusy()) {
      void vscode.window.showInformationMessage(
        localize(
          "Wait for the active chat run to finish before starting Change Court.",
          "実行中のチャットが完了してから変更の法廷を開始してください。",
        ),
      );
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
          title: localize("Change Court is reviewing the evidence…", "変更の根拠を審査中…"),
        },
        async () => {
          const files: ChangeCourtFileEvidence[] = [];
          const unavailableFiles: string[] = [];
          const isExcluded = createExcludedPathMatcher(vscode.Uri.file(session.root));
          for (const file of session.files) {
            const relative = path.relative(session.root, file).replaceAll("\\", "/");
            const proposed = session.proposedFiles?.[file];
            if (isExcluded(relative) || !proposed?.contentCaptured) {
              unavailableFiles.push(relative);
              continue;
            }
            const beforeExists = await this.changeSessions.baselineFileExists(session.id, file);
            if (beforeExists === undefined) {
              unavailableFiles.push(relative);
              continue;
            }
            const [before, after] = await Promise.all([
              this.changeSessions.baselineContent(session.id, file),
              this.changeSessions.proposedContent(session.id, file),
            ]);
            if (before.includes("\0") || after.includes("\0")) {
              unavailableFiles.push(relative);
              continue;
            }
            files.push({
              relative,
              beforeExists,
              afterExists: proposed.worktreeExisted,
              before,
              after,
            });
          }
          if (files.length === 0) {
            void vscode.window.showInformationMessage(
              localize(
                "This session has no saved text snapshots that Change Court can review.",
                "このセッションには変更の法廷で審査できる保存済みテキストがありません。",
              ),
            );
            return;
          }

          const verification = this.changeCourtVerificationSummary(session.verification);
          const evidence = buildChangeCourtPrompt({
            goal: session.goal,
            verification,
            files,
          });
          const reviewRoot = vscode.Uri.joinPath(
            this.context.storageUri ?? this.context.globalStorageUri,
            "change-court",
          );
          await vscode.workspace.fs.createDirectory(reviewRoot);
          const result = await Agent.prompt(evidence.prompt, {
            apiKey,
            model: this.selectedModelSelection(),
            name: "VS Code: Change Court",
            mode: "plan",
            // The complete review evidence is carried in the prompt. Keeping
            // cwd outside the project prevents ambient workspace context from
            // silently changing the verdict, while Plan mode remains read-only.
            local: { cwd: reviewRoot.fsPath, settingSources: [] },
          });
          if (result.status !== "finished") {
            throw new Error(this.formatRunFailure(result));
          }
          if (result.usage) {
            await this.recordUsage("chat", result.usage);
          }
          const review = parseChangeCourtReview(result.result ?? "");
          const markdown = formatChangeCourtMarkdown({
            goal: session.goal,
            review,
            verification,
            includedFiles: evidence.includedFiles,
            skippedFiles: [...new Set([...evidence.skippedFiles, ...unavailableFiles])],
            japanese: IS_JAPANESE,
            reviewedAt: new Date(),
          });
          const uri = vscode.Uri.from({
            scheme: "cursor-ai-preview",
            path: `/change-court/${session.id}/${randomUUID()}.md`,
          });
          this.previewContents.set(uri.toString(), markdown);
          const document = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(document, { preview: true });
        },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[${new Date().toISOString()}] Change Court failed: ${message}`);
      void vscode.window.showErrorMessage(
        localize(`Change Court failed: ${message}`, `変更の法廷に失敗しました: ${message}`),
      );
    }
  }

  public async openFailureTimeMachine(sessionId?: string): Promise<void> {
    if (
      !this.ensureFeatureEnabled(
        "enableChangeSessions",
        localize("Failure Time Machine", "失敗のタイムマシン"),
      )
    ) {
      return;
    }
    const report = analyzeFailureTimeMachine({
      sessions: this.changeSessions.history(),
      auditEntries: this.context.workspaceState.get<AuditEntry[]>(AUDIT_LOG_KEY, []),
      targetSessionId: sessionId,
    });
    if (!report) {
      void vscode.window.showInformationMessage(
        localize(
          "No recorded failed AI change session is available.",
          "記録済みの失敗したAI変更セッションはありません。",
        ),
      );
      return;
    }
    const markdown = formatFailureTimeMachineMarkdown(report, IS_JAPANESE);
    const uri = vscode.Uri.from({
      scheme: "cursor-ai-preview",
      path: `/failure-time-machine/${report.targetSessionId}/${randomUUID()}.md`,
    });
    this.previewContents.set(uri.toString(), markdown);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true });
  }

  public async analyzeDebugContext(): Promise<void> {
    if (
      !this.ensureFeatureEnabled("enableDebugContext", localize("Debug analysis", "デバッグ解析"))
    ) {
      return;
    }
    const editor = vscode.window.activeTextEditor;
    const session = vscode.debug.activeDebugSession;
    const diagnostics = editor ? vscode.languages.getDiagnostics(editor.document.uri) : [];
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
      session
        ? `Debug session: ${session.name} (${session.type})`
        : "Debug session: not currently running",
      breakpoints.length > 0 ? `Breakpoints: ${breakpoints.join(", ")}` : undefined,
      diagnostics.length > 0
        ? `Editor diagnostics:\n${diagnostics.map((item) => `- ${item.message}`).join("\n")}`
        : undefined,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
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
    if (
      !this.ensureFeatureEnabled(
        "enableProjectMemory",
        localize("Project memory", "プロジェクト記憶"),
      )
    ) {
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
    const session = this.changeSessions.snapshot(sessionId);
    if (sessionId && !session) {
      void vscode.window.showWarningMessage(
        localize(
          "The selected AI change session is no longer available.",
          "選択したAI変更セッションは利用できません。",
        ),
      );
      return undefined;
    }
    const sessionRoot = session?.root;
    const sessionWorkspace = sessionRoot
      ? resolveWorkspaceFolder(vscode.Uri.file(sessionRoot))
      : undefined;
    if (sessionId && !sessionWorkspace) {
      void vscode.window.showWarningMessage(
        localize(
          "The selected session workspace is not open. Verification was not run.",
          "選択したセッションのワークスペースが開かれていないため、検証を実行しませんでした。",
        ),
      );
      return undefined;
    }
    const workspace =
      sessionWorkspace ??
      resolveWorkspaceFolder(vscode.window.activeTextEditor?.document.uri) ??
      (await pickWorkspaceFolder(
        localize("Select a workspace to verify", "検証するワークスペースを選択"),
      ));
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
      () =>
        runVerification(
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

  public async reverifyChangeSession(sessionId?: string): Promise<VerificationResult | undefined> {
    const session = this.changeSessions.snapshot(sessionId);
    if (!session?.verification || session.verification.success || session.verification.skipped) {
      void vscode.window.showInformationMessage(
        localize(
          "No recorded failed verification is available for this session.",
          "このセッションには記録済みの検証失敗がありません。",
        ),
      );
      return undefined;
    }
    if (session.id !== this.changeSessions.snapshot()?.id) {
      void vscode.window.showWarningMessage(
        localize(
          "Historical workspace state is not retained completely, so only the latest failed session can be verified again.",
          "過去のワークスペース状態は完全には保持されないため、再検証できるのは最新の失敗セッションだけです。",
        ),
      );
      return undefined;
    }
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(
        localize(
          "Re-running verification requires a trusted workspace.",
          "検証の再実行には信頼済みワークスペースが必要です。",
        ),
      );
      return undefined;
    }
    return this.verifyCurrentChanges(session.id);
  }

  public async revertLastSession(sessionId?: string): Promise<void> {
    if (
      !this.ensureFeatureEnabled(
        "enableChangeSessions",
        localize("AI change sessions", "AI変更セッション"),
      )
    ) {
      return;
    }
    if (!this.changeSessions.canRevert(sessionId)) {
      void vscode.window.showWarningMessage(
        localize(
          "This session cannot be safely reverted.",
          "このセッションは安全に元に戻せません。",
        ),
      );
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
    void vscode.window.showInformationMessage(
      localize(
        `Reverted ${result.restored.length + result.removed.length} file(s).`,
        `${result.restored.length + result.removed.length}ファイルを元に戻しました。`,
      ),
    );
  }

  public async openSessionFile(sessionId: string, file: string): Promise<void> {
    const baseline = await this.changeSessions.baselineContent(sessionId, file);
    let current = "";
    try {
      current = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(file)));
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

  public async compareChangeSessions(sessionId?: string): Promise<void> {
    const resolvedId = sessionId ?? this.changeSessions.snapshot()?.id;
    const markdown = resolvedId ? this.changeSessions.comparisonMarkdown(resolvedId) : undefined;
    if (!markdown) {
      void vscode.window.showInformationMessage(
        localize(
          "There is no previous change session to compare.",
          "比較できる前の変更セッションがありません。",
        ),
      );
      return;
    }
    const uri = vscode.Uri.from({
      scheme: "cursor-ai-preview",
      path: `/session-comparison/${resolvedId}.md`,
    });
    this.previewContents.set(uri.toString(), markdown);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true });
  }

  public async compareSessionContents(sessionId?: string): Promise<void> {
    const resolvedId = sessionId ?? this.changeSessions.snapshot()?.id;
    const comparisons = resolvedId ? this.changeSessions.contentComparisons(resolvedId) : [];
    if (comparisons.length === 0) {
      void vscode.window.showInformationMessage(
        localize(
          "No file content snapshots are shared with the previous session.",
          "前のセッションと共通する内容スナップショットがありません。",
        ),
      );
      return;
    }
    const selected =
      comparisons.length === 1
        ? comparisons[0]
        : (
            await vscode.window.showQuickPick(
              comparisons.map((comparison) => ({
                label: comparison.relative,
                comparison,
              })),
              { placeHolder: localize("Select a file to compare", "比較するファイルを選択") },
            )
          )?.comparison;
    if (!selected) {
      return;
    }
    const [previous, current] = await Promise.all([
      this.changeSessions.proposedContent(selected.previousSessionId, selected.previousFile),
      this.changeSessions.proposedContent(selected.currentSessionId, selected.currentFile),
    ]);
    const previewId = randomUUID();
    const fileName = path.basename(selected.relative);
    const previousUri = vscode.Uri.from({
      scheme: "cursor-ai-preview",
      path: `/${previewId}/previous/${fileName}`,
    });
    const currentUri = vscode.Uri.from({
      scheme: "cursor-ai-preview",
      path: `/${previewId}/current/${fileName}`,
    });
    this.previewContents.set(previousUri.toString(), previous);
    this.previewContents.set(currentUri.toString(), current);
    await vscode.commands.executeCommand(
      "vscode.diff",
      previousUri,
      currentUri,
      localize(`${selected.relative}: previous ↔ current`, `${selected.relative}: 前回 ↔ 今回`),
      { preview: true },
    );
  }

  public async keepSessionEdit(sessionId?: string, file?: string): Promise<void> {
    if (!sessionId || !file) {
      return;
    }
    await this.runSessionDecision(sessionId, async () => {
      this.changeSessions.keep(file, sessionId);
      await this.recordAudit({
        action: "session.keep",
        summary: `Kept ${vscode.workspace.asRelativePath(file)}`,
        files: [vscode.workspace.asRelativePath(file)],
        sessionId,
      });
      await this.verifyAfterPendingReview(sessionId);
    });
  }

  public async restoreSessionEdit(sessionId?: string, file?: string): Promise<void> {
    if (!sessionId || !file) {
      return;
    }
    await this.runSessionDecision(sessionId, async () => {
      await this.changeSessions.restoreFile(file, sessionId);
      await this.recordAudit({
        action: "session.restore",
        summary: `Restored ${vscode.workspace.asRelativePath(file)}`,
        files: [vscode.workspace.asRelativePath(file)],
        sessionId,
      });
      await this.verifyAfterPendingReview(sessionId);
    });
  }

  public async keepAllSessionEdits(sessionId?: string): Promise<void> {
    const resolvedId = sessionId ?? this.changeSessions.snapshot()?.id;
    if (!resolvedId) {
      return;
    }
    await this.runSessionDecision(resolvedId, async () => {
      const files = this.changeSessions
        .pendingFiles(resolvedId)
        .map((file) => vscode.workspace.asRelativePath(file));
      this.changeSessions.keepAll(resolvedId);
      await this.recordAudit({
        action: "session.keepAll",
        summary: `Kept all pending AI changes (${files.length})`,
        files,
        sessionId: resolvedId,
      });
      await this.verifyAfterPendingReview(resolvedId);
    });
  }

  public async restoreAllSessionEdits(sessionId?: string): Promise<void> {
    const resolvedId = sessionId ?? this.changeSessions.snapshot()?.id;
    if (!resolvedId) {
      return;
    }
    await this.runSessionDecision(resolvedId, async () => {
      const files = this.changeSessions
        .pendingFiles(resolvedId)
        .map((file) => vscode.workspace.asRelativePath(file));
      await this.changeSessions.restorePending(resolvedId);
      await this.recordAudit({
        action: "session.restoreAll",
        summary: `Restored all pending AI changes (${files.length})`,
        files,
        sessionId: resolvedId,
      });
      await this.verifyAfterPendingReview(resolvedId);
    });
  }

  public async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    inlineContext: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[]> {
    const enabled = this.featureEnabled("enableInlineCompletions");
    const configuration = this.alertConfiguration();
    if (
      !enabled ||
      document.uri.scheme !== "file" ||
      (configuration.get<boolean>("inlineCompletionPauseDuringAgentRuns", true) &&
        this.anyChatBusy())
    ) {
      return [];
    }
    const ledger = this.context.workspaceState.get<UsageLedger>(USAGE_LEDGER_KEY);
    const budgets = [
      budgetSnapshot(ledger, configuration.get<number>("dailyTokenBudget", 0)),
      monthlyBudgetSnapshot(ledger, configuration.get<number>("monthlyTokenBudget", 0)),
      estimatedMonthlyCostSnapshot(
        ledger,
        configuration.get<number>("monthlyCostLimitUsd", 0),
        configuration.get<number>("estimatedCostPerMillionTokensUsd", 0),
      ),
    ];
    if (budgets.some((budget) => budget?.status === "exceeded")) {
      return [];
    }
    const offset = document.offsetAt(position);
    const source = document.getText();
    const before = source.slice(Math.max(0, offset - 8_000), offset);
    const after = source.slice(offset, Math.min(source.length, offset + 3_000));
    if (
      !shouldRequestInlineCompletion(
        before,
        after,
        configuration.get<number>("inlineCompletionMinPrefixCharacters", 3),
      )
    ) {
      return [];
    }
    const key = [
      document.uri.toString(),
      document.languageId,
      document.version,
      position.line,
      position.character,
      before.slice(-256),
      after.slice(0, 128),
    ].join(":");
    const documentVersion = document.version;
    const cached = this.inlineCompletionCache.get(key);
    if (cached) {
      this.touchInlineCompletionCache(key, cached);
      return [this.inlineCompletionItem(cached)];
    }
    const apiKey = await this.context.secrets.get(API_KEY_SECRET);
    const workspace = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!apiKey || !workspace || token.isCancellationRequested) {
      return [];
    }

    try {
      const uriKey = document.uri.toString();
      const generation = (this.inlineCompletionGeneration.get(uriKey) ?? 0) + 1;
      this.inlineCompletionGeneration.set(uriKey, generation);
      if (inlineContext.triggerKind !== vscode.InlineCompletionTriggerKind.Invoke) {
        await new Promise<void>((resolve) =>
          setTimeout(resolve, configuration.get<number>("inlineCompletionDebounceMs", 350)),
        );
      }
      if (
        token.isCancellationRequested ||
        this.inlineCompletionGeneration.get(uriKey) !== generation ||
        document.version !== documentVersion
      ) {
        return [];
      }
      let request = this.inlineCompletionInFlight.get(key);
      if (!request) {
        request = (async () => {
          const result = await Agent.prompt(
            [
              "Complete code at the cursor. Return only the exact text to insert, without Markdown or explanation.",
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
              local: {
                cwd: workspace.uri.fsPath,
                settingSources: projectSettingSourcesForWorkspaceTrust(
                  vscode.workspace.isTrusted,
                  configuration.get<boolean>("inlineCompletionIncludeProjectRules", true)
                    && workspaceIntegrationSelection({
                      disabledIds: this.disabledIntegrationIds(),
                      folderUri: workspace.uri.toString(),
                      folderName: workspace.name,
                      mcpPath: vscode.Uri.joinPath(workspace.uri, ".cursor", "mcp.json").fsPath,
                    }).disabledIds.length === 0,
                ),
              },
            },
          );
          if (result.usage) {
            await this.recordUsage("chat", result.usage);
          }
          return result.status === "finished"
            ? sanitizeInlineCompletion(result.result ?? "", before, after, {
                maxCharacters: configuration.get<number>("inlineCompletionMaxCharacters", 1_200),
                maxLines: configuration.get<number>("inlineCompletionMaxLines", 24),
              })
            : "";
        })();
        this.inlineCompletionInFlight.set(key, request);
        void request.then(
          () => this.inlineCompletionInFlight.delete(key),
          () => this.inlineCompletionInFlight.delete(key),
        );
      }
      const completion = await request;
      if (!completion || token.isCancellationRequested) {
        return [];
      }
      this.touchInlineCompletionCache(key, completion);
      await this.noteInlineCompletionSuggested();
      return [this.inlineCompletionItem(completion)];
    } catch (error) {
      this.output.appendLine(
        `[${new Date().toISOString()}] Inline completion failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  private inlineCompletionItem(completion: string): vscode.InlineCompletionItem {
    const item = new vscode.InlineCompletionItem(completion);
    item.command = {
      command: "cursorSubscription.inlineCompletionAccepted",
      title: localize("Inline completion accepted", "インライン補完を採用"),
    };
    return item;
  }

  private async noteInlineCompletionSuggested(): Promise<void> {
    const stats = this.context.workspaceState.get<InlineCompletionStats>(
      INLINE_COMPLETION_STATS_KEY,
      { suggested: 0, accepted: 0 },
    );
    await this.context.workspaceState.update(INLINE_COMPLETION_STATS_KEY, {
      ...stats,
      suggested: stats.suggested + 1,
    });
    this.postUsageStats();
  }

  public async noteInlineCompletionAccepted(): Promise<void> {
    const stats = this.context.workspaceState.get<InlineCompletionStats>(
      INLINE_COMPLETION_STATS_KEY,
      { suggested: 0, accepted: 0 },
    );
    await this.context.workspaceState.update(INLINE_COMPLETION_STATS_KEY, {
      ...stats,
      accepted: stats.accepted + 1,
    });
    this.postUsageStats();
    this.output.appendLine(
      `[${new Date().toISOString()}] Inline completion acceptance: ${(
        inlineCompletionAcceptanceRate({ ...stats, accepted: stats.accepted + 1 }) * 100
      ).toFixed(1)}%`,
    );
  }

  public async generateCode(editor: vscode.TextEditor): Promise<void> {
    if (editor.document.uri.scheme !== "file") {
      void vscode.window.showInformationMessage(
        localize(
          "Save the file before generating code.",
          "コードを生成する前にファイルを保存してください。",
        ),
      );
      return;
    }

    const selection = new vscode.Range(editor.selection.start, editor.selection.end);
    const selectedText = editor.document.getText(selection);
    if (selectedText.length > MAX_EDITOR_GENERATION_CONTEXT) {
      void vscode.window.showWarningMessage(
        localize(
          "The selected code is too large to generate safely. Select a smaller range.",
          "選択範囲が大きすぎるため、安全にコードを生成できません。範囲を小さくしてください。",
        ),
      );
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
    const surroundingBudget = Math.max(0, MAX_EDITOR_GENERATION_CONTEXT - selectedText.length);
    const contextPerSide = Math.floor(surroundingBudget / 2);
    const beforeStartOffset = Math.max(0, cursorOffset - contextPerSide);
    const afterEndOffset = Math.min(document.getText().length, selectionEndOffset + contextPerSide);
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
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n");

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
            throw new Error(
              localize("The model returned empty code.", "モデルから空のコードが返されました。"),
            );
          }

          const currentDocument =
            vscode.workspace.textDocuments.find(
              (candidate) => candidate.uri.toString() === document.uri.toString(),
            ) ?? (await vscode.workspace.openTextDocument(document.uri));
          if (currentDocument.version !== documentVersion) {
            throw new Error(
              localize(
                "The file changed while code was being generated. Run the command again.",
                "コードの生成中にファイルが変更されました。もう一度実行してください。",
              ),
            );
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
              throw new Error(
                localize(
                  "The file changed while the preview was open. Generate the change again.",
                  "プレビュー中にファイルが変更されました。再度生成してください。",
                ),
              );
            }
          }

          const edit = new vscode.WorkspaceEdit();
          edit.replace(document.uri, selection, generatedCode);
          const applied = await vscode.workspace.applyEdit(edit);
          if (!applied) {
            throw new Error(
              localize(
                "Could not apply the generated code.",
                "生成したコードを適用できませんでした。",
              ),
            );
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
      this.output.appendLine(`[${new Date().toISOString()}] Code generation error: ${message}`);
      void vscode.window.showErrorMessage(message);
    }
  }

  public async explainSelection(editor: vscode.TextEditor): Promise<void> {
    if (editor.selection.isEmpty) {
      void vscode.window.showInformationMessage(
        localize(
          "Select the code you want Cursor to explain.",
          "Cursorに説明してほしいコードを選択してください。",
        ),
      );
      return;
    }

    const editorContext = this.captureEditorContext(editor);
    if (!editorContext?.selectedText) {
      return;
    }
    if (editorContext.selectedText.length > MAX_EDITOR_GENERATION_CONTEXT) {
      void vscode.window.showWarningMessage(
        localize(
          "The selected code is too large to explain safely. Select a smaller range.",
          "選択範囲が大きすぎるため、安全に説明できません。範囲を小さくしてください。",
        ),
      );
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
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(
        localize(
          "Creating a pull request requires a trusted workspace.",
          "プルリクエストを作成するには、信頼済みワークスペースが必要です。",
        ),
      );
      return;
    }
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
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(
        localize(
          "Creating a pull request requires a trusted workspace.",
          "プルリクエストを作成するには、信頼済みワークスペースが必要です。",
        ),
      );
      return;
    }
    if (!force && !this.alertConfiguration().get<boolean>("offerPullRequestAfterVerify", true)) {
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
      await this.showPullRequestCreated(result.branch, result.url);
    } catch (error) {
      await this.handlePullRequestCreationFailure(error, {
        root,
        title,
      });
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

  public async findInChat(): Promise<void> {
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    this.post({ type: "openFind" });
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

    await Promise.all(
      conversationIds.map((conversationId) =>
        this.enqueueMessage(
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
        ),
      ),
    );
    void vscode.window.showInformationMessage(
      localize(
        `Started best-of-${runCount}. Candidates verify in isolation; a winner is selected automatically when all finish (or pick one from history).`,
        `best-of-${runCount}を開始しました。候補は隔離検証され、全完了後に自動で勝者を選びます（履歴からの手動選択も可）。`,
      ),
    );
  }

  private collectBestOfNEvidence(experiment: BestOfNExperiment): BestOfNCandidateEvidence[] {
    return experiment.conversationIds.flatMap((id) => {
      const conversation = this.conversations.find((item) => item.id === id);
      if (!conversation) {
        return [];
      }
      const lastAssistant = [...conversation.transcript]
        .reverse()
        .find((entry) => entry.role === "assistant");
      const artifact = this.bestOfNArtifacts.get(id);
      const failed =
        lastAssistant?.error === true ||
        lastAssistant?.progressState === "error" ||
        lastAssistant?.progressState === "stopped";
      const completed = Boolean(lastAssistant) && !this.isConversationBusy(id);
      const verification = artifact?.verification;
      return [
        {
          conversationId: id,
          title: conversation.title,
          completed,
          failed,
          hasArtifact: (artifact?.changes.length ?? 0) > 0,
          changedFileCount: artifact?.changes.length ?? lastAssistant?.files?.length ?? 0,
          changedFiles: artifact?.changes.map((change) => change.relative) ?? lastAssistant?.files,
          verificationSuccess: verification
            ? verification.skipped
              ? undefined
              : verification.success
            : undefined,
          verificationSkipped: verification?.skipped === true,
          totalTokens: conversation.tokenUsage?.totalTokens ?? 0,
          lastAssistant: lastAssistant?.text?.slice(0, 2_000),
        },
      ];
    });
  }

  private async maybeAutoSelectBestOfNWinner(experimentId: string): Promise<void> {
    if (!this.alertConfiguration().get<boolean>("bestOfNAutoSelect", true)) {
      return;
    }
    if (this.bestOfNAutoSelectInFlight.has(experimentId)) {
      return;
    }
    const index = this.bestOfNExperiments.findIndex((item) => item.id === experimentId);
    if (index < 0) {
      return;
    }
    const experiment = this.bestOfNExperiments[index];
    if (shouldAbortBestOfNAutoSelect(experiment, { autoSelectEnabled: true })) {
      return;
    }
    if (experiment.conversationIds.some((id) => this.isConversationBusy(id))) {
      return;
    }
    const evidence = this.collectBestOfNEvidence(experiment);
    if (evidence.length === 0 || evidence.some((item) => !item.completed)) {
      return;
    }

    this.bestOfNAutoSelectInFlight.add(experimentId);
    try {
      let selection = selectBestOfNWinner(evidence);
      if (!selection) {
        void vscode.window.showWarningMessage(
          localize(
            "All best-of-N candidates failed. No winner was selected.",
            "best-of-Nの候補がすべて失敗したため、勝者を選べませんでした。",
          ),
        );
        return;
      }

      const autoJudgeEnabled = this.alertConfiguration().get<boolean>("bestOfNAutoJudge", false);
      const shouldJudge = selection.tied && autoJudgeEnabled && vscode.workspace.isTrusted;
      if (shouldJudge) {
        const apiKey = await this.context.secrets.get(API_KEY_SECRET);
        const workspace = this.resolveChatWorkspace();
        if (apiKey && workspace) {
          try {
            if (
              shouldAbortBestOfNAutoSelect(
                this.bestOfNExperiments.find((item) => item.id === experimentId),
                {
                  autoSelectEnabled: this.alertConfiguration().get<boolean>(
                    "bestOfNAutoSelect",
                    true,
                  ),
                  requireAutoJudge: true,
                  autoJudgeEnabled: this.alertConfiguration().get<boolean>(
                    "bestOfNAutoJudge",
                    false,
                  ),
                },
              )
            ) {
              return;
            }
            const result = await Agent.prompt(
              buildBestOfNJudgePrompt(experiment.prompt, evidence),
              {
                apiKey,
                model: this.selectedModelSelection(),
                name: "VS Code: Best-of-N Judge",
                mode: "plan",
                local: { cwd: workspace.uri.fsPath, settingSources: [] },
              },
            );
            if (result.usage) {
              await this.recordUsage("chat", result.usage);
            }
            const latestForVerdict = this.bestOfNExperiments.find(
              (item) => item.id === experimentId,
            );
            if (
              shouldAbortBestOfNAutoSelect(latestForVerdict, {
                autoSelectEnabled: this.alertConfiguration().get<boolean>(
                  "bestOfNAutoSelect",
                  true,
                ),
                requireAutoJudge: true,
                autoJudgeEnabled: this.alertConfiguration().get<boolean>("bestOfNAutoJudge", false),
              })
            ) {
              return;
            }
            const verdict =
              result.status === "finished"
                ? parseBestOfNWinnerVerdict(
                    result.result ?? "",
                    latestForVerdict?.conversationIds ?? experiment.conversationIds,
                  )
                : undefined;
            if (verdict) {
              selection = {
                winnerId: verdict.winnerId,
                reasons:
                  verdict.reasons.length > 0
                    ? verdict.reasons
                    : ["AI judge selected this candidate"],
                tied: false,
                method: "judge",
              };
            }
          } catch (error) {
            this.output.appendLine(
              `[${new Date().toISOString()}] Best-of-N judge failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      }

      const latestIndex = this.bestOfNExperiments.findIndex((item) => item.id === experimentId);
      if (latestIndex < 0) {
        return;
      }
      const latest = this.bestOfNExperiments[latestIndex];
      if (
        shouldAbortBestOfNAutoSelect(latest, {
          autoSelectEnabled: this.alertConfiguration().get<boolean>("bestOfNAutoSelect", true),
        })
      ) {
        return;
      }
      if (!latest.conversationIds.includes(selection.winnerId)) {
        return;
      }

      const winnerConversation = this.conversations.find((item) => item.id === selection.winnerId);
      if (!winnerConversation) {
        return;
      }
      const reasons = selection.reasons;
      this.bestOfNExperiments[latestIndex] = pickWinner(latest, selection.winnerId, {
        autoSelected: true,
        reasons,
      });
      await this.context.workspaceState.update(BEST_OF_N_KEY, this.bestOfNExperiments);
      winnerConversation.pinned = true;
      await this.saveConversations();

      // Single toast via pickBestOfNWinner (alreadyPinned) — avoid duplicate
      // InformationMessage from auto-select + pin.
      await this.pickBestOfNWinner(selection.winnerId, { alreadyPinned: true });
    } finally {
      this.bestOfNAutoSelectInFlight.delete(experimentId);
    }
  }

  private async pickBestOfNWinner(
    conversationId: string,
    options?: { alreadyPinned?: boolean },
  ): Promise<void> {
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
    const experiment = options?.alreadyPinned
      ? this.bestOfNExperiments[index]
      : pickWinner(this.bestOfNExperiments[index], conversationId);
    this.bestOfNExperiments[index] = experiment;
    conversation.pinned = true;
    await this.context.workspaceState.update(BEST_OF_N_KEY, this.bestOfNExperiments);
    await this.saveConversations();
    const applyLabel = localize("Apply winner", "勝者を適用");
    const prLabel = localize("Apply and create PR", "適用してPRを作成");
    const discardLabel = localize("Delete losing runs", "敗者の会話を削除");
    const hasArtifact = this.bestOfNArtifacts.has(conversationId);
    const stillRunning = experiment.conversationIds.some((id) => this.isConversationBusy(id));
    const actions =
      hasArtifact && !stillRunning ? [applyLabel, prLabel, discardLabel] : [discardLabel];
    const answer = await vscode.window.showInformationMessage(
      localize(
        stillRunning
          ? "Pinned the best-of-N winner. Wait for all candidates to finish before applying it."
          : hasArtifact
            ? options?.alreadyPinned
              ? "Apply the auto-selected best-of-N winner, create a pull request, or delete the losing runs."
              : "Pinned the best-of-N winner. Its isolated changes can now be applied directly or turned into a pull request."
            : "Pinned the winning conversation from best-of-N.",
        stillRunning
          ? "best-of-Nの勝者をピン留めしました。全候補の完了後に適用できます。"
          : hasArtifact
            ? options?.alreadyPinned
              ? "自動選択されたbest-of-Nの勝者を適用、PR作成、または敗者会話の削除ができます。"
              : "best-of-Nの勝者をピン留めしました。隔離された変更を直接適用またはPR化できます。"
            : "best-of-Nの勝者会話をピン留めしました。",
      ),
      ...actions,
    );
    if (answer === applyLabel || answer === prLabel) {
      await this.applyBestOfNWinner(experiment, conversation, answer === prLabel);
    } else if (answer === discardLabel) {
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

  private async applyBestOfNWinner(
    experiment: BestOfNExperiment,
    conversation: Conversation,
    createPullRequest: boolean,
  ): Promise<void> {
    const artifact = this.bestOfNArtifacts.get(conversation.id);
    if (!artifact) {
      return;
    }
    const storageRoot = this.context.storageUri ?? this.context.globalStorageUri;
    let appliedFiles: string[] = [];
    let appliedSuccessfully = false;
    try {
      const changeSession = this.featureEnabled("enableChangeSessions")
        ? await this.changeSessions.begin(
            `Apply best-of-N winner: ${conversation.title}`,
            artifact.root,
          )
        : undefined;
      const result = await this.parallelApplyQueue.run(async () => {
        const lease = await this.fileOwnership.acquire(`best-of-n:${conversation.id}`, [
          path.join(artifact.root, ".cursor-parallel-workspace-owner"),
          ...artifact.changes.map((change) => path.join(artifact.root, change.relative)),
        ]);
        try {
          return await applyIsolatedChanges(artifact.session, storageRoot, artifact.changes, {
            pathEscapeLabel: "best-of-N candidate",
            unavailableMessage: localize(
              "The winning candidate worktree is unavailable.",
              "勝者候補のworktreeを利用できません。",
            ),
            conflictMessage: localize(
              "The workspace changed after the candidate started; the conflicting file was not applied.",
              "候補開始後にワークスペースが変更されたため、競合ファイルは適用しませんでした。",
            ),
            missingBaselineMessage: (relative) =>
              localize(
                `The best-of-N baseline for ${relative} is unavailable.`,
                `${relative} のbest-of-Nベースラインを利用できません。`,
              ),
            autoMerge: false,
          });
        } finally {
          lease.release();
        }
      });
      appliedFiles = result.applied.map((relative) => path.join(artifact.root, relative));
      if (changeSession && appliedFiles.length > 0) {
        await this.changeSessions.markPending(appliedFiles, changeSession.id);
        this.changeSessions.keepAll(changeSession.id);
      }
      await this.recordAudit({
        action: "compare.apply",
        summary: `Applied best-of-N winner (${result.applied.length} file(s))`,
        details:
          result.merged.length > 0
            ? `Automatically merged: ${result.merged.join(", ")}`
            : undefined,
        files: result.applied,
        sessionId: changeSession?.id,
      });
      if (result.conflicts.length > 0) {
        if (changeSession) {
          this.changeSessions.setPhase("review", changeSession.id);
        }
        void vscode.window.showWarningMessage(
          localize(
            `Applied the winner, but ${result.conflicts.length} conflicting file(s) require manual review.`,
            `勝者を適用しましたが、${result.conflicts.length}件の競合ファイルは手動確認が必要です。`,
          ),
        );
      }
      const verification = this.featureEnabled("enableVerification")
        ? await runVerification(
            artifact.root,
            this.alertConfiguration().get<string[]>("verificationCommands", []),
            this.output,
          )
        : undefined;
      if (verification && changeSession) {
        this.changeSessions.setVerification(verification, changeSession.id);
      }
      if (createPullRequest && result.conflicts.length === 0 && verification?.success !== false) {
        await this.recordAudit({
          action: "compare.pr",
          summary: `Creating PR from best-of-N winner: ${conversation.title}`,
          files: result.applied,
          sessionId: changeSession?.id,
        });
        await this.createPipelinePullRequest(
          artifact.root,
          conversation.title.replace(/^\[B\d+\]\s*/, ""),
          [experiment.prompt, "", verification ? this.formatVerificationSummary(verification) : ""]
            .filter(Boolean)
            .join("\n"),
          appliedFiles,
        );
      }
      experiment.appliedWinnerId = conversation.id;
      experiment.pullRequestCreated = createPullRequest && verification?.success !== false;
      appliedSuccessfully = true;
      await this.context.workspaceState.update(BEST_OF_N_KEY, this.bestOfNExperiments);
      void vscode.window.showInformationMessage(
        localize(
          `Applied best-of-N winner (${appliedFiles.length} file(s)).`,
          `best-of-Nの勝者を適用しました（${appliedFiles.length}ファイル）。`,
        ),
      );
    } catch (error) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (appliedSuccessfully) {
        await this.cleanupBestOfNArtifacts(experiment);
      }
    }
  }

  private async cleanupBestOfNArtifact(conversationId: string): Promise<void> {
    const artifact = this.bestOfNArtifacts.get(conversationId);
    if (!artifact) {
      return;
    }
    this.bestOfNArtifacts.delete(conversationId);
    await cleanupIsolatedWorktree(
      artifact.session,
      this.context.storageUri ?? this.context.globalStorageUri,
      (message) => this.output.appendLine(message),
    );
  }

  private async cleanupBestOfNArtifacts(experiment: BestOfNExperiment): Promise<void> {
    await Promise.all(experiment.conversationIds.map((id) => this.cleanupBestOfNArtifact(id)));
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
          this.conversations.some((conversation) => conversation.id === id),
        ),
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
      void vscode.window.showWarningMessage(
        localize(
          "No files could be added to chat.",
          "チャットに追加できるファイルがありませんでした。",
        ),
      );
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
      previousId &&
      previousId !== nextConversationId &&
      this.retainedParallelTasks.has(previousId) &&
      this.viewedRetainedParallelTasks.has(previousId)
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
    await this.cleanupBestOfNArtifact(id);
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
      await this.attachmentService.deleteConversationAttachments(deletedConversation);
    }
    await this.saveConversations();
    if (!this.activeId) {
      this.postView();
    }
  }

  public dispose(): Promise<void> {
    return this.lifecycle.dispose(() => this.disposeInternal());
  }

  private async disposeInternal(): Promise<void> {
    this.workspaceIndexGeneration += 1;
    if (this.workspaceIndexRefreshTimer) {
      clearTimeout(this.workspaceIndexRefreshTimer);
      this.workspaceIndexRefreshTimer = undefined;
    }
    this.messageQueue.splice(0, this.messageQueue.length);
    await this.waitForShutdownOperation(
      this.cancelAllChats(),
      "cancelling active Cursor runs",
    );
    await this.disposeAgentsForShutdown();
    await this.waitForShutdownOperation(
      Promise.allSettled(this.activeSendOperations),
      "waiting for active Cursor sends",
    );
    await this.waitForPendingPreparationOperations();
    // A send that was still acquiring or recovering an agent when shutdown
    // began may have installed a handle after the first disposal pass.
    await this.disposeAgentsForShutdown();
    try {
      await this.conversationStore.flush();
    } catch (error) {
      this.output.appendLine(
        `[${new Date().toISOString()}] Could not flush conversation storage during shutdown: ${String(error)}`,
      );
    }
    await Promise.all(
      [...this.bestOfNArtifacts.keys()].map((id) => this.cleanupBestOfNArtifact(id)),
    );
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
    return raw.replace(/^(?:\r?\n)+/, "").replace(/(?:\r?\n)+$/, "");
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

  private changeCourtVerificationSummary(result?: VerificationResult): string {
    if (!result) {
      return "Verification was not run for this change session.";
    }
    if (result.skipped) {
      return "Verification was skipped because no configured or detected commands were available.";
    }
    return [
      `Overall verification: ${result.success ? "passed" : "failed"}.`,
      ...result.steps.map((step) => `- ${step.success ? "passed" : "failed"}: ${step.command}`),
    ].join("\n");
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
      selectedText: selection.isEmpty ? undefined : editor.document.getText(selection),
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
    return value === "safe-worktree" || value === "auto-review" || value === "full-access";
  }

  private selectedApprovalMode(): ApprovalMode {
    const fallback = defaultSafetyApprovalMode(SUPPORTS_LOCAL_SANDBOX);
    const stored = this.context.globalState.get<string>(APPROVAL_MODE_KEY, fallback);
    if (SUPPORTS_LOCAL_SANDBOX && stored === "safe-worktree") {
      return "auto-review";
    }
    return this.isApprovalMode(stored) ? stored : fallback;
  }

  private ensureWindowsSafeModeMigrated(): Promise<void> {
    if (
      !shouldMigrateToSafeWorktree(
        SUPPORTS_LOCAL_SANDBOX,
        this.context.globalState.get<boolean>(WINDOWS_SAFE_MODE_MIGRATION_KEY, false),
      )
    ) {
      return Promise.resolve();
    }
    this.windowsSafeModeMigrationPromise ??= (async () => {
      await this.context.globalState.update(APPROVAL_MODE_KEY, "safe-worktree");
      await this.context.globalState.update(WINDOWS_SAFE_MODE_MIGRATION_KEY, true);
      this.output.appendLine(
        `[${new Date().toISOString()}] Migrated Windows execution permissions to Safe worktree mode.`,
      );
    })().finally(() => {
      this.windowsSafeModeMigrationPromise = undefined;
    });
    return this.windowsSafeModeMigrationPromise;
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
    return value === "agent" || value === "plan" || value === "multitask";
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
    orchestratorFinalResultConversationId?: string;
  }> {
    const finalResultLinks = this.availableOrchestratorFinalResultLinks();
    return buildConversationSummaries(this.conversations, query, {
      isBusy: (id) => this.isConversationBusy(id),
      isQueued: (id) => this.messageQueue.some((item) => item.conversationId === id),
      orchestratorFinalResultLinks: finalResultLinks,
    });
  }

  private availableOrchestratorFinalResultLinks(): ReadonlyMap<string, string> {
    const existingConversationIds = new Set(this.conversations.map((conversation) => conversation.id));
    return new Map(
      [...orchestratorFinalResultLinks(this.orchestratorExperiments)]
        .filter(([conversationId, finalResultId]) =>
          existingConversationIds.has(conversationId)
          && existingConversationIds.has(finalResultId)
        ),
    );
  }

  private async saveConversations(): Promise<void> {
    await this.conversationStore.save();
    this.postUsageStats();
  }

  public async recordUsage(source: UsageSource, usage: StoredTokenUsage): Promise<void> {
    const ledger = this.context.workspaceState.get<UsageLedger>(USAGE_LEDGER_KEY);
    await this.context.workspaceState.update(USAGE_LEDGER_KEY, recordUsage(ledger, source, usage));
    this.postUsageStats();
  }

  private usageSummary(): UsageSummary {
    return summarizeUsage(
      this.conversations,
      this.context.workspaceState.get<UsageLedger>(USAGE_LEDGER_KEY),
    );
  }

  private postUsageStats(): void {
    const configuration = this.alertConfiguration();
    const dailyBudget = configuration.get<number>("dailyTokenBudget", 0);
    const monthlyBudget = configuration.get<number>("monthlyTokenBudget", 0);
    const monthlyCostLimit = configuration.get<number>("monthlyCostLimitUsd", 0);
    const blendedRate = configuration.get<number>("estimatedCostPerMillionTokensUsd", 0);
    const ledger = this.context.workspaceState.get<UsageLedger>(USAGE_LEDGER_KEY);
    const budget = budgetSnapshot(ledger, dailyBudget);
    const monthly = monthlyBudgetSnapshot(ledger, monthlyBudget);
    const cost = estimatedMonthlyCostSnapshot(ledger, monthlyCostLimit, blendedRate);
    const inlineCompletion = this.context.workspaceState.get<InlineCompletionStats>(
      INLINE_COMPLETION_STATS_KEY,
      { suggested: 0, accepted: 0 },
    );
    this.post({
      type: "usageStats",
      summary: this.usageSummary(),
      budget: budget
        ? {
            budget: budget.budget,
            used: budget.used,
            remaining: budget.remaining,
            ratio: budget.ratio,
            status: budget.status,
          }
        : undefined,
      monthlyBudget: monthly,
      estimatedCost: cost
        ? {
            estimatedUsd: cost.estimatedUsd,
            limitUsd: cost.limitUsd,
            ratio: cost.ratio,
            status: cost.status,
          }
        : undefined,
      inlineCompletion: {
        ...inlineCompletion,
        acceptanceRate: inlineCompletionAcceptanceRate(inlineCompletion),
      },
    });
  }

  private async createPipelinePullRequest(
    root: string,
    title: string,
    body: string,
    files: string[],
  ): Promise<void> {
    try {
      const relativeFiles = files
        .map((file) => path.relative(root, file).replaceAll("\\", "/"))
        .filter((file) => isSafeRelativePath(file));
      const result = await createBranchCommitAndPullRequest({
        root,
        title,
        body,
        files: relativeFiles.length > 0 ? relativeFiles : undefined,
        japanese: IS_JAPANESE,
      });
      await this.recordAudit({
        action: "pipeline.pr",
        summary: `Created pipeline PR ${result.branch}`,
        details: result.url,
        files: relativeFiles,
      });
      await this.showPullRequestCreated(
        result.branch,
        result.url,
        localize(
          `Pipeline created ${result.branch}`,
          `パイプラインが ${result.branch} を作成しました`,
        ),
      );
    } catch (error) {
      await this.handlePullRequestCreationFailure(error, {
        root,
        title,
        body,
      });
    }
  }

  private async showPullRequestCreated(
    branch: string,
    url: string | undefined,
    message?: string,
  ): Promise<void> {
    const openLabel = localize("Open pull request", "PRを開く");
    const followUp = url
      ? await vscode.window.showInformationMessage(
          message ?? localize(`Created ${branch}`, `${branch} を作成しました`),
          openLabel,
        )
      : undefined;
    if (followUp === openLabel && url) {
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }
  }

  private async handlePullRequestCreationFailure(
    error: unknown,
    context: { root: string; title: string; body?: string },
  ): Promise<void> {
    if (!(error instanceof PullRequestCreationError)) {
      void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
      return;
    }

    const actions = pullRequestRecoveryActions(error.recovery);
    const labels = actions.map((action) => pullRequestRecoveryActionLabel(action, IS_JAPANESE));
    const answer = await vscode.window.showErrorMessage(error.message, ...labels);
    if (!answer) {
      return;
    }
    const chosen = actions.find(
      (action) => pullRequestRecoveryActionLabel(action, IS_JAPANESE) === answer,
    );
    if (!chosen) {
      return;
    }

    try {
      if (chosen === "checkout") {
        await checkoutPreservedPullRequestBranch(context.root, error.recovery, IS_JAPANESE);
        void vscode.window.showInformationMessage(
          localize(
            `Checked out ${error.recovery.branch}`,
            `${error.recovery.branch} をチェックアウトしました`,
          ),
        );
        return;
      }

      const result = await retryPullRequestCreation({
        root: context.root,
        title: context.title,
        body: context.body,
        recovery: error.recovery,
        japanese: IS_JAPANESE,
      });
      await this.showPullRequestCreated(result.branch, result.url);
    } catch (recoveryError) {
      await this.handlePullRequestCreationFailure(recoveryError, context);
    }
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
      this.postOrchestratorState();
    } else {
      this.post({ type: "newChat" });
    }
    this.postQueueState();
    this.refreshRunCenter();
  }

  private refreshRunCenter(): void {
    if (!this.runCenter) return;
    const session = this.changeSessions.snapshot();
    this.runCenter.pushState(
      this.runCenterCoordinator.buildState(
        buildRunCenterHostSnapshot({
          conversations: this.conversations,
          runtimes: [...this.chatRuntimes.entries()].map(([conversationId, runtime]) => ({
            conversationId,
            busy: runtime.busy,
            live: runtime.live
              ? {
                  assistantText: runtime.live.assistantText,
                  progressSteps: [...runtime.live.progressSteps.values()],
                  progressState: runtime.live.progressState,
                }
              : undefined,
          })),
          activeConversationId: this.activeId,
          queuedConversationIds: this.messageQueue.map((item) => item.conversationId),
          session: session
            ? {
                id: session.id,
                goal: session.goal,
                root: session.root,
                files: session.files,
                pendingFiles: this.changeSessions.pendingFiles(session.id),
                verification: session.verification
                  ? {
                      success: session.verification.success,
                      steps: session.verification.steps.map((step) => ({
                        command: step.command,
                        success: step.success,
                        output: step.output,
                      })),
                    }
                  : undefined,
              }
            : undefined,
          plan: this.executionPlans[0],
          backgroundJobs: this.runCenterSources?.backgroundJobs() ?? [],
          supervisorTasks: this.runCenterSources?.supervisorTasks() ?? [],
        }),
      ),
    );
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

  private async exportConversation(
    id: string,
    format: "markdown" | "json" = "markdown",
  ): Promise<void> {
    const conversation = this.conversations.find((item) => item.id === id);
    if (!conversation) {
      return;
    }
    const defaultName =
      conversation.title.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_").slice(0, 60) || "conversation";
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(`${defaultName}.${format === "json" ? "json" : "md"}`),
      filters:
        format === "json"
          ? { JSON: ["json"] }
          : ({ Markdown: ["md"] } satisfies Record<string, string[]>),
    });
    if (!target) {
      return;
    }
    const body =
      format === "json"
        ? Buffer.from(
            JSON.stringify(
              {
                id: conversation.id,
                title: conversation.title,
                createdAt: conversation.createdAt,
                updatedAt: conversation.updatedAt,
                pinned: conversation.pinned === true,
                tokenUsage: conversation.tokenUsage,
                transcript: conversation.transcript,
              },
              null,
              2,
            ),
            "utf8",
          )
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
    return formatConversationMarkdown(conversation);
  }

  private ensureConversation(prompt: string): Conversation {
    const existing = this.activeConversation();
    if (existing) {
      return existing;
    }
    const workspace = this.resolveChatWorkspace();
    const conversation = this.conversationStore.create(prompt, workspace?.uri.toString());
    this.draftWorkspaceFolderUri = undefined;
    this.showingHome = false;
    return conversation;
  }

  private resolveChatWorkspace(conversation?: Conversation): vscode.WorkspaceFolder | undefined {
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

  private explicitTargetFiles(
    workspace: vscode.WorkspaceFolder,
    requestedFiles: readonly string[],
    editorContext: EditorContextSnapshot | undefined,
    attachContext: boolean,
  ): string[] {
    const root = path.resolve(workspace.uri.fsPath);
    const candidates = [
      path.join(root, ".cursor-parallel-workspace-owner"),
      ...requestedFiles
        .map((file) => resolveAbsoluteInWorkspace(file, workspace))
        .filter((file): file is string => Boolean(file)),
    ];
    if (editorContext?.filePath) {
      candidates.push(editorContext.filePath);
    }
    const active = attachContext ? vscode.window.activeTextEditor?.document.uri : undefined;
    if (active?.scheme === "file") {
      candidates.push(active.fsPath);
    }
    const unique = new Map<string, string>();
    for (const file of candidates) {
      const resolved = path.resolve(file);
      const relative = path.relative(root, resolved);
      if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
        unique.set(process.platform === "win32" ? resolved.toLowerCase() : resolved, resolved);
      }
    }
    return [...unique.values()];
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
      void vscode.window.showWarningMessage(
        localize(
          "Stop the current agent run before changing the workspace folder.",
          "ワークスペースを変更する前に、実行中のAgentを停止してください。",
        ),
      );
      return;
    }
    const picked = await pickWorkspaceFolder(
      localize("Select a workspace folder for this chat", "このチャットのワークスペースを選択"),
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
    await this.publishSetupChecklistState();
  }

  private postIfActive(conversationId: string, message: HostToWebviewMessage): void {
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
    const finalResultLinks = this.availableOrchestratorFinalResultLinks();
    const queueCounts = new Map<string, number>();
    for (const item of this.messageQueue) {
      queueCounts.set(item.conversationId, (queueCounts.get(item.conversationId) ?? 0) + 1);
    }
    const liveTaskIds = this.conversations
      .filter(
        (conversation) =>
          this.isConversationBusy(conversation.id) || (queueCounts.get(conversation.id) ?? 0) > 0,
      )
      .map((conversation) => conversation.id);
    if (liveTaskIds.length > 1) {
      for (const conversationId of liveTaskIds) {
        this.parallelTaskParticipants.add(conversationId);
      }
    }
    const orchestratorSubtaskIndexByConversationId = new Map<string, number>();
    for (const experiment of this.orchestratorExperiments) {
      experiment.subtasks.forEach((subtask, index) => {
        if (subtask.conversationId) {
          orchestratorSubtaskIndexByConversationId.set(subtask.conversationId, index);
        }
      });
    }
    const tasks = this.conversations
      .map((conversation) => {
        const running = this.isConversationBusy(conversation.id);
        const queueCount = queueCounts.get(conversation.id) ?? 0;
        const retainedStatus = this.retainedParallelTasks.get(conversation.id);
        const status =
          conversationRunState({
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
        const orchestratorRole = conversation.orchestratorRole;
        const shortTitle =
          orchestratorRole === "plan"
            ? "Plan"
            : orchestratorRole === "synthesis"
              ? "Synthesis"
              : orchestratorRole === "subtask"
                ? conversation.title.match(/^\[([^\]]+)\]/)?.[1] || conversation.title
                : conversation.title;
        const activity = this.orchestratorActivityByConversationId.get(conversation.id);
        const orchestratorSubtaskIndex =
          orchestratorRole === "subtask"
            ? orchestratorSubtaskIndexByConversationId.get(conversation.id)
            : undefined;
        return {
          id: conversation.id,
          title: shortTitle,
          status,
          queueCount,
          active: this.activeId === conversation.id,
          updatedAt: conversation.updatedAt,
          visible: status !== undefined,
          orchestratorExperimentId: conversation.orchestratorExperimentId,
          orchestratorRole,
          ...(finalResultLinks.has(conversation.id)
            ? {
                orchestratorFinalResultConversationId: finalResultLinks.get(conversation.id),
              }
            : {}),
          ...(orchestratorSubtaskIndex !== undefined ? { orchestratorSubtaskIndex } : {}),
          activity: status === "running" ? activity : undefined,
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
    void vscode.window
      .showInformationMessage(
        localize(
          `${featureName} is disabled in Cursor Subscription settings.`,
          `${featureName}はCursor Subscriptionの設定で無効になっています。`,
        ),
        openLabel,
      )
      .then((answer) => {
        if (answer === openLabel) {
          void vscode.commands.executeCommand("cursorSubscription.openSettings");
        }
      });
    return false;
  }

  private async updateAlertSetting(setting: string, enabled: boolean): Promise<void> {
    const configuration = this.alertConfiguration();
    const inspected = configuration.inspect<boolean>(setting);
    const target =
      inspected?.workspaceFolderValue !== undefined
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
    if (this.lifecycle.isDisposing) {
      return;
    }
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
    this.messageQueue.splice(0, this.messageQueue.length, ...(next as QueuedMessage[]));
    this.postQueueState();
  }

  /**
   * Move selected queued prompts into new conversations and start them as
   * parallel agents without leaving the active chat.
   */
  private async launchQueuedMessagesParallel(ids: string[]): Promise<void> {
    const items = selectParallelLaunchCandidates(this.messageQueue, ids, this.activeId);
    if (items.length === 0) {
      return;
    }

    const maximumParallelAgents = normalizeMaxParallelAgents(
      this.alertConfiguration().get<number>("maxParallelChatAgents", 3),
    );
    const available = availableParallelSlots(this.activeRunCount(), maximumParallelAgents);
    if (available === 0) {
      this.post({
        type: "error",
        text: localize(
          `The parallel chat-agent limit (${maximumParallelAgents}) has been reached. Wait for a run to finish or increase cursorSubscription.maxParallelChatAgents.`,
          `並列チャットAgentの上限（${maximumParallelAgents}）に達しました。完了を待つか、cursorSubscription.maxParallelChatAgents を増やしてください。`,
        ),
      });
      return;
    }

    const { launchable, skippedForLimit } = takeParallelLaunchBatch(items, available);
    const launchIds = new Set(launchable.map((item) => item.id));
    this.messageQueue.splice(
      0,
      this.messageQueue.length,
      ...(removeQueuedMessages(this.messageQueue, (item) =>
        launchIds.has(item.id),
      ) as QueuedMessage[]),
    );
    this.postQueueState();

    const workspaceFolderUri = this.resolveChatWorkspace()?.uri.toString();
    const pending = [...launchable];
    let launched = 0;
    while (pending.length > 0) {
      if (!canStartAnotherParallelAgent(this.activeRunCount(), maximumParallelAgents)) {
        break;
      }
      const item = pending.shift()!;
      const conversation: Conversation = {
        id: randomUUID(),
        title: makeConversationTitle(item.prompt),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        workspaceFolderUri,
        transcript: [],
      };
      this.conversations.unshift(conversation);

      const started = await this.send(
        item.prompt,
        item.attachContext,
        item.files,
        item.profile,
        item.skills,
        conversation.id,
        item.model,
        item.editorContext,
        item.internalRepair === true,
        false,
        item.commandId,
        item.includeProjectMemory !== false,
      );
      if (!started) {
        this.conversations.splice(
          0,
          this.conversations.length,
          ...this.conversations.filter((candidate) => candidate.id !== conversation.id),
        );
        pending.unshift(item);
        break;
      }
      launched += 1;
    }

    if (pending.length > 0) {
      this.messageQueue.splice(
        0,
        this.messageQueue.length,
        ...requeueUnstartedMessages(this.messageQueue, pending),
      );
      this.postQueueState();
    }

    if (skippedForLimit > 0 || pending.length > 0) {
      this.post({
        type: "error",
        text: localize(
          `Started ${launched} parallel agent(s). ${skippedForLimit + pending.length} message(s) stayed queued (limit or start failure).`,
          `${launched}件を並列Agentで起動しました。${skippedForLimit + pending.length}件は上限または起動失敗のためキューに残しました。`,
        ),
      });
    }

    await this.saveConversations();
    this.postParallelState();
  }

  private async drainMessageQueue(conversationId?: string): Promise<void> {
    if (this.lifecycle.isDisposing) {
      return;
    }
    if (!conversationId) {
      const conversationIds = queuedConversationIds(this.messageQueue);
      await Promise.all(conversationIds.map((id) => this.drainMessageQueue(id)));
      return;
    }
    if (this.drainingConversations.has(conversationId) || this.isConversationBusy(conversationId)) {
      return;
    }
    this.drainingConversations.add(conversationId);
    try {
      while (!this.lifecycle.isDisposing && !this.isConversationBusy(conversationId)) {
        const maximumParallelAgents = normalizeMaxParallelAgents(
          this.alertConfiguration().get<number>("maxParallelChatAgents", 3),
        );
        if (!canStartAnotherParallelAgent(this.activeRunCount(), maximumParallelAgents)) {
          break;
        }
        const { next: item, remaining } = takeNextQueuedMessage(this.messageQueue, conversationId);
        if (!item) {
          break;
        }
        this.messageQueue.splice(0, this.messageQueue.length, ...remaining);
        const conversation = this.conversations.find(
          (candidate) => candidate.id === item.conversationId,
        );
        this.postQueueState();
        if (!conversation) {
          continue;
        }
        const started = await this.send(
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
          {
            fromQueue: true,
            queueKind: item.kind,
          },
        );
        if (!started) {
          // send() rejected before reserving the run (parallel limit race,
          // missing auth, etc). Put the item back so it is not dropped.
          this.messageQueue.splice(
            0,
            this.messageQueue.length,
            ...requeueUnstartedMessage(this.messageQueue, item),
          );
          this.postQueueState();
          break;
        }
      }
    } finally {
      this.drainingConversations.delete(conversationId);
    }
  }

  private deferQueueDrain(): void {
    this.lifecycle.defer(() => {
      void this.drainMessageQueue();
    });
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
    queue?: { fromQueue: true; queueKind: "queued" | "interrupt" },
  ): Promise<boolean> {
    if (this.lifecycle.isDisposing) {
      return false;
    }
    let finishTrackedSend: (() => void) | undefined;
    const trackedSend = new Promise<void>((resolve) => {
      finishTrackedSend = resolve;
    });
    const finishSend = (): void => {
      finishTrackedSend?.();
      finishTrackedSend = undefined;
      this.activeSendOperations.delete(trackedSend);
    };
    this.activeSendOperations.add(trackedSend);
    try {
    const commandCandidate = commandId
      ? this.projectCommands.find((command) => command.id === commandId)
      : undefined;
    const projectCommand =
      commandCandidate &&
      isPromptCommandAllowedForWorkspaceTrust(vscode.workspace.isTrusted, commandCandidate.source)
        ? commandCandidate
        : undefined;
    const effectivePrompt = projectCommand ? expandProjectCommand(projectCommand, prompt) : prompt;
    if (!effectivePrompt) {
      return false;
    }

    const tokenBudgetAllowed = await this.ensureTokenBudgetAllows();
    if (this.lifecycle.isDisposing) {
      return false;
    }
    if (!tokenBudgetAllowed) {
      this.post({
        type: "error",
        text: localize(
          "Send cancelled because the daily token budget was exceeded.",
          "1日のトークン予算を超過したため送信を中止しました。",
        ),
      });
      return false;
    }

    await this.ensureWindowsSafeModeMigrated();
    if (this.lifecycle.isDisposing) {
      return false;
    }
    if (!SUPPORTS_LOCAL_SANDBOX) {
      const sandboxWarningAcknowledged = await this.ensureSandboxWarningAcknowledged();
      if (this.lifecycle.isDisposing) {
        return false;
      }
      if (!sandboxWarningAcknowledged) {
        this.post({
          type: "error",
          text: localize(
            "Acknowledge the Windows sandbox warning before starting an agent run.",
            "エージェントを実行する前に、Windowsのサンドボックス警告を確認してください。",
          ),
        });
        return false;
      }
    }

    const apiKey = await this.context.secrets.get(API_KEY_SECRET);
    if (this.lifecycle.isDisposing) {
      return false;
    }
    if (!apiKey) {
      this.post({ type: "authRequired" });
      await this.promptForApiKey();
      return false;
    }

    let conversation = targetConversationId
      ? this.conversations.find((candidate) => candidate.id === targetConversationId)
      : this.activeConversation();
    if (!conversation && targetConversationId) {
      return false;
    }

    let workspace = conversation
      ? await this.bindConversationWorkspace(conversation)
      : this.resolveChatWorkspace();
    if (this.lifecycle.isDisposing) {
      return false;
    }
    if (!workspace) {
      this.post({
        type: "error",
        text: localize(
          "Open a folder before running Cursor Agent.",
          "Cursor Agentを実行するには、先にフォルダーを開いてください。",
        ),
      });
      return false;
    }

    if (!conversation) {
      conversation = this.ensureConversation(effectivePrompt);
      workspace = (await this.bindConversationWorkspace(conversation)) ?? workspace;
      if (this.lifecycle.isDisposing) {
        return false;
      }
    }
    if (this.activeId === conversation.id) {
      this.postWorkspaceLabel();
    }

    if (this.lifecycle.isDisposing) {
      return false;
    }
    const conversationId = conversation.id;
    const runtime = this.runtimeFor(conversationId);
    if (runtime.busy) {
      return false;
    }
    const maximumParallelAgents = normalizeMaxParallelAgents(
      this.alertConfiguration().get<number>("maxParallelChatAgents", 3),
    );
    if (!canStartAnotherParallelAgent(this.activeRunCount(), maximumParallelAgents)) {
      if (!queue?.fromQueue) {
        this.postIfActive(conversationId, {
          type: "error",
          text: localize(
            `The parallel chat-agent limit (${maximumParallelAgents}) has been reached. Wait for a run to finish or increase cursorSubscription.maxParallelChatAgents.`,
            `並列チャットAgentの上限（${maximumParallelAgents}）に達しました。完了を待つか、cursorSubscription.maxParallelChatAgents を増やしてください。`,
          ),
        });
      }
      return false;
    }
    // Reserve this conversation synchronously so a fast double-submit cannot
    // create two root runs for the same agent while attachments are prepared.
    this.retainedParallelTasks.delete(conversationId);
    this.viewedRetainedParallelTasks.delete(conversationId);
    runtime.busy = true;
    runtime.pendingCancel = false;
    const preparationAbort = new AbortController();
    runtime.preparationAbort = preparationAbort;
    const assertPreparationActive = (phase: string): void => {
      if (!this.lifecycle.isDisposing && !preparationAbort.signal.aborted) {
        return;
      }
      preparationAbort.abort();
      throw new RunPreparationError("cancelled", phase);
    };
    runtime.mutating = profile !== "plan";
    // A queued orchestrator task becomes running only after it has reserved a
    // real chat-agent slot, keeping persisted/UI state aligned with execution.
    await this.markOrchestratorSubtaskRunning(conversationId).catch((error) => {
      this.output.appendLine(
        `[${new Date().toISOString()}] Could not persist orchestrator running state: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
    if (this.lifecycle.isDisposing || preparationAbort.signal.aborted) {
      runtime.busy = false;
      if (runtime.preparationAbort === preparationAbort) {
        runtime.preparationAbort = undefined;
      }
      runtime.pendingCancel = false;
      runtime.mutating = false;
      return true;
    }
    if (queue?.fromQueue) {
      this.postIfActive(conversationId, {
        type: "queuedStarted",
        prompt,
        files: requestedFiles,
        kind: queue.queueKind,
      });
    }
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
    const ownershipAttempt = runtime.mutating
      ? this.fileOwnership.tryAcquire(
          conversationId,
          this.explicitTargetFiles(workspace, requestedFiles, editorContext, attachContext),
        )
      : { conflicts: [] };
    runtime.ownershipLease = ownershipAttempt.lease;
    runtime.overlappedMutation =
      overlapFlags.get(conversationId) === true || ownershipAttempt.conflicts.length > 0;
    const bestOfNCandidate = Boolean(conversation.experimentGroupId) && profile !== "plan";
    const useIsolatedWorktree =
      bestOfNCandidate ||
      shouldUseIsolatedWorktree({
        approvalMode: this.selectedApprovalMode(),
        mutating: runtime.mutating,
        overlappedMutation: runtime.overlappedMutation,
        sandboxSupported: SUPPORTS_LOCAL_SANDBOX,
      });
    runtime.isolationKind = useIsolatedWorktree
      ? !SUPPORTS_LOCAL_SANDBOX &&
        this.selectedApprovalMode() === "safe-worktree" &&
        !bestOfNCandidate
        ? "windows-safe"
        : "parallel"
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
        void vscode.window.showWarningMessage(
          localize(
            "Additional parallel chat agents run in an isolated worktree. Their edits apply after the run finishes, with clean concurrent changes merged automatically.",
            "追加の並列チャットAgentは隔離worktreeで実行されます。編集は実行完了後に適用され、競合しない並行変更は自動マージされます。",
          ),
        );
      }
    }
    this.postParallelState();
    let attachmentReferences: AttachedFileReference[] = [];
    let composed = effectivePrompt;
    let contextLabel: string | undefined;
    let images: SDKImage[] = [];
    let changeSessionId = continueSession ? runtime.changeSessionId : undefined;
    let preserveIsolatedWorktree = false;
    const storageRoot = this.context.storageUri ?? this.context.globalStorageUri;
    const shouldStartChangeSession =
      profile !== "plan" &&
      !continueSession &&
      !bestOfNCandidate &&
      this.featureEnabled("enableChangeSessions");
    try {
      assertPreparationActive("preparing local run resources");
      if (useIsolatedWorktree) {
        if (runtime.isolatedWorktree) {
          await cleanupIsolatedWorktree(runtime.isolatedWorktree, storageRoot, (message) =>
            this.output.appendLine(message),
          );
          runtime.isolatedWorktree = undefined;
          assertPreparationActive("cleaning the previous isolated worktree");
        }
        runtime.isolatedWorktree = await prepareIsolatedWorktree({
          id: `${conversationId.slice(0, 8)}-${randomUUID().slice(0, 8)}`,
          root: workspace.uri.fsPath,
          storageRoot,
          worktreesHomeSegment:
            runtime.isolationKind === "windows-safe"
              ? ".cursor-safe-chat/worktrees"
              : ".cursor-parallel-chat/worktrees",
          baselinesFolder:
            runtime.isolationKind === "windows-safe"
              ? "safe-chat-baselines"
              : "parallel-chat-baselines",
          pathEscapeLabel: runtime.isolationKind === "windows-safe" ? "safe chat" : "parallel chat",
          isExcluded: createExcludedPathMatcher(workspace.uri),
          onLog: (message) => this.output.appendLine(message),
          beforeCaptureBaseline: (worktreePath) =>
            runConfiguredHooks(
              "preEdit",
              worktreePath,
              this.output,
              preparationAbort.signal,
            ),
        });
        assertPreparationActive("preparing the isolated worktree");
      }
      const attachedFiles = await this.attachmentService.resolveAttachedFiles(
        requestedFiles,
        workspace,
        preparationAbort.signal,
      );
      assertPreparationActive("resolving attached files");
      if (requestedFiles.length > 0 && attachedFiles.length === 0) {
        void vscode.window.showWarningMessage(
          localize(
            "Attached files could not be read and were omitted from this message.",
            "添付ファイルを読み取れなかったため、このメッセージからは除外されました。",
          ),
        );
      }
      attachmentReferences = await this.attachmentService.stageExternalAttachments(
        attachedFiles,
        workspace,
        conversation,
        preparationAbort.signal,
      );
      assertPreparationActive("staging attached files");
      ({ composed, contextLabel } = this.composePrompt(
        effectivePrompt,
        attachContext,
        attachmentReferences,
        profile,
        requestedSkills,
        editorContext,
        includeProjectMemory,
        workspace,
      ));
      images = await this.attachmentService.loadAttachedImages(
        attachedFiles,
        workspace,
        preparationAbort.signal,
      );
      assertPreparationActive("loading attached images");
      const attachedVisionCount = attachedFiles.filter((file) =>
        /\.(gif|jfif|jpe?g|png|webp)$/i.test(file),
      ).length;
      if (attachedVisionCount > 0 && images.length === 0) {
        void vscode.window.showWarningMessage(
          localize(
            "Attached images could not be loaded for the model (missing or over the size limit).",
            "添付画像をモデル向けに読み込めませんでした（欠落またはサイズ上限超過）。",
          ),
        );
      }
      if (shouldStartChangeSession) {
        if (!runtime.isolatedWorktree) {
          await runConfiguredHooks(
            "preEdit",
            workspace.uri.fsPath,
            this.output,
            preparationAbort.signal,
          );
          assertPreparationActive("running pre-edit hooks");
        }
        changeSessionId = (
          await this.changeSessions.begin(
            effectivePrompt,
            workspace.uri.fsPath,
            preparationAbort.signal,
          )
        ).id;
        runtime.changeSessionId = changeSessionId;
        assertPreparationActive("creating the change-session checkpoint");
        this.repairAttempts.set(conversationId, 0);
        this.changeSessions.setRepairBudget(
          {
            attempts: 0,
            maxAttempts: this.alertConfiguration().get<number>("maxAutoRepairAttempts", 1),
            status: "idle",
          },
          changeSessionId,
        );
      }
    } catch (error) {
      const preparationCancelled =
        preparationAbort.signal.aborted
        || (isRunPreparationError(error) && error.kind === "cancelled");
      runtime.ownershipLease?.release();
      runtime.ownershipLease = undefined;
      this.fileOwnership.releaseOwner(conversationId);
      if (runtime.isolatedWorktree) {
        await cleanupIsolatedWorktree(runtime.isolatedWorktree, storageRoot, (message) =>
          this.output.appendLine(message),
        );
        runtime.isolatedWorktree = undefined;
      }
      runtime.busy = false;
      if (runtime.preparationAbort === preparationAbort) {
        runtime.preparationAbort = undefined;
      }
      runtime.pendingCancel = false;
      runtime.mutating = false;
      runtime.overlappedMutation = false;
      runtime.isolationKind = undefined;
      if (!this.lifecycle.isDisposing) {
        this.retainFinishedParallelTask(
          conversationId,
          preparationCancelled ? "stopped" : "error",
        );
        this.postParallelState();
        if (!preparationCancelled) {
          this.postIfActive(conversationId, {
            type: "error",
            text: error instanceof Error ? error.message : String(error),
            recoveryActions: RUN_FAILURE_RECOVERY_ACTIONS,
          });
        }
        // Run was reserved then aborted during prep — drain any waiting messages.
        this.deferQueueDrain();
      }
      return true;
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
      ? prompt.trim()
        ? `/${projectCommand.id} ${prompt.trim()}`
        : `/${projectCommand.id}`
      : prompt;
    const userEntry: TranscriptEntry = {
      role: "user",
      text: contextLabel
        ? `${displayPrompt}\n\n[${localize("Attached", "添付")}: ${contextLabel}]`
        : displayPrompt,
      attachments:
        attachmentReferences.length > 0
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
    let resetInterruptedAgent = false;
    let interruptedRuntimeError:
      | { code: string | undefined; message: string }
      | undefined;
    const noteInterruptedRuntimeError = (error: unknown): void => {
      const errorRecord =
        typeof error === "object" && error !== null
          ? (error as { code?: unknown; message?: unknown })
          : undefined;
      const code = typeof errorRecord?.code === "string" ? errorRecord.code : undefined;
      const message =
        error instanceof Error
          ? error.message
          : typeof errorRecord?.message === "string"
            ? errorRecord.message
            : String(error);
      if (isLocalRuntimeWriteCancelled(code, message)) {
        interruptedRuntimeError = { code, message };
      }
    };
    runtime.live = {
      userEntry,
      assistantText,
      editedFiles,
      progressSteps,
      progressState,
    };
    if (runtime.isolatedWorktree) {
      const isolationNote =
        runtime.isolationKind === "windows-safe"
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

    if (runtime.pendingCancel) {
      preparationAbort.abort();
    }
    const configuredPreparationTimeout = this.alertConfiguration().get<number>(
      "runPreparationTimeoutSeconds",
      120,
    );
    const preparationTimeoutSeconds = Number.isFinite(configuredPreparationTimeout)
      ? Math.min(600, Math.max(15, configuredPreparationTimeout))
      : 120;
    const preparationTimeoutMs = preparationTimeoutSeconds * 1_000;
    const startupStep: ToolProgressEntry = {
      id: `run-startup-${conversationId}`,
      text: localize("Connecting to Cursor", "Cursorへ接続中"),
      status: "running",
    };
    const updateStartupStep = (
      text: string,
      status: ToolProgressEntry["status"] = "running",
    ): void => {
      startupStep.text = text;
      startupStep.status = status;
      progressSteps.set(startupStep.id, { ...startupStep });
      if (!this.lifecycle.isDisposing) {
        this.postIfActive(conversationId, {
          type: "toolStatus",
          callId: startupStep.id,
          text,
          status,
        });
      }
    };
    updateStartupStep(startupStep.text);

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
      const currentRootsKey = (): string =>
        [
          ...agentRoots.map((root) => path.resolve(root).toLowerCase()),
          this.integrationStateKey(conversation),
        ].join("\n");
      const disposeLateAgent = async (lateAgent: CursorAgent): Promise<void> => {
        try {
          const currentAgent = runtime.agent;
          if (currentAgent && currentAgent.agentId !== lateAgent.agentId) {
            conversation.agentId = currentAgent.agentId;
            await this.saveConversations();
          } else if (conversation.agentId === lateAgent.agentId) {
            conversation.agentId = undefined;
            await this.saveConversations();
          }
        } catch (cleanupError) {
          this.output.appendLine(
            `[${new Date().toISOString()}] Failed to persist late-agent cleanup: ${
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }`,
          );
        } finally {
          try {
            await lateAgent[Symbol.asyncDispose]();
          } catch (disposeError) {
            this.output.appendLine(
              `[${new Date().toISOString()}] Failed to dispose late agent: ${
                disposeError instanceof Error ? disposeError.message : String(disposeError)
              }`,
            );
          }
        }
      };
      const ensureAgentForCurrentTrust = async (): Promise<string> => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const desiredRootsKey = currentRootsKey();
          if (!runtime.agent || runtime.rootsKey !== desiredRootsKey) {
            if (runtime.agent) {
              updateStartupStep(localize("Resetting Cursor agent", "Cursor Agentを再初期化中"));
              await waitForRunPreparation(() => this.disposeAgent(conversationId), {
                signal: preparationAbort.signal,
                timeoutMs: preparationTimeoutMs,
                phase: "resetting the Cursor agent",
                onOperationSettled: (completion) =>
                  this.trackPreparationOperation(completion),
              });
            }
            updateStartupStep(localize("Connecting to Cursor", "Cursorへ接続中"));
            runtime.agent = await waitForRunPreparation(
              () => this.createOrResumeAgent(apiKey, agentRoots, workspace.name, conversation),
              {
                signal: preparationAbort.signal,
                timeoutMs: preparationTimeoutMs,
                phase: "connecting to Cursor",
                onLateResolve: disposeLateAgent,
                onOperationSettled: (completion) =>
                  this.trackPreparationOperation(completion),
              },
            );
            runtime.rootsKey = desiredRootsKey;
          }
          if (runtime.agent && runtime.rootsKey === currentRootsKey()) {
            return runtime.rootsKey;
          }
        }
        throw new Error(
          localize(
            "Workspace trust changed repeatedly while preparing the Cursor agent. Try again.",
            "Cursor Agentの準備中にワークスペースの信頼状態が繰り返し変更されました。再試行してください。",
          ),
        );
      };

      updateStartupStep(localize("Starting Cursor run", "Cursor Runを開始中"));
      const runModel = modelSelection ?? this.selectedModelSelection();
      let run: CursorRun;
      const sendRun = async (): Promise<CursorRun> => {
        const preparedRootsKey = await ensureAgentForCurrentTrust();
        const trustSnapshot = vscode.workspace.isTrusted;
        const currentProjectCommand =
          commandCandidate &&
          isPromptCommandAllowedForWorkspaceTrust(trustSnapshot, commandCandidate.source)
            ? commandCandidate
            : undefined;
        const currentEffectivePrompt = currentProjectCommand
          ? expandProjectCommand(currentProjectCommand, prompt)
          : prompt;
        if (!currentEffectivePrompt) {
          throw new Error(
            localize(
              "The selected project command is unavailable while the workspace is untrusted.",
              "選択したプロジェクトコマンドは、ワークスペースが未信頼の間は使用できません。",
            ),
          );
        }
        ({ composed } = this.composePrompt(
          currentEffectivePrompt,
          attachContext,
          attachmentReferences,
          profile,
          requestedSkills,
          editorContext,
          includeProjectMemory,
          workspace,
        ));
        const runMessage = images.length > 0 ? { text: composed, images } : composed;
        const runOptions = {
          model: runModel,
          mode: profile === "plan" ? ("plan" as const) : ("agent" as const),
          ...(runtime.forceNextRun ? { local: { force: true } } : {}),
        };
        return waitForRunPreparation(
          () => {
            if (
              !workspaceTrustSnapshotMatches(trustSnapshot, vscode.workspace.isTrusted) ||
              runtime.rootsKey !== preparedRootsKey ||
              preparedRootsKey !== currentRootsKey()
            ) {
              throw new Error(
                localize(
                  "Workspace trust changed before the Cursor run started. Try again.",
                  "Cursor Runの開始前にワークスペースの信頼状態が変更されました。再試行してください。",
                ),
              );
            }
            return runtime.agent!.send(runMessage, runOptions);
          },
          {
            signal: preparationAbort.signal,
            timeoutMs: preparationTimeoutMs,
            phase: "starting the Cursor run",
            onLateResolve: async (lateRun) => {
              if (lateRun.supports("cancel")) {
                await lateRun.cancel();
              }
            },
            onOperationSettled: (completion) =>
              this.trackPreparationOperation(completion),
          },
        );
      };
      try {
        run = await sendRun();
        assertPreparationActive("starting the Cursor run");
      } catch (error) {
        if (!this.isAgentBusyError(error)) {
          noteInterruptedRuntimeError(error);
          throw error;
        }
        this.output.appendLine(
          `[${new Date().toISOString()}] Recovering stale active run for agent ${
            runtime.agent?.agentId ?? conversation.agentId ?? "unknown"
          }.`,
        );
        updateStartupStep(localize("Recovering stalled Cursor run", "停止したCursor Runを復旧中"));
        const recoveryRootsKey = currentRootsKey();
        runtime.agent = await waitForRunPreparation(
          () =>
            this.recoverBusyAgent(runtime, apiKey, agentRoots, workspace.name, conversation, cwd),
          {
            signal: preparationAbort.signal,
            timeoutMs: preparationTimeoutMs,
            phase: "recovering a stalled Cursor run",
            onLateResolve: disposeLateAgent,
            onOperationSettled: (completion) =>
              this.trackPreparationOperation(completion),
          },
        );
        assertPreparationActive("recovering a stalled Cursor run");
        runtime.rootsKey = recoveryRootsKey === currentRootsKey() ? recoveryRootsKey : undefined;
        try {
          run = await sendRun();
          assertPreparationActive("restarting the Cursor run");
        } catch (error) {
          noteInterruptedRuntimeError(error);
          throw error;
        }
      }
      runtime.run = run;
      runtime.forceNextRun = false;
      if (runtime.pendingCancel && run.supports("cancel")) {
        runtime.pendingCancel = false;
        await run.cancel();
        assertPreparationActive("cancelling the Cursor run");
      }

      updateStartupStep(localize("Waiting for Cursor response", "Cursorの応答を待機中"));
      const eventStream = run.stream();
      const resultPromise = run.wait().catch((error: unknown) => {
        noteInterruptedRuntimeError(error);
        throw error;
      });
      const terminalSignal = resultPromise.then(async (result) => {
        // Give the stream a short grace period to deliver its final message.
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        return { type: "result" as const, result };
      });
      let result: RunResult | undefined;
      let waitingForFirstResponse = true;
      while (!result) {
        const nextOutcome = Promise.race([
          eventStream.next().then(
            (next) => ({ type: "event" as const, next }),
            (error: unknown) => ({ type: "streamError" as const, error }),
          ),
          terminalSignal,
        ]);
        const outcome = waitingForFirstResponse
          ? await waitForRunPreparation(() => nextOutcome, {
              signal: preparationAbort.signal,
              timeoutMs: preparationTimeoutMs,
              phase: "waiting for the first Cursor response",
              onLateResolve: () => {
                void eventStream.return(undefined).catch(() => {});
              },
              onOperationSettled: (completion) =>
                this.trackPreparationOperation(completion),
            })
          : await nextOutcome;
        assertPreparationActive("streaming the Cursor response");
        if (waitingForFirstResponse) {
          waitingForFirstResponse = false;
          updateStartupStep(localize("Cursor responded", "Cursorから応答あり"), "completed");
        }
        if (outcome.type === "result") {
          result = outcome.result;
          this.output.appendLine(
            `[${new Date().toISOString()}] Run ${run.id} reached ${result.status} before its event stream closed; finalizing from the run result.`,
          );
          void eventStream.return(undefined).catch(() => {});
          break;
        }
        if (outcome.type === "streamError") {
          noteInterruptedRuntimeError(outcome.error);
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
      assertPreparationActive("finalizing the Cursor run");
      if (
        result.status === "finished" &&
        editedFiles.size > 0 &&
        profile !== "plan" &&
        runtime.isolatedWorktree
      ) {
        try {
          await runConfiguredHooks(
            "postEdit",
            runtime.isolatedWorktree.worktreePath,
            this.output,
            preparationAbort.signal,
          );
          assertPreparationActive("running isolated post-edit hooks");
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
        const isExcluded = createExcludedPathMatcher(workspace.uri);
        const changes = await collectIsolatedChanges(session, storageRoot, {
          pathEscapeLabel: isolationPathLabel,
          isExcluded,
          missingBaselineMessage: (relative) =>
            localize(
              `The ${baselineLabel} baseline for ${relative} is unavailable.`,
              `${relative} の隔離チャットベースラインを利用できません。`,
            ),
        });
        assertPreparationActive("collecting isolated changes");
        const excludedChanges = changes.filter((change) => change.excluded);
        if (excludedChanges.length > 0) {
          const excludedSummary = localize(
            `${excludedChanges.length} sensitive path(s) were not applied:\n${excludedChanges
              .map((change) => `- ${change.relative}`)
              .join("\n")}`,
            `${excludedChanges.length}件の機微パスは適用しませんでした:\n${excludedChanges
              .map((change) => `- ${change.relative}`)
              .join("\n")}`,
          );
          assistantText = `${assistantText}\n\n${excludedSummary}`.trim();
          if (runtime.live) {
            runtime.live.assistantText = assistantText;
          }
          this.postIfActive(conversationId, { type: "chunk", text: `\n\n${excludedSummary}` });
        }
        const applyableChanges = changes.filter((change) => !change.excluded);
        if (bestOfNCandidate) {
          await this.cleanupBestOfNArtifact(conversationId);
          assertPreparationActive("preparing the isolated candidate");
          let candidateVerification: VerificationResult | undefined;
          if (
            applyableChanges.length > 0 &&
            this.featureEnabled("enableVerification") &&
            this.alertConfiguration().get<boolean>("autoVerify", true)
          ) {
            const verificationStep: ToolProgressEntry = {
              id: `bestofn-verification-${run.id}`,
              text: localize(
                "Running candidate verification in isolated worktree",
                "隔離worktreeで候補の検証を実行",
              ),
              status: "running",
            };
            progressSteps.set(verificationStep.id, verificationStep);
            this.postIfActive(conversationId, {
              type: "toolStatus",
              callId: verificationStep.id,
              text: verificationStep.text,
              status: "running",
            });
            candidateVerification = await runVerification(
              session.worktreePath,
              this.alertConfiguration().get<string[]>("verificationCommands", []),
              this.output,
              preparationAbort.signal,
            );
            assertPreparationActive("verifying the isolated candidate");
            verificationStep.status = candidateVerification.success ? "completed" : "error";
            const verificationSummary = this.formatVerificationSummary(candidateVerification);
            this.postIfActive(conversationId, {
              type: "toolStatus",
              callId: verificationStep.id,
              text: verificationSummary,
              status: verificationStep.status,
            });
            assistantText = `${assistantText}\n\n${verificationSummary}`.trim();
            if (runtime.live) {
              runtime.live.assistantText = assistantText;
            }
          }
          this.bestOfNArtifacts.set(conversationId, {
            session,
            changes: applyableChanges,
            root: workspaceRoot,
            verification: candidateVerification,
          });
          preserveIsolatedWorktree = true;
          const comparisonSummary = localize(
            `Prepared ${applyableChanges.length} isolated candidate change(s). When all candidates finish, a winner can be selected automatically; you can also pick one from history.`,
            `${applyableChanges.length}件の候補変更を隔離して準備しました。全候補の完了後に自動で勝者を選べます。履歴からの手動選択も可能です。`,
          );
          assistantText = `${assistantText}\n\n${comparisonSummary}`.trim();
          if (runtime.live) {
            runtime.live.assistantText = assistantText;
          }
          this.postIfActive(conversationId, { type: "chunk", text: `\n\n${comparisonSummary}` });
        } else {
          runtime.ownershipLease?.release();
          runtime.ownershipLease = undefined;
          const { applied, merged, conflicts } = await this.parallelApplyQueue.run(async () => {
            assertPreparationActive("waiting to apply isolated changes");
            const applyLease = await this.fileOwnership.acquire(conversationId, [
              path.join(workspaceRoot, ".cursor-parallel-workspace-owner"),
              ...applyableChanges.map((change) => path.join(workspaceRoot, change.relative)),
            ]);
            try {
              assertPreparationActive("applying isolated changes");
              return await applyIsolatedChanges(session, storageRoot, applyableChanges, {
                pathEscapeLabel: isolationPathLabel,
                unavailableMessage: localize(
                  "The isolated worktree is unavailable.",
                  "隔離worktreeを利用できません。",
                ),
                conflictMessage: localize(
                  "The workspace file changed after the isolated agent started. Review and merge it manually.",
                  "隔離Agent開始後にワークスペースのファイルが変更されています。手動で確認してマージしてください。",
                ),
                missingBaselineMessage: (relative) =>
                  localize(
                    `The ${baselineLabel} baseline for ${relative} is unavailable.`,
                    `${relative} の隔離チャットベースラインを利用できません。`,
                  ),
                autoMerge: runtime.overlappedMutation,
              });
            } finally {
              applyLease.release();
            }
          });
          assertPreparationActive("applying isolated changes");
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
              `${merged.length} concurrently edited file(s) were merged automatically:\n${merged
                .map((relative) => `- ${relative}`)
                .join("\n")}`,
              `${merged.length}件の並行編集ファイルを自動マージしました:\n${merged
                .map((relative) => `- ${relative}`)
                .join("\n")}`,
            );
            assistantText = assistantText ? `${assistantText}\n\n${mergeSummary}` : mergeSummary;
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
              rawPrompt: prompt,
              commandCandidate,
              agentRoots,
              priorAssistantText: assistantText,
              model: runModel,
              signal: preparationAbort.signal,
              pathEscapeLabel: isolationPathLabel,
              missingBaselineMessage: (relative) =>
                localize(
                  `The ${baselineLabel} baseline for ${relative} is unavailable.`,
                  `${relative} の隔離チャットベースラインを利用できません。`,
                ),
              progressSteps,
            });
            assertPreparationActive("resolving isolated-change conflicts");
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
            if (changeSessionId && editedFiles.size > 0) {
              await this.changeSessions.markPending([...editedFiles], changeSessionId);
              assertPreparationActive("saving isolated changes for review");
            }
          }
          if (remainingConflicts.length > 0) {
            const conflictSummary = localize(
              `${remainingConflicts.length} file(s) remain unresolved and were not applied:\n${remainingConflicts
                .map((item) => `- ${item.relative}: ${item.error}`)
                .join("\n")}`,
              `${remainingConflicts.length}ファイルの競合が未解決のため適用しませんでした:\n${remainingConflicts
                .map((item) => `- ${item.relative}: ${item.error}`)
                .join("\n")}`,
            );
            void vscode.window.showWarningMessage(
              localize(
                `${remainingConflicts.length} file(s) still have unresolved conflicts and were not applied.`,
                `${remainingConflicts.length}ファイルの競合が未解決のため適用しませんでした。`,
              ),
            );
            assistantText = assistantText
              ? `${assistantText}\n\n${conflictSummary}`
              : conflictSummary;
            if (runtime.live) {
              runtime.live.assistantText = assistantText;
            }
            this.postIfActive(conversationId, { type: "chunk", text: `\n\n${conflictSummary}` });
          }
        }
      } else if (profile !== "plan" && changeSessionId && !runtime.isolatedWorktree) {
        const changedFiles = await this.changeSessions.detectChangedFiles(
          [...editedFiles],
          changeSessionId,
          runtime.overlappedMutation,
        );
        assertPreparationActive("detecting changed files");
        editedFiles.clear();
        for (const changedFile of changedFiles) {
          editedFiles.add(changedFile);
          this.changeSessions.noteFile(changedFile, changeSessionId);
        }
      }
      if (result.usage) {
        conversation.tokenUsage = addTokenUsage(conversation.tokenUsage, result.usage);
        await this.recordUsage("chat", result.usage);
        assertPreparationActive("recording token usage");
      }
      if (result.status === "error") {
        const runtimeWriteCancelled = isLocalRuntimeWriteCancelled(
          result.error?.code,
          result.error?.message,
        );
        const requestedStop =
          runtimeWriteCancelled &&
          (preparationAbort.signal.aborted ||
            runtime.pendingCancel ||
            runtime.cancellation !== undefined);
        this.output.appendLine(
          `[${new Date().toISOString()}] Run ${result.id} failed: ${result.error?.code ?? "unknown"} ${result.error?.message ?? ""}`.trim(),
        );
        if (requestedStop) {
          // A Windows pipe write can lose the race with run.cancel() and arrive
          // as ECANCELED instead of the SDK's normal cancelled terminal state.
          progressState = "stopped";
          this.postIfActive(conversationId, { type: "cancelled" });
          if (!assistantText) {
            assistantText = localize("(Stopped)", "（停止しました）");
          }
        } else {
          failed = true;
          progressState = "error";
          resetInterruptedAgent = runtimeWriteCancelled;
          const errorText = this.formatRunFailure(result);
          this.postIfActive(conversationId, {
            type: "error",
            text: errorText,
            recoveryActions: RUN_FAILURE_RECOVERY_ACTIONS,
          });
          assistantText = assistantText ? `${assistantText}\n\n${errorText}` : errorText;
        }
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
        result.status === "finished" &&
        editedFiles.size > 0 &&
        profile !== "plan" &&
        !runtime.isolatedWorktree
      ) {
        try {
          await runConfiguredHooks(
            "postEdit",
            workspace.uri.fsPath,
            this.output,
            preparationAbort.signal,
          );
          assertPreparationActive("running post-edit hooks");
        } catch (error) {
          const text = error instanceof Error ? error.message : String(error);
          this.postIfActive(conversationId, { type: "error", text });
        }
      }

      if (result.status === "finished" && reviewEdits && editedFiles.size > 0) {
        await this.changeSessions.markPending([...editedFiles], changeSessionId);
        assertPreparationActive("saving edits for review");
        await this.reviewAutopilotEdits(changeSessionId);
        assertPreparationActive("reviewing edits");
        const identity = (file: string) =>
          process.platform === "win32" ? path.resolve(file).toLowerCase() : path.resolve(file);
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
        result.status === "finished" &&
        editedFiles.size > 0 &&
        !hasPendingReview &&
        !bestOfNCandidate &&
        this.featureEnabled("enableVerification") &&
        this.alertConfiguration().get<boolean>("autoVerify", true)
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
          preparationAbort.signal,
        );
        assertPreparationActive("running automatic verification");
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
        assistantText =
          `${assistantText}\n\n${this.formatVerificationSummary(verificationResult)}`.trim();

        if (verificationResult.success) {
          if (this.pendingPipelinePr) {
            const pipeline = this.pendingPipelinePr;
            this.pendingPipelinePr = undefined;
            void this.createPipelinePullRequest(
              pipeline.root,
              pipeline.title,
              buildPipelinePullRequestBody(
                pipeline.body,
                this.formatVerificationSummary(verificationResult),
              ),
              [...editedFiles],
            );
          } else if (!this.suppressPullRequestOffers.has(conversationId)) {
            void this.offerCreatePullRequest(workspace.uri.fsPath, conversation.title, [
              ...editedFiles,
            ]);
          }
        }

        const autoRepair =
          vscode.workspace.isTrusted &&
          this.featureEnabled("enableVerification") &&
          this.alertConfiguration().get<boolean>("autoRepair", false);
        const maxAttempts = this.alertConfiguration().get<number>("maxAutoRepairAttempts", 1);
        const persistedRepair = changeSessionId
          ? this.changeSessions.snapshot(changeSessionId)?.repair
          : undefined;
        const attempts = persistedRepair?.attempts ?? this.repairAttempts.get(conversationId) ?? 0;
        if (changeSessionId && verificationResult.success && attempts > 0) {
          this.changeSessions.setRepairBudget(
            {
              attempts,
              maxAttempts,
              status: "succeeded",
            },
            changeSessionId,
          );
        }
        if (!verificationResult.success && autoRepair && attempts < maxAttempts) {
          this.repairAttempts.set(conversationId, attempts + 1);
          const failures = verificationResult.steps
            .filter((step) => !step.success)
            .map((step) => `$ ${step.command}\n${step.output}`)
            .join("\n\n");
          if (changeSessionId) {
            this.changeSessions.setRepairBudget(
              {
                attempts: attempts + 1,
                maxAttempts,
                status: "repairing",
                lastFailure: failures.slice(0, 12_000),
              },
              changeSessionId,
            );
          }
          this.postIfActive(conversationId, {
            type: "toolStatus",
            callId: `repair-budget-${run.id}`,
            text: localize(
              `Automatic repair budget: ${attempts + 1}/${maxAttempts}`,
              `自動修復バジェット: ${attempts + 1}/${maxAttempts}`,
            ),
            status: "running",
          });
          await this.enqueueMessage(
            buildAutoRepairPrompt({
              attempt: attempts + 1,
              maxAttempts,
              failures,
              editedFiles: [...editedFiles],
            }),
            false,
            [],
            "agent",
            [],
            false,
            undefined,
            true,
            conversationId,
          );
          assertPreparationActive("queuing automatic repair");
        } else if (!verificationResult.success && autoRepair && changeSessionId) {
          const failures = verificationResult.steps
            .filter((step) => !step.success)
            .map((step) => `$ ${step.command}\n${step.output}`)
            .join("\n\n");
          this.changeSessions.setRepairBudget(
            {
              attempts,
              maxAttempts,
              status: "exhausted",
              lastFailure: failures.slice(0, 12_000),
            },
            changeSessionId,
          );
          this.postIfActive(conversationId, {
            type: "toolStatus",
            callId: `repair-budget-${run.id}`,
            text: localize(
              `Automatic repair budget exhausted (${attempts}/${maxAttempts}).`,
              `自動修復バジェットの上限に達しました (${attempts}/${maxAttempts})。`,
            ),
            status: "error",
          });
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
      const preparationFailure = isRunPreparationError(error) ? error : undefined;
      const runtimeInterruption = interruptedRuntimeError;
      const runtimeWriteCancelled = runtimeInterruption !== undefined;
      const requestedStop =
        runtimeWriteCancelled &&
        (preparationAbort.signal.aborted ||
          runtime.pendingCancel ||
          runtime.cancellation !== undefined);
      const wasCancelled =
        preparationFailure?.kind === "cancelled"
        || preparationAbort.signal.aborted
        || this.lifecycle.isDisposing
        || requestedStop;
      const timedOut = preparationFailure?.kind === "timeout";
      failed = !wasCancelled;
      progressState = wasCancelled ? "stopped" : "error";
      resetInterruptedAgent = runtimeWriteCancelled && !requestedStop;
      if (runtime.live) {
        runtime.live.progressState = progressState;
      }

      if (wasCancelled) {
        updateStartupStep(localize("Run stopped", "実行を停止しました"), "stopped");
      } else {
        updateStartupStep(
          timedOut
            ? localize("Cursor did not respond in time", "Cursorの応答がタイムアウトしました")
            : startupStep.text,
          "error",
        );
        this.output.appendLine(
          `[${new Date().toISOString()}] Cursor Agent error: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      if (timedOut || (wasCancelled && !runtime.run)) {
        const timedOutRun = runtime.run;
        const canCancelTimedOutRun = timedOutRun?.supports("cancel") === true;
        if (timedOutRun && canCancelTimedOutRun) {
          runtime.cancellation ??= timedOutRun.cancel();
        } else if (timedOutRun && runtime.agent) {
          const staleAgent = runtime.agent;
          runtime.agent = undefined;
          runtime.rootsKey = undefined;
          runtime.forceNextRun = false;
          conversation.agentId = undefined;
          runtime.cancellation ??= staleAgent[Symbol.asyncDispose]();
        }
        if (!timedOutRun && runtime.agent) {
          // send() may still be pending without having returned a Run handle.
          // Closing the agent is the only way to prove its executor is gone.
          const staleAgent = runtime.agent;
          runtime.agent = undefined;
          runtime.rootsKey = undefined;
          runtime.forceNextRun = false;
          conversation.agentId = undefined;
          runtime.cancellation ??= staleAgent[Symbol.asyncDispose]();
        } else if (
          timedOutRun &&
          canCancelTimedOutRun &&
          runtime.agent &&
          !runtime.isolatedWorktree
        ) {
          // Preserve conversation context, but force the SDK to expire any
          // persisted active run before accepting the next follow-up.
          runtime.forceNextRun = true;
        } else if (!runtime.agent) {
          runtime.rootsKey = undefined;
          conversation.agentId = undefined;
        }
      }

      const text = wasCancelled
        ? localize("(Stopped)", "（停止しました）")
        : timedOut
          ? localize(
              `Cursor did not respond within ${preparationTimeoutSeconds} seconds. The stalled run was discarded; check the network, VPN, proxy, or API key, then try again.`,
              `${preparationTimeoutSeconds}秒以内にCursorから応答がありませんでした。停止したRunは破棄しました。ネットワーク、VPN、プロキシ、APIキーを確認して再試行してください。`,
            )
          : runtimeWriteCancelled
            ? this.formatLocalRuntimeInterruption(
                runtimeInterruption.message,
                runtimeInterruption.code,
                runtime.run?.id,
                runtime.run?.requestId,
              )
            : error instanceof CursorAgentError
              ? localize(
                `Could not start the connection to Cursor: ${error.message}`,
                `Cursorへの接続を開始できませんでした: ${error.message}`,
              )
              : error instanceof Error
                ? error.message
                : String(error);
      if (!wasCancelled && !this.lifecycle.isDisposing) {
        this.postIfActive(conversationId, {
          type: "error",
          text,
          recoveryActions: RUN_FAILURE_RECOVERY_ACTIONS,
        });
      }
      if (!assistantText) {
        assistantText = text;
      }
    } finally {
      if (runtime.preparationAbort === preparationAbort) {
        runtime.preparationAbort = undefined;
      }
      const cancellation = runtime.cancellation;
      if (cancellation) {
        updateStartupStep(
          localize("Stopping the Cursor run", "Cursor Runの停止を待機中"),
          "running",
        );
        try {
          await this.waitForRunCleanup(cancellation, "stopping the Cursor run");
        } catch (cancellationError) {
          this.output.appendLine(
            `[${new Date().toISOString()}] Cursor run cancellation failed: ${
              cancellationError instanceof Error
                ? cancellationError.message
                : String(cancellationError)
            }`,
          );
          const agent = runtime.agent;
          if (agent) {
            updateStartupStep(
              localize("Closing the stalled Cursor agent", "停止したCursor Agentを終了中"),
              "running",
            );
            try {
              await this.waitForRunCleanup(
                agent[Symbol.asyncDispose](),
                "closing the stalled Cursor agent",
              );
              runtime.agent = undefined;
              runtime.rootsKey = undefined;
              runtime.forceNextRun = false;
              conversation.agentId = undefined;
            } catch (disposeError) {
              this.output.appendLine(
                `[${new Date().toISOString()}] Stalled agent could not be closed safely: ${
                  disposeError instanceof Error ? disposeError.message : String(disposeError)
                }`,
              );
              this.postIfActive(conversationId, {
                type: "error",
                text: localize(
                  "The stalled Cursor agent could not be stopped safely. Reload the VS Code window before starting another run.",
                  "停止したCursor Agentを安全に終了できませんでした。次のRunを開始する前にVS Codeウィンドウを再読み込みしてください。",
                ),
              });
              // Keep the runtime busy and retain file ownership. Starting a
              // second mutating run while this one may still be alive is unsafe.
              updateStartupStep(
                localize("Cursor agent requires reload", "Cursor Agentの再読み込みが必要です"),
                "error",
              );
              runningSound.dispose();
              // oxlint-disable-next-line eslint/no-unsafe-finally -- A failed safety cleanup must supersede the run result and force a window reload.
              throw disposeError;
            }
          } else {
            this.postIfActive(conversationId, {
              type: "error",
              text: localize(
                "The stalled Cursor run could not be stopped safely. Reload the VS Code window before starting another run.",
                "停止したCursor Runを安全に終了できませんでした。次のRunを開始する前にVS Codeウィンドウを再読み込みしてください。",
              ),
            });
            updateStartupStep(
              localize("Cursor run requires reload", "Cursor Runの再読み込みが必要です"),
              "error",
            );
            runningSound.dispose();
            // oxlint-disable-next-line eslint/no-unsafe-finally -- An unconfirmed cancellation must supersede the run result and force a window reload.
            throw cancellationError;
          }
        } finally {
          if (runtime.cancellation === cancellation) {
            runtime.cancellation = undefined;
          }
        }
      }
      runningSound.dispose();
      if (!this.lifecycle.isDisposing) {
        if (progressState === "completed") {
          this.runningSound.playCompletion();
        } else if (progressState === "error") {
          this.runningSound.playError();
        }
      }
      if (runtime.live) {
        runtime.live.assistantText = assistantText;
        runtime.live.progressState = progressState;
      }
      runtime.run = undefined;

      if (resetInterruptedAgent && runtime.agent && !runtime.isolatedWorktree) {
        // The run is terminal, so it is safe to drop only the SDK process
        // handle. Keep conversation.agentId: the next message resumes the
        // persisted conversation through a freshly spawned local runtime.
        const interruptedAgent = runtime.agent;
        runtime.agent = undefined;
        runtime.rootsKey = undefined;
        runtime.forceNextRun = false;
        try {
          await this.waitForRunCleanup(
            interruptedAgent[Symbol.asyncDispose](),
            "resetting the interrupted Cursor agent",
          );
          this.output.appendLine(
            `[${new Date().toISOString()}] Reset the local Cursor runtime after an ECANCELED write failure.`,
          );
        } catch (resetError) {
          // The stale handle is intentionally discarded even when its process
          // cannot acknowledge disposal; the next run must not reuse it.
          this.output.appendLine(
            `[${new Date().toISOString()}] Could not cleanly reset the interrupted Cursor agent: ${
              resetError instanceof Error ? resetError.message : String(resetError)
            }`,
          );
        }
      }

      const isolated = runtime.isolatedWorktree;
      runtime.isolatedWorktree = undefined;
      if (isolated) {
        const agent = runtime.agent;
        runtime.agent = undefined;
        runtime.rootsKey = undefined;
        if (agent) {
          try {
            await this.waitForRunCleanup(
              agent[Symbol.asyncDispose](),
              "closing the isolated Cursor agent",
            );
          } catch (error) {
            this.output.appendLine(
              `[${new Date().toISOString()}] Failed to dispose isolated agent: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
        if (!preserveIsolatedWorktree || this.lifecycle.isDisposing) {
          await cleanupIsolatedWorktree(isolated, storageRoot, (message) =>
            this.output.appendLine(message),
          );
        }
      }

      runtime.busy = false;
      runtime.pendingCancel = false;
      runtime.isolationKind = undefined;
      runtime.ownershipLease?.release();
      runtime.ownershipLease = undefined;
      this.fileOwnership.releaseOwner(conversationId);
      runtime.live = undefined;
      runtime.mutating = false;
      runtime.overlappedMutation = false;
      // Shutdown may deliberately stop waiting for a misbehaving SDK send.
      // Late completion must only release local resources; storage, UI, hooks,
      // and follow-up orchestration may already have been disposed.
      if (!this.lifecycle.isDisposing) {
        this.retainFinishedParallelTask(conversationId, progressState);
        this.clearOrchestratorActivity(conversationId);
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
            changeSessionId &&
            !verificationResult &&
            this.changeSessions.snapshot(changeSessionId)?.phase !== "complete"
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
          // Terminal state is recovery data, not merely tool-progress metadata.
          // Persist it even when the run emitted no tool steps.
          progressState,
        });
        conversation.updatedAt = Date.now();
        await this.saveConversations();
        if (!this.lifecycle.isDisposing) {
          if (!this.conversations.some((candidate) => candidate.id === conversationId)) {
            this.chatRuntimes.delete(conversationId);
          }
          if (this.showingHome) {
            this.postView();
          }
          if (profile === "plan" && progressState === "completed") {
            await this.captureExecutionPlan(effectivePrompt, conversationId, assistantText);
          }
          if (!this.lifecycle.isDisposing) {
            await this.handleOrchestratorConversationComplete(
              conversationId,
              progressState,
              assistantText,
            );
          }
          if (!this.lifecycle.isDisposing) {
            if (conversation.experimentGroupId) {
              void this.maybeAutoSelectBestOfNWinner(conversation.experimentGroupId);
            }
            this.notifyRunComplete(conversation, progressState);
            this.deferQueueDrain();
          }
        }
      } else if (this.chatRuntimes.get(conversationId) === runtime) {
        this.chatRuntimes.delete(conversationId);
      }
    }
    return true;
    } finally {
      finishSend();
    }
  }

  private async reviewAutopilotEdits(sessionId?: string): Promise<void> {
    const session = this.changeSessions.snapshot(sessionId);
    if (!session) {
      return;
    }
    const policy = this.alertConfiguration().get<"prompt" | "keep-all" | "restore-all">(
      "changeSessionReviewPolicy",
      "prompt",
    );
    if (policy === "keep-all" && vscode.workspace.isTrusted) {
      const files = this.changeSessions
        .pendingFiles(session.id)
        .map((file) => vscode.workspace.asRelativePath(file));
      this.changeSessions.keepAll(session.id);
      await this.recordAudit({
        action: "session.keepAll",
        summary: `Applied change-session keep-all policy (${files.length})`,
        files,
        sessionId: session.id,
      });
      return;
    }
    if (policy === "restore-all" && this.changeSessions.canRestorePending(session.id)) {
      const files = this.changeSessions
        .pendingFiles(session.id)
        .map((file) => vscode.workspace.asRelativePath(file));
      await this.changeSessions.restorePending(session.id);
      await this.recordAudit({
        action: "session.restoreAll",
        summary: `Applied change-session restore-all policy (${files.length})`,
        files,
        sessionId: session.id,
      });
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
      void vscode.commands.executeCommand("cursorSubscription.focusWorkspaceSessions");
      void vscode.window.showInformationMessage(
        localize(
          `${pending} AI-edited file(s) remain pending. Resolve them under Workspace → Sessions before verification.`,
          `${pending}件のAI編集が確認待ちです。検証前にワークスペース → Sessions で確定してください。`,
        ),
      );
    }
  }

  private async verifyAfterPendingReview(sessionId: string): Promise<void> {
    const current = this.changeSessions.snapshot(sessionId);
    if (
      !current ||
      this.changeSessions.pendingFiles(sessionId).length > 0 ||
      this.verifyingSessions.has(sessionId)
    ) {
      return;
    }
    if (this.changeSessions.keptFiles(sessionId).length === 0) {
      this.changeSessions.setPhase("complete", sessionId);
      return;
    }
    if (
      this.featureEnabled("enableVerification") &&
      this.alertConfiguration().get<boolean>("autoVerify", true)
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
    const logsLabel = localize("Open Logs", "ログを開く");
    const retryLabel = localize("Retry", "再試行");
    const diagnosticsLabel = localize("Export diagnostics", "診断をエクスポート");
    const runCenterLabel = localize("Open Run Center", "Run Centerを開く");
    const title = conversation.title || localize("Chat", "チャット");
    const message =
      progressState === "error"
        ? localize(`Cursor Agent failed: ${title}`, `Cursor Agentが失敗しました: ${title}`)
        : localize(`Cursor Agent finished: ${title}`, `Cursor Agentが完了しました: ${title}`);

    const show =
      progressState === "error"
        ? vscode.window.showErrorMessage(
            message,
            openLabel,
            retryLabel,
            diagnosticsLabel,
            runCenterLabel,
            logsLabel,
          )
        : vscode.window.showInformationMessage(message, openLabel);

    void show.then(async (answer) => {
      if (answer === logsLabel) {
        await vscode.commands.executeCommand("cursorSubscription.openOutput");
        return;
      }
      if (answer === diagnosticsLabel) {
        await vscode.commands.executeCommand("cursorSubscription.exportDiagnostics");
        return;
      }
      if (answer === runCenterLabel) {
        await vscode.commands.executeCommand("cursorSubscription.openRunCenter");
        return;
      }
      if (answer === retryLabel) {
        await this.openConversation(conversation.id);
        await this.retryLastRun();
        return;
      }
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

  private formatLocalRuntimeInterruption(
    message: string | undefined,
    code: string | undefined,
    runId?: string,
    requestId?: string,
  ): string {
    const rawDetail = message?.trim();
    const detail = rawDetail?.replace(/^\[[^\]]+\]\s*/, "");
    return [
      localize(
        "The connection to the local Cursor runtime was interrupted. The extension will reconnect automatically on the next run; try the message again.",
        "ローカルのCursor Runtimeとの接続が中断されました。次の実行時に自動で再接続するため、メッセージをもう一度送信してください。",
      ),
      detail ? `${localize("Details", "詳細")}: ${detail}` : undefined,
      code ? `${localize("Error code", "エラーコード")}: ${code}` : undefined,
      requestId ? `Request: ${requestId}` : undefined,
      runId ? `Run: ${runId}` : undefined,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }

  private formatRunFailure(result: RunResult): string {
    const rawDetail = result.error?.message?.trim();
    const detail = rawDetail?.replace(/^\[[^\]]+\]\s*/, "");
    const searchable = `${result.error?.code ?? ""} ${detail ?? ""}`.toLowerCase();
    let summary: string;

    const blockedProxy = detectBlockedProxyEnvironment();
    if (blockedProxy) {
      return [this.formatBlockedProxyError(blockedProxy), `Run: ${result.id}`].join("\n");
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
    } else if (isLocalRuntimeWriteCancelled(result.error?.code, detail)) {
      return this.formatLocalRuntimeInterruption(
        detail,
        result.error?.code,
        result.id,
        result.requestId,
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
      result.requestId ? `Request: ${result.requestId}` : undefined,
      `Run: ${result.id}`,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
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

  private projectGuidanceInstruction(
    workspace: vscode.WorkspaceFolder | undefined,
    includeProjectMemory: boolean,
  ): string | undefined {
    if (!workspace || !shouldUseWorkspacePromptIntegrations(vscode.workspace.isTrusted)) {
      return undefined;
    }
    const disabled = this.disabledIntegrationIds();
    const integrationEnabled = (kind: string, relative: string): boolean =>
      isWorkspaceIntegrationEnabled(
        disabled, kind, workspace.uri.toString(),
        vscode.Uri.joinPath(workspace.uri, ...relative.split("/")).fsPath,
        workspace.name, relative,
      );
    const allowMemory =
      includeProjectMemory &&
      this.featureEnabled("enableProjectMemory") &&
      this.alertConfiguration().get<boolean>("includeProjectMemory", true);
    const allowed: string[] = [];
    const blocked: string[] = [];
    if (!integrationEnabled("rules", ".cursor/rules.md")) {
      blocked.push(".cursor/rules.md");
    } else {
      allowed.push(".cursor/rules.md");
    }
    if (!integrationEnabled("memory", ".cursor/project-memory.md")) {
      blocked.push(".cursor/project-memory.md");
    } else if (allowMemory) {
      allowed.push(".cursor/project-memory.md");
    }
    const disabledSkills = [...this.skillIntegrationIdsByName.entries()]
      .filter(([, ids]) => {
        const workspaceSkillIds = ids.filter((item) => item.folderUri === workspace.uri.toString());
        return workspaceSkillIds.length > 0
          && workspaceSkillIds.every((item) => disabled.has(item.id) || disabled.has(item.legacyId));
      })
      .map(([name]) => name)
      .sort();
    if (disabledSkills.length > 0) {
      blocked.push(`skills: ${disabledSkills.join(", ")}`);
    }
    if (allowed.length === 0 && blocked.length === 0) {
      return undefined;
    }
    return [
      allowed.length > 0
        ? `If present, read and follow only these enabled project guidance files before acting: ${allowed.join(", ")}. Never write secrets to project memory.`
        : undefined,
      blocked.length > 0
        ? `Do not read or use these disabled project integrations: ${blocked.join(", ")}.`
        : undefined,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
  }

  private composePrompt(
    prompt: string,
    attachContext: boolean,
    attachedFiles: AttachedFileReference[],
    profile: RunProfile,
    requestedSkills: string[],
    editorContext?: EditorContextSnapshot,
    includeProjectMemory = true,
    workspace?: vscode.WorkspaceFolder,
  ): { composed: string; contextLabel?: string } {
    const profileInstruction: Partial<Record<RunProfile, string>> = {
      plan: [
        "Create a concrete implementation plan. Do not edit files or run mutating commands.",
        "End with a machine-readable JSON array of independently executable steps, each with title and prompt:",
        "<CURSOR_EXECUTION_PLAN>",
        '[{"title":"Step title","prompt":"Complete implementation instruction for this step"}]',
        "</CURSOR_EXECUTION_PLAN>",
        "Order steps so each can run after the previous step and keep each step small enough for a safe checkpoint.",
      ].join("\n"),
      multitask:
        "Split independent work into parallel workstreams and delegate them to the available specialist subagents when useful. Integrate and verify their results.",
    };
    const trustFilteredSkills = filterRequestedSkillsForWorkspaceTrust(
      vscode.workspace.isTrusted,
      requestedSkills,
    );
    const skills = [...new Set(trustFilteredSkills)]
      .filter((skill) => skill.length > 0 && skill.length <= 80)
      .filter((skill) => this.isRequestedSkillEnabled(skill, workspace))
      .slice(0, 10);
    const memoryInstruction = this.projectGuidanceInstruction(workspace, includeProjectMemory);
    const intentReference = [
      profileInstruction[profile],
      memoryInstruction,
      skills.length > 0
        ? "Use these Cursor skills for this request when applicable: " + skills.join(", ") + "."
        : undefined,
    ]
      .filter((line): line is string => Boolean(line))
      .join("\n");
    const effectivePrompt = intentReference ? intentReference + "\n\n" + prompt : prompt;
    const fileReference =
      attachedFiles.length > 0
        ? [
            "The user explicitly attached these files. Read them as needed before responding:",
            ...attachedFiles.map((file) =>
              file.external
                ? `- ${file.displayPath} (read-only staged copy: ${file.agentPath})`
                : `- ${file.agentPath}`,
            ),
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
        ]
          .filter(Boolean)
          .join("\n"),
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
      ]
        .filter(Boolean)
        .join("\n"),
      contextLabel: `${relative} L${startLine}-L${endLine}`,
    };
  }

  private async searchWorkspaceFiles(query: string, requestId: number): Promise<void> {
    const normalizedQuery = query.trim().toLowerCase().replaceAll("\\", "/");
    const workspaceFiles = await this.getWorkspaceFiles();
    const files = workspaceFiles
      .filter((file) => !normalizedQuery || file.path.toLowerCase().includes(normalizedQuery))
      .sort(
        (a, b) =>
          this.fileMatchScore(a, normalizedQuery) - this.fileMatchScore(b, normalizedQuery) ||
          a.path.localeCompare(b.path),
      )
      .slice(0, 12);

    this.post({ type: "fileResults", requestId, files });
  }

  private scheduleWorkspaceIndexRefresh(): void {
    if (this.lifecycle.isDisposing) {
      return;
    }
    const generation = ++this.workspaceIndexGeneration;
    this.workspaceFileCache = undefined;
    this.workspaceFileCacheKey = undefined;
    if (this.workspaceIndexRefreshTimer) {
      clearTimeout(this.workspaceIndexRefreshTimer);
    }
    this.workspaceIndexRefreshTimer = setTimeout(() => {
      this.workspaceIndexRefreshTimer = undefined;
      if (this.lifecycle.isDisposing) {
        return;
      }
      void Promise.all([
        this.publishWorkspaceFileIndex(generation),
        this.publishIntegrationIndex(generation),
      ]).catch((error) => {
        this.output.appendLine(
          `[${new Date().toISOString()}] Could not refresh the workspace index: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
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
      return;
    }
    // Always reply so the webview can clear its pending-attachment gate on cancel.
    this.post({ type: "resolvedAttachments", requestId, files: [] });
  }

  private async resolveAttachmentReferences(
    references: string[],
    requestId: number,
    uploads: DroppedFileUpload[] = [],
  ): Promise<void> {
    const workspace = resolveWorkspaceFolder() ?? vscode.workspace.workspaceFolders?.[0];
    const hasWorkspaceFolders = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
    // Clipboard uploads stage under globalStorage and do not require a workspace.
    // Path references still need an open folder when nothing was uploaded.
    if (!workspace && !hasWorkspaceFolders && uploads.length === 0) {
      this.post({ type: "resolvedAttachments", requestId, files: [] });
      void vscode.window.showWarningMessage(
        localize(
          "Open a workspace folder to attach dropped files.",
          "ドロップしたファイルを添付するには、ワークスペースフォルダーを開いてください。",
        ),
      );
      return;
    }

    const preferred = workspace;
    const workspaceFiles = preferred ? await this.getWorkspaceFiles() : [];
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
      const workspaceAbsolute = await resolveAbsoluteInWorkspaceResolved(candidatePath, preferred);
      const absolute = workspaceAbsolute ?? (isAbsolute ? path.resolve(candidatePath) : undefined);
      let item: WorkspaceFileItem | undefined;

      if (absolute) {
        try {
          const stat = await vscode.workspace.fs.stat(vscode.Uri.file(absolute));
          if ((stat.type & vscode.FileType.File) !== 0) {
            const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(absolute));
            const normalized = (
              folder ? vscode.workspace.asRelativePath(vscode.Uri.file(absolute), true) : absolute
            ).replaceAll("\\", "/");
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
      void vscode.window.showWarningMessage(
        localize(
          `${rejected} file(s) could not be attached because they were unavailable or no longer exist.`,
          `${rejected}件のファイルを添付できませんでした。ファイルが利用できないか、既に存在しない可能性があります。`,
        ),
      );
    }
  }

  private integrationStateKey(conversation: Conversation): string {
    const trustKey = workspaceTrustIntegrationKey(vscode.workspace.isTrusted);
    const workspace = this.resolveChatWorkspace(conversation);
    if (!workspace) {
      return `integrations:${trustKey}:none`;
    }
    const selection = workspaceIntegrationSelection({
      disabledIds: this.disabledIntegrationIds(),
      folderUri: workspace.uri.toString(),
      folderName: workspace.name,
      mcpPath: vscode.Uri.joinPath(workspace.uri, ".cursor", "mcp.json").fsPath,
    });
    return `integrations:${trustKey}:${selection.key}`;
  }

  private async agentIntegrationOptions(conversation: Conversation): Promise<{
    settingSources: SettingSource[];
    mcpServers?: Record<string, McpServerConfig>;
  }> {
    const workspace = this.resolveChatWorkspace(conversation);
    const isWorkspaceTrusted = vscode.workspace.isTrusted;
    if (!isWorkspaceTrusted || !workspace) {
      return resolveAgentIntegrationPolicy({
        isWorkspaceTrusted,
        hasWorkspace: workspace !== undefined,
        hasDisabledWorkspaceIntegrations: false,
      });
    }
    const disabled = this.disabledIntegrationIds();
    const selection = workspaceIntegrationSelection({
      disabledIds: disabled,
      folderUri: workspace.uri.toString(),
      folderName: workspace.name,
      mcpPath: vscode.Uri.joinPath(workspace.uri, ".cursor", "mcp.json").fsPath,
    });
    const hasDisabledWorkspaceIntegrations = selection.disabledIds.length > 0;
    if (!hasDisabledWorkspaceIntegrations) {
      return resolveAgentIntegrationPolicy({
        isWorkspaceTrusted,
        hasWorkspace: true,
        hasDisabledWorkspaceIntegrations,
      });
    }
    let mcpServers: Record<string, McpServerConfig> | undefined;
    if (selection.mcpEnabled) {
      try {
        const mcpUri = vscode.Uri.joinPath(workspace.uri, ".cursor", "mcp.json");
        const parsed = JSON.parse(
          Buffer.from(await vscode.workspace.fs.readFile(mcpUri)).toString("utf8"),
        ) as { mcpServers?: unknown };
        if (
          parsed.mcpServers &&
          typeof parsed.mcpServers === "object" &&
          !Array.isArray(parsed.mcpServers)
        ) {
          mcpServers = parsed.mcpServers as Record<string, McpServerConfig>;
        }
      } catch {
        // Invalid or missing MCP configuration remains visible in the editor.
      }
    }
    return resolveAgentIntegrationPolicy({
      // Re-read trust after the MCP file I/O so a trust transition cannot
      // expose the parsed workspace configuration to the SDK.
      isWorkspaceTrusted: vscode.workspace.isTrusted,
      hasWorkspace: true,
      hasDisabledWorkspaceIntegrations,
      workspaceMcpServers: mcpServers,
    });
  }

  private async createOrResumeAgent(
    apiKey: string,
    roots: string[],
    workspaceName: string,
    conversation: Conversation,
  ): Promise<CursorAgent> {
    let integrations = await this.agentIntegrationOptions(conversation);
    const isWorkspaceTrusted = vscode.workspace.isTrusted;
    if (!isWorkspaceTrusted) {
      // Apply the trust boundary again immediately before the SDK call in case
      // trust changed while a workspace MCP file was being read.
      integrations = resolveAgentIntegrationPolicy({
        isWorkspaceTrusted: false,
        hasWorkspace: roots.length > 0,
        hasDisabledWorkspaceIntegrations: false,
      });
    }
    const resumableAgentId = resumableAgentIdForWorkspaceTrust(
      isWorkspaceTrusted,
      conversation.agentId,
    );
    if (conversation.agentId !== resumableAgentId) {
      conversation.agentId = resumableAgentId;
      await this.saveConversations();
    }
    const integrationBoundaryKey = this.integrationStateKey(conversation);
    const assertIntegrationBoundary = (): void => {
      if (
        !workspaceTrustSnapshotMatches(isWorkspaceTrusted, vscode.workspace.isTrusted) ||
        integrationBoundaryKey !== this.integrationStateKey(conversation)
      ) {
        throw new Error(
          localize(
            "Workspace trust or project integrations changed while connecting to Cursor. Try again.",
            "Cursorへの接続中にワークスペースの信頼状態またはプロジェクト統合が変更されました。再試行してください。",
          ),
        );
      }
    };
    return this.agentFactory.createOrResume({
      apiKey,
      roots,
      workspaceName,
      conversation,
      ...integrations,
      assertIntegrationBoundary,
    });
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
    rawPrompt: string;
    commandCandidate?: ProjectCommand;
    agentRoots: string[];
    priorAssistantText: string;
    model?: ModelSelection;
    signal?: AbortSignal;
    pathEscapeLabel: string;
    missingBaselineMessage: (relative: string) => string;
    progressSteps: Map<string, ToolProgressEntry>;
  }): Promise<{
    resolved: string[];
    unresolved: Array<{ relative: string; error: string }>;
    text: string;
  }> {
    const assertActive = (phase: string): void => {
      if (!this.lifecycle.isDisposing && !input.signal?.aborted) {
        return;
      }
      throw new RunPreparationError("cancelled", phase);
    };
    assertActive("preparing AI conflict resolution");
    const prepared: PreparedAiConflict[] = [];
    const unresolved: Array<{ relative: string; error: string }> = [];
    const originalByPath = new Map(
      input.conflicts.map((conflict) => [conflict.relative, conflict]),
    );
    for (const conflict of input.conflicts) {
      try {
        assertActive("preparing AI conflict resolution");
        const candidate = await prepareAiConflictResolution(
          input.session,
          input.storageRoot,
          conflict.relative,
          {
            pathEscapeLabel: input.pathEscapeLabel,
            missingBaselineMessage: input.missingBaselineMessage,
          },
        );
        assertActive("preparing AI conflict resolution");
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
        assertActive("preparing AI conflict resolution");
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
    assertActive("confirming AI conflict resolution");
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

    try {
      assertActive("starting AI conflict resolution");
      const trustSnapshot = vscode.workspace.isTrusted;
      const desiredRootsKey = [
        ...input.agentRoots.map((root) => path.resolve(root).toLowerCase()),
        this.integrationStateKey(input.conversation),
      ].join("\n");
      const expectedBoundary = {
        isWorkspaceTrusted: trustSnapshot,
        rootsKey: desiredRootsKey,
        agentId: input.conversation.agentId,
      };
      const currentBoundary = () => ({
        isWorkspaceTrusted: vscode.workspace.isTrusted,
        rootsKey: input.runtime.rootsKey,
        agentId: input.runtime.agent?.agentId,
      });
      if (!agentSendBoundaryMatches(expectedBoundary, currentBoundary())) {
        throw new Error(
          localize(
            "Workspace trust or the Cursor agent changed before AI conflict resolution. The conflicts were left unresolved.",
            "AI競合解決の前にワークスペースの信頼状態またはCursor Agentが変更されました。競合は未解決のまま残しました。",
          ),
        );
      }
      if (
        input.commandCandidate?.source === "project" &&
        !isPromptCommandAllowedForWorkspaceTrust(trustSnapshot, input.commandCandidate.source)
      ) {
        throw new Error(
          localize(
            "AI conflict resolution cannot reuse a project command while the workspace is untrusted.",
            "ワークスペースが未信頼の間は、AI競合解決でプロジェクトコマンドを再利用できません。",
          ),
        );
      }
      const currentOriginalPrompt = input.commandCandidate
        ? expandProjectCommand(input.commandCandidate, input.rawPrompt)
        : input.rawPrompt;
      const prompt = [
        "Resolve the overlapping three-way merge conflicts in the files listed below.",
        "Each file contains standard conflict markers. `workspace` is the other agent or user's current edit; `parallel-agent` is your proposed edit.",
        "Infer the intent of both sides, preserve compatible behavior from both, and remove every conflict marker.",
        "Edit only the listed conflicted files. Do not commit, delete files, or modify unrelated files.",
        "After editing, re-read each listed file and ensure no conflict markers remain.",
        "",
        "Original request for this agent:",
        currentOriginalPrompt,
        "",
        "Conflicted files:",
        listedFiles,
      ].join("\n");
      const resolutionRun = await (() => {
        assertActive("starting AI conflict resolution");
        if (!agentSendBoundaryMatches(expectedBoundary, currentBoundary())) {
          throw new Error(
            localize(
              "Workspace trust or the Cursor agent changed before AI conflict resolution started.",
              "AI競合解決の開始前にワークスペースの信頼状態またはCursor Agentが変更されました。",
            ),
          );
        }
        return input.runtime.agent!.send(prompt, {
          model: input.model,
          mode: "agent",
        });
      })();
      assertActive("starting AI conflict resolution");
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
        assertActive("streaming AI conflict resolution");
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
      assertActive("finalizing AI conflict resolution");
      if (result.usage) {
        input.conversation.tokenUsage = addTokenUsage(input.conversation.tokenUsage, result.usage);
        await this.recordUsage("chat", result.usage);
        assertActive("recording AI conflict-resolution usage");
      }
      if (result.status !== "finished") {
        const error =
          result.status === "error"
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
          assertActive("applying AI conflict resolution");
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
          assertActive("applying AI conflict resolution");
          resolved.push(candidate.relative);
        } catch (error) {
          assertActive("applying AI conflict resolution");
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
      assertActive("handling AI conflict resolution");
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

    const id =
      typeof tool.call_id === "string" ? tool.call_id : `${tool.name}-${progressSteps.size}`;
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

    if (status === "running" && this.resolveOrchestratorActivityTarget(conversationId)) {
      const filePath = extractFilePaths(tool.args)[0];
      let relativePath: string | undefined;
      if (filePath) {
        const absolute = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
        const displayPath = isolatedWorktree
          ? mapWorktreePathToRoot(absolute, isolatedWorktree)
          : absolute;
        relativePath = vscode.workspace.asRelativePath(displayPath);
      }
      this.postOrchestratorActivity(conversationId, {
        text,
        path: relativePath,
      });
    }

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
      const subagentName = extractSubagentName(args);
      action = subagentName
        ? localize("Running subagent", "サブエージェントを実行") + `: ${subagentName}`
        : localize("Running subagent", "サブエージェントを実行");
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
      const command = [record.command, record.cmd, record.script].find(
        (value): value is string => typeof value === "string" && value.length > 0,
      );
      if (command) {
        const compact = command.replace(/\s+/g, " ").trim();
        return `${action}: ${compact.length > 90 ? `${compact.slice(0, 87)}…` : compact}`;
      }
    }

    return action;
  }

  private async openDiff(filePath: string): Promise<void> {
    const workspace = this.resolveChatWorkspace() ?? resolveWorkspaceFolder();
    const absolute = await resolveAbsoluteInWorkspaceResolved(filePath, workspace);
    if (!absolute || !vscode.workspace.getWorkspaceFolder(vscode.Uri.file(absolute))) {
      void vscode.window.showWarningMessage(
        localize(
          "The diff target is outside the open workspace and was not opened.",
          "差分対象がワークスペース外のため開きませんでした。",
        ),
      );
      return;
    }
    const uri = vscode.Uri.file(absolute);
    try {
      await vscode.commands.executeCommand("git.openChange", uri);
    } catch {
      await vscode.window.showTextDocument(uri, { preview: true });
    }
  }

  private async openFile(filePath: string): Promise<void> {
    const workspaceAbsolute = await resolveAbsoluteInWorkspaceResolved(
      filePath,
      resolveWorkspaceFolder(),
    );
    // Clipboard/picker images are staged under globalStorage outside the workspace.
    const absolute = normalizeAttachedFilePath(filePath, workspaceAbsolute);
    if (!absolute) {
      void vscode.window.showWarningMessage(
        localize(`Could not open file: ${filePath}`, `ファイルを開けませんでした: ${filePath}`),
      );
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
        void vscode.window.showWarningMessage(
          localize(`Could not open file: ${filePath}`, `ファイルを開けませんでした: ${filePath}`),
        );
        return;
      }
    }

    try {
      await vscode.commands.executeCommand("vscode.open", uri);
    } catch {
      void vscode.window.showWarningMessage(
        localize(`Could not open file: ${filePath}`, `ファイルを開けませんでした: ${filePath}`),
      );
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

    const exactAbsolute = await resolveAbsoluteInWorkspaceResolved(
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
        const absolute = await resolveAbsoluteInWorkspaceResolved(file.path);
        if (absolute) {
          candidates.push(vscode.Uri.file(absolute));
        }
      }
    }

    if (candidates.length === 0) {
      void vscode.window.showWarningMessage(
        localize(
          `No workspace file matches: ${requestedPath}`,
          `一致するワークスペースファイルがありません: ${requestedPath}`,
        ),
      );
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
    const selection =
      line === undefined
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

  private async waitForRunCleanup(operation: Promise<void>, phase: string): Promise<void> {
    const configured = this.alertConfiguration().get<number>("runPreparationTimeoutSeconds", 120);
    // Cleanup can take as long as run preparation; never hard-cap below 60s
    // so a slow cancel/dispose is not mistaken for a stuck agent.
    const configuredMs = Number.isFinite(configured)
      ? Math.max(60_000, configured * 1_000)
      : 120_000;
    await waitForRunPreparation(() => operation, {
      // Preparation cancellation is already signalled on this path. Cleanup
      // needs its own live signal and the configured preparation deadline.
      signal: new AbortController().signal,
      timeoutMs: configuredMs,
      phase,
    });
  }

  private async cancelConversation(conversationId: string, clearQueue = true): Promise<void> {
    if (clearQueue) {
      const next = removeQueuedMessages(
        this.messageQueue,
        (item) => item.conversationId === conversationId,
      );
      this.messageQueue.splice(0, this.messageQueue.length, ...(next as QueuedMessage[]));
      this.postQueueState();
    }
    const runtime = this.chatRuntimes.get(conversationId);
    if (runtime?.busy) {
      runtime.preparationAbort?.abort();
    }
    const run = runtime?.run;
    if (!run || !run.supports("cancel")) {
      if (runtime?.busy) {
        runtime.pendingCancel = true;
      }
      return;
    }
    runtime.pendingCancel = false;
    runtime.cancellation ??= run.cancel();
  }

  private async cancelAllChats(clearQueues = true): Promise<void> {
    const conversationIds = [...this.chatRuntimes.keys()];
    await Promise.all(conversationIds.map((id) => this.cancelConversation(id, clearQueues)));
  }

  private trackPreparationOperation(operation: Promise<void>): void {
    this.pendingPreparationOperations.add(operation);
    void operation.then(
      () => this.pendingPreparationOperations.delete(operation),
      () => this.pendingPreparationOperations.delete(operation),
    );
  }

  private async waitForShutdownOperation(
    operation: Promise<unknown>,
    label: string,
  ): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      operation.then(
        () => ({ kind: "completed" as const }),
        (error: unknown) => ({ kind: "failed" as const, error }),
      ),
      new Promise<{ kind: "timeout" }>((resolve) => {
        timer = setTimeout(
          () => resolve({ kind: "timeout" }),
          SHUTDOWN_CLEANUP_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
    if (timer) {
      clearTimeout(timer);
    }
    if (outcome.kind === "failed") {
      this.output.appendLine(
        `[${new Date().toISOString()}] Shutdown cleanup failed while ${label}: ${
          outcome.error instanceof Error ? outcome.error.message : String(outcome.error)
        }`,
      );
    } else if (outcome.kind === "timeout") {
      this.output.appendLine(
        `[${new Date().toISOString()}] Shutdown cleanup timed out while ${label}.`,
      );
    }
  }

  private async waitForPendingPreparationOperations(): Promise<void> {
    if (this.pendingPreparationOperations.size === 0) {
      return;
    }
    await this.waitForShutdownOperation(
      Promise.allSettled(this.pendingPreparationOperations),
      "waiting for late Cursor runtime cleanup",
    );
  }

  private async disposeAgentsForShutdown(): Promise<void> {
    const disposals: Promise<void>[] = [];
    for (const [id, runtime] of this.chatRuntimes) {
      const agent = runtime.agent;
      runtime.agent = undefined;
      runtime.rootsKey = undefined;
      if (agent) {
        // Normalize synchronous throws as a rejected promise so one broken
        // SDK handle cannot prevent the remaining agents from being cleaned up.
        const disposal = Promise.resolve().then(() => agent[Symbol.asyncDispose]());
        disposals.push(
          this.waitForShutdownOperation(
            disposal,
            `disposing Cursor agent for conversation ${id}`,
          ),
        );
      }
      if (!runtime.busy) {
        this.chatRuntimes.delete(id);
      }
    }
    await Promise.allSettled(disposals);
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
    return (
      error instanceof AgentBusyError ||
      (error instanceof Error && /already has active run/i.test(error.message))
    );
  }

  private async recoverBusyAgent(
    runtime: ChatRuntime,
    apiKey: string,
    agentRoots: string[],
    workspaceName: string,
    conversation: Conversation,
    cwd: string,
  ): Promise<CursorAgent> {
    const agent = runtime.agent;
    const agentId = agent?.agentId ?? conversation.agentId;
    if (agent && agentId) {
      try {
        const runs = await Agent.listRuns(agentId, { runtime: "local", cwd });
        const activeRun = [...runs.items]
          .reverse()
          .find((candidate) => candidate.status === "running");
        if (activeRun) {
          await Agent.cancelRun(activeRun.id, { runtime: "local", cwd });
          await agent.reload();
          return agent;
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
    return this.createOrResumeAgent(apiKey, agentRoots, workspaceName, conversation);
  }

  public async refreshIntegrationIndex(): Promise<void> {
    // Existing SDK agents may already have launched the now-disabled MCPs.
    // A changed policy must not wait for the next user message to take effect.
    await this.cancelAllChats();
    await this.disposeAgent();
    const generation = ++this.workspaceIndexGeneration;
    await this.publishIntegrationIndex(generation);
  }

  private disabledIntegrationIds(): Set<string> {
    const state = this.context.workspaceState.get<IntegrationToggleState>(INTEGRATION_TOGGLE_KEY);
    return new Set(state?.disabledIds ?? []);
  }

  private isRequestedSkillEnabled(skill: string, workspace?: vscode.WorkspaceFolder): boolean {
    const ids = this.skillIntegrationIdsByName.get(skill);
    if (!ids) {
      return true;
    }
    const scopedIds = workspace
      ? ids.filter((item) => item.folderUri === workspace.uri.toString())
      : ids;
    const disabled = this.disabledIntegrationIds();
    return scopedIds.length === 0
      || scopedIds.some((item) => !disabled.has(item.id) && !disabled.has(item.legacyId));
  }

  private async publishUserPromptIntegrations(generation: number): Promise<void> {
    const userCommands = await loadProjectCommands([]);
    if (generation !== this.workspaceIndexGeneration) {
      return;
    }
    this.skillIntegrationIdsByName.clear();
    this.projectCommands = filterEnabledProjectCommands(
      userCommands,
      this.disabledIntegrationIds(),
    );
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
  }

  private async publishIntegrationIndex(generation = this.workspaceIndexGeneration): Promise<void> {
    if (generation !== this.workspaceIndexGeneration) {
      return;
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0 || !shouldUseWorkspacePromptIntegrations(vscode.workspace.isTrusted)) {
      await this.publishUserPromptIntegrations(generation);
      return;
    }
    const disabledIntegrationIds = this.disabledIntegrationIds();

    const skillsByName = new Map<string, { name: string; description?: string }>();
    const skillIdsByName = new Map<string, { id: string; legacyId: string; folderUri: string }[]>();
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
          const name =
            /^name:\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(source)?.[1]?.trim() ?? fallbackName;
          const description = /^description:\s*["']?([^"'\r\n]+)["']?\s*$/m
            .exec(source)?.[1]
            ?.trim();
          const integrationId = integrationToggleId("skill", workspace.uri.toString(), uri.fsPath);
          const legacyId = legacyIntegrationToggleId("skill", workspace.name, fallbackName);
          const ids = skillIdsByName.get(name) ?? [];
          ids.push({ id: integrationId, legacyId, folderUri: workspace.uri.toString() });
          skillIdsByName.set(name, ids);
          if (!disabledIntegrationIds.has(integrationId)
            && !disabledIntegrationIds.has(legacyId) && !skillsByName.has(name)) {
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
      if (!isWorkspaceIntegrationEnabled(
        disabledIntegrationIds, "mcp", workspace.uri.toString(), mcpUri.fsPath,
        workspace.name, "mcp.json",
      )) {
        continue;
      }
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
    if (!shouldUseWorkspacePromptIntegrations(vscode.workspace.isTrusted)) {
      await this.publishUserPromptIntegrations(generation);
      return;
    }
    this.skillIntegrationIdsByName.clear();
    for (const [name, ids] of skillIdsByName) {
      this.skillIntegrationIdsByName.set(name, ids);
    }
    this.projectCommands = filterEnabledProjectCommands(projectCommands, disabledIntegrationIds);
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
    const workspace =
      resolveWorkspaceFolder() ??
      (await pickWorkspaceFolder(
        localize("Select a workspace for Skills", "Skills用のワークスペースを選択"),
      ));
    if (!workspace) {
      return;
    }
    const uri = vscode.Uri.file(
      await safeResolvePathResolved(workspace.uri.fsPath, ".cursor/skills"),
    );
    await vscode.workspace.fs.createDirectory(uri);
    await vscode.commands.executeCommand("revealInExplorer", uri);
  }

  private async openMcpSettings(): Promise<void> {
    const workspace =
      resolveWorkspaceFolder() ??
      (await pickWorkspaceFolder(
        localize("Select a workspace for MCP settings", "MCP設定用のワークスペースを選択"),
      ));
    if (!workspace) {
      return;
    }
    const directory = vscode.Uri.file(
      await safeResolvePathResolved(workspace.uri.fsPath, ".cursor"),
    );
    const uri = vscode.Uri.file(
      await safeResolvePathResolved(workspace.uri.fsPath, ".cursor/mcp.json"),
    );
    await vscode.workspace.fs.createDirectory(directory);
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      await vscode.workspace.fs.writeFile(uri, Buffer.from('{\n  "mcpServers": {}\n}\n', "utf8"));
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

  public async showSetupChecklist(): Promise<void> {
    await this.context.workspaceState.update(SETUP_CHECKLIST_DISMISSED_KEY, false);
    await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    await this.publishSetupChecklistState();
  }

  private async confirmSetupChecklistStep(stepId: string): Promise<void> {
    if (stepId === "permissions") {
      await this.context.workspaceState.update(SETUP_CHECKLIST_PERMISSIONS_CONFIRMED_KEY, true);
    } else if (stepId === "gh") {
      await this.context.workspaceState.update(SETUP_CHECKLIST_GH_SKIPPED_KEY, true);
    }
    await this.publishSetupChecklistState();
  }

  private async runSetupChecklistAction(actionId: string): Promise<void> {
    switch (actionId) {
      case "apiKey":
        await this.promptForApiKey();
        break;
      case "gitWorkspace": {
        const folders = vscode.workspace.workspaceFolders ?? [];
        if (folders.length === 0) {
          await vscode.commands.executeCommand("workbench.action.files.openFolder");
        } else if (folders.length > 1) {
          await this.pickChatWorkspaceFolder();
        } else {
          const ready = await this.hasGitWorkspace();
          if (!ready) {
            void vscode.window.showInformationMessage(
              localize(
                "Open a Git repository folder for Safe worktree, Supervisor, and checkpoint features. This unofficial extension is not affiliated with Anysphere / Cursor.",
                "安全worktree・Supervisor・チェックポイント機能のため、Gitリポジトリのフォルダーを開いてください。この非公式拡張機能は Anysphere / Cursor 非提携です。",
              ),
            );
          }
        }
        await this.publishSetupChecklistState();
        break;
      }
      case "permissions":
        this.post({ type: "focusApprovalModeMenu" });
        break;
      case "workspaceTrust":
        if (!vscode.workspace.isTrusted) {
          try {
            await vscode.commands.executeCommand("workbench.trust.manage");
          } catch {
            try {
              await vscode.commands.executeCommand("workbench.action.manageTrust");
            } catch {
              void vscode.window.showInformationMessage(
                localize(
                  "Trust this workspace from the Restricted Mode banner or status bar to enable autonomous automation.",
                  "自律自動化を使うには、Restricted Mode のバナーまたはステータスバーからこのワークスペースを信頼してください。",
                ),
              );
            }
          }
        }
        await this.publishSetupChecklistState();
        break;
      case "gh":
        await this.publishSetupChecklistState({ forceGhProbe: true });
        break;
      case "openGhSettings":
        await vscode.commands.executeCommand(
          "workbench.action.openSettings",
          "cursorSubscription.supervisorGitHubTrigger",
        );
        break;
      case "openDashboard":
        await vscode.env.openExternal(vscode.Uri.parse("https://cursor.com/dashboard"));
        break;
      default:
        break;
    }
  }

  private async hasGitWorkspace(): Promise<boolean> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (folders.length === 0) {
      return false;
    }
    try {
      const git = await getGitApi();
      if (!git) {
        return false;
      }
      return folders.some((folder) => Boolean(git.getRepository(folder.uri)));
    } catch {
      return false;
    }
  }

  private async detectGhCli(force = false): Promise<boolean> {
    const now = Date.now();
    if (!force && this.ghCliAvailabilityCache && now - this.ghCliAvailabilityCache.at < 60_000) {
      return this.ghCliAvailabilityCache.value;
    }
    const cwd =
      resolveWorkspaceFolder()?.uri.fsPath ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      process.cwd();
    let available = false;
    try {
      await runExecutableCommand("gh", ["--version"], {
        cwd,
        timeout: 5_000,
        maxBuffer: 64 * 1024,
        env: githubCliEnv(),
      });
      available = true;
    } catch {
      available = false;
    }
    this.ghCliAvailabilityCache = { value: available, at: now };
    return available;
  }

  private async buildCurrentSetupChecklistState(options?: {
    forceGhProbe?: boolean;
  }): Promise<SetupChecklistState> {
    const dismissed = this.context.workspaceState.get<boolean>(
      SETUP_CHECKLIST_DISMISSED_KEY,
      false,
    );
    const apiKeyConfigured = Boolean(await this.context.secrets.get(API_KEY_SECRET));
    const hasWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
    const gitReady = await this.hasGitWorkspace();
    const permissionsConfirmed = this.context.workspaceState.get<boolean>(
      SETUP_CHECKLIST_PERMISSIONS_CONFIRMED_KEY,
      false,
    );
    const approvalMode = this.selectedApprovalMode();
    // Require an explicit confirm (or mode change, which sets the flag) so the
    // Windows default alone does not auto-complete the permissions step.
    const ghSkipped = this.context.workspaceState.get<boolean>(
      SETUP_CHECKLIST_GH_SKIPPED_KEY,
      false,
    );
    const ghAvailable = await this.detectGhCli(options?.forceGhProbe === true);
    return buildSetupChecklistState({
      dismissed,
      apiKeyConfigured,
      workspaceTrusted: vscode.workspace.isTrusted,
      hasWorkspace,
      gitReady,
      permissionsConfirmed,
      approvalMode,
      ghSkipped,
      ghAvailable,
      sandboxSupported: SUPPORTS_LOCAL_SANDBOX,
    });
  }

  private async publishSetupChecklistState(options?: { forceGhProbe?: boolean }): Promise<void> {
    const state = await this.buildCurrentSetupChecklistState(options);
    this.lastSetupChecklistState = state;
    if (!this.webviewReady) {
      return;
    }
    this.post({
      type: "setupChecklistState",
      ...state,
    });
  }

  private async handleRecoveryAction(action: RecoveryActionId): Promise<void> {
    switch (action) {
      case "retry":
        await this.retryLastRun();
        break;
      case "diagnostics":
        await vscode.commands.executeCommand("cursorSubscription.exportDiagnostics");
        break;
      case "runCenter":
        await vscode.commands.executeCommand("cursorSubscription.openRunCenter");
        break;
      case "logs":
        await vscode.commands.executeCommand("cursorSubscription.openOutput");
        break;
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
      models = [
        {
          id: "composer-2.5",
          label: "composer-2.5",
          parameters: [],
          variants: [],
        },
      ];
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

  private post(message: HostToWebviewMessage): void {
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
