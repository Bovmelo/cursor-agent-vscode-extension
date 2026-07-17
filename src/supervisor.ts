import { execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { runVerification, type VerificationResult } from "./aiNative.js";
import { configurationFor, resolveWorkspaceFolder } from "./workspaceFolder.js";

const execFileAsync = promisify(execFileCallback);
const TASKS_KEY = "cursorSubscription.supervisorTasks";
const MAX_TASKS = 50;
const MAX_GIT_OUTPUT = 32 * 1024 * 1024;

export type SupervisorMode = "off" | "observe" | "autonomous";
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

export interface SupervisorBaselineFile {
  existed: boolean;
  hash?: string;
  backupName?: string;
}

export interface SupervisorTask {
  id: string;
  title: string;
  detail: string;
  root: string;
  source: "diagnostics" | "manual";
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
  blockedReasons?: string[];
  runStartedAt?: number;
  runFinishedAt?: number;
  error?: string;
}

export interface SupervisorExecutionResult {
  status: "finished" | "cancelled" | "error";
  error?: string;
  summary?: string;
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

function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizedRelative(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function safePath(root: string, relative: string): string {
  const candidate = path.resolve(root, relative);
  if (!isInside(root, candidate)) {
    throw new Error(`Path escapes the AI Supervisor workspace: ${relative}`);
  }
  return candidate;
}

function splitNull(value: string): string[] {
  return value.split("\0").filter((item) => item.length > 0).map(normalizedRelative);
}

function lineDiffCounts(
  baseline: Uint8Array | undefined,
  proposed: Uint8Array | undefined,
): { added: number; deleted: number } {
  const before = baseline ? Buffer.from(baseline) : Buffer.alloc(0);
  const after = proposed ? Buffer.from(proposed) : Buffer.alloc(0);
  if (before.includes(0) || after.includes(0)) {
    return { added: 0, deleted: 0 };
  }
  const beforeLines = before.length === 0 ? [] : before.toString("utf8").split(/\r?\n/);
  const afterLines = after.length === 0 ? [] : after.toString("utf8").split(/\r?\n/);
  if (beforeLines.length * afterLines.length > 2_000_000) {
    return { added: afterLines.length, deleted: beforeLines.length };
  }
  const previous = new Uint32Array(afterLines.length + 1);
  const current = new Uint32Array(afterLines.length + 1);
  for (const beforeLine of beforeLines) {
    for (let column = 1; column <= afterLines.length; column += 1) {
      current[column] = beforeLine === afterLines[column - 1]
        ? previous[column - 1] + 1
        : Math.max(previous[column], current[column - 1]);
    }
    previous.set(current);
    current.fill(0);
  }
  const common = previous[afterLines.length];
  return {
    added: afterLines.length - common,
    deleted: beforeLines.length - common,
  };
}

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

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    windowsHide: true,
    maxBuffer: MAX_GIT_OUTPUT,
    encoding: "utf8",
  });
  return stdout;
}

async function gitBytes(root: string, args: string[]): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    execFileCallback(
      "git",
      args,
      {
        cwd: root,
        windowsHide: true,
        maxBuffer: MAX_GIT_OUTPUT,
        encoding: "buffer",
      },
      (error, stdout) => {
        if (error) {
          reject(error);
        } else {
          resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
        }
      },
    );
  });
}

