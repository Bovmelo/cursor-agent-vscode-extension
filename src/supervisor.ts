import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { runVerification, verificationStage, type VerificationResult } from "./aiNative.js";
import type { AuditAction } from "./auditLog.js";
import {
  applyIsolatedChange,
  cleanupIsolatedWorktree,
  collectIsolatedChanges,
  isInside,
  normalizedRelative,
  prepareIsolatedWorktree,
  readIsolatedBaseline,
  safePath,
  type IsolatedBaselineFile,
  type IsolatedWorktreeSession,
} from "./isolatedWorktree.js";
import { parseSupervisorReviewVerdict, scanTodoAiComments } from "./todoScanner.js";
import { scanCurrentGitHubPullRequest } from "./githubTriggers.js";
import {
  dependencyReadiness,
  overlappingTaskIds,
  selectRunnableSupervisorTasks,
} from "./supervisorScheduling.js";
import { runGit } from "./worktreeLifecycle.js";
import { configurationFor, resolveWorkspaceFolder } from "./workspaceFolder.js";

const TASKS_KEY = "cursorSubscription.supervisorTasks";
const MAX_TASKS = 50;
export type SupervisorMode = "off" | "observe" | "autonomous";
export type SupervisorPriority = "high" | "normal" | "low";
export type SupervisorTaskSource =
  | "diagnostics"
  | "manual"
  | "todo"
  | "test-failure"
  | "ci"
  | "pr-comment";
export type SupervisorTaskStatus =
  | "detected"
  | "queued"
  | "running"
  | "review"
  | "blocked"
  | "applying"
  | "completed"
  | "failed"
  | "dismissed";

export interface SupervisorChange {
  relative: string;
  kind: "added" | "modified" | "deleted";
  added: number;
  deleted: number;
  excluded: boolean;
  reason?: string;
  decision?: "applied" | "discarded";
}

export type SupervisorBaselineFile = IsolatedBaselineFile;

export interface SupervisorTask {
  id: string;
  title: string;
  detail: string;
  root: string;
  source: SupervisorTaskSource;
  priority?: SupervisorPriority;
  dependencyIds?: string[];
  ownedFiles?: string[];
  ownershipBlockedBy?: string[];
  ownershipBlockedReason?: string;
  file?: string;
  fingerprint: string;
  createdAt: number;
  updatedAt: number;
  status: SupervisorTaskStatus;
  diagnostics?: string[];
  worktreePath?: string;
  baselineCommit?: string;
  baselineFiles?: Record<string, SupervisorBaselineFile>;
  initialChangedFiles?: string[];
  changes?: SupervisorChange[];
  verification?: VerificationResult;
  reviewVerdict?: "approve" | "reject";
  blockedReasons?: string[];
  runStartedAt?: number;
  runFinishedAt?: number;
  error?: string;
}

export interface SupervisorAuditEvent {
  action: AuditAction;
  summary: string;
  details?: string;
  files?: string[];
  taskId?: string;
}

export interface SupervisorExecutionResult {
  status: "finished" | "cancelled" | "error";
  error?: string;
  summary?: string;
  assistantText?: string;
  changeReasons?: Record<string, string>;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    totalTokens: number;
    reasoningTokens?: number;
  };
}

export interface SupervisorTaskTarget {
  taskId?: string;
  relative?: string;
}

interface SupervisorNode {
  kind: "mode" | "task" | "change" | "detail";
  taskId: string;
  relative?: string;
  label: string;
  description?: string;
  contextValue?: string;
  command?: vscode.Command;
}

type SupervisorExecutor = (
  task: SupervisorTask,
  worktreePath: string,
  prompt: string,
) => Promise<SupervisorExecutionResult | undefined>;

function globRegex(pattern: string): RegExp {
  let source = normalizedRelative(pattern.trim());
  const optionalPrefix = source.startsWith("**/");
  if (optionalPrefix) {
    source = source.slice(3);
  }
  let result = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "*" && source[index + 1] === "*") {
      result += ".*";
      index += 1;
    } else if (character === "*") {
      result += "[^/]*";
    } else if (character === "?") {
      result += "[^/]";
    } else {
      result += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`^${optionalPrefix ? "(?:.*/)?" : ""}${result}$`, "i");
}

