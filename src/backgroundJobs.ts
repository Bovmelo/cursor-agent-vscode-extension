import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { ModelParameterValue, ModelSelection } from "@cursor/sdk";
import * as vscode from "vscode";
import type { BackgroundJob, BackgroundWorkerInput } from "./backgroundJobTypes.js";
import {
  FileBackgroundJobRepository,
  type BackgroundJobRepository,
} from "./backgroundJobRepository.js";
import { nextBackgroundJobPollDelay } from "./backgroundJobScheduler.js";
import {
  isActiveBackgroundJobStatus,
  reduceBackgroundJobState,
  type BackgroundJobStateEvent,
} from "./backgroundJobState.js";
import { hardStopBackgroundWorkerProcess, inspectBackgroundProcess } from "./backgroundProcess.js";
import {
  backgroundWorkerProtocolPaths,
  cancellationInvalidatesCompletedResult,
  decideBackgroundWorkerRecovery,
  isAuthenticatedWorkerCancellation,
  isAuthenticatedWorkerHeartbeat,
  isAuthenticatedWorkerHeartbeatIdentity,
  isAuthenticatedWorkerInstance,
  type BackgroundWorkerCancellationReason,
  type BackgroundWorkerCancellation,
  type BackgroundWorkerHeartbeat,
} from "./backgroundWorkerProtocol.js";
import {
  cleanupIsolatedWorktree,
  collectIsolatedChanges,
  prepareIsolatedWorktree,
  type IsolatedChange,
} from "./isolatedWorktree.js";
import { runConfiguredHooks } from "./hooks.js";
import { createExcludedPathMatcher } from "./sensitivePaths.js";
import { minimalShellEnv } from "./shellEnv.js";
import { managedWorktreesRoot } from "./worktreeLifecycle.js";
import { pickWorkspaceFolder } from "./workspaceFolder.js";

const API_KEY_SECRET = "cursorSubscription.apiKey";
const MODEL_KEY = "cursorSubscription.model";
const MODEL_PARAMS_KEY = "cursorSubscription.modelParams";
const APPROVAL_MODE_KEY = "cursorSubscription.approvalMode";
const DEADLINE_ERROR = "The background agent exceeded its execution-time budget.";
const UNRESPONSIVE_ERROR =
  "The detached background worker stopped responding before reporting a result.";
const WORKSPACE_TRUST_ERROR =
  "The background agent stopped because the workspace is no longer trusted.";
const BACKGROUND_WORKTREES_HOME_SEGMENT = ".cursor-background/worktrees";
const APPLY_RECOVERY_ERROR =
  "Applying background changes failed after workspace mutation began. Automatic retry is disabled; inspect the workspace and discard the background job when recovery is complete.";
const INTERRUPTED_APPLY_RECOVERY_ERROR =
  "The extension host stopped while background changes were being applied. The workspace may have been modified. Automatic retry is disabled; inspect the workspace and discard the background job when recovery is complete.";

interface LaunchedBackgroundWorker {
  token: string;
  child: ChildProcess;
}

interface BackgroundNode {
  job: BackgroundJob;
  kind: "job" | "summary";
  label: string;
  description?: string;
}

interface BackgroundPollResult {
  changed: boolean;
  requiresSupervision: boolean;
}

interface BackgroundRecoveryResult {
  changed: boolean;
  requiresSupervision: boolean;
}

export type ApplyBackgroundJob = (
  job: BackgroundJob,
  changes: readonly IsolatedChange[],
) => Promise<void>;
export type AuditBackgroundJob = (
  job: BackgroundJob,
  action: "background.cancel" | "background.discard",
) => Promise<void>;

