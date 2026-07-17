import { exec as execCallback, execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";

const execAsync = promisify(execCallback);
const execFileAsync = promisify(execFileCallback);
const MAX_VERIFICATION_OUTPUT = 24_000;

export type ChangeSessionPhase =
  | "observe"
  | "plan"
  | "edit"
  | "verify"
  | "review"
  | "complete"
  | "failed"
  | "stopped"
  | "reverted";

export interface VerificationStep {
  command: string;
  success: boolean;
  output: string;
  durationMs: number;
}

export interface VerificationResult {
  success: boolean;
  skipped: boolean;
  steps: VerificationStep[];
}

export interface ChangeSessionSnapshot {
  id: string;
  goal: string;
  root: string;
  startedAt: number;
  finishedAt?: number;
  phase: ChangeSessionPhase;
  baselineClean: boolean;
  files: string[];
  verification?: VerificationResult;
}

interface SessionNode {
  kind: "session" | "phase" | "file" | "verification" | "action";
  label: string;
  description?: string;
  file?: string;
  command?: vscode.Command;
}

function compactOutput(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_VERIFICATION_OUTPUT
    ? `${trimmed.slice(0, MAX_VERIFICATION_OUTPUT)}\n… output truncated …`
    : trimmed;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function gitStatusIsClean(root: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain", "--untracked-files=all"],
      { cwd: root, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
    return stdout.trim().length === 0;
  } catch {
    return false;
  }
}

export class ChangeSessionController implements vscode.TreeDataProvider<SessionNode>, vscode.Disposable {
  private readonly changedEmitter = new vscode.EventEmitter<SessionNode | undefined>();
  private current: ChangeSessionSnapshot | undefined;

  public readonly onDidChangeTreeData = this.changedEmitter.event;

  public constructor(
    private readonly state: vscode.Memento,
    private readonly output: vscode.OutputChannel,
    private readonly japanese: boolean,
  ) {
    this.current = state.get<ChangeSessionSnapshot>("cursorSubscription.lastChangeSession");
  }

  public snapshot(): ChangeSessionSnapshot | undefined {
    return this.current;
  }

  public async begin(goal: string, root: string): Promise<ChangeSessionSnapshot> {
    const firstLine = goal.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim()
      ?? (this.japanese ? "AI変更セッション" : "AI change session");
    const snapshot: ChangeSessionSnapshot = {
      id: randomUUID(),
      goal: firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine,
      root,
      startedAt: Date.now(),
      phase: "observe",
      baselineClean: await gitStatusIsClean(root),
      files: [],
    };
    this.current = snapshot;
    await this.persist();
    return snapshot;
  }

  public setPhase(phase: ChangeSessionPhase): void {
    if (!this.current) {
      return;
    }
    this.current.phase = phase;
    if (["complete", "failed", "stopped", "reverted"].includes(phase)) {
      this.current.finishedAt = Date.now();
    }
    void this.persist();
  }

  public noteTool(toolName: string): void {
    const lower = toolName.toLowerCase();
    if (/edit|write|apply.?patch/.test(lower)) {
      this.setPhase("edit");
    } else if (/read|search|grep|find|glob/.test(lower) && this.current?.phase === "observe") {
      this.setPhase("plan");
    }
  }

  public noteFile(filePath: string): void {
    if (!this.current || !isInside(this.current.root, filePath)) {
      return;
    }
    const absolute = path.resolve(filePath);
    if (!this.current.files.includes(absolute)) {
      this.current.files.push(absolute);
      void this.persist();
    }
  }

  public setVerification(result: VerificationResult): void {
    if (!this.current) {
      return;
    }
    this.current.verification = result;
    this.current.phase = result.success ? "review" : "failed";
    void this.persist();
  }

  public canRevert(): boolean {
    return Boolean(
      this.current?.baselineClean
      && this.current.files.length > 0
      && this.current.phase !== "reverted",
    );
  }

  public async revert(): Promise<{ restored: string[]; removed: string[] }> {
    const session = this.current;
    if (!session?.baselineClean) {
      throw new Error(this.japanese
        ? "開始時の作業ツリーがクリーンではないため、このセッションは安全に戻せません。"
        : "This session cannot be safely reverted because the working tree was not clean when it started.");
    }

    const restored: string[] = [];
    const removed: string[] = [];
    for (const file of session.files) {
      if (!isInside(session.root, file)) {
        continue;
      }
      const relative = path.relative(session.root, file).replaceAll("\\", "/");
      let trackedInHead = true;
      try {
        await execFileAsync(
          "git",
          ["cat-file", "-e", `HEAD:${relative}`],
          { cwd: session.root, windowsHide: true },
        );
      } catch {
        trackedInHead = false;
      }

      if (trackedInHead) {
        await execFileAsync(
          "git",
          ["restore", "--source=HEAD", "--staged", "--worktree", "--", relative],
          { cwd: session.root, windowsHide: true },
        );
        restored.push(file);
      } else {
        await execFileAsync(
          "git",
          ["rm", "--cached", "--ignore-unmatch", "--", relative],
          { cwd: session.root, windowsHide: true },
        );
        try {
          await vscode.workspace.fs.delete(vscode.Uri.file(file), { useTrash: true });
          removed.push(file);
        } catch (error) {
          this.output.appendLine(
            `[${new Date().toISOString()}] Could not remove session-created file ${file}: ${String(error)}`,
          );
        }
      }
    }
    this.setPhase("reverted");
    return { restored, removed };
  }

  public dispose(): void {
    this.changedEmitter.dispose();
  }

  public getTreeItem(element: SessionNode): vscode.TreeItem {
    const collapsibleState = element.kind === "session"
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(element.label, collapsibleState);
    item.description = element.description;
    item.command = element.command;
    item.contextValue = `cursorAiSession.${element.kind}`;
    item.iconPath = this.iconFor(element);
    return item;
  }

  public getChildren(element?: SessionNode): SessionNode[] {
    const session = this.current;
    if (!session) {
      return [];
    }
    if (!element) {
      return [{
        kind: "session",
        label: session.goal,
        description: new Date(session.startedAt).toLocaleTimeString(),
      }];
    }
    if (element.kind !== "session") {
      return [];
    }

    const nodes: SessionNode[] = [
      {
        kind: "phase",
        label: this.japanese ? "進行状況" : "Status",
        description: this.phaseLabel(session.phase),
      },
      {
        kind: "phase",
        label: this.japanese ? "チェックポイント" : "Checkpoint",
        description: session.baselineClean
          ? (this.japanese ? "復元可能" : "revertible")
          : (this.japanese ? "開始時に未コミット変更あり" : "baseline was dirty"),
      },
    ];
    if (session.verification) {
      nodes.push({
        kind: "verification",
        label: this.japanese ? "自動検証" : "Verification",
        description: session.verification.skipped
          ? (this.japanese ? "対象コマンドなし" : "no commands")
          : session.verification.success
            ? (this.japanese ? "成功" : "passed")
            : (this.japanese ? "失敗" : "failed"),
      });
    }
    for (const file of session.files) {
      nodes.push({
        kind: "file",
        label: path.basename(file),
        description: vscode.workspace.asRelativePath(file),
        file,
        command: {
          command: "cursorSubscription.openSessionFile",
          title: this.japanese ? "差分を開く" : "Open diff",
          arguments: [file],
        },
      });
    }
    if (this.canRevert()) {
      nodes.push({
        kind: "action",
        label: this.japanese ? "このセッションを元に戻す" : "Revert this session",
        command: {
          command: "cursorSubscription.revertLastSession",
          title: this.japanese ? "元に戻す" : "Revert",
        },
      });
    }
    return nodes;
  }

  private iconFor(element: SessionNode): vscode.ThemeIcon {
    switch (element.kind) {
      case "session":
        return new vscode.ThemeIcon("sparkle");
      case "file":
        return new vscode.ThemeIcon("diff");
      case "verification":
        return new vscode.ThemeIcon(this.current?.verification?.success ? "pass" : "error");
      case "action":
        return new vscode.ThemeIcon("discard");
      default:
        return new vscode.ThemeIcon("circle-filled");
    }
  }

  private phaseLabel(phase: ChangeSessionPhase): string {
    const labels: Record<ChangeSessionPhase, [string, string]> = {
      observe: ["Observing", "調査中"],
      plan: ["Planning", "計画中"],
      edit: ["Editing", "編集中"],
      verify: ["Verifying", "検証中"],
      review: ["Ready for review", "レビュー待ち"],
      complete: ["Complete", "完了"],
      failed: ["Needs attention", "要確認"],
      stopped: ["Stopped", "停止"],
      reverted: ["Reverted", "復元済み"],
    };
    return labels[phase][this.japanese ? 1 : 0];
  }

  private async persist(): Promise<void> {
    await this.state.update("cursorSubscription.lastChangeSession", this.current);
    this.changedEmitter.fire(undefined);
  }
}

export class CursorAiCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  public constructor(private readonly japanese: boolean) {}

  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const diagnostics = context.diagnostics.filter(
      (diagnostic) => diagnostic.range.intersection(range) !== undefined,
    );
    if (diagnostics.length === 0) {
      return [];
    }

    const actions = diagnostics.slice(0, 5).map((diagnostic) => {
      const action = new vscode.CodeAction(
        this.japanese ? `Cursorで修正: ${diagnostic.message}` : `Fix with Cursor: ${diagnostic.message}`,
        vscode.CodeActionKind.QuickFix,
      );
      action.diagnostics = [diagnostic];
      action.isPreferred = false;
      action.command = {
        command: "cursorSubscription.fixDiagnostics",
        title: action.title,
        arguments: [document.uri, diagnostic.range, [diagnostic]],
      };
      return action;
    });

    if (context.diagnostics.length > 1) {
      const all = new vscode.CodeAction(
        this.japanese ? "Cursorでこのファイルの問題をまとめて修正" : "Fix file diagnostics with Cursor",
        vscode.CodeActionKind.QuickFix,
      );
      all.command = {
        command: "cursorSubscription.fixDiagnostics",
        title: all.title,
        arguments: [document.uri, range, context.diagnostics],
      };
      actions.push(all);
    }
    return actions;
  }
}