async function fileState(file: string): Promise<{ exists: boolean; bytes?: Uint8Array }> {
  try {
    return {
      exists: true,
      bytes: await vscode.workspace.fs.readFile(vscode.Uri.file(file)),
    };
  } catch {
    return { exists: false };
  }
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
  private cancelActiveRun: (() => Promise<void>) | undefined;
  private scheduler: ReturnType<typeof setTimeout> | undefined;
  private autoRunActive = false;
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
      vscode.workspace.onDidSaveTextDocument((document) => void this.observeDocument(document)),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration("cursorSubscription.enableAiNativeFeatures")
          || event.affectsConfiguration("cursorSubscription.enableAiSupervisor")
          || event.affectsConfiguration("cursorSubscription.supervisorMode")
        ) {
          this.updateStatusBar();
          this.refresh();
          this.scheduleAutoRun();
        }
      }),
    );
  }

  public dispose(): void {
    if (this.scheduler) {
      clearTimeout(this.scheduler);
      this.scheduler = undefined;
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
    cancelActiveRun?: () => Promise<void>,
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
    return this.configuration().get<SupervisorMode>("supervisorMode", "observe");
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
    if (task.verification) {
      children.push({
        kind: "detail",
        taskId: task.id,
        label: task.verification.success
          ? this.text("Verification passed", "検証成功")
          : this.text("Verification failed", "検証失敗"),
        description: `${task.verification.steps.length} step(s)`,
      });
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
    const root = await this.currentRepoRoot();
    if (!root) {
      return;
    }
    const now = Date.now();
    const task: SupervisorTask = {
      id: randomUUID(),
      title: goal.trim().split(/\r?\n/, 1)[0].slice(0, 80),
      detail: goal.trim(),
      root,
      source: "manual",
      fingerprint: createHash("sha256").update(goal.trim()).digest("hex"),
      createdAt: now,
      updatedAt: now,
      status: this.mode() === "autonomous" ? "queued" : "detected",
    };
    this.tasks.unshift(task);
    this.trimTasks();
    await this.persist();
    this.refresh();
    this.scheduleAutoRun();
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
      await this.cancelActiveRun?.();
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
    if (this.tasks.some((task) => task.fingerprint === fingerprint && task.status !== "dismissed")) {
      return;
    }
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
    const now = Date.now();
    this.tasks.unshift({
      id: randomUUID(),
      title: this.text(
        `Fix ${errors.length} error(s) in ${relative}`,
        `${relative} のエラー${errors.length}件を修正`,
      ),
      detail: details.join("\n"),
      root,
      source: "diagnostics",
      file: relative,
      fingerprint,
      createdAt: now,
      updatedAt: now,
      status: this.mode() === "autonomous" ? "queued" : "detected",
      diagnostics: details,
    });
    this.trimTasks();
    await this.persist();
    this.refresh();
    this.scheduleAutoRun();
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
    if (this.busyCheck?.() || this.autoRunActive) {
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

    this.autoRunActive = true;
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
      this.attachChangeReasons(task, outcome);
      task.runFinishedAt = Date.now();
      const totalLines = task.changes.reduce(
        (total, change) => total + change.added + change.deleted,
        0,
      );
      const maximumFiles = this.configuration().get<number>("supervisorMaxFiles", 5);
      const maximumLines = this.configuration().get<number>("supervisorMaxChangedLines", 300);
      const reasons: string[] = [];
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
        await this.applyAll({ taskId: task.id }, true);
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
      this.autoRunActive = false;
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
      const root = path.resolve((await git(candidate, ["rev-parse", "--show-toplevel"])).trim());
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
      || this.autoRunActive
      || this.busyCheck?.()
      || !this.withinHourlyBudget()
    ) {
      this.scheduleAutoRun(10_000);
      return;
    }
    const task = this.tasks.find((candidate) =>
      candidate.status === "queued" || candidate.status === "detected"
    );
    if (task) {
      await this.runTask(task.id, true);
    }
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

  private async prepareWorktree(task: SupervisorTask): Promise<string> {
    if (task.worktreePath) {
      await this.cleanupWorktree(task);
    }
    await vscode.workspace.fs.createDirectory(this.storageRoot);
    // Cursor SDK derives its SQLite state path from cwd. A VS Code
    // workspaceStorage path can exceed Windows MAX_PATH after that expansion,
    // so keep the isolated checkout in a deliberately short home-directory path.
    const worktreesRoot = path.join(homedir(), ".cursor-supervisor", "worktrees");
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(worktreesRoot));
    const worktree = path.join(worktreesRoot, task.id);
    await git(task.root, ["worktree", "add", "--detach", worktree, "HEAD"]);
    task.worktreePath = worktree;
    await this.overlayCurrentWorkspace(task.root, worktree);
    task.baselineCommit = (await git(worktree, ["rev-parse", "HEAD"])).trim();
    await this.captureBaseline(task);
    await this.linkNodeModules(task.root, worktree);
    await this.persist();
    return worktree;
  }

  private async overlayCurrentWorkspace(root: string, worktree: string): Promise<void> {
    const tracked = splitNull(await git(root, ["ls-files", "-z"]));
    const untracked = splitNull(await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]));
    for (const relative of new Set([...tracked, ...untracked])) {
      if (this.isExcluded(relative)) {
        continue;
      }
      const source = safePath(root, relative);
      const target = safePath(worktree, relative);
      const state = await fileState(source);
      if (!state.exists) {
        try {
          await vscode.workspace.fs.delete(vscode.Uri.file(target), { recursive: false });
        } catch {
          // The detached worktree may already reflect the deletion.
        }
        continue;
      }
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target)));
      await vscode.workspace.fs.copy(
        vscode.Uri.file(source),
        vscode.Uri.file(target),
        { overwrite: true },
      );
    }
  }

  private async captureBaseline(task: SupervisorTask): Promise<void> {
    if (!task.worktreePath || !task.baselineCommit) {
      return;
    }
    const changed = splitNull(await git(task.worktreePath, [
      "diff", "--name-only", "--no-renames", "-z", task.baselineCommit,
    ]));
    const untracked = splitNull(await git(task.worktreePath, [
      "ls-files", "--others", "--exclude-standard", "-z",
    ]));
    task.initialChangedFiles = [...new Set([...changed, ...untracked])];
    task.baselineFiles = {};
    const backupRoot = vscode.Uri.joinPath(
      this.storageRoot,
      "supervisor-baselines",
      task.id,
    );
    await vscode.workspace.fs.createDirectory(backupRoot);
    for (const relative of task.initialChangedFiles) {
      const current = await fileState(safePath(task.worktreePath, relative));
      if (!current.exists || !current.bytes) {
        task.baselineFiles[relative] = { existed: false };
        continue;
      }
      const backupName = createHash("sha256").update(relative).digest("hex");
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(backupRoot, backupName),
        current.bytes,
      );
      task.baselineFiles[relative] = {
        existed: true,
        hash: hashBytes(current.bytes),
        backupName,
      };
    }
  }

  private async linkNodeModules(root: string, worktree: string): Promise<void> {
    const source = path.join(root, "node_modules");
    const target = path.join(worktree, "node_modules");
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(source));
      if ((stat.type & vscode.FileType.Directory) === 0) {
        return;
      }
    } catch {
      return;
    }
    try {
      const { symlink } = await import("node:fs/promises");
      await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      this.output.appendLine(
        `[${new Date().toISOString()}] AI Supervisor could not link node_modules: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private async collectChanges(task: SupervisorTask): Promise<SupervisorChange[]> {
    if (!task.worktreePath || !task.baselineCommit) {
      return [];
    }
    const changed = splitNull(await git(task.worktreePath, [
      "diff", "--name-only", "--no-renames", "-z", task.baselineCommit,
    ]));
    const untracked = splitNull(await git(task.worktreePath, [
      "ls-files", "--others", "--exclude-standard", "-z",
    ]));
    const paths = [...new Set([
      ...(task.initialChangedFiles ?? []),
      ...changed,
      ...untracked,
    ])];

    const result: SupervisorChange[] = [];
    for (const relative of paths) {
      const baseline = await this.readBaseline(task, relative);
      const current = await fileState(safePath(task.worktreePath, relative));
      const unchanged = baseline.exists === current.exists
        && (!baseline.exists
          || Boolean(
            baseline.bytes
            && current.bytes
            && hashBytes(baseline.bytes) === hashBytes(current.bytes),
          ));
      if (unchanged) {
        continue;
      }
      const kind = !baseline.exists ? "added" : !current.exists ? "deleted" : "modified";
      const stats = lineDiffCounts(baseline.bytes, current.bytes);
      result.push({
        relative,
        kind,
        ...stats,
        excluded: this.isExcluded(relative),
      });
    }
    return result.sort((left, right) => left.relative.localeCompare(right.relative));
  }

  private async readBaseline(
    task: SupervisorTask,
    relative: string,
  ): Promise<{ exists: boolean; bytes?: Uint8Array }> {
    const snapshot = task.baselineFiles?.[relative];
    if (snapshot) {
      if (!snapshot.existed || !snapshot.backupName) {
        return { exists: false };
      }
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(
          this.storageRoot,
          "supervisor-baselines",
          task.id,
          snapshot.backupName,
        ));
        return { exists: true, bytes };
      } catch {
        throw new Error(this.text(
          `The Supervisor baseline for ${relative} is unavailable.`,
          `${relative} のSupervisorベースラインを利用できません。`,
        ));
      }
    }
    if (!task.worktreePath || !task.baselineCommit) {
      return { exists: false };
    }
    try {
      return {
        exists: true,
        bytes: await gitBytes(task.worktreePath, [
          "show", `${task.baselineCommit}:${relative}`,
        ]),
      };
    } catch {
      return { exists: false };
    }
  }

  private async applyOne(task: SupervisorTask, change: SupervisorChange): Promise<void> {
    if (!task.worktreePath || !task.baselineCommit) {
      throw new Error(this.text("The isolated worktree is unavailable.", "隔離worktreeを利用できません。"));
    }
    const baseline = await this.readBaseline(task, change.relative);

    const mainFile = safePath(task.root, change.relative);
    const currentMain = await fileState(mainFile);
    const unchanged = baseline.exists
      ? currentMain.exists
        && currentMain.bytes
        && baseline.bytes
        && hashBytes(currentMain.bytes) === hashBytes(baseline.bytes)
      : !currentMain.exists;
    if (!unchanged) {
      throw new Error(this.text(
        "The file changed after the Supervisor task started. Review and merge it manually.",
        "Supervisor開始後にファイルが変更されています。手動で確認してマージしてください。",
      ));
    }

    const proposed = safePath(task.worktreePath, change.relative);
    const proposedState = await fileState(proposed);
    if (proposedState.exists) {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(mainFile)));
      await vscode.workspace.fs.copy(
        vscode.Uri.file(proposed),
        vscode.Uri.file(mainFile),
        { overwrite: true },
      );
    } else if (currentMain.exists) {
      await vscode.workspace.fs.delete(vscode.Uri.file(mainFile), { recursive: false });
    }
  }

  private async finishDecisions(task: SupervisorTask): Promise<void> {
    if (task.changes?.some((change) => !change.decision)) {
      task.status = task.blockedReasons?.length ? "blocked" : "review";
      return;
    }
    task.status = "completed";
    task.runFinishedAt ??= Date.now();
    await this.cleanupWorktree(task);
  }

  private shouldAutoApply(task: SupervisorTask): boolean {
    if (
      this.mode() !== "autonomous"
      || !this.configuration().get<boolean>("supervisorAutoApplySafeChanges", false)
      || task.blockedReasons?.length
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
    const worktree = task.worktreePath;
    if (!worktree) {
      return;
    }
    try {
      try {
        const { unlink } = await import("node:fs/promises");
        await unlink(path.join(worktree, "node_modules"));
      } catch {
        // node_modules may not have been linked.
      }
      await git(task.root, ["worktree", "remove", "--force", worktree]);
      await git(task.root, ["worktree", "prune"]);
      task.worktreePath = undefined;
      task.baselineCommit = undefined;
      task.baselineFiles = undefined;
      task.initialChangedFiles = undefined;
      try {
        await vscode.workspace.fs.delete(vscode.Uri.joinPath(
          this.storageRoot,
          "supervisor-baselines",
          task.id,
        ), { recursive: true });
      } catch {
        // The baseline directory may already have been cleaned up.
      }
    } catch (error) {
      this.output.appendLine(
        `[${new Date().toISOString()}] AI Supervisor could not remove worktree ${worktree}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
