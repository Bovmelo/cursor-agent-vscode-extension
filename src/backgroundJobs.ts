import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { ModelParameterValue, ModelSelection } from "@cursor/sdk";
import * as vscode from "vscode";
import type { BackgroundJob, BackgroundWorkerInput } from "./backgroundJobTypes.js";
import {
  hardStopBackgroundWorkerProcess,
  inspectBackgroundProcess,
} from "./backgroundProcess.js";
import {
  backgroundWorkerProtocolPaths,
  cancellationInvalidatesCompletedResult,
  decideBackgroundWorkerRecovery,
  isBackgroundJobDocument,
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
import { pickWorkspaceFolder } from "./workspaceFolder.js";

const API_KEY_SECRET = "cursorSubscription.apiKey";
const MODEL_KEY = "cursorSubscription.model";
const MODEL_PARAMS_KEY = "cursorSubscription.modelParams";
const APPROVAL_MODE_KEY = "cursorSubscription.approvalMode";
const DEADLINE_ERROR = "The background agent exceeded its execution-time budget.";
const UNRESPONSIVE_ERROR = "The detached background worker stopped responding before reporting a result.";
const WORKSPACE_TRUST_ERROR = "The background agent stopped because the workspace is no longer trusted.";

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

export type ApplyBackgroundJob = (
  job: BackgroundJob,
  changes: readonly IsolatedChange[],
) => Promise<void>;
export type AuditBackgroundJob = (
  job: BackgroundJob,
  action: "background.cancel" | "background.discard",
) => Promise<void>;

export class BackgroundJobsController implements vscode.TreeDataProvider<BackgroundNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<BackgroundNode | undefined>();
  private readonly jobs = new Map<string, BackgroundJob>();
  private readonly saveQueues = new Map<string, Promise<void>>();
  private readonly stopRequestQueues = new Map<string, Promise<BackgroundWorkerCancellation | undefined>>();
  private readonly launchedWorkers = new Map<string, LaunchedBackgroundWorker>();
  private readonly recoveryWarnings = new Set<string>();
  private readonly jobsRoot: string;
  private readonly storageRoot: vscode.Uri;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
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
    void this.initialize().catch((error) => {
      this.output.appendLine(`[${new Date().toISOString()}] Could not initialize background jobs: ${String(error)}`);
    });
    this.pollTimer = setInterval(() => {
      void this.poll().catch((error) => {
        this.output.appendLine(`[${new Date().toISOString()}] Could not poll background jobs: ${String(error)}`);
      });
    }, 2_000);
    this.pollTimer.unref?.();
  }

  public dispose(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }
    // Detached workers intentionally outlive the extension host unless
    // cancelAllRunning is invoked (e.g. API key revocation).
    this.changed.dispose();
  }

  public async cancelAllRunning(): Promise<void> {
    const running = [...this.jobs.values()].filter((job) =>
      ["starting", "running"].includes(job.status)
    );
    await Promise.all(running.map((job) => this.cancel(job.id)));
  }

  public refresh(): void {
    void this.poll(true).catch((error) => {
      this.output.appendLine(`[${new Date().toISOString()}] Could not refresh background jobs: ${String(error)}`);
    });
  }

  public async create(): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(this.text(
        "Background agents require a trusted workspace.",
        "バックグラウンドAgentには信頼済みワークスペースが必要です。",
      ));
      return;
    }
    const apiKey = await this.context.secrets.get(API_KEY_SECRET);
    if (!apiKey) {
      void vscode.window.showWarningMessage(this.text(
        "Set the Cursor API key before starting a background agent.",
        "バックグラウンドAgentの開始前にCursor APIキーを設定してください。",
      ));
      return;
    }
    const workspace = await pickWorkspaceFolder(this.text(
      "Select a workspace for the background agent",
      "バックグラウンドAgentのワークスペースを選択",
    ));
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
    const running = [...this.jobs.values()].filter((job) => ["starting", "running"].includes(job.status));
    const maximum = vscode.workspace.getConfiguration("cursorSubscription", workspace.uri)
      .get<number>("maxBackgroundJobs", 2);
    if (running.length >= maximum) {
      void vscode.window.showWarningMessage(this.text(
        `The limit of ${maximum} running background job(s) has been reached.`,
        `実行中バックグラウンドジョブの上限 ${maximum} 件に達しています。`,
      ));
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
      worktreesHomeSegment: ".cursor-background/worktrees",
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
    const maxMinutes = vscode.workspace.getConfiguration("cursorSubscription", workspace.uri)
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
      void vscode.window.showInformationMessage(this.text(
        "Background agent started. It will keep running if this VS Code window closes.",
        "バックグラウンドAgentを開始しました。VS Codeを閉じても実行を継続します。",
      ));
    } catch (error) {
      job.status = "error";
      job.error = error instanceof Error ? error.message : String(error);
      await this.save(job);
      throw error;
    }
  }

  public async apply(target?: BackgroundNode | string): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(this.text(
        "Applying background-agent changes requires a trusted workspace.",
        "バックグラウンドAgentの変更を適用するには、信頼済みワークスペースが必要です。",
      ));
      return;
    }
    const job = this.resolve(target);
    if (!job || job.status !== "completed") {
      return;
    }
    await this.recoverWorker(job);
    if (job.status !== "completed") {
      this.changed.fire(undefined);
      return;
    }
    if (!await this.isWorkerExitConfirmed(job)) {
      void vscode.window.showWarningMessage(this.text(
        "The background worker is still finishing, so its changes cannot be applied yet. Try again after it exits.",
        "バックグラウンドワーカーは終了処理中のため、変更をまだ適用できません。終了後に再試行してください。",
      ));
      return;
    }
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
      job.status = "cancelled";
      await this.save(job);
      this.changed.fire(undefined);
      return;
    }
    job.status = "applying";
    await this.save(job);
    this.changed.fire(undefined);
    try {
      const isExcluded = createExcludedPathMatcher(vscode.Uri.file(job.workspaceRoot));
      const changes = await collectIsolatedChanges(job.session, this.storageRoot, {
        pathEscapeLabel: "background agent",
        isExcluded,
        missingBaselineMessage: (relative) => `Background baseline is unavailable for ${relative}.`,
      });
      const applyable = changes.filter((change) => !change.excluded);
      if (applyable.length === 0) {
        throw new Error(this.text(
          "No non-excluded changes were available to apply.",
          "適用可能な（除外されていない）変更がありません。",
        ));
      }
      await this.applyJob(job, applyable);
      job.status = "applied";
      await cleanupIsolatedWorktree(job.session, this.storageRoot, (message) => this.output.appendLine(message));
      await this.cleanupWorkerProtocol(job);
      await this.save(job);
    } catch (error) {
      job.status = "completed";
      job.error = error instanceof Error ? error.message : String(error);
      await this.save(job);
      void vscode.window.showErrorMessage(job.error);
    }
    this.changed.fire(undefined);
  }

  public async cancel(target?: BackgroundNode | string): Promise<void> {
    const job = this.resolve(target);
    if (!job || !["starting", "running"].includes(job.status)) {
      return;
    }
    await this.requestWorkerStop(job, "user");
    job.status = "cancelled";
    await this.save(job);
    await this.auditJob(job, "background.cancel");
    this.changed.fire(undefined);
  }

  public async discard(target?: BackgroundNode | string): Promise<void> {
    const job = this.resolve(target);
    if (!job || ["starting", "running", "applying", "applied", "discarded"].includes(job.status)) {
      return;
    }
    await this.recoverWorker(job);
    if (!await this.isWorkerExitConfirmed(job)) {
      void vscode.window.showWarningMessage(this.text(
        "The background worker is still stopping, so its worktree cannot be discarded yet. Try again after it exits.",
        "バックグラウンドワーカーは停止処理中のため、worktreeをまだ破棄できません。終了後に再試行してください。",
      ));
      return;
    }
    await cleanupIsolatedWorktree(job.session, this.storageRoot, (message) => this.output.appendLine(message));
    await this.cleanupWorkerProtocol(job);
    job.status = "discarded";
    await this.save(job);
    await this.auditJob(job, "background.discard");
    this.changed.fire(undefined);
  }

  public getTreeItem(node: BackgroundNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      node.kind === "job" ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
    );
    item.description = node.description;
    item.contextValue = `cursorBackground.${node.kind}.${node.job.status}`;
    item.iconPath = new vscode.ThemeIcon(this.icon(node.job.status));
    item.tooltip = [node.job.prompt, node.job.error, node.job.assistantText].filter(Boolean).join("\n\n");
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
    return [{
      kind: "summary",
      job: node.job,
      label: node.job.error || node.job.assistantText?.split(/\r?\n/u)[0].slice(0, 180)
        || this.text("Waiting for the agent…", "Agentの完了を待機中…"),
      description: node.job.workspaceRoot,
    }];
  }

  private async initialize(): Promise<void> {
    await mkdir(this.jobsRoot, { recursive: true });
    const files = await readdir(this.jobsRoot).catch(() => []);
    for (const file of files.filter(isBackgroundJobDocument)) {
      try {
        const job = JSON.parse(await readFile(path.join(this.jobsRoot, file), "utf8")) as BackgroundJob;
        this.jobs.set(job.id, job);
      } catch (error) {
        this.output.appendLine(`[${new Date().toISOString()}] Could not restore background job ${file}: ${String(error)}`);
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
    await this.poll(true);
  }

  private async poll(forceRefresh = false): Promise<void> {
    let changed = forceRefresh;
    for (const [id, known] of this.jobs) {
      try {
        const current = JSON.parse(await readFile(known.jobFile, "utf8")) as BackgroundJob;
        const recovered = await this.recoverWorker(current);
        if (current.updatedAt !== known.updatedAt || current.status !== known.status) {
          this.jobs.set(id, current);
          changed = true;
          if (["completed", "error", "cancelled"].includes(current.status) && !current.notified) {
            current.notified = true;
            await this.save(current);
            void vscode.window.showInformationMessage(this.text(
              `Background job “${current.title}” is ${current.status}.`,
              `バックグラウンドジョブ「${current.title}」は${this.statusLabel(current.status)}です。`,
            ));
          }
        }
        changed ||= recovered;
      } catch {
        // A worker replaces the JSON file atomically; retry on the next poll.
      }
    }
    if (changed) {
      this.changed.fire(undefined);
    }
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
      this.output.appendLine(`[${new Date().toISOString()}] Background worker failed: ${error.message}`);
      job.status = "error";
      job.error = error.message;
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
    const operation = previous.catch(() => undefined).then(async () => {
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
    if (reason === "deadline") {
      job.status = "error";
      job.error = DEADLINE_ERROR;
    } else if (reason === "unresponsive") {
      job.status = "error";
      job.error = UNRESPONSIVE_ERROR;
    } else {
      job.status = "cancelled";
      job.error = undefined;
    }
    await this.save(job);
    return true;
  }

  private async recoverWorker(job: BackgroundJob): Promise<boolean> {
    const launched = this.launchedWorkers.get(job.id);
    const authenticatedLaunch = launched && launched.token === job.workerToken
      ? launched
      : undefined;
    const launchedPid = authenticatedLaunch?.child.pid;
    if (!job.pid && launchedPid && Number.isSafeInteger(launchedPid) && launchedPid > 0) {
      // The retained ChildProcess handle is authoritative until the worker has
      // persisted its own identity. It is only adopted for this recovery pass.
      job.pid = launchedPid;
    }
    let managedChild = authenticatedLaunch && authenticatedLaunch.child.pid === job.pid
      ? authenticatedLaunch.child
      : undefined;
    const heartbeat = await this.readAuthenticatedHeartbeat(job);
    if (
      !job.pid
      && heartbeat
      && job.workerProcessStartId
      && heartbeat.processStartId === job.workerProcessStartId
      && isAuthenticatedWorkerInstance(
        job.workerToken,
        undefined,
        job.workerStartedAt,
        heartbeat,
      )
    ) {
      job.pid = heartbeat.pid;
      managedChild = authenticatedLaunch && authenticatedLaunch.child.pid === job.pid
        ? authenticatedLaunch.child
        : undefined;
    }
    let cancellation = await this.readAuthenticatedCancellation(job);
    const now = Date.now();
    const active = ["starting", "running"].includes(job.status);
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
      return false;
    }
    if (decision.action === "request-stop") {
      cancellation = await this.requestWorkerStop(job, decision.reason);
      if (!cancellation) {
        return false;
      }
      const statusChanged = await this.synchronizeCancellationStatus(job, cancellation);
      return statusChanged || decision.reason === "orphan";
    }

    let changed = cancellation
      ? await this.synchronizeCancellationStatus(job, cancellation)
      : false;
    if (decision.action === "await-grace") {
      return changed;
    }
    if (!job.workerToken || !job.pid) {
      this.logRecoveryOnce(
        job,
        "missing-identity",
        "Refused to hard-stop a background worker because its authenticated PID was unavailable.",
      );
      return changed;
    }

    const result = await hardStopBackgroundWorkerProcess({
      pid: job.pid,
      token: job.workerToken,
      startedAt: job.workerStartedAt,
      processStartId: job.workerProcessStartId,
      workerFile: this.workerFile(),
      jobFile: job.jobFile,
      executableFile: process.execPath,
    }, heartbeat, { managedChild });
    if (result === "already-exited") {
      if (this.launchedWorkers.get(job.id)?.child === managedChild) {
        this.launchedWorkers.delete(job.id);
      }
      await this.cleanupWorkerProtocol(job);
      this.recoveryWarnings.delete(`${job.id}:signalled`);
      return true;
    }
    if (result === "signalled") {
      this.logRecoveryOnce(
        job,
        "signalled",
        `Hard-stopped background worker ${job.pid} after its cancellation grace period.`,
      );
      return true;
    }
    const message = result === "identity-mismatch"
      ? "Refused to hard-stop a background worker because its live process identity did not match the authenticated job."
      : result === "inspection-unavailable"
        ? "Could not safely inspect a restored background worker; it was left untouched."
        : "Could not hard-stop the authenticated background worker after its cancellation grace period.";
    this.logRecoveryOnce(job, result, message);
    return changed;
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
      job.workerProcessStartId
      && inspection.identity.startId !== job.workerProcessStartId
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

  private async readAuthenticatedHeartbeat(job: BackgroundJob): Promise<BackgroundWorkerHeartbeat | undefined> {
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
    const previous = this.saveQueues.get(job.id) ?? Promise.resolve();
    const operation = previous.then(async () => {
      job.updatedAt = Date.now();
      const temporary = `${job.jobFile}.host.tmp`;
      await writeFile(temporary, JSON.stringify(job, undefined, 2), "utf8");
      await rename(temporary, job.jobFile);
      this.jobs.set(job.id, job);
    });
    const queued = operation.catch(() => {});
    this.saveQueues.set(job.id, queued);
    try {
      await operation;
    } finally {
      if (this.saveQueues.get(job.id) === queued) {
        this.saveQueues.delete(job.id);
      }
    }
  }

  private selectedModel(): ModelSelection {
    const id = this.context.globalState.get<string>(MODEL_KEY, "auto");
    const params = this.context.globalState
      .get<Record<string, ModelParameterValue[]>>(MODEL_PARAMS_KEY, {})[id];
    return { id, params: params?.length ? params : undefined };
  }

  private resolve(target?: BackgroundNode | string): BackgroundJob | undefined {
    return typeof target === "string" ? this.jobs.get(target) : target?.job;
  }

  private text(english: string, japanese: string): string {
    return this.japanese ? japanese : english;
  }

  private statusLabel(status: BackgroundJob["status"]): string {
    const labels: Record<BackgroundJob["status"], [string, string]> = {
      starting: ["starting", "開始中"], running: ["running", "実行中"], completed: ["ready to apply", "適用待ち"],
      applying: ["applying", "適用中"], applied: ["applied", "適用済み"], cancelled: ["cancelled", "中止済み"],
      discarded: ["discarded", "破棄済み"], error: ["failed", "失敗"],
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
