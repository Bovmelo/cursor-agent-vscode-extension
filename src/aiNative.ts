import { exec as execCallback, execFile as execFileCallback } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import {
  baselineKey,
  fileIdentity,
  isPathInside,
  worktreeMatchesProposed,
} from "./safety.js";

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
  checkpointReady?: boolean;
  headOid?: string;
  files: string[];
  fileDecisions?: Record<string, "pending" | "kept" | "restored">;
  baselineFiles?: Record<string, BaselineFileSnapshot>;
  proposedFiles?: Record<string, ProposedFileSnapshot>;
  nonRestorableFiles?: string[];
  verification?: VerificationResult;
}

interface BaselineFileSnapshot {
  relative: string;
  worktreeExisted: boolean;
  backupName?: string;
  indexMode?: string;
  indexOid?: string;
  trackedInHead: boolean;
}

interface ProposedFileSnapshot {
  worktreeExisted: boolean;
  worktreeHash?: string;
  indexMode?: string;
  indexOid?: string;
}

interface SessionNode {
  kind: "session" | "phase" | "file" | "verification" | "action";
  label: string;
  description?: string;
  sessionId?: string;
  file?: string;
  contextValue?: string;
  command?: vscode.Command;
}

const SESSION_HISTORY_KEY = "cursorSubscription.changeSessionHistory";
const LAST_SESSION_KEY = "cursorSubscription.lastChangeSession";
const MAX_SESSION_HISTORY = 20;

function compactOutput(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_VERIFICATION_OUTPUT
    ? `${trimmed.slice(0, MAX_VERIFICATION_OUTPUT)}\n… output truncated …`
    : trimmed;
}

function isInside(root: string, candidate: string): boolean {
  return isPathInside(root, candidate);
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

async function isTrackedInHead(root: string, relative: string): Promise<boolean> {
  try {
    await execFileAsync(
      "git",
      ["cat-file", "-e", `HEAD:${relative}`],
      { cwd: root, windowsHide: true },
    );
    return true;
  } catch {
    return false;
  }
}

async function readIndexEntry(
  root: string,
  relative: string,
): Promise<{ mode: string; oid: string } | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "--stage", "--", relative],
      { cwd: root, windowsHide: true, maxBuffer: 1024 * 1024 },
    );
    const match = stdout.match(/^(\d+)\s+([0-9a-f]+)\s+\d+\t/);
    return match ? { mode: match[1], oid: match[2] } : undefined;
  } catch {
    return undefined;
  }
}

async function readWorktreeState(file: string): Promise<{
  existed: boolean;
  bytes?: Uint8Array;
  hash?: string;
}> {
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(file));
    return {
      existed: true,
      bytes,
      hash: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch {
    return { existed: false };
  }
}

export class ChangeSessionController implements vscode.TreeDataProvider<SessionNode>, vscode.Disposable {
  private readonly changedEmitter = new vscode.EventEmitter<SessionNode | undefined>();
  private readonly sessions: ChangeSessionSnapshot[];

  public readonly onDidChangeTreeData = this.changedEmitter.event;

  public constructor(
    private readonly state: vscode.Memento,
    private readonly output: vscode.OutputChannel,
    private readonly japanese: boolean,
    private readonly storageRoot: vscode.Uri,
    private readonly enabled: () => boolean = () => true,
  ) {
    const history = state.get<ChangeSessionSnapshot[]>(SESSION_HISTORY_KEY);
    const legacy = state.get<ChangeSessionSnapshot>(LAST_SESSION_KEY);
    this.sessions = history?.length ? history : legacy ? [legacy] : [];
    const removed = this.sessions.splice(MAX_SESSION_HISTORY);
    for (const session of removed) {
      void this.deleteCheckpoint(session.id);
    }
    if (removed.length > 0) {
      void this.persist();
    }
  }

  public snapshot(sessionId?: string): ChangeSessionSnapshot | undefined {
    return sessionId ? this.session(sessionId) : this.sessions[0];
  }

