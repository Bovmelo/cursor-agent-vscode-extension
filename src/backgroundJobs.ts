import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { ModelParameterValue, ModelSelection } from "@cursor/sdk";
import * as vscode from "vscode";
import type { BackgroundJob, BackgroundWorkerInput } from "./backgroundJobTypes.js";
import {
  backgroundWorkerProtocolPaths,
  isAuthenticatedWorkerHeartbeat,
  WORKER_STARTUP_GRACE_MS,
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
      beforeCaptureBaseline: (worktreePath) =>
        runConfiguredHooks("preEdit", worktreePath, this.output),
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
      this.launch(job, {
        apiKey,
        model: this.selectedModel(),
        approvalMode: this.context.globalState.get<string>(APPROVAL_MODE_KEY, "auto-review"),
        maxMinutes,
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
    const job = this.resolve(target);
    if (!job || job.status !== "completed") {
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
    if (job.workerToken) {
      const cancellation: BackgroundWorkerCancellation = {
        token: job.workerToken,
        requestedAt: Date.now(),
      };
      const target = backgroundWorkerProtocolPaths(job.jobFile).cancellation;
      const temporary = `${target}.host.tmp`;
      await writeFile(temporary, JSON.stringify(cancellation), "utf8");
      await rename(temporary, target);
    }
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
    for (const file of files.filter((candidate) => candidate.endsWith(".json"))) {
      try {
        const job = JSON.parse(await readFile(path.join(this.jobsRoot, file), "utf8")) as BackgroundJob;
        this.jobs.set(job.id, job);
      } catch (error) {
        this.output.appendLine(`[${new Date().toISOString()}] Could not restore background job ${file}: ${String(error)}`);
      }
    }
    await this.poll(true);
  }

  private async poll(forceRefresh = false): Promise<void> {
    let changed = forceRefresh;
    for (const [id, known] of this.jobs) {
      try {
        const current = JSON.parse(await readFile(known.jobFile, "utf8")) as BackgroundJob;
        if (
          ["starting", "running"].includes(current.status)
          && Date.now() - current.createdAt > WORKER_STARTUP_GRACE_MS
          && !(await this.hasAuthenticatedHeartbeat(current))
        ) {
          current.status = "error";
          current.error = "The detached background worker stopped responding before reporting a result.";
          await this.save(current);
        }
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
      } catch {
        // A worker replaces the JSON file atomically; retry on the next poll.
      }
    }
    if (changed) {
      this.changed.fire(undefined);
    }
  }

  private launch(job: BackgroundJob, input: BackgroundWorkerInput): void {
    const worker = path.join(this.context.extensionUri.fsPath, "out", "backgroundWorker.js");
    const child = spawn(process.execPath, [worker, job.jobFile, job.workerToken ?? ""], {
      detached: true,
      windowsHide: true,
      stdio: ["pipe", "ignore", "ignore"],
      env: { ...minimalShellEnv(), ELECTRON_RUN_AS_NODE: "1" },
    });
    child.once("error", (error) => {
      this.output.appendLine(`[${new Date().toISOString()}] Background worker failed: ${error.message}`);
      job.status = "error";
      job.error = error.message;
      void this.save(job).then(() => this.changed.fire(undefined));
    });
    job.pid = child.pid;
    child.stdin.end(JSON.stringify(input));
    child.unref();
  }

  private async hasAuthenticatedHeartbeat(job: BackgroundJob): Promise<boolean> {
    try {
      const raw = await readFile(backgroundWorkerProtocolPaths(job.jobFile).heartbeat, "utf8");
      const heartbeat = JSON.parse(raw) as BackgroundWorkerHeartbeat;
      return isAuthenticatedWorkerHeartbeat(job.workerToken, job.pid, heartbeat);
    } catch {
      return false;
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