export class BackgroundJobsController
  implements vscode.TreeDataProvider<BackgroundNode>, vscode.Disposable
{
  private readonly changed = new vscode.EventEmitter<BackgroundNode | undefined>();
  private readonly jobs = new Map<string, BackgroundJob>();
  private readonly stopRequestQueues = new Map<
    string,
    Promise<BackgroundWorkerCancellation | undefined>
  >();
  private readonly activeJobOperations = new Set<string>();
  private readonly launchedWorkers = new Map<string, LaunchedBackgroundWorker>();
  private readonly recoveryWarnings = new Set<string>();
  private readonly jobsRoot: string;
  private readonly storageRoot: vscode.Uri;
  private readonly repository: BackgroundJobRepository;
  private readonly windowStateSubscription: vscode.Disposable;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private pollInFlight = false;
  private pollAgain = false;
  private forceNextPoll = false;
  private unchangedPolls = 0;
  private requiresSupervision = false;
  private windowActive: boolean;
  private initialized = false;
  private disposed = false;
  public readonly onDidChangeTreeData = this.changed.event;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly japanese: boolean,
    private readonly applyJob: ApplyBackgroundJob,
    private readonly auditJob: AuditBackgroundJob,
  ) {
    this.storageRoot = context.storageUri ?? context.globalStorageUri;
    this.jobsRoot = path.join(this.storageRoot.fsPath, "background-jobs");
    this.repository = new FileBackgroundJobRepository(this.jobsRoot, {
      storageRoot: this.storageRoot.fsPath,
      worktreesRoot: managedWorktreesRoot(BACKGROUND_WORKTREES_HOME_SEGMENT),
    });
    this.windowActive = vscode.window.state.active;
    this.windowStateSubscription = vscode.window.onDidChangeWindowState((state) => {
      this.windowActive = state.active;
      this.unchangedPolls = 0;
      this.requestPoll(false);
    });
    void this.initialize()
      .catch((error) => {
        this.output.appendLine(
          `[${new Date().toISOString()}] Could not initialize background jobs: ${String(error)}`,
        );
      })
      .finally(() => {
        this.initialized = true;
        this.schedulePoll(this.forceNextPoll ? 0 : undefined);
      });
  }

  public dispose(): void {
    this.disposed = true;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    // Detached workers intentionally outlive the extension host unless
    // cancelAllRunning is invoked (e.g. API key revocation).
    this.windowStateSubscription.dispose();
    this.changed.dispose();
  }

  public async cancelAllRunning(): Promise<void> {
    const running = [...this.jobs.values()].filter((job) =>
      ["starting", "running"].includes(job.status),
    );
    await Promise.all(running.map((job) => this.cancel(job.id)));
  }

  public refresh(): void {
    this.unchangedPolls = 0;
    this.requestPoll(true);
  }

  public snapshots(): readonly BackgroundJob[] {
    return [...this.jobs.values()]
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .map((job) => structuredClone(job));
  }

  public async create(): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(
        this.text(
          "Background agents require a trusted workspace.",
          "バックグラウンドAgentには信頼済みワークスペースが必要です。",
        ),
      );
      return;
    }
    const apiKey = await this.context.secrets.get(API_KEY_SECRET);
    if (!apiKey) {
      void vscode.window.showWarningMessage(
        this.text(
          "Set the Cursor API key before starting a background agent.",
          "バックグラウンドAgentの開始前にCursor APIキーを設定してください。",
        ),
      );
      return;
    }
    const workspace = await pickWorkspaceFolder(
      this.text(
        "Select a workspace for the background agent",
        "バックグラウンドAgentのワークスペースを選択",
      ),
    );
    if (!workspace) {
      return;
    }
    const prompt = await vscode.window.showInputBox({
      title: this.text("Start background agent", "バックグラウンドAgentを開始"),
      prompt: this.text(
        "Describe the long-running task. Changes remain isolated until you apply them.",
        "長時間実行するタスクを入力してください。変更は適用するまで隔離されます。",
      ),
      ignoreFocusOut: true,
    });
    if (!prompt?.trim()) {
      return;
    }
    const running = [...this.jobs.values()].filter((job) =>
      ["starting", "running"].includes(job.status),
    );
    const maximum = vscode.workspace
      .getConfiguration("cursorSubscription", workspace.uri)
      .get<number>("maxBackgroundJobs", 2);
    if (running.length >= maximum) {
      void vscode.window.showWarningMessage(
        this.text(
          `The limit of ${maximum} running background job(s) has been reached.`,
          `実行中バックグラウンドジョブの上限 ${maximum} 件に達しています。`,
        ),
      );
      return;
    }

    if (!vscode.workspace.isTrusted) {
      throw new Error(WORKSPACE_TRUST_ERROR);
    }

    await mkdir(this.jobsRoot, { recursive: true });
    const id = randomUUID();
    const session = await prepareIsolatedWorktree({
      id,
      root: workspace.uri.fsPath,
      storageRoot: this.storageRoot,
      worktreesHomeSegment: BACKGROUND_WORKTREES_HOME_SEGMENT,
      baselinesFolder: "background-baselines",
      pathEscapeLabel: "background agent",
      isExcluded: createExcludedPathMatcher(workspace.uri),
      beforeCaptureBaseline: (worktreePath) => {
        if (!vscode.workspace.isTrusted) {
          throw new Error(WORKSPACE_TRUST_ERROR);
        }
        return runConfiguredHooks("preEdit", worktreePath, this.output);
      },
      onLog: (message) => this.output.appendLine(message),
    });
    const jobFile = path.join(this.jobsRoot, `${id}.json`);
    const now = Date.now();
    const maxMinutes = vscode.workspace
      .getConfiguration("cursorSubscription", workspace.uri)
      .get<number>("backgroundMaxRunMinutes", 240);
    const job: BackgroundJob = {
      id,
      title: prompt.trim().split(/\r?\n/u)[0].slice(0, 80),
      prompt: prompt.trim(),
      workspaceRoot: workspace.uri.fsPath,
      storageRoot: this.storageRoot.fsPath,
      jobFile,
      session,
      status: "starting",
      createdAt: now,
      updatedAt: now,
      workerToken: randomUUID(),
      maxMinutes,
    };
    this.jobs.set(id, job);
    await this.save(job);
    try {
      const workspaceTrustedAtLaunch = vscode.workspace.isTrusted;
      if (!workspaceTrustedAtLaunch) {
        throw new Error(WORKSPACE_TRUST_ERROR);
      }
      this.launch(job, {
        apiKey,
        model: this.selectedModel(),
        approvalMode: this.context.globalState.get<string>(APPROVAL_MODE_KEY, "auto-review"),
        maxMinutes,
        workspaceTrustedAtLaunch,
      });
      this.changed.fire(undefined);
      void vscode.window.showInformationMessage(
        this.text(
          "Background agent started. It will keep running if this VS Code window closes.",
          "バックグラウンドAgentを開始しました。VS Codeを閉じても実行を継続します。",
        ),
      );
    } catch (error) {
      this.applyStateTransition(job, {
        type: "launch-failed",
        error: error instanceof Error ? error.message : String(error),
      });
      await this.save(job);
      throw error;
    }
  }

  public async apply(target?: BackgroundNode | string): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(
        this.text(
          "Applying background-agent changes requires a trusted workspace.",
          "バックグラウンドAgentの変更を適用するには、信頼済みワークスペースが必要です。",
        ),
      );
      return;
    }
    let job = this.resolve(target);
    if (!job || job.status !== "completed") {
      return;
    }
    if (!this.beginJobOperation(job.id)) {
      return;
    }
    try {
      job = await this.repository.read(job.jobFile);
      this.jobs.set(job.id, job);
      if (job.status !== "completed") {
        return;
      }
      await this.recoverWorker(job);
      if (job.status !== "completed") {
        this.changed.fire(undefined);
        return;
      }
      if (!(await this.isWorkerExitConfirmed(job))) {
        void vscode.window.showWarningMessage(
          this.text(
            "The background worker is still finishing, so its changes cannot be applied yet. Try again after it exits.",
            "バックグラウンドワーカーは終了処理中のため、変更をまだ適用できません。終了後に再試行してください。",
          ),
        );
        return;
      }
      await this.repository.validateOperationalBoundaries(job);
      let cancellationRequested = false;
      if (job.workerToken) {
        try {
          const cancellation = JSON.parse(
            await readFile(backgroundWorkerProtocolPaths(job.jobFile).cancellation, "utf8"),
          ) as BackgroundWorkerCancellation;
          cancellationRequested = cancellationInvalidatesCompletedResult(
            job.workerToken,
            cancellation,
          );
        } catch {
          // No authenticated cancellation request exists, so the completed result is applyable.
        }
      }
      if (cancellationRequested) {
        this.applyStateTransition(job, { type: "cancel", reason: "user" });
        await this.save(job);
        this.changed.fire(undefined);
        return;
      }
      if (!this.applyStateTransition(job, { type: "begin-apply" })) {
        return;
      }
      await this.save(job);
      this.changed.fire(undefined);
      let applyStarted = false;
      let changesApplied = false;
      try {
        const isExcluded = createExcludedPathMatcher(vscode.Uri.file(job.workspaceRoot));
        const changes = await collectIsolatedChanges(job.session, this.storageRoot, {
          pathEscapeLabel: "background agent",
          isExcluded,
          missingBaselineMessage: (relative) =>
            `Background baseline is unavailable for ${relative}.`,
        });
        const applyable = changes.filter((change) => !change.excluded);
        if (applyable.length === 0) {
          throw new Error(
            this.text(
              "No non-excluded changes were available to apply.",
              "適用可能な（除外されていない）変更がありません。",
            ),
          );
        }
        // The callback spans workspace mutations and post-apply bookkeeping.
        // A rejected promise cannot prove that its best-effort rollback completed.
        applyStarted = true;
        await this.applyJob(job, applyable);
        changesApplied = true;
        this.applyStateTransition(job, { type: "apply-succeeded" });
        await this.save(job);
        await cleanupIsolatedWorktree(job.session, this.storageRoot, (message) =>
          this.output.appendLine(message),
        );
        await this.cleanupWorkerProtocol(job);
      } catch (error) {
        const originalError = error instanceof Error ? error.message : String(error);
        const errorMessage =
          applyStarted && !changesApplied
            ? `${APPLY_RECOVERY_ERROR}\n\n${originalError}`
            : originalError;
        this.applyStateTransition(job, {
          type: changesApplied
            ? "applied-cleanup-failed"
            : applyStarted
              ? "apply-uncertain"
              : "apply-failed",
          error: errorMessage,
        });
        await this.save(job);
        void vscode.window.showErrorMessage(errorMessage);
      }
      this.changed.fire(undefined);
    } finally {
      this.finishJobOperation(job.id);
      // A post-apply persistence failure can leave the durable record at
      // `applying`; reconcile it as soon as this host-owned operation ends.
      this.requestPoll(false);
    }
  }

  public async cancel(target?: BackgroundNode | string): Promise<void> {
    let job = this.resolve(target);
    if (!job || !["starting", "running"].includes(job.status)) {
      return;
    }
    if (!this.beginJobOperation(job.id)) {
      return;
    }
    try {
      job = await this.repository.read(job.jobFile);
      this.jobs.set(job.id, job);
      if (!isActiveBackgroundJobStatus(job.status)) {
        return;
      }
      await this.requestWorkerStop(job, "user");
      this.applyStateTransition(job, { type: "cancel", reason: "user" });
      await this.save(job);
      await this.auditJob(job, "background.cancel");
      this.changed.fire(undefined);
    } finally {
      this.finishJobOperation(job.id);
    }
  }

  /** Retry cleanup only after changes were durably recorded as applied. */
  public async cleanupApplied(target?: BackgroundNode | string): Promise<void> {
    let job = this.resolve(target);
    if (!job || job.status !== "applied") {
      return;
    }
    if (!this.beginJobOperation(job.id)) {
      return;
    }
    try {
      job = await this.repository.read(job.jobFile);
      this.jobs.set(job.id, job);
      if (job.status !== "applied") {
        return;
      }
      await this.recoverWorker(job);
      if (job.status !== "applied") {
        this.changed.fire(undefined);
        return;
      }
      if (!(await this.isWorkerExitConfirmed(job))) {
        void vscode.window.showWarningMessage(
          this.text(
            "The background worker is still finishing, so applied-job cleanup cannot run yet. Try again after it exits.",
            "バックグラウンドワーカーは終了処理中のため、適用済みジョブをまだクリーンアップできません。終了後に再試行してください。",
          ),
        );
        return;
      }
      try {
        await this.repository.validateOperationalBoundaries(job);
        await cleanupIsolatedWorktree(job.session, this.storageRoot, (message) =>
          this.output.appendLine(message),
        );
        await this.cleanupWorkerProtocol(job);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.applyStateTransition(job, {
          type: "applied-cleanup-failed",
          error: errorMessage,
        });
        await this.save(job);
        void vscode.window.showErrorMessage(errorMessage);
        this.changed.fire(undefined);
        return;
      }
      this.applyStateTransition(job, { type: "applied-cleanup-succeeded" });
      await this.save(job);
      void vscode.window.showInformationMessage(
        this.text(
          "Applied background-job artifacts were cleaned up.",
          "適用済みバックグラウンドジョブの成果物をクリーンアップしました。",
        ),
      );
      this.changed.fire(undefined);
    } finally {
      this.finishJobOperation(job.id);
    }
  }

  public async discard(target?: BackgroundNode | string): Promise<void> {
    let job = this.resolve(target);
    if (!job || ["starting", "running", "applying", "applied", "discarded"].includes(job.status)) {
      return;
    }
    if (!this.beginJobOperation(job.id)) {
      return;
    }
    try {
      job = await this.repository.read(job.jobFile);
      this.jobs.set(job.id, job);
      if (["starting", "running", "applying", "applied", "discarded"].includes(job.status)) {
        return;
      }
      await this.recoverWorker(job);
      if (["starting", "running", "applying", "applied", "discarded"].includes(job.status)) {
        return;
      }
      if (!(await this.isWorkerExitConfirmed(job))) {
        void vscode.window.showWarningMessage(
          this.text(
            "The background worker is still stopping, so its worktree cannot be discarded yet. Try again after it exits.",
            "バックグラウンドワーカーは停止処理中のため、worktreeをまだ破棄できません。終了後に再試行してください。",
          ),
        );
        return;
      }
      await this.repository.validateOperationalBoundaries(job);
      await cleanupIsolatedWorktree(job.session, this.storageRoot, (message) =>
        this.output.appendLine(message),
      );
      await this.cleanupWorkerProtocol(job);
      this.applyStateTransition(job, { type: "discard" });
      await this.save(job);
      await this.auditJob(job, "background.discard");
      this.changed.fire(undefined);
    } finally {
      this.finishJobOperation(job.id);
    }
  }

  public getTreeItem(node: BackgroundNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      node.kind === "job"
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.description = node.description;
    item.contextValue = `cursorBackground.${node.kind}.${node.job.status}`;
    item.iconPath = new vscode.ThemeIcon(this.icon(node.job.status));
    item.tooltip = [node.job.prompt, node.job.error, node.job.assistantText]
      .filter(Boolean)
      .join("\n\n");
    return item;
  }

  public getChildren(node?: BackgroundNode): BackgroundNode[] {
    if (!node) {
      return [...this.jobs.values()]
        .sort((left, right) => right.createdAt - left.createdAt)
        .map((job) => ({
          kind: "job",
          job,
          label: job.title,
          description: `${this.statusLabel(job.status)} · ${new Date(job.updatedAt).toLocaleString()}`,
        }));
    }
    if (node.kind !== "job") {
      return [];
    }
    return [
      {
        kind: "summary",
        job: node.job,
        label:
          node.job.error ||
          node.job.assistantText?.split(/\r?\n/u)[0].slice(0, 180) ||
          this.text("Waiting for the agent…", "Agentの完了を待機中…"),
        description: node.job.workspaceRoot,
      },
    ];
  }

  private async initialize(): Promise<void> {
    await this.repository.initialize();
    for (const loaded of await this.repository.list()) {
      if (loaded.ok) {
        this.jobs.set(loaded.job.id, loaded.job);
      } else {
        this.output.appendLine(
          `[${new Date().toISOString()}] Could not restore background job ${path.basename(loaded.jobFile)}: ${String(loaded.error)}`,
        );
      }
    }
    if (!vscode.workspace.isTrusted) {
      for (const job of this.jobs.values()) {
        if (!["starting", "running"].includes(job.status)) {
          continue;
        }
        const cancellation = await this.requestWorkerStop(job, "orphan");
        if (cancellation) {
          await this.synchronizeCancellationStatus(job, cancellation);
        }
      }
    }
    const result = await this.poll(true);
    this.requiresSupervision = result.requiresSupervision;
  }

  private async poll(forceRefresh = false): Promise<BackgroundPollResult> {
    let changed = forceRefresh;
    let requiresSupervision = false;
    for (const [id, known] of this.jobs) {
      try {
        const current = await this.repository.read(known.jobFile);
        const interruptedApplyRecovered = await this.recoverInterruptedApply(current);
        const recovered = await this.recoverWorker(current);
        requiresSupervision ||= recovered.requiresSupervision;
        if (current.updatedAt !== known.updatedAt || current.status !== known.status) {
          this.jobs.set(id, current);
          changed = true;
          if (["completed", "error", "cancelled"].includes(current.status) && !current.notified) {
            current.notified = true;
            await this.save(current);
            void vscode.window.showInformationMessage(
              this.text(
                `Background job “${current.title}” is ${current.status}.`,
                `バックグラウンドジョブ「${current.title}」は${this.statusLabel(current.status)}です。`,
              ),
            );
          }
        }
        changed ||= interruptedApplyRecovered || recovered.changed;
      } catch {
        // A worker replaces the JSON file atomically; retry on the next poll.
        requiresSupervision ||=
          isActiveBackgroundJobStatus(known.status) ||
          known.status === "applying" ||
          this.launchedWorkers.has(id) ||
          this.stopRequestQueues.has(id);
      }
    }
    if (changed) {
      this.changed.fire(undefined);
    }
    return { changed, requiresSupervision };
  }

  private requestPoll(forceRefresh: boolean): void {
    this.forceNextPoll ||= forceRefresh;
    if (!this.initialized || this.disposed) {
      return;
    }
    if (this.pollInFlight) {
      this.pollAgain = true;
      return;
    }
    this.schedulePoll(0);
  }

  private schedulePoll(delay?: number): void {
    if (this.disposed || !this.initialized) {
      return;
    }
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
    }
    const wait =
      delay ??
      nextBackgroundJobPollDelay({
        requiresSupervision: this.requiresSupervision,
        windowActive: this.windowActive,
        unchangedPolls: this.unchangedPolls,
      });
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.runPollCycle();
    }, wait);
    this.pollTimer.unref?.();
  }

  private async runPollCycle(): Promise<void> {
    if (this.disposed || this.pollInFlight) {
      this.pollAgain ||= !this.disposed;
      return;
    }
    this.pollInFlight = true;
    const forceRefresh = this.forceNextPoll;
    this.forceNextPoll = false;
    let result: BackgroundPollResult | undefined;
    try {
      result = await this.poll(forceRefresh);
    } catch (error) {
      this.output.appendLine(
        `[${new Date().toISOString()}] Could not poll background jobs: ${String(error)}`,
      );
    } finally {
      this.pollInFlight = false;
    }
    if (this.disposed) {
      return;
    }
    if (result) {
      this.requiresSupervision = result.requiresSupervision;
      this.unchangedPolls = result.changed ? 0 : this.unchangedPolls + 1;
    } else {
      // Repository-level failures back off instead of spinning, while active
      // work keeps the tighter supervision ceiling.
      this.unchangedPolls += 1;
    }
    if (this.pollAgain) {
      this.pollAgain = false;
      this.schedulePoll(0);
      return;
    }
    this.schedulePoll();
  }

  private launch(job: BackgroundJob, input: BackgroundWorkerInput): void {
    if (!input.workspaceTrustedAtLaunch || !vscode.workspace.isTrusted) {
      throw new Error(WORKSPACE_TRUST_ERROR);
    }
    const worker = this.workerFile();
    const child = spawn(process.execPath, [worker, job.jobFile, job.workerToken ?? ""], {
      detached: true,
      windowsHide: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...minimalShellEnv(), ELECTRON_RUN_AS_NODE: "1" },
    });
    if (job.workerToken) {
      this.launchedWorkers.set(job.id, { token: job.workerToken, child });
    }
    const forgetChild = (): void => {
      if (this.launchedWorkers.get(job.id)?.child === child) {
        this.launchedWorkers.delete(job.id);
      }
    };
    child.once("exit", forgetChild);
    child.once("error", (error) => {
      forgetChild();
      this.output.appendLine(
        `[${new Date().toISOString()}] Background worker failed: ${error.message}`,
      );
      this.applyStateTransition(job, { type: "launch-failed", error: error.message });
      job.workerToken = undefined;
      void this.save(job).then(() => this.changed.fire(undefined));
    });
    job.pid = child.pid;
    child.stdin.end(JSON.stringify(input));
    child.unref();
  }

  private workerFile(): string {
    return path.join(this.context.extensionUri.fsPath, "out", "backgroundWorker.js");
  }

  private async readAuthenticatedCancellation(
    job: BackgroundJob,
  ): Promise<BackgroundWorkerCancellation | undefined> {
    if (!job.workerToken) {
      return undefined;
    }
    try {
      const raw = await readFile(backgroundWorkerProtocolPaths(job.jobFile).cancellation, "utf8");
      const cancellation = JSON.parse(raw) as BackgroundWorkerCancellation;
      return isAuthenticatedWorkerCancellation(job.workerToken, cancellation)
        ? cancellation
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async requestWorkerStop(
    job: BackgroundJob,
    reason: BackgroundWorkerCancellationReason,
  ): Promise<BackgroundWorkerCancellation | undefined> {
    const previous = this.stopRequestQueues.get(job.id) ?? Promise.resolve(undefined);
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        if (!job.workerToken) {
          return undefined;
        }
        const existing = await this.readAuthenticatedCancellation(job);
        if (existing) {
          return existing;
        }
        const cancellation: BackgroundWorkerCancellation = {
          token: job.workerToken,
          requestedAt: Date.now(),
          reason,
        };
        const target = backgroundWorkerProtocolPaths(job.jobFile).cancellation;
        const temporary = `${target}.host.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(cancellation), "utf8");
        try {
          await rename(temporary, target);
        } finally {
          await unlink(temporary).catch(() => undefined);
        }
        return cancellation;
      });
    this.stopRequestQueues.set(job.id, operation);
    try {
      return await operation;
    } finally {
      if (this.stopRequestQueues.get(job.id) === operation) {
        this.stopRequestQueues.delete(job.id);
      }
    }
  }

  private async synchronizeCancellationStatus(
    job: BackgroundJob,
    cancellation: BackgroundWorkerCancellation,
  ): Promise<boolean> {
    const reason = cancellation.reason ?? "user";
    const active = ["starting", "running"].includes(job.status);
    if (!active && (job.status !== "completed" || reason === "orphan")) {
      return false;
    }
    // The worker owns orphan terminal state until its exit is proven. Saving a
    // stale active snapshot here could overwrite a concurrently completed job.
    if (reason === "orphan") {
      return false;
    }
    if (!this.applyStateTransition(job, { type: "cancel", reason })) {
      return false;
    }
    await this.save(job);
    return true;
  }

  private async recoverWorker(job: BackgroundJob): Promise<BackgroundRecoveryResult> {
    const launched = this.launchedWorkers.get(job.id);
    const authenticatedLaunch =
      launched && launched.token === job.workerToken ? launched : undefined;
    const launchedPid = authenticatedLaunch?.child.pid;
    if (!job.pid && launchedPid && Number.isSafeInteger(launchedPid) && launchedPid > 0) {
      // The retained ChildProcess handle is authoritative until the worker has
      // persisted its own identity. It is only adopted for this recovery pass.
      job.pid = launchedPid;
    }
    let managedChild =
      authenticatedLaunch && authenticatedLaunch.child.pid === job.pid
        ? authenticatedLaunch.child
        : undefined;
    const heartbeat = await this.readAuthenticatedHeartbeat(job);
    if (
      !job.pid &&
      heartbeat &&
      job.workerProcessStartId &&
      heartbeat.processStartId === job.workerProcessStartId &&
      isAuthenticatedWorkerInstance(job.workerToken, undefined, job.workerStartedAt, heartbeat)
    ) {
      job.pid = heartbeat.pid;
      managedChild =
        authenticatedLaunch && authenticatedLaunch.child.pid === job.pid
          ? authenticatedLaunch.child
          : undefined;
    }
    let cancellation = await this.readAuthenticatedCancellation(job);
    const now = Date.now();
    const active = isActiveBackgroundJobStatus(job.status);
    if (active && !vscode.workspace.isTrusted && !cancellation) {
      cancellation = await this.requestWorkerStop(job, "orphan");
    }
    const decision = decideBackgroundWorkerRecovery({
      active,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      workerStartedAt: job.workerStartedAt,
      maxMinutes: job.maxMinutes ?? 240,
      hasFreshHeartbeat: Boolean(
        heartbeat && isAuthenticatedWorkerHeartbeat(job.workerToken, job.pid, heartbeat, now),
      ),
      hasRecoverableWorker: Boolean(heartbeat || managedChild),
      cancellation,
      now,
    });

    if (decision.action === "none") {
      return {
        changed: false,
        requiresSupervision: active || Boolean(heartbeat || managedChild),
      };
    }
    if (decision.action === "request-stop") {
      cancellation = await this.requestWorkerStop(job, decision.reason);
      if (!cancellation) {
        return { changed: false, requiresSupervision: true };
      }
      const statusChanged = await this.synchronizeCancellationStatus(job, cancellation);
      return {
        changed: statusChanged || decision.reason === "orphan",
        requiresSupervision: true,
      };
    }

    let changed = cancellation
      ? await this.synchronizeCancellationStatus(job, cancellation)
      : false;
    if (decision.action === "await-grace") {
      return { changed, requiresSupervision: true };
    }
    if (!job.workerToken || !job.pid) {
      this.logRecoveryOnce(
        job,
        "missing-identity",
        "Refused to hard-stop a background worker because its authenticated PID was unavailable.",
      );
      return { changed, requiresSupervision: true };
    }

    const result = await hardStopBackgroundWorkerProcess(
      {
        pid: job.pid,
        token: job.workerToken,
        startedAt: job.workerStartedAt,
        processStartId: job.workerProcessStartId,
        workerFile: this.workerFile(),
        jobFile: job.jobFile,
        executableFile: process.execPath,
      },
      heartbeat,
      { managedChild },
    );
    if (result === "already-exited") {
      if (this.launchedWorkers.get(job.id)?.child === managedChild) {
        this.launchedWorkers.delete(job.id);
      }
      if (cancellation?.reason === "orphan") {
        const latest = await this.repository.read(job.jobFile);
        Object.assign(job, latest);
        if (
          latest.workerToken === cancellation.token &&
          isActiveBackgroundJobStatus(latest.status)
        ) {
          this.applyStateTransition(job, {
            type: "cancel",
            reason: "orphan",
            workerExitConfirmed: true,
          });
          await this.save(job);
        }
      }
      await this.cleanupWorkerProtocol(job);
      this.recoveryWarnings.delete(`${job.id}:signalled`);
      return { changed: true, requiresSupervision: false };
    }
    if (result === "signalled") {
      this.logRecoveryOnce(
        job,
        "signalled",
        `Hard-stopped background worker ${job.pid} after its cancellation grace period.`,
      );
      return { changed: true, requiresSupervision: true };
    }
    const message =
      result === "identity-mismatch"
        ? "Refused to hard-stop a background worker because its live process identity did not match the authenticated job."
        : result === "inspection-unavailable"
          ? "Could not safely inspect a restored background worker; it was left untouched."
          : "Could not hard-stop the authenticated background worker after its cancellation grace period.";
    this.logRecoveryOnce(job, result, message);
    return { changed, requiresSupervision: true };
  }

  private async recoverInterruptedApply(job: BackgroundJob): Promise<boolean> {
    if (job.status !== "applying" || this.activeJobOperations.has(job.id)) {
      return false;
    }
    if (
      !this.applyStateTransition(job, {
        type: "recover-interrupted-apply",
        error: INTERRUPTED_APPLY_RECOVERY_ERROR,
      })
    ) {
      return false;
    }
    await this.save(job);
    this.logRecoveryOnce(
      job,
      "interrupted-apply",
      "Recovered an interrupted background apply as manual-recovery-required.",
    );
    return true;
  }

  /** Never delete a worktree or stop sidecars until worker exit is proven. */
  private async isWorkerExitConfirmed(job: BackgroundJob): Promise<boolean> {
    const launched = this.launchedWorkers.get(job.id);
    if (launched && launched.token === job.workerToken) {
      if (launched.child.exitCode === null && launched.child.signalCode === null) {
        return false;
      }
      return true;
    }
    if (!job.pid) {
      // A failed spawn clears its token. A restored job with a token but no PID
      // remains fail-closed because this host cannot prove it never started.
      return !job.workerToken;
    }
    const inspection = await inspectBackgroundProcess(job.pid);
    if (inspection.state === "missing") {
      return true;
    }
    if (inspection.state === "unavailable") {
      return false;
    }
    return Boolean(
      job.workerProcessStartId && inspection.identity.startId !== job.workerProcessStartId,
    );
  }

  private logRecoveryOnce(job: BackgroundJob, key: string, message: string): void {
    const warning = `${job.id}:${key}`;
    if (this.recoveryWarnings.has(warning)) {
      return;
    }
    this.recoveryWarnings.add(warning);
    this.output.appendLine(`[${new Date().toISOString()}] ${message}`);
  }

  private async readAuthenticatedHeartbeat(
    job: BackgroundJob,
  ): Promise<BackgroundWorkerHeartbeat | undefined> {
    try {
      const raw = await readFile(backgroundWorkerProtocolPaths(job.jobFile).heartbeat, "utf8");
      const heartbeat = JSON.parse(raw) as BackgroundWorkerHeartbeat;
      return isAuthenticatedWorkerHeartbeatIdentity(job.workerToken, job.pid, heartbeat)
        ? heartbeat
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async cleanupWorkerProtocol(job: BackgroundJob): Promise<void> {
    const files = backgroundWorkerProtocolPaths(job.jobFile);
    await Promise.all([
      unlink(files.heartbeat).catch(() => undefined),
      unlink(files.cancellation).catch(() => undefined),
    ]);
  }

  private async save(job: BackgroundJob): Promise<void> {
    await this.repository.save(job);
    this.jobs.set(job.id, job);
    this.unchangedPolls = 0;
    if (isActiveBackgroundJobStatus(job.status) || this.launchedWorkers.has(job.id)) {
      this.requiresSupervision = true;
    }
    this.requestPoll(false);
  }

  private applyStateTransition(job: BackgroundJob, event: BackgroundJobStateEvent): boolean {
    const update = reduceBackgroundJobState(job, event, {
      deadline: DEADLINE_ERROR,
      unresponsive: UNRESPONSIVE_ERROR,
    });
    if (!update) {
      return false;
    }
    job.status = update.status;
    job.error = update.error;
    return true;
  }

  private selectedModel(): ModelSelection {
    const id = this.context.globalState.get<string>(MODEL_KEY, "auto");
    const params = this.context.globalState.get<Record<string, ModelParameterValue[]>>(
      MODEL_PARAMS_KEY,
      {},
    )[id];
    return { id, params: params?.length ? params : undefined };
  }

  private beginJobOperation(jobId: string): boolean {
    if (this.activeJobOperations.has(jobId)) {
      return false;
    }
    this.activeJobOperations.add(jobId);
    return true;
  }

  private finishJobOperation(jobId: string): void {
    this.activeJobOperations.delete(jobId);
  }

  private resolve(target?: BackgroundNode | string): BackgroundJob | undefined {
    return typeof target === "string" ? this.jobs.get(target) : target?.job;
  }

  private text(english: string, japanese: string): string {
    return this.japanese ? japanese : english;
  }

  private statusLabel(status: BackgroundJob["status"]): string {
    const labels: Record<BackgroundJob["status"], [string, string]> = {
      starting: ["starting", "開始中"],
      running: ["running", "実行中"],
      completed: ["ready to apply", "適用待ち"],
      applying: ["applying", "適用中"],
      applied: ["applied", "適用済み"],
      cancelled: ["cancelled", "中止済み"],
      discarded: ["discarded", "破棄済み"],
      error: ["failed", "失敗"],
    };
    return labels[status][this.japanese ? 1 : 0];
  }

  private icon(status: BackgroundJob["status"]): string {
    if (["starting", "running", "applying"].includes(status)) return "loading~spin";
    if (status === "completed") return "diff";
    if (status === "applied") return "pass-filled";
    if (status === "error") return "error";
    return "circle-slash";
  }
}