  public history(): readonly ChangeSessionSnapshot[] {
    return this.sessions;
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
      checkpointReady: false,
      files: [],
      fileDecisions: {},
      baselineFiles: {},
    };
    snapshot.checkpointReady = await this.captureCheckpoint(snapshot);
    this.sessions.unshift(snapshot);
    const removed = this.sessions.splice(MAX_SESSION_HISTORY);
    for (const session of removed) {
      await this.deleteCheckpoint(session.id);
    }
    await this.persist();
    return snapshot;
  }

  public setPhase(phase: ChangeSessionPhase, sessionId?: string): void {
    if (!this.enabled()) {
      return;
    }
    const current = this.snapshot(sessionId);
    if (!current) {
      return;
    }
    current.phase = phase;
    if (["complete", "failed", "stopped", "reverted"].includes(phase)) {
      current.finishedAt = Date.now();
    }
    void this.persist();
  }

  public noteTool(toolName: string, sessionId?: string): void {
    if (!this.enabled()) {
      return;
    }
    const lower = toolName.toLowerCase();
    if (/edit|write|apply.?patch/.test(lower)) {
      this.setPhase("edit", sessionId);
    } else if (
      /read|search|grep|find|glob/.test(lower)
      && this.snapshot(sessionId)?.phase === "observe"
    ) {
      this.setPhase("plan", sessionId);
    }
  }

  public noteFile(filePath: string, sessionId?: string): void {
    if (!this.enabled()) {
      return;
    }
    const current = this.snapshot(sessionId);
    if (!current || !isInside(current.root, filePath)) {
      return;
    }
    const absolute = path.resolve(filePath);
    if (!current.files.some((file) => fileIdentity(file) === fileIdentity(absolute))) {
      current.files.push(absolute);
      void this.persist();
    }
  }

  public setVerification(result: VerificationResult, sessionId?: string): void {
    if (!this.enabled()) {
      return;
    }
    const current = this.snapshot(sessionId);
    if (!current) {
      return;
    }
    current.verification = result;
    current.phase = result.success ? "review" : "failed";
    void this.persist();
  }

  public async markPending(filePaths: readonly string[], sessionId?: string): Promise<void> {
    const current = this.snapshot(sessionId);
    if (!current) {
      return;
    }
    current.fileDecisions ??= {};
    current.proposedFiles ??= {};
    for (const filePath of filePaths) {
      const absolute = path.resolve(filePath);
      if (isInside(current.root, absolute)) {
        this.noteFile(absolute, sessionId);
        const trackedFile = current.files.find(
          (file) => fileIdentity(file) === fileIdentity(absolute),
        ) ?? absolute;
        current.fileDecisions[trackedFile] = "pending";
        const relative = path.relative(current.root, absolute).replaceAll("\\", "/");
        const worktree = await readWorktreeState(absolute);
        const indexEntry = await readIndexEntry(current.root, relative);
        current.proposedFiles[trackedFile] = {
          worktreeExisted: worktree.existed,
          worktreeHash: worktree.hash,
          indexMode: indexEntry?.mode,
          indexOid: indexEntry?.oid,
        };
      }
    }
    current.phase = "review";
    await this.persist();
  }

  public async detectChangedFiles(
    candidateHints: readonly string[] = [],
    sessionId?: string,
    restrictToCandidateHints = false,
  ): Promise<string[]> {
    const session = this.snapshot(sessionId);
    if (!session) {
      return [];
    }
    const restrict = restrictToCandidateHints && candidateHints.length > 0;
    const postRunChanges = restrict ? [] : await listWorkspaceChanges(session.root);
    const postRunIdentities = new Set(postRunChanges.map((file) => fileIdentity(file)));
    const hintIdentities = new Set(candidateHints.map((file) => fileIdentity(file)));
    const candidates = new Map<string, string>();
    for (const file of [...postRunChanges, ...candidateHints]) {
      if (isInside(session.root, file)) {
        candidates.set(fileIdentity(file), path.resolve(file));
      }
    }
    if (!restrict) {
      for (const baseline of Object.values(session.baselineFiles ?? {})) {
        const file = path.resolve(session.root, baseline.relative);
        candidates.set(fileIdentity(file), file);
      }
    }

    const changed: string[] = [];
    for (const [identity, file] of candidates) {
      const relative = path.relative(session.root, file).replaceAll("\\", "/");
      const baseline = session.baselineFiles?.[baselineKey(relative)];
      if (!baseline) {
        if (postRunIdentities.has(identity) || hintIdentities.has(identity)) {
          changed.push(file);
        }
        continue;
      }
      const worktree = await readWorktreeState(file);
      const indexEntry = await readIndexEntry(session.root, relative);
      const baselineBytes = baseline.backupName
        ? await vscode.workspace.fs.readFile(
            vscode.Uri.joinPath(
              this.storageRoot,
              "change-sessions",
              session.id,
              baseline.backupName,
            ),
          )
        : undefined;
      const baselineHash = baselineBytes
        ? createHash("sha256").update(baselineBytes).digest("hex")
        : undefined;
      if (
        worktree.existed !== baseline.worktreeExisted
        || worktree.hash !== baselineHash
        || indexEntry?.mode !== baseline.indexMode
        || indexEntry?.oid !== baseline.indexOid
      ) {
        changed.push(file);
      }
    }
    session.files = changed;
    session.proposedFiles ??= {};
    session.nonRestorableFiles = [];
    for (const file of changed) {
      const relative = path.relative(session.root, file).replaceAll("\\", "/");
      const worktree = await readWorktreeState(file);
      const indexEntry = await readIndexEntry(session.root, relative);
      session.proposedFiles[file] = {
        worktreeExisted: worktree.existed,
        worktreeHash: worktree.hash,
        indexMode: indexEntry?.mode,
        indexOid: indexEntry?.oid,
      };
      if (
        !session.baselineFiles?.[baselineKey(relative)]
        && !(await this.isTrackedAtCheckpoint(session, relative))
        && await this.isIgnored(session.root, relative)
      ) {
        session.nonRestorableFiles.push(file);
      }
    }
    await this.persist();
    return changed;
  }

  public pendingFiles(sessionId = this.snapshot()?.id): string[] {
    const session = this.session(sessionId);
    if (!session) {
      return [];
    }
    return session.files.filter((file) => session.fileDecisions?.[file] === "pending");
  }

  public keptFiles(sessionId = this.snapshot()?.id): string[] {
    const session = this.session(sessionId);
    if (!session) {
      return [];
    }
    return session.files.filter((file) => session.fileDecisions?.[file] !== "restored");
  }

  public async baselineContent(sessionId: string, file: string): Promise<string> {
    const session = this.session(sessionId);
    if (!session || !isInside(session.root, file)) {
      return "";
    }
    const relative = path.relative(session.root, file).replaceAll("\\", "/");
    const baseline = session.baselineFiles?.[baselineKey(relative)];
    if (baseline) {
      if (!baseline.worktreeExisted || !baseline.backupName) {
        return "";
      }
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(this.storageRoot, "change-sessions", session.id, baseline.backupName),
      );
      return new TextDecoder().decode(bytes);
    }
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["show", `${session.headOid ?? "HEAD"}:${relative}`],
        { cwd: session.root, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
      );
      return stdout;
    } catch {
      return "";
    }
  }

  public keep(file: string, sessionId = this.snapshot()?.id): void {
    const session = this.session(sessionId);
    if (!session || session.fileDecisions?.[file] !== "pending") {
      return;
    }
    session.fileDecisions ??= {};
    session.fileDecisions[file] = "kept";
    void this.persist();
  }

  public keepAll(sessionId = this.snapshot()?.id): void {
    const session = this.session(sessionId);
    if (!session) {
      return;
    }
    session.fileDecisions ??= {};
    for (const file of session.files) {
      if (session.fileDecisions[file] === "pending") {
        session.fileDecisions[file] = "kept";
      }
    }
    void this.persist();
  }

  public canRevert(sessionId = this.snapshot()?.id): boolean {
    if (!this.enabled()) {
      return false;
    }
    const session = this.session(sessionId);
    return Boolean(
      session
      && session.id === this.snapshot()?.id
      && (session.checkpointReady ?? session.baselineClean)
      && session.files.length > 0
      && (session.nonRestorableFiles?.length ?? 0) === 0
      && session.phase !== "reverted",
    );
  }

  public canRestoreFile(file: string, sessionId = this.snapshot()?.id): boolean {
    const session = this.session(sessionId);
    return Boolean(
      session
      && (session.checkpointReady ?? session.baselineClean)
      && !session.nonRestorableFiles?.some(
        (candidate) => fileIdentity(candidate) === fileIdentity(file),
      ),
    );
  }

  public canRestorePending(sessionId = this.snapshot()?.id): boolean {
    return this.pendingFiles(sessionId).every((file) => this.canRestoreFile(file, sessionId));
  }

  public async restoreFile(
    file: string,
    sessionId = this.snapshot()?.id,
  ): Promise<{ restored: string[]; removed: string[] }> {
    const session = this.session(sessionId);
    if (!session || !session.files.includes(file)) {
      return { restored: [], removed: [] };
    }
    if (session.fileDecisions?.[file] !== "pending") {
      return { restored: [], removed: [] };
    }
    if (!(session.checkpointReady ?? session.baselineClean)) {
      throw new Error(this.japanese
        ? "このセッションには安全に復元できるチェックポイントがありません。"
        : "This session does not have a safe checkpoint to restore.");
    }
    const result = await this.restoreFiles(session, [file]);
    return result;
  }

  public async restorePending(
    sessionId = this.snapshot()?.id,
  ): Promise<{ restored: string[]; removed: string[] }> {
    const session = this.session(sessionId);
    if (!session) {
      return { restored: [], removed: [] };
    }
    if (!(session.checkpointReady ?? session.baselineClean)) {
      throw new Error(this.japanese
        ? "このセッションには安全に復元できるチェックポイントがありません。"
        : "This session does not have a safe checkpoint to restore.");
    }
    const files = this.pendingFiles(session.id);
    return this.restoreFiles(session, files);
  }

  public async revert(sessionId = this.snapshot()?.id): Promise<{ restored: string[]; removed: string[] }> {
    const session = this.session(sessionId);
    if (!session || !(session.checkpointReady ?? session.baselineClean)) {
      throw new Error(this.japanese
        ? "このセッションには安全に復元できるチェックポイントがありません。"
        : "This session does not have a safe checkpoint to restore.");
    }
    const result = await this.restoreFiles(session, session.files);
    session.phase = "reverted";
    session.finishedAt = Date.now();
    await this.persist();
    return result;
  }

  private async restoreFiles(
    session: ChangeSessionSnapshot,
    files: readonly string[],
  ): Promise<{ restored: string[]; removed: string[] }> {
    await this.assertCanRestore(session, files);
    const restored: string[] = [];
    const removed: string[] = [];
    for (const file of files) {
      if (!isInside(session.root, file)) {
        continue;
      }
      const relative = path.relative(session.root, file).replaceAll("\\", "/");
      const baseline = session.baselineFiles?.[baselineKey(relative)];

      if (baseline) {
        await this.restoreBaselineFile(session, file, baseline);
        (baseline.worktreeExisted ? restored : removed).push(file);
      } else if (await this.isTrackedAtCheckpoint(session, relative)) {
        await execFileAsync(
          "git",
          ["restore", `--source=${session.headOid ?? "HEAD"}`, "--staged", "--worktree", "--", relative],
          { cwd: session.root, windowsHide: true },
        );
        restored.push(file);
      } else {
        await execFileAsync(
          "git",
          ["rm", "--cached", "--ignore-unmatch", "--", relative],
          { cwd: session.root, windowsHide: true },
        );
        await this.deleteWorktreeFile(file);
        removed.push(file);
      }
      session.fileDecisions ??= {};
      session.fileDecisions[file] = "restored";
      await this.persist();
    }
    return { restored, removed };
  }

  public dispose(): void {
    this.changedEmitter.dispose();
  }

  public refresh(): void {
    this.changedEmitter.fire(undefined);
  }

  public getTreeItem(element: SessionNode): vscode.TreeItem {
    const collapsibleState = element.kind === "session"
      ? element.sessionId === this.snapshot()?.id
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(element.label, collapsibleState);
    item.description = element.description;
    item.command = element.command;
    item.contextValue = element.contextValue ?? `cursorAiSession.${element.kind}`;
    item.iconPath = this.iconFor(element);
    return item;
  }

  public getChildren(element?: SessionNode): SessionNode[] {
    if (!this.enabled()) {
      return [];
    }
    if (!element) {
      return this.sessions.map((session) => ({
        kind: "session",
        label: session.goal,
        description: new Date(session.startedAt).toLocaleString(),
        sessionId: session.id,
      }));
    }
    if (element.kind !== "session") {
      return [];
    }
    const session = this.session(element.sessionId);
    if (!session) {
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
        description: (session.checkpointReady ?? session.baselineClean)
          ? session.baselineClean
            ? (this.japanese ? "復元可能" : "revertible")
            : (this.japanese ? "未コミット変更を保存済み" : "dirty baseline saved")
          : (this.japanese ? "復元不可" : "unavailable"),
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
        description: [
          vscode.workspace.asRelativePath(file),
          this.fileDecisionLabel(session.fileDecisions?.[file]),
        ].filter(Boolean).join(" · "),
        sessionId: session.id,
        file,
        contextValue: session.fileDecisions?.[file] === "pending"
          ? this.canRestoreFile(file, session.id)
            ? "cursorAiSession.file.pending"
            : "cursorAiSession.file.pendingKeepOnly"
          : "cursorAiSession.file",
        command: {
          command: "cursorSubscription.openSessionFile",
          title: this.japanese ? "差分を開く" : "Open diff",
          arguments: [session.id, file],
        },
      });
    }
    if (this.pendingFiles(session.id).length > 0) {
      nodes.push({
        kind: "action",
        label: this.japanese ? "すべて保持" : "Keep all",
        sessionId: session.id,
        command: {
          command: "cursorSubscription.keepAllSessionEdits",
          title: this.japanese ? "すべて保持" : "Keep all",
          arguments: [session.id],
        },
      });
      if (this.canRestorePending(session.id)) {
        nodes.push({
          kind: "action",
          label: this.japanese ? "すべて復元" : "Restore all",
          sessionId: session.id,
          command: {
            command: "cursorSubscription.restoreAllSessionEdits",
            title: this.japanese ? "すべて復元" : "Restore all",
            arguments: [session.id],
          },
        });
      }
    }
    if (this.canRevert(session.id)) {
      nodes.push({
        kind: "action",
        label: this.japanese ? "このセッションを元に戻す" : "Revert this session",
        sessionId: session.id,
        command: {
          command: "cursorSubscription.revertLastSession",
          title: this.japanese ? "元に戻す" : "Revert",
          arguments: [session.id],
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
        return new vscode.ThemeIcon("beaker");
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
    await Promise.all([
      this.state.update(SESSION_HISTORY_KEY, this.sessions),
      this.state.update(LAST_SESSION_KEY, this.snapshot()),
    ]);
    this.changedEmitter.fire(undefined);
  }

  private session(sessionId: string | undefined): ChangeSessionSnapshot | undefined {
    return sessionId ? this.sessions.find((session) => session.id === sessionId) : undefined;
  }

  private fileDecisionLabel(
    decision: "pending" | "kept" | "restored" | undefined,
  ): string | undefined {
    if (!decision) {
      return undefined;
    }
    const labels = {
      pending: ["pending review", "確認待ち"],
      kept: ["kept", "保持"],
      restored: ["restored", "復元"],
    } as const;
    return labels[decision][this.japanese ? 1 : 0];
  }

  private async captureCheckpoint(session: ChangeSessionSnapshot): Promise<boolean> {
    try {
      const { stdout: headOid } = await execFileAsync(
        "git",
        ["rev-parse", "HEAD"],
        { cwd: session.root, windowsHide: true },
      );
      session.headOid = headOid.trim();
      const { stdout: unmerged } = await execFileAsync(
        "git",
        ["ls-files", "--unmerged"],
        { cwd: session.root, windowsHide: true, maxBuffer: 1024 * 1024 },
      );
      if (unmerged.trim()) {
        throw new Error("Cannot checkpoint an unmerged Git index.");
      }
      const changedFiles = await listWorkspaceChanges(session.root);
      const checkpointFolder = vscode.Uri.joinPath(this.storageRoot, "change-sessions", session.id);
      await vscode.workspace.fs.createDirectory(checkpointFolder);
      for (const file of changedFiles) {
        if (!isInside(session.root, file)) {
          continue;
        }
        const relative = path.relative(session.root, file).replaceAll("\\", "/");
        const indexEntry = await readIndexEntry(session.root, relative);
        const baseline: BaselineFileSnapshot = {
          relative,
          worktreeExisted: false,
          indexMode: indexEntry?.mode,
          indexOid: indexEntry?.oid,
          trackedInHead: await isTrackedInHead(session.root, relative),
        };
        const worktree = await readWorktreeState(file);
        if (worktree.existed && worktree.bytes) {
          baseline.worktreeExisted = true;
          baseline.backupName = `${randomUUID()}.bin`;
          await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(checkpointFolder, baseline.backupName),
            worktree.bytes,
          );
        }
        session.baselineFiles![baselineKey(relative)] = baseline;
      }
      return true;
    } catch (error) {
      this.output.appendLine(
        `[${new Date().toISOString()}] Could not create change-session checkpoint: ${String(error)}`,
      );
      return false;
    }
  }

  private async restoreBaselineFile(
    session: ChangeSessionSnapshot,
    file: string,
    baseline: BaselineFileSnapshot,
  ): Promise<void> {
    const uri = vscode.Uri.file(file);
    if (baseline.worktreeExisted && baseline.backupName) {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(this.storageRoot, "change-sessions", session.id, baseline.backupName),
      );
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(file)));
      await vscode.workspace.fs.writeFile(uri, bytes);
    } else {
      await this.deleteWorktreeFile(file);
    }

    if (baseline.indexMode && baseline.indexOid) {
      await execFileAsync(
        "git",
        ["update-index", "--add", "--cacheinfo", `${baseline.indexMode},${baseline.indexOid},${baseline.relative}`],
        { cwd: session.root, windowsHide: true },
      );
    } else {
      await execFileAsync(
        "git",
        ["rm", "--cached", "--ignore-unmatch", "--", baseline.relative],
        { cwd: session.root, windowsHide: true },
      );
    }
  }

  private async deleteCheckpoint(sessionId: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(
        vscode.Uri.joinPath(this.storageRoot, "change-sessions", sessionId),
        { recursive: true },
      );
    } catch {
      // Older sessions may not have checkpoint files.
    }
  }

  private async assertCanRestore(
    session: ChangeSessionSnapshot,
    files: readonly string[],
  ): Promise<void> {
    for (const file of files) {
      const proposed = session.proposedFiles?.[file];
      if (proposed) {
        const current = await readWorktreeState(file);
        const relative = path.relative(session.root, file).replaceAll("\\", "/");
        const indexEntry = await readIndexEntry(session.root, relative);
        if (!worktreeMatchesProposed(
          {
            existed: current.existed,
            hash: current.hash,
            indexMode: indexEntry?.mode,
            indexOid: indexEntry?.oid,
          },
          {
            existed: proposed.worktreeExisted,
            hash: proposed.worktreeHash,
            indexMode: proposed.indexMode,
            indexOid: proposed.indexOid,
          },
        )) {
          throw new Error(this.japanese
            ? `${vscode.workspace.asRelativePath(file)} はAI編集後に変更されたため、自動復元を中止しました。`
            : `${vscode.workspace.asRelativePath(file)} changed after the AI edit, so automatic restore was cancelled.`);
        }
      }

      const relative = path.relative(session.root, file).replaceAll("\\", "/");
      const baseline = session.baselineFiles?.[baselineKey(relative)];
      if (!baseline && !(await this.isTrackedAtCheckpoint(session, relative))) {
        if (await this.isIgnored(session.root, relative)) {
          throw new Error(this.japanese
            ? `${vscode.workspace.asRelativePath(file)} は開始時の状態を確認できない除外ファイルのため、自動復元できません。`
            : `${vscode.workspace.asRelativePath(file)} is ignored and has no known starting state, so it cannot be restored automatically.`);
        }
      }
    }
  }

  private async isTrackedAtCheckpoint(
    session: ChangeSessionSnapshot,
    relative: string,
  ): Promise<boolean> {
    try {
      await execFileAsync(
        "git",
        ["cat-file", "-e", `${session.headOid ?? "HEAD"}:${relative}`],
        { cwd: session.root, windowsHide: true },
      );
      return true;
    } catch {
      return false;
    }
  }

  private async isIgnored(root: string, relative: string): Promise<boolean> {
    try {
      await execFileAsync(
        "git",
        ["check-ignore", "-q", "--", relative],
        { cwd: root, windowsHide: true },
      );
      return true;
    } catch (error) {
      if ((error as { code?: number }).code === 1) {
        return false;
      }
      throw error;
    }
  }

  private async deleteWorktreeFile(file: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(file), { useTrash: true });
    } catch (error) {
      if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {
        return;
      }
      throw error;
    }
  }
}

export class CursorAiCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  public constructor(
    private readonly japanese: boolean,
    private readonly enabled: () => boolean = () => true,
  ) {}

  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    if (!this.enabled()) {
      return [];
    }
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