export class AiSupervisorController
implements vscode.TreeDataProvider<SupervisorNode>, vscode.TextDocumentContentProvider,
vscode.CodeLensProvider, vscode.Disposable {
  private readonly changedEmitter = new vscode.EventEmitter<SupervisorNode | undefined>();
  private readonly contentChangedEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly previewContents = new Map<string, string>();
  private readonly previewReasons = new Map<string, SupervisorTaskTarget>();
  private readonly tasks: SupervisorTask[];
  private readonly repoRoots = new Map<string, string>();
  private executor: SupervisorExecutor | undefined;
  private busyCheck: (() => boolean) | undefined;
  private cancelActiveRun: ((taskId?: string) => Promise<void>) | undefined;
  private onAudit: ((event: SupervisorAuditEvent) => void) | undefined;
  private scheduler: ReturnType<typeof setTimeout> | undefined;
  private githubScheduler: ReturnType<typeof setTimeout> | undefined;
  private readonly activeRunIds = new Set<string>();
  private applyQueue: Promise<void> = Promise.resolve();
  private readonly statusBar: vscode.StatusBarItem;
  private treeView: vscode.TreeView<SupervisorNode> | undefined;

  public readonly onDidChangeTreeData = this.changedEmitter.event;
  public readonly onDidChange = this.contentChangedEmitter.event;

  public constructor(
    private readonly state: vscode.Memento,
    private readonly storageRoot: vscode.Uri,
    private readonly output: vscode.OutputChannel,
    private readonly japanese: boolean,
    private readonly enabled: () => boolean,
  ) {
    this.tasks = state.get<SupervisorTask[]>(TASKS_KEY, []).slice(0, MAX_TASKS);
    let recovered = false;
    for (const task of this.tasks) {
      if (task.status === "running") {
        task.status = "failed";
        task.error = this.text(
          "The previous Supervisor run was interrupted. Run it again to restart safely.",
          "前回のSupervisor実行が中断されました。安全に再開するにはもう一度実行してください。",
        );
        recovered = true;
      } else if (task.status === "applying") {
        task.status = task.blockedReasons?.length ? "blocked" : "review";
        recovered = true;
      }
    }
    if (recovered) {
      void this.persist();
    }
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.statusBar.command = "cursorSubscription.chooseSupervisorMode";
    this.statusBar.name = "Cursor AI Supervisor";
    this.statusBar.show();
    this.updateStatusBar();

    this.disposables.push(
      this.statusBar,
      vscode.workspace.onDidSaveTextDocument((document) => {
        void this.observeDocument(document);
        void this.observeTodoComments(document);
      }),
      vscode.tasks.onDidEndTaskProcess((event) => void this.observeTaskFailure(event)),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        this.updateStatusBar();
        this.refresh();
        this.scheduleAutoRun();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration("cursorSubscription.enableAiNativeFeatures")
          || event.affectsConfiguration("cursorSubscription.enableAiSupervisor")
          || event.affectsConfiguration("cursorSubscription.supervisorMode")
          || event.affectsConfiguration("cursorSubscription.supervisorTodoTrigger")
          || event.affectsConfiguration("cursorSubscription.supervisorTestFailureTrigger")
          || event.affectsConfiguration("cursorSubscription.supervisorReviewGate")
          || event.affectsConfiguration("cursorSubscription.supervisorMaxParallelTasks")
          || event.affectsConfiguration("cursorSubscription.supervisorGitHubTrigger")
        ) {
          this.updateStatusBar();
          this.refresh();
          this.scheduleAutoRun();
          this.scheduleGitHubScan();
        }
      }),
    );
    this.scheduleGitHubScan();
  }

  public setAuditSink(onAudit: (event: SupervisorAuditEvent) => void): void {
    this.onAudit = onAudit;
  }

  public dispose(): void {
    if (this.scheduler) {
      clearTimeout(this.scheduler);
      this.scheduler = undefined;
    }
    if (this.githubScheduler) {
      clearTimeout(this.githubScheduler);
      this.githubScheduler = undefined;
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.changedEmitter.dispose();
    this.contentChangedEmitter.dispose();
  }

  public setExecutor(
    executor: SupervisorExecutor,
    busyCheck: () => boolean,
    cancelActiveRun?: (taskId?: string) => Promise<void>,
  ): void {
    this.executor = executor;
    this.busyCheck = busyCheck;
    this.cancelActiveRun = cancelActiveRun;
    this.scheduleAutoRun();
  }

  public attachTreeView(treeView: vscode.TreeView<SupervisorNode>): void {
    this.treeView = treeView;
    this.updateStatusBar();
  }

  public refresh(): void {
    this.changedEmitter.fire(undefined);
  }

  public mode(): SupervisorMode {
    if (!this.enabled()) {
      return "off";
    }
    const configured = this.configuration().get<SupervisorMode>("supervisorMode", "observe");
    if (!vscode.workspace.isTrusted && configured === "autonomous") {
      return "observe";
    }
    return configured;
  }

  public effectiveAutonomousAllowed(): boolean {
    return vscode.workspace.isTrusted;
  }

  public getTreeItem(node: SupervisorNode): vscode.TreeItem {
    const item = new vscode.TreeItem(
      node.label,
      node.kind === "task"
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    item.description = node.description;
    item.contextValue = node.contextValue;
    item.command = node.command;
    if (node.kind === "mode") {
      const mode = this.mode();
      item.iconPath = new vscode.ThemeIcon(this.modeIcon(mode));
      item.tooltip = this.text(
        `Current AI Supervisor mode: ${this.modeLabel(mode)}. Click to change it.`,
        `現在のAI Supervisorモード: ${this.modeLabel(mode)}。クリックして変更できます。`,
      );
    } else if (node.kind === "task") {
      const task = this.findTask(node.taskId);
      item.iconPath = new vscode.ThemeIcon(this.taskIcon(task?.status ?? "detected"));
      item.tooltip = task
        ? new vscode.MarkdownString(`${task.detail}\n\n${this.statusLabel(task.status)}`)
        : node.label;
    } else if (node.kind === "change") {
      const task = this.findTask(node.taskId);
      const change = task?.changes?.find((candidate) => candidate.relative === node.relative);
      item.iconPath = new vscode.ThemeIcon(
        change?.decision === "applied"
          ? "check"
          : change?.decision === "discarded"
            ? "discard"
            : change?.excluded
              ? "warning"
              : "diff",
      );
      item.resourceUri = task?.worktreePath && node.relative
        ? vscode.Uri.file(safePath(task.worktreePath, node.relative))
        : undefined;
      if (task && change) {
        const tooltip = new vscode.MarkdownString();
        tooltip.appendMarkdown(`**${this.text("Change reason", "変更理由")}**\n\n`);
        tooltip.appendText(this.changeReason(task, change));
        tooltip.appendMarkdown(`\n\n${change.kind} · +${change.added}/-${change.deleted}`);
        item.tooltip = tooltip;
      }
    } else {
      item.iconPath = new vscode.ThemeIcon("info");
      item.tooltip = node.label;
    }
    return item;
  }

  public getChildren(node?: SupervisorNode): SupervisorNode[] {
    if (!node) {
      const mode = this.mode();
      const modeNode: SupervisorNode = {
        kind: "mode",
        taskId: "",
        label: this.text("Current mode", "現在のモード"),
        description: this.modeLabel(mode),
        contextValue: `cursorSupervisor.mode.${mode}`,
        command: {
          command: "cursorSubscription.chooseSupervisorMode",
          title: this.text("Change AI Supervisor mode", "AI Supervisorモードを変更"),
        },
      };
      if (!this.enabled()) {
        return [modeNode];
      }
      return [modeNode, ...this.tasks
        .filter((task) => task.status !== "dismissed")
        .map((task) => ({
          kind: "task" as const,
          taskId: task.id,
          label: task.title,
          description: this.statusLabel(task.status),
          contextValue: `cursorSupervisor.task.${task.status}`,
          command: task.status === "detected" || task.status === "queued" || task.status === "failed"
            ? {
                command: "cursorSubscription.runSupervisorTask",
                title: "Run AI Supervisor task",
                arguments: [{ taskId: task.id }],
              }
            : undefined,
        }))];
    }
    if (!this.enabled()) {
      return [];
    }

    const task = this.findTask(node.taskId);
    if (!task || node.kind !== "task") {
      return [];
    }
    const children: SupervisorNode[] = [];
    if (task.error) {
      children.push({
        kind: "detail",
        taskId: task.id,
        label: this.text(`Reason: ${task.error}`, `理由: ${task.error}`),
      });
    }
    if (task.blockedReasons?.length) {
      children.push(...task.blockedReasons.map((reason) => ({
        kind: "detail" as const,
        taskId: task.id,
        label: reason,
      })));
    }
    if (task.dependencyIds?.length) {
      children.push({
        kind: "detail",
        taskId: task.id,
        label: this.text(
          `Dependencies: ${task.dependencyIds.map((id) => this.findTask(id)?.title ?? id.slice(0, 8)).join(", ")}`,
          `依存: ${task.dependencyIds.map((id) => this.findTask(id)?.title ?? id.slice(0, 8)).join("、")}`,
        ),
      });
    }
    if (task.ownedFiles?.length) {
      children.push({
        kind: "detail",
        taskId: task.id,
        label: this.text(
          `File ownership: ${task.ownedFiles.length} file(s)`,
          `ファイル所有権: ${task.ownedFiles.length}件`,
        ),
        description: task.ownedFiles.slice(0, 3).join(", "),
      });
    }
    if (task.verification) {
      children.push({
        kind: "detail",
        taskId: task.id,
        label: task.verification.success
          ? this.text("Verification passed", "検証成功")
          : this.text("Verification failed", "検証失敗"),
        description: `${task.verification.steps.length} step(s)`,
      });
      children.push(...task.verification.steps.map((step) => ({
        kind: "detail" as const,
        taskId: task.id,
        label: `${step.success ? "✓" : "✗"} ${String(step.stage ?? verificationStage(step.command)).toUpperCase()}: ${step.command}`,
        description: `${Math.max(0, step.durationMs / 1_000).toFixed(1)}s`,
      })));
    }
    children.push(...(task.changes ?? []).map((change) => ({
      kind: "change" as const,
      taskId: task.id,
      relative: change.relative,
      label: change.relative,
      description: change.decision
        ? this.decisionLabel(change.decision)
        : `${change.kind} +${change.added}/-${change.deleted}`,
      contextValue: change.decision
        ? `cursorSupervisor.change.${change.decision}`
        : change.excluded
          ? "cursorSupervisor.change.excluded"
          : "cursorSupervisor.change.pending",
      command: {
        command: "cursorSubscription.openSupervisorChange",
        title: "Open AI change",
        arguments: [{ taskId: task.id, relative: change.relative }],
      },
    })));
    return children;
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.previewContents.get(uri.toString()) ?? "";
  }

  public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const target = this.previewReasons.get(document.uri.toString());
    const task = this.findTask(target?.taskId);
    const change = task?.changes?.find((candidate) => candidate.relative === target?.relative);
    if (!task || !change) {
      return [];
    }
    const reason = this.changeReason(task, change);
    return [new vscode.CodeLens(new vscode.Range(0, 0, 0, 0), {
      command: "cursorSubscription.showSupervisorChangeReason",
      title: `${this.text("Change reason", "変更理由")}: ${this.compactReason(reason, 120)}`,
      tooltip: this.text(
        "Open the complete reason for this AI change",
        "このAI変更の理由を全文表示",
      ),
      arguments: [{ taskId: task.id, relative: change.relative }],
    })];
  }

  public async chooseMode(): Promise<void> {
    const choices: Array<vscode.QuickPickItem & { mode: SupervisorMode }> = [
      {
        mode: "observe",
        label: this.text("$(eye) Observe", "$(eye) 監視"),
        description: this.text(
          "Detect problems and add them to the inbox without spending AI quota",
          "問題を検出して受信箱へ追加（AI利用枠は消費しません）",
        ),
      },
      {
        mode: "autonomous",
        label: this.text("$(sparkle) Autonomous", "$(sparkle) 自律実行"),
        description: this.text(
          "Run queued tasks automatically within the configured budgets",
          "設定した予算内でタスクを自動実行",
        ),
      },
      {
        mode: "off",
        label: this.text("$(circle-slash) Off", "$(circle-slash) オフ"),
        description: this.text("Disable detection and automatic runs", "検出と自動実行を停止"),
      },
    ];
    const picked = await vscode.window.showQuickPick(choices, {
      title: this.text("AI Supervisor mode", "AI Supervisorモード"),
    });
    if (!picked) {
      return;
    }
    await this.configuration().update("supervisorMode", picked.mode, vscode.ConfigurationTarget.Workspace);
    this.updateStatusBar();
    this.refresh();
    this.scheduleAutoRun();
  }

  public async createManualTask(): Promise<void> {
    if (!this.enabled()) {
      this.showDisabledMessage();
      return;
    }
    const goal = await vscode.window.showInputBox({
      title: this.text("New AI Supervisor task", "AI Supervisorタスクを追加"),
      prompt: this.text(
        "Describe the desired outcome. The AI will work in an isolated worktree.",
        "実現したい結果を入力してください。AIは隔離worktreeで作業します。",
      ),
      ignoreFocusOut: true,
    });
    if (!goal?.trim()) {
      return;
    }
    const priorityPick = await vscode.window.showQuickPick(
      [
        {
          label: this.text("Normal priority", "通常優先度"),
          priority: "normal" as const,
        },
        {
          label: this.text("High priority", "高優先度"),
          priority: "high" as const,
        },
        {
          label: this.text("Low priority", "低優先度"),
          priority: "low" as const,
        },
      ],
      { title: this.text("Task priority", "タスク優先度") },
    );
    const root = await this.currentRepoRoot();
    if (!root) {
      return;
    }
    const dependencyPick = await vscode.window.showQuickPick(
      this.tasks
        .filter((task) => task.root === root && task.status !== "dismissed" && task.status !== "failed")
        .map((task) => ({
          label: task.title,
          description: `${this.statusLabel(task.status)} · ${task.id.slice(0, 8)}`,
          task,
        })),
      {
        title: this.text("Dependencies (optional)", "依存タスク（任意）"),
        placeHolder: this.text(
          "Run this task only after the selected tasks complete",
          "選択したタスクの完了後にのみ実行します",
        ),
        canPickMany: true,
      },
    );
    await this.createTask({
      source: "manual",
      title: goal.trim().split(/\r?\n/, 1)[0].slice(0, 80),
      detail: goal.trim(),
      root,
      fingerprint: createHash("sha256").update(goal.trim()).digest("hex"),
      priority: priorityPick?.priority ?? "normal",
      dependencyIds: dependencyPick?.map((item) => item.task.id),
    });
  }

  public async createTask(options: {
    source: SupervisorTaskSource;
    title: string;
    detail: string;
    root: string;
    fingerprint: string;
    file?: string;
    diagnostics?: string[];
    priority?: SupervisorPriority;
    dependencyIds?: string[];
  }): Promise<SupervisorTask | undefined> {
    if (!this.enabled() || this.mode() === "off") {
      return undefined;
    }
    if (this.tasks.some((task) => task.fingerprint === options.fingerprint && task.status !== "dismissed")) {
      return undefined;
    }
    const now = Date.now();
    const task: SupervisorTask = {
      id: randomUUID(),
      title: options.title,
      detail: options.detail,
      root: options.root,
      source: options.source,
      priority: options.priority ?? "normal",
      dependencyIds: [...new Set(options.dependencyIds ?? [])],
      file: options.file,
      fingerprint: options.fingerprint,
      createdAt: now,
      updatedAt: now,
      status: this.mode() === "autonomous" ? "queued" : "detected",
      diagnostics: options.diagnostics,
    };
    this.tasks.unshift(task);
    this.trimTasks();
    await this.persist();
    this.refresh();
    this.scheduleAutoRun();
    return task;
  }

  public async scanDiagnostics(): Promise<void> {
    if (!this.enabled() || this.mode() === "off") {
      this.showDisabledMessage();
      return;
    }
    const diagnostics = vscode.languages.getDiagnostics();
    for (const [uri] of diagnostics) {
      if (uri.scheme !== "file") {
        continue;
      }
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        await this.observeDocument(document);
      } catch {
        // Ignore diagnostics for documents that disappeared during the scan.
      }
    }
  }

  public async scanTodos(): Promise<void> {
    if (!this.enabled() || this.mode() === "off") {
      this.showDisabledMessage();
      return;
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    for (const folder of folders) {
      const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, "**/*.{ts,tsx,js,jsx,mjs,cjs,py,go,rs,java,kt,cs,md}"),
        "**/{node_modules,dist,out,.git}/**",
        200,
      );
      for (const uri of files) {
        try {
          const document = await vscode.workspace.openTextDocument(uri);
          await this.observeTodoComments(document, true);
        } catch {
          // Skip unreadable files.
        }
      }
    }
  }

  public async scanGitHubSignals(force = true): Promise<void> {
    if (!this.enabled() || this.mode() === "off") {
      if (force) {
        this.showDisabledMessage();
      }
      return;
    }
    if (!force && (
      !vscode.workspace.isTrusted
      || !this.configuration().get<boolean>("supervisorGitHubTrigger", false)
    )) {
      return;
    }
    const workspace = resolveWorkspaceFolder(vscode.window.activeTextEditor?.document.uri)
      ?? vscode.workspace.workspaceFolders?.[0];
    const root = workspace ? await this.repoRootFor(workspace.uri.fsPath) : undefined;
    if (!root) {
      return;
    }
    try {
      const signals = await scanCurrentGitHubPullRequest(root);
      let created = 0;
      for (const signal of signals) {
        const task = await this.createTask({
          ...signal,
          root,
        });
        if (task) {
          created += 1;
        }
      }
      if (force) {
        void vscode.window.showInformationMessage(this.text(
          created > 0
            ? `Added ${created} GitHub CI/review task(s) to Supervisor.`
            : "No new failed CI checks or actionable PR review comments were found.",
          created > 0
            ? `GitHub CI/レビューから${created}件のSupervisorタスクを追加しました。`
            : "新しいCI失敗または対応可能なPRレビューコメントはありませんでした。",
        ));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(`[${new Date().toISOString()}] GitHub Supervisor scan failed: ${message}`);
      if (force) {
        void vscode.window.showWarningMessage(this.text(
          "Could not scan the current GitHub PR. Install/authenticate gh and open a branch with a PR.",
          "現在のGitHub PRを取得できませんでした。ghをインストール・認証し、PRのあるブランチを開いてください。",
        ));
      }
    } finally {
      this.scheduleGitHubScan();
    }
  }

  public async observeDocument(document: vscode.TextDocument): Promise<void> {
    if (!this.enabled() || this.mode() === "off" || document.uri.scheme !== "file") {
      return;
    }
    const root = await this.repoRootFor(document.uri.fsPath);
    if (!root || !isInside(root, document.uri.fsPath)) {
      return;
    }
    const relative = normalizedRelative(path.relative(root, document.uri.fsPath));
    const runningTask = this.tasks.find((task) =>
      task.status === "running" && task.root === root && task.file === relative
    );
    if (runningTask) {
      runningTask.error = this.text(
        "Paused because the target file was edited while AI was running.",
        "AI実行中に対象ファイルが編集されたため停止しました。",
      );
      runningTask.updatedAt = Date.now();
      await this.persist();
      this.refresh();
      await this.cancelActiveRun?.(runningTask.id);
      return;
    }
    const errors = vscode.languages.getDiagnostics(document.uri)
      .filter((diagnostic) => diagnostic.severity === vscode.DiagnosticSeverity.Error)
      .slice(0, 20);
    if (errors.length === 0) {
      return;
    }
    const details = errors.map((diagnostic) =>
      `L${diagnostic.range.start.line + 1}: ${diagnostic.message}`
    );
    const fingerprint = createHash("sha256")
      .update(`${relative}\n${details.join("\n")}`)
      .digest("hex");
    for (const task of this.tasks) {
      if (
        task.source === "diagnostics"
        && task.file === relative
        && (task.status === "detected" || task.status === "queued")
      ) {
        task.status = "dismissed";
        task.updatedAt = Date.now();
      }
    }
    await this.createTask({
      source: "diagnostics",
      title: this.text(
        `Fix ${errors.length} error(s) in ${relative}`,
        `${relative} のエラー${errors.length}件を修正`,
      ),
      detail: details.join("\n"),
      root,
      file: relative,
      fingerprint,
      diagnostics: details,
      priority: "high",
    });
  }

  public async observeTodoComments(
    document: vscode.TextDocument,
    force = false,
  ): Promise<void> {
    if (
      !this.enabled()
      || this.mode() === "off"
      || document.uri.scheme !== "file"
      || (!force && !this.configuration().get<boolean>("supervisorTodoTrigger", false))
    ) {
      return;
    }
    const root = await this.repoRootFor(document.uri.fsPath);
    if (!root || !isInside(root, document.uri.fsPath)) {
      return;
    }
    const relative = normalizedRelative(path.relative(root, document.uri.fsPath));
    const matches = scanTodoAiComments(document.getText());
    for (const match of matches) {
      const fingerprint = createHash("sha256")
        .update(`todo:${relative}:${match.line}:${match.text}`)
        .digest("hex");
      await this.createTask({
        source: "todo",
        title: this.text(
          `TODO(ai) in ${relative}:${match.line}`,
          `${relative}:${match.line} の TODO(ai)`,
        ),
        detail: [
          `Resolve the TODO(ai) comment in ${relative} at line ${match.line}.`,
          match.text,
        ].join("\n"),
        root,
        file: relative,
        fingerprint,
        diagnostics: [match.detail],
        priority: "normal",
      });
    }
  }

  public async observeTaskFailure(
    event: vscode.TaskProcessEndEvent,
  ): Promise<void> {
    if (
      !this.enabled()
      || this.mode() === "off"
      || !this.configuration().get<boolean>("supervisorTestFailureTrigger", false)
      || event.exitCode === 0
      || event.exitCode === undefined
    ) {
      return;
    }
    const taskName = event.execution.task.name;
    const isTestLike = /test|spec|jest|mocha|vitest|pytest|phpunit/i.test(
      `${taskName} ${event.execution.task.source}`,
    );
    if (!isTestLike) {
      return;
    }
    const root = await this.currentRepoRoot();
    if (!root) {
      return;
    }
    const detail = [
      `The task "${taskName}" exited with code ${event.exitCode}.`,
      "Investigate the failure, fix the smallest coherent cause, and keep related tests green.",
    ].join("\n");
    const fingerprint = createHash("sha256")
      .update(`test-failure:${taskName}:${event.exitCode}:${Math.floor(Date.now() / 60_000)}`)
      .digest("hex");
    await this.createTask({
      source: "test-failure",
      title: this.text(
        `Fix failed task: ${taskName}`,
        `失敗タスクを修正: ${taskName}`,
      ),
      detail,
      root,
      fingerprint,
      priority: "high",
    });
  }

  public async runTask(target: SupervisorTaskTarget | string | undefined, automatic = false): Promise<void> {
    let taskId = typeof target === "string" ? target : target?.taskId;
    if (!taskId && !automatic) {
      const candidates = this.tasks.filter((task) =>
        task.status === "detected" || task.status === "queued" || task.status === "failed"
      );
      const picked = await vscode.window.showQuickPick(
        candidates.map((task) => ({ label: task.title, description: this.statusLabel(task.status), task })),
        { title: this.text("Run AI Supervisor task", "AI Supervisorタスクを実行") },
      );
      taskId = picked?.task.id;
    }
    const task = this.findTask(taskId);
    if (!task || !this.executor) {
      return;
    }
    const readiness = dependencyReadiness(task, this.tasks);
    if (!readiness.ready) {
      task.status = readiness.failed.length > 0 || readiness.missing.length > 0 ? "blocked" : "queued";
      task.error = readiness.failed.length > 0
        ? this.text("A dependency failed or is blocked.", "依存タスクが失敗またはブロックされています。")
        : readiness.missing.length > 0
          ? this.text("A dependency is missing or dismissed.", "依存タスクが見つからないか破棄されています。")
          : this.text("Waiting for dependencies to complete.", "依存タスクの完了を待っています。");
      task.updatedAt = Date.now();
      await this.persist();
      this.refresh();
      return;
    }
    const ownershipConflicts = overlappingTaskIds(task, this.tasks);
    if (ownershipConflicts.length > 0) {
      task.status = "queued";
      task.error = this.text(
        `Waiting for file ownership held by ${ownershipConflicts.length} task(s).`,
        `${ownershipConflicts.length}件のタスクが保持するファイル所有権を待っています。`,
      );
      task.updatedAt = Date.now();
      await this.persist();
      this.refresh();
      this.scheduleAutoRun(5_000);
      return;
    }
    if (this.busyCheck?.() || this.activeRunIds.has(task.id)) {
      task.status = "queued";
      task.updatedAt = Date.now();
      await this.persist();
      this.refresh();
      if (!automatic) {
        void vscode.window.showInformationMessage(this.text(
          "The task was queued until the current AI run finishes.",
          "現在のAI処理が終わるまでタスクをキューに追加しました。",
        ));
      }
      this.scheduleAutoRun(10_000);
      return;
    }
    if (automatic && !this.withinHourlyBudget()) {
      task.status = "queued";
      task.updatedAt = Date.now();
      task.error = this.text("Hourly AI run budget reached", "1時間あたりのAI実行上限に達しました");
      await this.persist();
      this.refresh();
      return;
    }

    this.activeRunIds.add(task.id);
    task.status = "running";
    task.runStartedAt = Date.now();
    task.updatedAt = Date.now();
    task.error = undefined;
    task.blockedReasons = undefined;
    task.changes = undefined;
    task.verification = undefined;
    await this.persist();
    this.refresh();

    try {
      const worktree = await this.prepareWorktree(task);
      const outcome = await this.executor(task, worktree, this.taskPrompt(task));
      if (!outcome) {
        task.status = "queued";
        task.error = this.text("AI runner is unavailable", "AIランナーを利用できません");
        return;
      }
      if (outcome.status !== "finished") {
        task.status = "failed";
        task.error ??= outcome.error
          ?? this.text("AI run did not finish", "AI処理が完了しませんでした");
        return;
      }

      task.changes = await this.collectChanges(task);
      task.ownedFiles = task.changes.map((change) => change.relative);
      this.attachChangeReasons(task, outcome);
      task.runFinishedAt = Date.now();
      const totalLines = task.changes.reduce(
        (total, change) => total + change.added + change.deleted,
        0,
      );
      const maximumFiles = this.configuration().get<number>("supervisorMaxFiles", 5);
      const maximumLines = this.configuration().get<number>("supervisorMaxChangedLines", 300);
      const reasons: string[] = [];
      const concurrentOwners = overlappingTaskIds(task, this.tasks);
      if (concurrentOwners.length > 0) {
        task.ownershipBlockedBy = concurrentOwners;
        task.ownershipBlockedReason = this.text(
          `File ownership overlaps ${concurrentOwners.length} active task(s); automatic apply is queued.`,
          `ファイル所有権が${concurrentOwners.length}件の実行中タスクと重複するため、自動適用を待機します。`,
        );
        reasons.push(task.ownershipBlockedReason);
      } else {
        task.ownershipBlockedBy = undefined;
        task.ownershipBlockedReason = undefined;
      }
      if (task.changes.length > maximumFiles) {
        reasons.push(this.text(
          `Changed ${task.changes.length} files; budget is ${maximumFiles}`,
          `${task.changes.length}ファイルを変更（上限${maximumFiles}）`,
        ));
      }
      if (totalLines > maximumLines) {
        reasons.push(this.text(
          `Changed ${totalLines} lines; budget is ${maximumLines}`,
          `${totalLines}行を変更（上限${maximumLines}）`,
        ));
      }
      const excluded = task.changes.filter((change) => change.excluded);
      if (excluded.length > 0) {
        reasons.push(this.text(
          `Touched ${excluded.length} excluded file(s)`,
          `除外対象の${excluded.length}ファイルを変更`,
        ));
      }
      if (
        task.changes.length > 0
        && this.configuration().get<boolean>("supervisorReviewGate", false)
        && this.executor
      ) {
        const review = await this.executor(task, worktree, this.reviewPrompt(task));
        const verdict = parseSupervisorReviewVerdict(
          review?.assistantText ?? review?.summary ?? "",
        );
        if (verdict) {
          task.reviewVerdict = verdict.verdict;
          if (verdict.verdict === "reject") {
            reasons.push(
              ...verdict.reasons.map((reason) =>
                this.text(`Review rejected: ${reason}`, `レビュー却下: ${reason}`)
              ),
            );
            if (verdict.reasons.length === 0) {
              reasons.push(this.text(
                "AI review gate rejected these changes.",
                "AIレビューゲートが変更を却下しました。",
              ));
            }
          }
        } else if (review?.status === "finished") {
          reasons.push(this.text(
            "AI review gate did not return a usable verdict.",
            "AIレビューゲートが有効な判定を返しませんでした。",
          ));
        }
      }
      task.blockedReasons = reasons.length > 0 ? reasons : undefined;

      if (task.changes.length === 0) {
        task.status = "completed";
        await this.cleanupWorktree(task);
        return;
      }

      if (this.configuration().get<boolean>("enableVerification", true)) {
        task.verification = await runVerification(
          worktree,
          this.configuration().get<string[]>("verificationCommands", []),
          this.output,
        );
      }
      task.status = reasons.length > 0 ? "blocked" : "review";
      await this.persist();
      this.refresh();

      if (this.shouldAutoApply(task)) {
        await this.enqueueAutomaticApply(task.id);
      } else {
        const openLabel = this.text("Open inbox", "受信箱を開く");
        const answer = await vscode.window.showInformationMessage(
          this.text(
            `AI Supervisor prepared ${task.changes.length} change(s) for review.`,
            `AI Supervisorが${task.changes.length}件の変更をレビュー待ちにしました。`,
          ),
          openLabel,
        );
        if (answer === openLabel) {
          await vscode.commands.executeCommand("cursorSubscription.supervisorTasks.focus");
        }
      }
    } catch (error) {
      task.status = "failed";
      task.error = error instanceof Error ? error.message : String(error);
      this.output.appendLine(
        `[${new Date().toISOString()}] AI Supervisor task failed: ${task.error}`,
      );
    } finally {
      task.updatedAt = Date.now();
      if (!task.runFinishedAt && (task.status === "failed" || task.status === "completed")) {
        task.runFinishedAt = Date.now();
      }
      this.activeRunIds.delete(task.id);
      await this.persist();
      this.refresh();
      this.scheduleAutoRun();
    }
  }

  public async openChange(target: SupervisorTaskTarget | undefined): Promise<void> {
    const task = this.findTask(target?.taskId);
    const relative = target?.relative;
    if (!task?.worktreePath || !task.baselineCommit || !relative) {
      return;
    }
    const baselineState = await this.readBaseline(task, relative);
    const baseline = baselineState.bytes
      ? Buffer.from(baselineState.bytes).toString("utf8")
      : "";
    let proposed = "";
    try {
      proposed = Buffer.from(
        await vscode.workspace.fs.readFile(vscode.Uri.file(safePath(task.worktreePath, relative))),
      ).toString("utf8");
    } catch {
      // Deleted files have no proposed content.
    }
    const previewId = randomUUID();
    const baselineUri = vscode.Uri.from({
      scheme: "cursor-supervisor-preview",
      path: `/${previewId}/baseline/${path.basename(relative)}`,
    });
    const proposedUri = vscode.Uri.from({
      scheme: "cursor-supervisor-preview",
      path: `/${previewId}/proposed/${path.basename(relative)}`,
    });
    this.previewContents.set(baselineUri.toString(), baseline);
    this.previewContents.set(proposedUri.toString(), proposed);
    this.previewReasons.set(proposedUri.toString(), {
      taskId: task.id,
      relative,
    });
    const change = task.changes?.find((candidate) => candidate.relative === relative);
    const reason = change ? this.changeReason(task, change) : task.title;
    await vscode.commands.executeCommand(
      "vscode.diff",
      baselineUri,
      proposedUri,
      `${relative} ↔ AI Supervisor — ${this.compactReason(reason, 72)}`,
      { preview: true },
    );
  }

  public showChangeReason(target: SupervisorTaskTarget | undefined): void {
    const task = this.findTask(target?.taskId);
    const change = task?.changes?.find((candidate) => candidate.relative === target?.relative);
    if (!task || !change) {
      return;
    }
    void vscode.window.showInformationMessage(
      `${this.text("Change reason", "変更理由")} (${change.relative}): ${this.changeReason(task, change)}`,
    );
  }

  public async applyChange(target: SupervisorTaskTarget | undefined): Promise<void> {
    const task = this.findTask(target?.taskId);
    const change = task?.changes?.find((candidate) => candidate.relative === target?.relative);
    if (!task || !change || change.decision) {
      return;
    }
    if (change.excluded) {
      const applyLabel = this.text("Apply anyway", "それでも適用");
      const answer = await vscode.window.showWarningMessage(
        this.text(
          `${change.relative} matches an excluded path. Apply it anyway?`,
          `${change.relative} は除外パスに一致します。それでも適用しますか？`,
        ),
        { modal: true },
        applyLabel,
      );
      if (answer !== applyLabel) {
        return;
      }
    }
    task.status = "applying";
    this.refresh();
    try {
      await this.applyOne(task, change);
      change.decision = "applied";
      this.emitAudit({
        action: "supervisor.apply",
        summary: `Applied ${change.relative}`,
        files: [change.relative],
        taskId: task.id,
      });
      await this.finishDecisions(task);
    } catch (error) {
      task.status = task.blockedReasons?.length ? "blocked" : "review";
      const message = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(message);
    } finally {
      task.updatedAt = Date.now();
      await this.persist();
      this.refresh();
    }
  }

  public async discardChange(target: SupervisorTaskTarget | undefined): Promise<void> {
    const task = this.findTask(target?.taskId);
    const change = task?.changes?.find((candidate) => candidate.relative === target?.relative);
    if (!task || !change || change.decision) {
      return;
    }
    change.decision = "discarded";
    task.updatedAt = Date.now();
    this.emitAudit({
      action: "supervisor.discard",
      summary: `Discarded ${change.relative}`,
      files: [change.relative],
      taskId: task.id,
    });
    await this.finishDecisions(task);
    await this.persist();
    this.refresh();
  }

  public async applyAll(target: SupervisorTaskTarget | string | undefined, automatic = false): Promise<void> {
    const taskId = typeof target === "string" ? target : target?.taskId;
    const task = this.findTask(taskId);
    if (!task?.changes?.length) {
      return;
    }
    if (!automatic) {
      const applyLabel = this.text("Apply all", "すべて適用");
      const warning = task.blockedReasons?.length
        ? `\n\n${task.blockedReasons.join("\n")}`
        : "";
      const answer = await vscode.window.showWarningMessage(
        this.text(
          `Apply all pending AI Supervisor changes?${warning}`,
          `AI Supervisorの確認待ち変更をすべて適用しますか？${warning}`,
        ),
        { modal: true },
        applyLabel,
      );
      if (answer !== applyLabel) {
        return;
      }
    }
    task.status = "applying";
    this.refresh();
    const conflicts: string[] = [];
    for (const change of task.changes.filter((candidate) => !candidate.decision)) {
      if (change.excluded && automatic) {
        continue;
      }
      try {
        await this.applyOne(task, change);
        change.decision = "applied";
      } catch (error) {
        conflicts.push(`${change.relative}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (conflicts.length > 0) {
      task.status = task.blockedReasons?.length ? "blocked" : "review";
      task.error = conflicts.join("\n");
      void vscode.window.showWarningMessage(this.text(
        `${conflicts.length} file(s) changed while AI was running and were not applied.`,
        `${conflicts.length}ファイルがAI実行中に更新されたため適用しませんでした。`,
      ));
    } else {
      this.emitAudit({
        action: "supervisor.applyAll",
        summary: `Applied all changes for ${task.title}`,
        files: task.changes.filter((change) => change.decision === "applied").map((change) => change.relative),
        taskId: task.id,
      });
    }
    await this.finishDecisions(task);
    task.updatedAt = Date.now();
    await this.persist();
    this.refresh();
  }

  public async discardAll(target: SupervisorTaskTarget | string | undefined): Promise<void> {
    const taskId = typeof target === "string" ? target : target?.taskId;
    const task = this.findTask(taskId);
    if (!task?.changes?.length) {
      return;
    }
    const discardLabel = this.text("Discard all", "すべて破棄");
    const answer = await vscode.window.showWarningMessage(
      this.text(
        "Discard all pending AI Supervisor changes?",
        "AI Supervisorの確認待ち変更をすべて破棄しますか？",
      ),
      { modal: true },
      discardLabel,
    );
    if (answer !== discardLabel) {
      return;
    }
    for (const change of task.changes) {
      change.decision ??= "discarded";
    }
    this.emitAudit({
      action: "supervisor.discardAll",
      summary: `Discarded all changes for ${task.title}`,
      files: task.changes.map((change) => change.relative),
      taskId: task.id,
    });
    await this.finishDecisions(task);
    task.updatedAt = Date.now();
    await this.persist();
    this.refresh();
  }

  public async dismissTask(target: SupervisorTaskTarget | string | undefined): Promise<void> {
    const taskId = typeof target === "string" ? target : target?.taskId;
    const task = this.findTask(taskId);
    if (!task || task.status === "running" || task.status === "applying") {
      return;
    }
    if (task.changes?.some((change) => !change.decision)) {
      await this.discardAll(task.id);
      return;
    }
    task.status = "dismissed";
    task.updatedAt = Date.now();
    await this.cleanupWorktree(task);
    await this.persist();
    this.refresh();
  }

  private configuration(): vscode.WorkspaceConfiguration {
    return configurationFor("cursorSubscription");
  }

  private text(english: string, japanese: string): string {
    return this.japanese ? japanese : english;
  }

  private findTask(id: string | undefined): SupervisorTask | undefined {
    return id ? this.tasks.find((task) => task.id === id) : undefined;
  }

  private async persist(): Promise<void> {
    await this.state.update(TASKS_KEY, this.tasks.slice(0, MAX_TASKS));
  }

  private trimTasks(): void {
    const removed = this.tasks.splice(MAX_TASKS);
    for (const task of removed) {
      void this.cleanupWorktree(task);
    }
  }

  private updateStatusBar(): void {
    const mode = this.mode();
    this.statusBar.text = `$(${this.modeIcon(mode)}) Supervisor: ${this.modeLabel(mode)}`;
    this.statusBar.tooltip = this.text(
      `Cursor AI Supervisor is in ${this.modeLabel(mode)} mode — click to change it`,
      `Cursor AI Supervisorは「${this.modeLabel(mode)}」モードです — クリックして変更`,
    );
    if (this.treeView) {
      this.treeView.description = this.modeLabel(mode);
    }
  }

  private modeIcon(mode: SupervisorMode): string {
    return mode === "autonomous" ? "sparkle" : mode === "observe" ? "eye" : "circle-slash";
  }

  private modeLabel(mode: SupervisorMode): string {
    const labels: Record<SupervisorMode, [string, string]> = {
      autonomous: ["Autonomous", "自律実行"],
      observe: ["Observe", "監視"],
      off: ["Off", "オフ"],
    };
    return this.japanese ? labels[mode][1] : labels[mode][0];
  }

  private showDisabledMessage(): void {
    void vscode.window.showInformationMessage(this.text(
      "AI Supervisor is disabled in Cursor Subscription settings.",
      "AI SupervisorはCursor Subscriptionの設定で無効です。",
    ));
  }

  private taskIcon(status: SupervisorTaskStatus): string {
    const icons: Record<SupervisorTaskStatus, string> = {
      detected: "lightbulb",
      queued: "clock",
      running: "sync~spin",
      review: "diff",
      blocked: "warning",
      applying: "loading~spin",
      completed: "pass-filled",
      failed: "error",
      dismissed: "circle-slash",
    };
    return icons[status];
  }

  private statusLabel(status: SupervisorTaskStatus): string {
    const labels: Record<SupervisorTaskStatus, [string, string]> = {
      detected: ["Detected", "検出"],
      queued: ["Queued", "待機中"],
      running: ["Running", "実行中"],
      review: ["Review", "レビュー待ち"],
      blocked: ["Budget blocked", "予算超過"],
      applying: ["Applying", "適用中"],
      completed: ["Completed", "完了"],
      failed: ["Failed", "失敗"],
      dismissed: ["Dismissed", "破棄"],
    };
    return this.japanese ? labels[status][1] : labels[status][0];
  }

  private decisionLabel(decision: "applied" | "discarded"): string {
    return decision === "applied"
      ? this.text("Applied", "適用済み")
      : this.text("Discarded", "破棄済み");
  }

  private changeReason(task: SupervisorTask, change: SupervisorChange): string {
    return change.reason?.trim() || this.text(
      `This change addresses the Supervisor task: ${task.title}`,
      `この変更はSupervisorタスク「${task.title}」に対応するためです。`,
    );
  }

  private compactReason(reason: string, maximum: number): string {
    const compact = reason.replace(/\s+/g, " ").trim();
    return compact.length > maximum ? `${compact.slice(0, maximum - 1)}…` : compact;
  }

  private attachChangeReasons(
    task: SupervisorTask,
    outcome: SupervisorExecutionResult,
  ): void {
    const reasons = new Map(
      Object.entries(outcome.changeReasons ?? {}).map(([relative, reason]) => [
        normalizedRelative(relative.replace(/^`|`$/g, "")),
        reason.trim(),
      ]),
    );
    const summary = outcome.summary?.trim();
    for (const change of task.changes ?? []) {
      change.reason = reasons.get(normalizedRelative(change.relative))
        || (summary ? this.compactReason(summary, 500) : undefined)
        || this.changeReason(task, change);
    }
  }

  private async currentRepoRoot(): Promise<string | undefined> {
    const workspace = resolveWorkspaceFolder(
      vscode.window.activeTextEditor?.document.uri,
    );
    if (!workspace) {
      void vscode.window.showWarningMessage(this.text(
        "Open a Git workspace before creating an AI Supervisor task.",
        "AI Supervisorタスクを作成する前にGitワークスペースを開いてください。",
      ));
      return undefined;
    }
    const root = await this.repoRootFor(workspace.uri.fsPath);
    if (!root) {
      void vscode.window.showWarningMessage(this.text(
        "AI Supervisor isolation requires a Git repository.",
        "AI Supervisorの隔離実行にはGitリポジトリが必要です。",
      ));
    }
    return root;
  }

  private async repoRootFor(candidate: string): Promise<string | undefined> {
    const key = path.resolve(candidate).toLowerCase();
    const cached = this.repoRoots.get(key);
    if (cached) {
      return cached;
    }
    try {
      const root = path.resolve((await runGit(candidate, ["rev-parse", "--show-toplevel"])).trim());
      this.repoRoots.set(key, root);
      return root;
    } catch {
      return undefined;
    }
  }

  private scheduleAutoRun(delay?: number): void {
    if (this.scheduler) {
      clearTimeout(this.scheduler);
      this.scheduler = undefined;
    }
    if (this.mode() !== "autonomous") {
      return;
    }
    const configuredDelay = Math.max(
      1,
      this.configuration().get<number>("supervisorDebounceSeconds", 5),
    ) * 1000;
    this.scheduler = setTimeout(() => {
      this.scheduler = undefined;
      void this.runNextAutomatic();
    }, delay ?? configuredDelay);
  }

  private async runNextAutomatic(): Promise<void> {
    if (
      this.mode() !== "autonomous"
      || this.busyCheck?.()
      || !this.withinHourlyBudget()
    ) {
      this.scheduleAutoRun(10_000);
      return;
    }
    for (const task of this.tasks) {
      if (task.status === "blocked" && task.dependencyIds?.length) {
        const readiness = dependencyReadiness(task, this.tasks);
        if (readiness.ready && !(task.changes?.length)) {
          task.status = "queued";
          task.error = undefined;
        }
      }
    }
    const maximumParallel = Math.max(
      1,
      this.configuration().get<number>("supervisorMaxParallelTasks", 2),
    );
    const available = Math.max(0, maximumParallel - this.activeRunIds.size);
    const tasks = selectRunnableSupervisorTasks(this.tasks, available);
    if (tasks.length === 0) {
      this.scheduleAutoRun(10_000);
      return;
    }
    await this.persist();
    this.refresh();
    await Promise.all(tasks.map((task) => this.runTask(task.id, true)));
  }

  private scheduleGitHubScan(delay = 5 * 60 * 1000): void {
    if (this.githubScheduler) {
      clearTimeout(this.githubScheduler);
      this.githubScheduler = undefined;
    }
    if (
      !vscode.workspace.isTrusted
      || !this.configuration().get<boolean>("supervisorGitHubTrigger", false)
      || this.mode() === "off"
    ) {
      return;
    }
    this.githubScheduler = setTimeout(() => {
      this.githubScheduler = undefined;
      void this.scanGitHubSignals(false);
    }, Math.max(30_000, delay));
  }

  private async enqueueAutomaticApply(taskId: string): Promise<void> {
    const operation = this.applyQueue
      .catch(() => {})
      .then(() => this.applyAll({ taskId }, true));
    this.applyQueue = operation;
    await operation;
  }

  private withinHourlyBudget(): boolean {
    const maximum = this.configuration().get<number>("supervisorMaxAiRunsPerHour", 4);
    const cutoff = Date.now() - 60 * 60 * 1000;
    return this.tasks.filter((task) => (task.runStartedAt ?? 0) >= cutoff).length < maximum;
  }

  private excludedPatterns(): RegExp[] {
    return this.configuration()
      .get<string[]>("supervisorExcludedGlobs", [])
      .filter((pattern) => pattern.trim().length > 0)
      .map(globRegex);
  }

  private isExcluded(relative: string): boolean {
    const normalized = normalizedRelative(relative);
    return this.excludedPatterns().some((pattern) => pattern.test(normalized));
  }

  private taskPrompt(task: SupervisorTask): string {
    const maximumFiles = this.configuration().get<number>("supervisorMaxFiles", 5);
    const maximumLines = this.configuration().get<number>("supervisorMaxChangedLines", 300);
    const maximumMinutes = this.configuration().get<number>("supervisorMaxRunMinutes", 15);
    const exclusions = this.configuration().get<string[]>("supervisorExcludedGlobs", []);
    return [
      task.detail,
      task.dependencyIds?.length
        ? `This task started after ${task.dependencyIds.length} prerequisite task(s) completed.`
        : undefined,
      "",
      "You are executing an isolated AI Supervisor task.",
      "Investigate the issue, make the smallest coherent fix, and add or update focused tests when useful.",
      "Do not commit, create branches, or modify files outside the current worktree.",
      `Keep the change within ${maximumFiles} files and approximately ${maximumLines} changed lines.`,
      `Finish within the ${maximumMinutes}-minute execution budget.`,
      exclusions.length > 0
        ? `Do not modify paths matching: ${exclusions.join(", ")}.`
        : undefined,
      "Do not stop after explaining the fix; implement it and report validation and remaining risks.",
      "For every file you change, record one concise reason explaining why that file had to change.",
      "End your final response with exactly this machine-readable block, using repository-relative paths and valid JSON:",
      "<SUPERVISOR_CHANGE_REASONS>",
      '{"path/to/file":"Concise reason this file changed"}',
      "</SUPERVISOR_CHANGE_REASONS>",
      "Include every changed file exactly once. Write reasons in the same language as the task when practical.",
    ].filter((line): line is string => typeof line === "string").join("\n");
  }

  private reviewPrompt(task: SupervisorTask): string {
    const files = (task.changes ?? [])
      .map((change) => `- ${change.relative} (${change.kind}, +${change.added}/-${change.deleted}): ${
        change.reason ?? "no reason"
      }`)
      .join("\n");
    return [
      "You are reviewing an isolated AI Supervisor change set.",
      "Do not edit any files. Do not run destructive commands.",
      "Reject changes that look unsafe, overscoped, secret-touching, or unrelated to the task.",
      `Task: ${task.title}`,
      task.detail,
      "",
      "Proposed changes:",
      files || "(none)",
      "",
      "End your response with exactly this machine-readable block:",
      "<SUPERVISOR_REVIEW_VERDICT>",
      '{"verdict":"approve"|"reject","reasons":["concise reason"]}',
      "</SUPERVISOR_REVIEW_VERDICT>",
    ].join("\n");
  }

  private emitAudit(event: SupervisorAuditEvent): void {
    this.onAudit?.(event);
  }

  private taskSession(task: SupervisorTask): IsolatedWorktreeSession | undefined {
    if (!task.worktreePath || !task.baselineCommit) {
      return undefined;
    }
    return {
      id: task.id,
      root: task.root,
      worktreePath: task.worktreePath,
      baselineCommit: task.baselineCommit,
      baselineFiles: task.baselineFiles ?? {},
      initialChangedFiles: task.initialChangedFiles ?? [],
      baselinesFolder: "supervisor-baselines",
    };
  }

  private async prepareWorktree(task: SupervisorTask): Promise<string> {
    if (task.worktreePath) {
      await this.cleanupWorktree(task);
    }
    // Cursor SDK derives its SQLite state path from cwd. A VS Code
    // workspaceStorage path can exceed Windows MAX_PATH after that expansion,
    // so keep the isolated checkout in a deliberately short home-directory path.
    const session = await prepareIsolatedWorktree({
      id: task.id,
      root: task.root,
      storageRoot: this.storageRoot,
      worktreesHomeSegment: ".cursor-supervisor/worktrees",
      baselinesFolder: "supervisor-baselines",
      isExcluded: (relative) => this.isExcluded(relative),
      pathEscapeLabel: "AI Supervisor",
      onLog: (message) => this.output.appendLine(
        message.replace("Could not link node_modules", "AI Supervisor could not link node_modules"),
      ),
    });
    task.worktreePath = session.worktreePath;
    task.baselineCommit = session.baselineCommit;
    task.baselineFiles = session.baselineFiles;
    task.initialChangedFiles = session.initialChangedFiles;
    await this.persist();
    return session.worktreePath;
  }

  private async collectChanges(task: SupervisorTask): Promise<SupervisorChange[]> {
    const session = this.taskSession(task);
    if (!session) {
      return [];
    }
    return collectIsolatedChanges(session, this.storageRoot, {
      isExcluded: (relative) => this.isExcluded(relative),
      pathEscapeLabel: "AI Supervisor",
      missingBaselineMessage: (relative) => this.text(
        `The Supervisor baseline for ${relative} is unavailable.`,
        `${relative} のSupervisorベースラインを利用できません。`,
      ),
    });
  }

  private async readBaseline(
    task: SupervisorTask,
    relative: string,
  ): Promise<{ exists: boolean; bytes?: Uint8Array }> {
    const session = this.taskSession(task);
    if (!session) {
      return { exists: false };
    }
    return readIsolatedBaseline(
      session,
      this.storageRoot,
      relative,
      (pathRelative) => this.text(
        `The Supervisor baseline for ${pathRelative} is unavailable.`,
        `${pathRelative} のSupervisorベースラインを利用できません。`,
      ),
    );
  }

  private async applyOne(task: SupervisorTask, change: SupervisorChange): Promise<void> {
    const session = this.taskSession(task);
    if (!session) {
      throw new Error(this.text("The isolated worktree is unavailable.", "隔離worktreeを利用できません。"));
    }
    await applyIsolatedChange(session, this.storageRoot, change, {
      pathEscapeLabel: "AI Supervisor",
      unavailableMessage: this.text(
        "The isolated worktree is unavailable.",
        "隔離worktreeを利用できません。",
      ),
      conflictMessage: this.text(
        "The file changed after the Supervisor task started. Review and merge it manually.",
        "Supervisor開始後にファイルが変更されています。手動で確認してマージしてください。",
      ),
      missingBaselineMessage: (relative) => this.text(
        `The Supervisor baseline for ${relative} is unavailable.`,
        `${relative} のSupervisorベースラインを利用できません。`,
      ),
    });
  }

  private async finishDecisions(task: SupervisorTask): Promise<void> {
    if (task.changes?.some((change) => !change.decision)) {
      task.status = task.blockedReasons?.length ? "blocked" : "review";
      return;
    }
    task.status = "completed";
    task.runFinishedAt ??= Date.now();
    await this.cleanupWorktree(task);
    this.refreshOwnershipBlocks();
    this.scheduleAutoRun(0);
  }

  private refreshOwnershipBlocks(): void {
    for (const candidate of this.tasks) {
      if (!candidate.ownershipBlockedReason || !candidate.changes?.length) {
        continue;
      }
      const overlaps = overlappingTaskIds(candidate, this.tasks);
      const priorReason = candidate.ownershipBlockedReason;
      candidate.blockedReasons = (candidate.blockedReasons ?? [])
        .filter((reason) => reason !== priorReason);
      if (overlaps.length > 0) {
        candidate.ownershipBlockedBy = overlaps;
        candidate.ownershipBlockedReason = this.text(
          `File ownership overlaps ${overlaps.length} active task(s); automatic apply is queued.`,
          `ファイル所有権が${overlaps.length}件の実行中タスクと重複するため、自動適用を待機します。`,
        );
        candidate.blockedReasons.push(candidate.ownershipBlockedReason);
        candidate.status = "blocked";
        continue;
      }
      candidate.ownershipBlockedBy = undefined;
      candidate.ownershipBlockedReason = undefined;
      candidate.blockedReasons = candidate.blockedReasons.length > 0
        ? candidate.blockedReasons
        : undefined;
      candidate.status = candidate.blockedReasons?.length ? "blocked" : "review";
      if (this.shouldAutoApply(candidate)) {
        void this.enqueueAutomaticApply(candidate.id);
      }
    }
  }

  private shouldAutoApply(task: SupervisorTask): boolean {
    if (
      this.mode() !== "autonomous"
      || !vscode.workspace.isTrusted
      || !this.configuration().get<boolean>("supervisorAutoApplySafeChanges", false)
      || task.blockedReasons?.length
      || task.reviewVerdict === "reject"
      || task.verification?.success !== true
      || task.verification.skipped
    ) {
      return false;
    }
    const safePatterns = this.configuration()
      .get<string[]>("supervisorAutoApplyGlobs", [
        "**/*.md",
        "**/*.test.*",
        "**/*.spec.*",
        "**/test/**",
        "**/tests/**",
      ])
      .filter((pattern) => typeof pattern === "string" && pattern.trim().length > 0)
      .map(globRegex);
    if (safePatterns.length === 0) {
      return false;
    }
    return Boolean(task.changes?.length)
      && task.changes!.every((change) =>
        !change.excluded && safePatterns.some((pattern) => pattern.test(change.relative))
      );
  }

  private async cleanupWorktree(task: SupervisorTask): Promise<void> {
    const session = this.taskSession(task);
    await cleanupIsolatedWorktree(
      session,
      this.storageRoot,
      (message) => this.output.appendLine(
        message.replace("Could not remove worktree", "AI Supervisor could not remove worktree"),
      ),
    );
    task.worktreePath = undefined;
    task.baselineCommit = undefined;
    task.baselineFiles = undefined;
    task.initialChangedFiles = undefined;
  }
}