export async function runVerification(
  root: string,
  configuredCommands: readonly string[],
  output: vscode.OutputChannel,
): Promise<VerificationResult> {
  const commands = configuredCommands.length > 0
    ? [...configuredCommands]
    : await detectVerificationCommands(root);
  if (commands.length === 0) {
    return { success: true, skipped: true, steps: [] };
  }

  const steps: VerificationStep[] = [];
  for (const command of commands) {
    const startedAt = Date.now();
    output.appendLine(`[${new Date().toISOString()}] Verification: ${command}`);
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: root,
        windowsHide: true,
        timeout: 180_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      steps.push({
        command,
        success: true,
        output: compactOutput(`${stdout}${stderr ? `\n${stderr}` : ""}`),
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const failure = error as Error & { stdout?: string; stderr?: string };
      steps.push({
        command,
        success: false,
        output: compactOutput(
          `${failure.stdout ?? ""}${failure.stderr ? `\n${failure.stderr}` : ""}\n${failure.message}`,
        ),
        durationMs: Date.now() - startedAt,
      });
      break;
    }
  }
  return {
    success: steps.every((step) => step.success),
    skipped: false,
    steps,
  };
}

export async function listWorkspaceChanges(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      { cwd: root, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    );
    const entries = stdout.split("\0");
    const files: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.length < 4) {
        continue;
      }
      const status = entry.slice(0, 2);
      const file = entry.slice(3);
      if (file) {
        files.push(path.resolve(root, file));
      }
      if (/[RC]/.test(status) && entries[index + 1]) {
        index += 1;
      }
    }
    return files;
  } catch {
    return [];
  }
}

async function detectVerificationCommands(root: string): Promise<string[]> {
  try {
    const raw = await readFile(path.join(root, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    const scripts = parsed.scripts ?? {};
    if (typeof scripts.validate === "string") {
      return ["npm run validate"];
    }
    return ["compile", "lint", "test"]
      .filter((name) => typeof scripts[name] === "string")
      .map((name) => `npm run ${name}`);
  } catch {
    return [];
  }
}

export interface ReviewFinding {
  file: string;
  line: number;
  endLine?: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  code?: string;
  suggestion?: string;
}

export function parseReviewFindings(raw: string): ReviewFinding[] {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1);
  const parsed = JSON.parse(candidate) as unknown;
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter((item): item is ReviewFinding => {
    if (!item || typeof item !== "object") {
      return false;
    }
    const record = item as Record<string, unknown>;
    return typeof record.file === "string"
      && typeof record.line === "number"
      && typeof record.message === "string"
      && ["error", "warning", "info", "hint"].includes(String(record.severity));
  });
}
