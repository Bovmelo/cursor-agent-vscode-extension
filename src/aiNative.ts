import { execFile as execFileCallback, spawn } from "node:child_process";
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
import { runConfiguredCommand } from "./shellCommand.js";
import { minimalShellEnv } from "./shellEnv.js";

const execFileAsync = promisify(execFileCallback);
const MAX_VERIFICATION_OUTPUT = 24_000;

function gitExecOptions(
  cwd: string,
  extra?: { maxBuffer?: number },
): {
  cwd: string;
  windowsHide: true;
  env: NodeJS.ProcessEnv;
  maxBuffer?: number;
} {
  return {
    cwd,
    windowsHide: true,
    env: minimalShellEnv(),
    ...extra,
  };
}

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
  stage?: VerificationStage;
  success: boolean;
  output: string;
  durationMs: number;
}

export type VerificationStage = "build" | "lint" | "test" | "e2e" | "other";

export interface VerificationResult {
  success: boolean;
  skipped: boolean;
  steps: VerificationStep[];
}

export interface VerificationRunSnapshot extends VerificationResult {
  at: number;
}

export interface ExactIgnoredPathIndexSnapshot {
  version: 1;
  /** Exact files, plus ignored directory prefixes marked by a trailing slash. */
  entries: string[];
}

export interface BloomIgnoredPathIndexSnapshot {
  version: 2;
  algorithm: "sha256-double-hash-v1";
  bitCount: number;
  hashCount: number;
  entryCount: number;
  bits: string;
}

export type IgnoredPathIndexSnapshot =
  | ExactIgnoredPathIndexSnapshot
  | BloomIgnoredPathIndexSnapshot;

export const MAX_PERSISTED_IGNORED_INDEX_BYTES = 96 * 1024;
const MAX_EXACT_IGNORED_INDEX_BYTES = 64 * 1024;
const IGNORED_BLOOM_BYTES = 64 * 1024;
const IGNORED_BLOOM_HASH_COUNT = 4;

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
  ignoredPathIndexAtCheckpoint?: IgnoredPathIndexSnapshot;
  /** Legacy exact-file index retained for persisted session compatibility. */
  ignoredFilesAtCheckpoint?: string[];
  proposedFiles?: Record<string, ProposedFileSnapshot>;
  nonRestorableFiles?: string[];
  verification?: VerificationResult;
  verificationHistory?: VerificationRunSnapshot[];
  repair?: RepairBudgetSnapshot;
}

export interface RepairBudgetSnapshot {
  attempts: number;
  maxAttempts: number;
  status: "idle" | "repairing" | "succeeded" | "exhausted";
  lastFailure?: string;
}

export interface SessionContentComparison {
  relative: string;
  currentSessionId: string;
  previousSessionId: string;
  currentFile: string;
  previousFile: string;
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
  contentCaptured?: boolean;
  contentBackupName?: string;
}

interface SessionNode {
  kind: "session" | "phase" | "file" | "verification" | "verificationStep" | "repair" | "repairDetail" | "action";
  label: string;
  description?: string;
  tooltip?: string;
  sessionId?: string;
  file?: string;
  contextValue?: string;
  command?: vscode.Command;
}

const SESSION_HISTORY_KEY = "cursorSubscription.changeSessionHistory";
const LAST_SESSION_KEY = "cursorSubscription.lastChangeSession";
const MAX_SESSION_HISTORY = 20;
const MAX_VERIFICATION_HISTORY = 20;

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
      gitExecOptions(root, { maxBuffer: 4 * 1024 * 1024 }),
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
      gitExecOptions(root),
    );
    return true;
  } catch {
    return false;
  }
}

export interface KnownRevisionPaths {
  readonly known: true;
  readonly exact: ReadonlyMap<string, string>;
  readonly folded?: ReadonlyMap<string, string>;
}

interface UnknownRevisionPaths {
  readonly known: false;
}

type RevisionPaths = KnownRevisionPaths | UnknownRevisionPaths;

const UNKNOWN_REVISION_PATHS: UnknownRevisionPaths = { known: false };

export function createRevisionPathIndex(
  revisionPaths: readonly string[],
  caseInsensitive = process.platform === "win32",
): KnownRevisionPaths {
  const exact = new Map<string, string>();
  const folded = caseInsensitive ? new Map<string, string>() : undefined;
  for (const candidate of revisionPaths) {
    exact.set(candidate, candidate);
    if (folded && !folded.has(candidate.toLowerCase())) {
      folded.set(candidate.toLowerCase(), candidate);
    }
  }
  return {
    known: true,
    exact,
    ...(folded ? { folded } : {}),
  };
}

async function listRevisionPaths(root: string, revision: string): Promise<KnownRevisionPaths> {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-tree", "-r", "--name-only", "-z", revision],
    gitExecOptions(root, { maxBuffer: 64 * 1024 * 1024 }),
  );
  return createRevisionPathIndex(stdout.split("\0").filter(Boolean));
}

function ignoredEntryToken(entry: string): string | undefined {
  const normalized = entry.replaceAll("\\", "/");
  const directory = normalized.endsWith("/");
  const key = baselineKey(directory ? normalized.replace(/\/+$/u, "") : normalized);
  return key ? `${directory ? "directory" : "file"}\0${key}` : undefined;
}

function forEachBloomPosition(
  token: string,
  bitCount: number,
  hashCount: number,
  visit: (position: number) => void,
): void {
  const digest = createHash("sha256").update(token).digest();
  const first = digest.readUInt32LE(0);
  const rawSecond = digest.readUInt32LE(4);
  const second = rawSecond % 2 === 0 ? rawSecond + 1 : rawSecond;
  for (let index = 0; index < hashCount; index += 1) {
    visit((first + index * second) % bitCount);
  }
}

function addBloomToken(bits: Uint8Array, token: string, hashCount: number): void {
  forEachBloomPosition(token, bits.byteLength * 8, hashCount, (position) => {
    bits[position >>> 3] |= 1 << (position & 7);
  });
}

function bloomHasToken(
  bits: Uint8Array,
  token: string,
  hashCount: number,
): boolean {
  let present = true;
  forEachBloomPosition(token, bits.byteLength * 8, hashCount, (position) => {
    if ((bits[position >>> 3] & (1 << (position & 7))) === 0) {
      present = false;
    }
  });
  return present;
}

function createIgnoredIndexAccumulator(): {
  add(entry: string): void;
  snapshot(): IgnoredPathIndexSnapshot;
} {
  let entries: string[] | undefined = [];
  let exactBytes = Buffer.byteLength('{"version":1,"entries":[]}');
  let bloomBits: Buffer | undefined;
  let entryCount = 0;

  const addToBloom = (entry: string) => {
    const token = ignoredEntryToken(entry);
    if (token && bloomBits) {
      addBloomToken(bloomBits, token, IGNORED_BLOOM_HASH_COUNT);
    }
  };

  return {
    add(entry) {
      if (!entry) {
        return;
      }
      entryCount += 1;
      if (entries) {
        const addedBytes = Buffer.byteLength(JSON.stringify(entry)) + (entries.length > 0 ? 1 : 0);
        if (exactBytes + addedBytes <= MAX_EXACT_IGNORED_INDEX_BYTES) {
          entries.push(entry);
          exactBytes += addedBytes;
          return;
        }
        bloomBits = Buffer.alloc(IGNORED_BLOOM_BYTES);
        for (const exactEntry of entries) {
          addToBloom(exactEntry);
        }
        entries = undefined;
      }
      addToBloom(entry);
    },
    snapshot() {
      if (entries) {
        return { version: 1, entries };
      }
      const bits = bloomBits ?? Buffer.alloc(IGNORED_BLOOM_BYTES);
      const snapshot: BloomIgnoredPathIndexSnapshot = {
        version: 2,
        algorithm: "sha256-double-hash-v1",
        bitCount: bits.byteLength * 8,
        hashCount: IGNORED_BLOOM_HASH_COUNT,
        entryCount,
        bits: bits.toString("base64"),
      };
      if (Buffer.byteLength(JSON.stringify(snapshot)) > MAX_PERSISTED_IGNORED_INDEX_BYTES) {
        throw new Error("The bounded ignored-path index exceeded its storage limit.");
      }
      return snapshot;
    },
  };
}

function createBoundedIgnoredPathIndex(
  entries: Iterable<string>,
): IgnoredPathIndexSnapshot {
  const accumulator = createIgnoredIndexAccumulator();
  for (const entry of entries) {
    accumulator.add(entry);
  }
  return accumulator.snapshot();
}

async function captureIgnoredWorkspaceIndex(
  root: string,
  signal?: AbortSignal,
): Promise<IgnoredPathIndexSnapshot> {
  signal?.throwIfAborted();
  // --directory collapses trees such as node_modules/ to one prefix. Reading
  // incrementally avoids turning a large set of exact ignore matches into a
  // fixed-maxBuffer failure that would make every new path unknowable.
  const child = spawn(
    "git",
    [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    ],
    {
      cwd: root,
      windowsHide: true,
      env: minimalShellEnv(),
      signal,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  return await new Promise<IgnoredPathIndexSnapshot>((resolve, reject) => {
    const index = createIgnoredIndexAccumulator();
    let pending = "";
    let stderr = "";
    child.stdout.on("data", (chunk: string) => {
      pending += chunk;
      let separator = pending.indexOf("\0");
      while (separator >= 0) {
        const entry = pending.slice(0, separator);
        if (entry) {
          index.add(entry);
        }
        pending = pending.slice(separator + 1);
        separator = pending.indexOf("\0");
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-16_000);
    });
    child.once("error", reject);
    child.once("close", (code, closeSignal) => {
      try {
        signal?.throwIfAborted();
      } catch (error) {
        reject(error);
        return;
      }
      if (code === 0) {
        resolve(index.snapshot());
        return;
      }
      reject(new Error(
        `git ls-files exited with ${code ?? closeSignal ?? "an unknown status"}${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
      ));
    });
  });
}

export function trackedRelativePath(
  relative: string,
  revisionPaths: RevisionPaths,
): string | undefined {
  if (!revisionPaths.known) {
    return undefined;
  }
  const normalized = relative.replaceAll("\\", "/");
  return revisionPaths.exact.get(normalized)
    ?? revisionPaths.folded?.get(normalized.toLowerCase());
}

interface RevisionPathCacheEntry {
  readonly root: string;
  readonly revision: string;
  readonly pending: Promise<KnownRevisionPaths>;
}

interface ExactIgnoredPathIndex {
  readonly kind: "exact";
  readonly exact: ReadonlySet<string>;
  readonly directories: ReadonlySet<string>;
}

interface BloomIgnoredPathIndex {
  readonly kind: "bloom";
  readonly bits: Uint8Array;
  readonly hashCount: number;
}

type IgnoredPathIndex = ExactIgnoredPathIndex | BloomIgnoredPathIndex;

async function readIndexEntry(
  root: string,
  relative: string,
): Promise<{ mode: string; oid: string } | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-files", "--stage", "--", relative],
      gitExecOptions(root, { maxBuffer: 1024 * 1024 }),
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
  private readonly revisionPathCache = new Map<string, RevisionPathCacheEntry>();
  private readonly ignoredPathIndexCache = new Map<string, IgnoredPathIndex>();

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
    let normalizedIgnoredIndexes = false;
    for (const session of this.sessions) {
      const current = session.ignoredPathIndexAtCheckpoint;
      const currentEntries = current?.version === 1 && Array.isArray(current.entries)
        ? current.entries
        : undefined;
      const legacyEntries = Array.isArray(session.ignoredFilesAtCheckpoint)
        ? session.ignoredFilesAtCheckpoint
        : undefined;
      if (
        (!current || currentEntries)
        && (
          legacyEntries
          || (
            currentEntries
            && Buffer.byteLength(JSON.stringify(current)) > MAX_EXACT_IGNORED_INDEX_BYTES
          )
        )
      ) {
        session.ignoredPathIndexAtCheckpoint = createBoundedIgnoredPathIndex([
          ...(currentEntries ?? []),
          ...(legacyEntries ?? []),
        ]);
        delete session.ignoredFilesAtCheckpoint;
        normalizedIgnoredIndexes = true;
      }
    }
    const removed = this.sessions.splice(MAX_SESSION_HISTORY);
    for (const session of removed) {
      void this.deleteCheckpoint(session.id);
    }
    if (removed.length > 0 || normalizedIgnoredIndexes) {
      void this.persist();
    }
  }

  public snapshot(sessionId?: string): ChangeSessionSnapshot | undefined {
    return sessionId ? this.session(sessionId) : this.sessions[0];
  }

  public history(): readonly ChangeSessionSnapshot[] {
    return this.sessions;
  }

  public comparisonMarkdown(sessionId: string): string | undefined {
    const index = this.sessions.findIndex((session) => session.id === sessionId);
    const current = this.sessions[index];
    const previous = index >= 0 ? this.sessions[index + 1] : undefined;
    if (!current || !previous) {
      return undefined;
    }
    return formatSessionComparison(current, previous);
  }

  public contentComparisons(sessionId: string): SessionContentComparison[] {
    const index = this.sessions.findIndex((session) => session.id === sessionId);
    const current = this.sessions[index];
    const previous = index >= 0 ? this.sessions[index + 1] : undefined;
    if (!current || !previous) {
      return [];
    }
    const previousByRelative = new Map(
      previous.files.map((file) => [
        path.relative(previous.root, file).replaceAll("\\", "/"),
        file,
      ]),
    );
    return current.files.flatMap((currentFile) => {
      const relative = path.relative(current.root, currentFile).replaceAll("\\", "/");
      const previousFile = previousByRelative.get(relative);
      const currentSnapshot = current.proposedFiles?.[currentFile];
      const previousSnapshot = previousFile ? previous.proposedFiles?.[previousFile] : undefined;
      return previousFile && currentSnapshot?.contentCaptured && previousSnapshot?.contentCaptured
        ? [{
            relative,
            currentSessionId: current.id,
            previousSessionId: previous.id,
            currentFile,
            previousFile,
          }]
        : [];
    });
  }

  public async proposedContent(sessionId: string, file: string): Promise<string> {
    const session = this.session(sessionId);
    const snapshot = session?.proposedFiles?.[file];
    if (!session || !snapshot?.contentCaptured || !snapshot.contentBackupName) {
      return "";
    }
    const bytes = await vscode.workspace.fs.readFile(
      vscode.Uri.joinPath(
        this.storageRoot,
        "change-sessions",
        session.id,
        snapshot.contentBackupName,
      ),
    );
    return new TextDecoder().decode(bytes);
  }

  public async begin(
    goal: string,
    root: string,
    signal?: AbortSignal,
  ): Promise<ChangeSessionSnapshot> {
    signal?.throwIfAborted();
    const baselineClean = await gitStatusIsClean(root);
    signal?.throwIfAborted();
    const firstLine = goal.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim()
      ?? (this.japanese ? "AI変更セッション" : "AI change session");
    const snapshot: ChangeSessionSnapshot = {
      id: randomUUID(),
      goal: firstLine.length > 80 ? `${firstLine.slice(0, 77)}…` : firstLine,
      root,
      startedAt: Date.now(),
      phase: "observe",
      baselineClean,
      checkpointReady: false,
      files: [],
      fileDecisions: {},
      baselineFiles: {},
    };
    try {
      snapshot.checkpointReady = await this.captureCheckpoint(snapshot, signal);
      signal?.throwIfAborted();
    } catch (error) {
      await this.deleteCheckpoint(snapshot.id);
      throw error;
    }

    const previousSessions = [...this.sessions];
    const nextSessions = [snapshot, ...previousSessions].slice(0, MAX_SESSION_HISTORY);
    const removed = previousSessions.slice(MAX_SESSION_HISTORY - 1);
    let persistenceStarted = false;
    try {
      signal?.throwIfAborted();
      persistenceStarted = true;
      await this.state.update(SESSION_HISTORY_KEY, nextSessions);
      signal?.throwIfAborted();
      await this.state.update(LAST_SESSION_KEY, snapshot);
      signal?.throwIfAborted();
    } catch (error) {
      if (persistenceStarted) {
        try {
          await Promise.all([
            this.state.update(SESSION_HISTORY_KEY, previousSessions),
            this.state.update(LAST_SESSION_KEY, previousSessions[0]),
          ]);
        } catch (rollbackError) {
          this.output.appendLine(
            `[${new Date().toISOString()}] Could not roll back an interrupted change session: ${String(rollbackError)}`,
          );
        }
      }
      await this.deleteCheckpoint(snapshot.id);
      throw error;
    }

    this.sessions.splice(0, this.sessions.length, ...nextSessions);
    this.changedEmitter.fire(undefined);
    // Persistence is the commit point. Do not turn a signal racing with
    // retired-checkpoint cleanup into a rejected begin after the new session
    // is already durable.
    for (const retired of removed) {
      await this.deleteCheckpoint(retired.id);
    }
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
    const history = current.verificationHistory
      ? [...current.verificationHistory]
      : current.verification
        ? [{
            ...current.verification,
            at: current.finishedAt ?? current.startedAt,
            steps: current.verification.steps.map((step) => ({ ...step })),
          }]
        : [];
    history.push({
      ...result,
      at: Date.now(),
      steps: result.steps.map((step) => ({ ...step })),
    });
    current.verificationHistory = history.slice(-MAX_VERIFICATION_HISTORY);
    current.verification = result;
    current.phase = result.success ? "review" : "failed";
    void this.persist();
  }

  public setRepairBudget(repair: RepairBudgetSnapshot, sessionId?: string): void {
    const current = this.snapshot(sessionId);
    if (!current) {
      return;
    }
    current.repair = { ...repair };
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
          ...(await this.captureProposedContent(current, worktree)),
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
    const revisionPaths = candidateHints.length > 0
      ? await this.revisionPathsAtCheckpoint(session)
      : UNKNOWN_REVISION_PATHS;
    const candidates = new Map<string, string>();
    // Insert hints first so Git/status paths, which retain the repository's
    // canonical spelling, win when both identify the same Windows file.
    for (const file of [...candidateHints, ...postRunChanges]) {
      if (isInside(session.root, file)) {
        const absolute = path.resolve(file);
        const relative = path.relative(session.root, absolute).replaceAll("\\", "/");
        const baselineRelative = session.baselineFiles?.[baselineKey(relative)]?.relative;
        const canonicalRelative = baselineRelative
          ?? trackedRelativePath(relative, revisionPaths);
        const canonicalFile = canonicalRelative
          ? path.resolve(session.root, canonicalRelative)
          : absolute;
        candidates.set(fileIdentity(canonicalFile), canonicalFile);
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
        ...(await this.captureProposedContent(session, worktree)),
      };
      if (
        !session.baselineFiles?.[baselineKey(relative)]
        && (await this.baselineFileExists(session.id, file)) === undefined
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
    const revisionPaths = await this.revisionPathsAtCheckpoint(session);
    const trackedRelative = revisionPaths.known
      ? trackedRelativePath(relative, revisionPaths)
      : relative;
    if (!trackedRelative) {
      return "";
    }
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["show", `${session.headOid ?? "HEAD"}:${trackedRelative}`],
        gitExecOptions(session.root, { maxBuffer: 8 * 1024 * 1024 }),
      );
      return stdout;
    } catch {
      return "";
    }
  }

  public async baselineFileExists(
    sessionId: string,
    file: string,
  ): Promise<boolean | undefined> {
    const session = this.session(sessionId);
    if (!session || !isInside(session.root, file)) {
      return undefined;
    }
    const relative = path.relative(session.root, file).replaceAll("\\", "/");
    const baseline = session.baselineFiles?.[baselineKey(relative)];
    if (baseline) {
      return baseline.worktreeExisted;
    }
    if (!(session.checkpointReady ?? session.baselineClean)) {
      return undefined;
    }
    const revisionPaths = await this.revisionPathsAtCheckpoint(session);
    if (!revisionPaths.known) {
      return undefined;
    }
    if (trackedRelativePath(relative, revisionPaths)) {
      return true;
    }
    if (this.wasIgnoredAtCheckpoint(session, relative) !== false) {
      return undefined;
    }
    return false;
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
      } else {
        const trackedRelative = await this.trackedRelativeAtCheckpoint(session, relative);
        if (trackedRelative) {
          await execFileAsync(
            "git",
            [
              "restore",
              `--source=${session.headOid ?? "HEAD"}`,
              "--staged",
              "--worktree",
              "--",
              trackedRelative,
            ],
            gitExecOptions(session.root),
          );
          restored.push(file);
        } else {
          await execFileAsync(
            "git",
            ["rm", "--cached", "--ignore-unmatch", "--", relative],
            gitExecOptions(session.root),
          );
          await this.deleteWorktreeFile(file);
          removed.push(file);
        }
      }
      session.fileDecisions ??= {};
      session.fileDecisions[file] = "restored";
      await this.persist();
    }
    return { restored, removed };
  }

  public dispose(): void {
    this.revisionPathCache.clear();
    this.ignoredPathIndexCache.clear();
    this.changedEmitter.dispose();
  }

  public refresh(): void {
    this.changedEmitter.fire(undefined);
  }

  public getTreeItem(element: SessionNode): vscode.TreeItem {
    const collapsibleState = element.kind === "session"
      ? element.sessionId && this.pendingFiles(element.sessionId).length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.Collapsed
      : element.kind === "verification"
        ? vscode.TreeItemCollapsibleState.Expanded
        : element.kind === "repair"
          ? this.session(element.sessionId)?.repair?.lastFailure
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None
      : vscode.TreeItemCollapsibleState.None;
    const item = new vscode.TreeItem(element.label, collapsibleState);
    item.description = element.description;
    item.tooltip = element.tooltip ?? element.description;
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
      return this.sessions.map((session) => {
        const phase = this.phaseLabel(session.phase);
        const checkpoint = this.checkpointLabel(session);
        const started = new Date(session.startedAt);
        return {
          kind: "session",
          label: session.goal,
          description: `${phase} · ${this.compactTime(started)}`,
          tooltip: [phase, checkpoint, started.toLocaleString()].join("\n"),
          sessionId: session.id,
        };
      });
    }
    if (element.kind === "verification") {
      const session = this.session(element.sessionId);
      return (session?.verification?.steps ?? []).map((step) => ({
        kind: "verificationStep",
        label: `${step.success ? "✓" : "✗"} ${verificationStageLabel(step.stage ?? verificationStage(step.command), this.japanese)}`,
        description: `${Math.max(0, step.durationMs / 1_000).toFixed(1)}s · ${step.command}`,
        sessionId: session?.id,
      }));
    }
    if (element.kind === "repair") {
      const session = this.session(element.sessionId);
      const failure = session?.repair?.lastFailure?.trim();
      return failure
        ? [{
            kind: "repairDetail",
            label: failure.split(/\r?\n/u)[0].slice(0, 180),
            description: this.japanese ? "直近の検証失敗" : "latest verification failure",
            sessionId: session?.id,
          }]
        : [];
    }
    if (element.kind !== "session") {
      return [];
    }
    const session = this.session(element.sessionId);
    if (!session) {
      return [];
    }

    const nodes: SessionNode[] = [];
    const hasRecordedFailure = session.verificationHistory
      ? session.verificationHistory.some((run) => !run.success && !run.skipped)
      : Boolean(session.verification && !session.verification.success && !session.verification.skipped);
    if (session.verification) {
      nodes.push({
        kind: "verification",
        label: this.japanese ? "自動検証" : "Verification",
        description: session.verification.skipped
          ? (this.japanese ? "対象コマンドなし" : "no commands")
          : session.verification.success
            ? (this.japanese ? "成功" : "passed")
            : (this.japanese ? "失敗" : "failed"),
        sessionId: session.id,
      });
    }
    if (session.repair) {
      nodes.push({
        kind: "repair",
        label: this.japanese ? "修復バジェット" : "Repair budget",
        description: `${session.repair.attempts}/${session.repair.maxAttempts} · ${this.repairLabel(session.repair.status)}`,
        sessionId: session.id,
      });
    }
    if (hasRecordedFailure) {
      nodes.push({
        kind: "action",
        label: this.japanese ? "失敗のタイムマシンを開く" : "Open failure time machine",
        sessionId: session.id,
        contextValue: "cursorAiSession.action.failureTimeMachine",
        command: {
          command: "cursorSubscription.openFailureTimeMachine",
          title: this.japanese ? "失敗のタイムマシンを開く" : "Open failure time machine",
          arguments: [session.id],
        },
      });
      if (
        session.id === this.sessions[0]?.id
        && session.verification
        && !session.verification.success
        && !session.verification.skipped
      ) {
        nodes.push({
          kind: "action",
          label: this.japanese ? "検証を再実行" : "Re-run verification",
          sessionId: session.id,
          contextValue: "cursorAiSession.action.reverify",
          command: {
            command: "cursorSubscription.reverifyChangeSession",
            title: this.japanese ? "検証を再実行" : "Re-run verification",
            arguments: [session.id],
          },
        });
      }
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
    if (this.comparisonMarkdown(session.id)) {
      nodes.push({
        kind: "action",
        label: this.japanese ? "前のセッションと比較" : "Compare with previous session",
        sessionId: session.id,
        command: {
          command: "cursorSubscription.compareChangeSessions",
          title: this.japanese ? "セッションを比較" : "Compare sessions",
          arguments: [session.id],
        },
      });
    }
    if (this.contentComparisons(session.id).length > 0) {
      nodes.push({
        kind: "action",
        label: this.japanese ? "セッション間の内容差分を開く" : "Open content diff between sessions",
        sessionId: session.id,
        command: {
          command: "cursorSubscription.compareSessionContents",
          title: this.japanese ? "内容差分を比較" : "Compare session contents",
          arguments: [session.id],
        },
      });
    }
    if (session.files.length > 0) {
      nodes.push({
        kind: "action",
        label: this.japanese ? "変更の根拠を審査" : "Review change evidence",
        sessionId: session.id,
        contextValue: "cursorAiSession.action.changeCourt",
        command: {
          command: "cursorSubscription.reviewChangeSession",
          title: this.japanese ? "変更の根拠を審査" : "Review change evidence",
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
      case "verificationStep":
        return new vscode.ThemeIcon("beaker");
      case "repair":
      case "repairDetail":
        return new vscode.ThemeIcon("wrench");
      case "action":
        if (element.command?.command === "cursorSubscription.openFailureTimeMachine") {
          return new vscode.ThemeIcon("history");
        }
        if (element.command?.command === "cursorSubscription.reverifyChangeSession") {
          return new vscode.ThemeIcon("debug-rerun");
        }
        if (element.command?.command === "cursorSubscription.reviewChangeSession") {
          return new vscode.ThemeIcon("law");
        }
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

  private checkpointLabel(session: ChangeSessionSnapshot): string {
    if (!(session.checkpointReady ?? session.baselineClean)) {
      return this.japanese ? "復元不可" : "unavailable";
    }
    if (session.baselineClean) {
      return this.japanese ? "復元可能" : "revertible";
    }
    return this.japanese ? "未コミット変更を保存済み" : "dirty baseline saved";
  }

  private compactTime(value: Date): string {
    return value.toLocaleString(undefined, {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  private repairLabel(status: RepairBudgetSnapshot["status"]): string {
    const labels: Record<RepairBudgetSnapshot["status"], [string, string]> = {
      idle: ["available", "待機"],
      repairing: ["repairing", "修復中"],
      succeeded: ["succeeded", "成功"],
      exhausted: ["exhausted", "上限到達"],
    };
    return labels[status][this.japanese ? 1 : 0];
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

  private async captureCheckpoint(
    session: ChangeSessionSnapshot,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      signal?.throwIfAborted();
      const { stdout: headOid } = await execFileAsync(
        "git",
        ["rev-parse", "HEAD"],
        gitExecOptions(session.root),
      );
      signal?.throwIfAborted();
      session.headOid = headOid.trim();
      const { stdout: unmerged } = await execFileAsync(
        "git",
        ["ls-files", "--unmerged"],
        gitExecOptions(session.root, { maxBuffer: 1024 * 1024 }),
      );
      signal?.throwIfAborted();
      if (unmerged.trim()) {
        throw new Error("Cannot checkpoint an unmerged Git index.");
      }
      try {
        session.ignoredPathIndexAtCheckpoint = await captureIgnoredWorkspaceIndex(
          session.root,
          signal,
        );
        signal?.throwIfAborted();
      } catch (error) {
        signal?.throwIfAborted();
        // The restore checkpoint remains useful, but an untracked file cannot
        // later be claimed as newly created without this baseline-time index.
        session.ignoredPathIndexAtCheckpoint = undefined;
        this.output.appendLine(
          `[${new Date().toISOString()}] Could not index ignored paths at checkpoint: ${String(error)}`,
        );
      }
      const changedFiles = await listWorkspaceChanges(session.root);
      signal?.throwIfAborted();
      const checkpointFolder = vscode.Uri.joinPath(this.storageRoot, "change-sessions", session.id);
      await vscode.workspace.fs.createDirectory(checkpointFolder);
      signal?.throwIfAborted();
      for (const file of changedFiles) {
        signal?.throwIfAborted();
        if (!isInside(session.root, file)) {
          continue;
        }
        const relative = path.relative(session.root, file).replaceAll("\\", "/");
        const indexEntry = await readIndexEntry(session.root, relative);
        signal?.throwIfAborted();
        const baseline: BaselineFileSnapshot = {
          relative,
          worktreeExisted: false,
          indexMode: indexEntry?.mode,
          indexOid: indexEntry?.oid,
          trackedInHead: await isTrackedInHead(session.root, relative),
        };
        signal?.throwIfAborted();
        const worktree = await readWorktreeState(file);
        signal?.throwIfAborted();
        if (worktree.existed && worktree.bytes) {
          baseline.worktreeExisted = true;
          baseline.backupName = `${randomUUID()}.bin`;
          await vscode.workspace.fs.writeFile(
            vscode.Uri.joinPath(checkpointFolder, baseline.backupName),
            worktree.bytes,
          );
          signal?.throwIfAborted();
        }
        session.baselineFiles![baselineKey(relative)] = baseline;
      }
      return true;
    } catch (error) {
      signal?.throwIfAborted();
      this.output.appendLine(
        `[${new Date().toISOString()}] Could not create change-session checkpoint: ${String(error)}`,
      );
      return false;
    }
  }

  private async captureProposedContent(
    session: ChangeSessionSnapshot,
    worktree: { existed: boolean; bytes?: Uint8Array },
  ): Promise<Pick<ProposedFileSnapshot, "contentCaptured" | "contentBackupName">> {
    if (!worktree.existed || !worktree.bytes) {
      return { contentCaptured: true };
    }
    const checkpointFolder = vscode.Uri.joinPath(this.storageRoot, "change-sessions", session.id);
    await vscode.workspace.fs.createDirectory(checkpointFolder);
    const contentBackupName = `proposed-${randomUUID()}.bin`;
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(checkpointFolder, contentBackupName),
      worktree.bytes,
    );
    return { contentCaptured: true, contentBackupName };
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
        gitExecOptions(session.root),
      );
    } else {
      await execFileAsync(
        "git",
        ["rm", "--cached", "--ignore-unmatch", "--", baseline.relative],
        gitExecOptions(session.root),
      );
    }
  }

  private async deleteCheckpoint(sessionId: string): Promise<void> {
    this.evictSessionCaches(sessionId);
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
      if (!baseline && (await this.baselineFileExists(session.id, file)) === undefined) {
        throw new Error(this.japanese
          ? `${vscode.workspace.asRelativePath(file)} は開始時の状態を確認できないため、自動復元できません。`
          : `${vscode.workspace.asRelativePath(file)} has no known starting state, so it cannot be restored automatically.`);
      }
    }
  }

  private async trackedRelativeAtCheckpoint(
    session: ChangeSessionSnapshot,
    relative: string,
  ): Promise<string | undefined> {
    return trackedRelativePath(relative, await this.revisionPathsAtCheckpoint(session));
  }

  private async revisionPathsAtCheckpoint(
    session: ChangeSessionSnapshot,
  ): Promise<RevisionPaths> {
    const revision = session.headOid ?? "HEAD";
    let entry = this.revisionPathCache.get(session.id);
    if (entry?.root !== session.root || entry.revision !== revision) {
      entry = {
        root: session.root,
        revision,
        pending: listRevisionPaths(session.root, revision),
      };
      this.revisionPathCache.set(session.id, entry);
    }
    try {
      return await entry.pending;
    } catch {
      if (this.revisionPathCache.get(session.id) === entry) {
        this.revisionPathCache.delete(session.id);
      }
      return UNKNOWN_REVISION_PATHS;
    }
  }

  private ignoredPathIndexAtCheckpoint(
    session: ChangeSessionSnapshot,
  ): IgnoredPathIndex | undefined {
    const cached = this.ignoredPathIndexCache.get(session.id);
    if (cached) {
      return cached;
    }
    const current = session.ignoredPathIndexAtCheckpoint;
    const currentEntries = current?.version === 1 && Array.isArray(current.entries)
      ? current.entries
      : undefined;
    const legacyEntries = Array.isArray(session.ignoredFilesAtCheckpoint)
      ? session.ignoredFilesAtCheckpoint
      : undefined;
    if (
      current?.version === 2
      && current.algorithm === "sha256-double-hash-v1"
      && Number.isInteger(current.hashCount)
      && current.hashCount > 0
      && current.hashCount <= 16
      && current.bits.length <= MAX_PERSISTED_IGNORED_INDEX_BYTES
    ) {
      const bits = Buffer.from(current.bits, "base64");
      if (
        bits.byteLength > 0
        && bits.byteLength <= IGNORED_BLOOM_BYTES
        && current.bitCount === bits.byteLength * 8
        && bits.toString("base64") === current.bits
      ) {
        for (const entry of legacyEntries ?? []) {
          addBloomToken(
            bits,
            `file\0${baselineKey(entry)}`,
            current.hashCount,
          );
        }
        const index: BloomIgnoredPathIndex = {
          kind: "bloom",
          bits,
          hashCount: current.hashCount,
        };
        this.ignoredPathIndexCache.set(session.id, index);
        return index;
      }
    }
    if (!currentEntries && !legacyEntries) {
      return undefined;
    }
    const exact = new Set<string>();
    const directories = new Set<string>();
    for (const entry of currentEntries ?? []) {
      const normalized = entry.replaceAll("\\", "/");
      if (normalized.endsWith("/")) {
        const directory = baselineKey(normalized.replace(/\/+$/u, ""));
        if (directory) {
          directories.add(directory);
        }
      } else {
        exact.add(baselineKey(normalized));
      }
    }
    for (const entry of legacyEntries ?? []) {
      exact.add(baselineKey(entry));
    }
    const index: ExactIgnoredPathIndex = { kind: "exact", exact, directories };
    this.ignoredPathIndexCache.set(session.id, index);
    return index;
  }

  private wasIgnoredAtCheckpoint(
    session: ChangeSessionSnapshot,
    relative: string,
  ): boolean | undefined {
    const index = this.ignoredPathIndexAtCheckpoint(session);
    if (!index) {
      return undefined;
    }
    const key = baselineKey(relative).replace(/\/+$/u, "");
    if (
      index.kind === "exact"
        ? index.exact.has(key) || index.directories.has(key)
        : bloomHasToken(index.bits, `file\0${key}`, index.hashCount)
          || bloomHasToken(index.bits, `directory\0${key}`, index.hashCount)
    ) {
      return true;
    }
    let separator = key.length;
    while ((separator = key.lastIndexOf("/", separator - 1)) >= 0) {
      const directory = key.slice(0, separator);
      if (
        index.kind === "exact"
          ? index.directories.has(directory)
          : bloomHasToken(index.bits, `directory\0${directory}`, index.hashCount)
      ) {
        return true;
      }
    }
    return false;
  }

  private evictSessionCaches(sessionId: string): void {
    this.revisionPathCache.delete(sessionId);
    this.ignoredPathIndexCache.delete(sessionId);
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
  signal?: AbortSignal,
): Promise<VerificationResult> {
  signal?.throwIfAborted();
  if (!vscode.workspace.isTrusted) {
    output.appendLine(
      `[${new Date().toISOString()}] Skipping verification in an untrusted workspace.`,
    );
    return { success: true, skipped: true, steps: [] };
  }
  const commands = configuredCommands.length > 0
    ? [...configuredCommands]
    : await detectVerificationCommands(root);
  signal?.throwIfAborted();
  if (commands.length === 0) {
    return { success: true, skipped: true, steps: [] };
  }

  const steps: VerificationStep[] = [];
  const maxCommands = 20;
  const totalStartedAt = Date.now();
  for (const command of commands.slice(0, maxCommands)) {
    signal?.throwIfAborted();
    if (typeof command !== "string" || !command.trim()) {
      continue;
    }
    if (!vscode.workspace.isTrusted) {
      output.appendLine(
        `[${new Date().toISOString()}] Stopping remaining verification commands because the workspace is no longer trusted.`,
      );
      steps.push({
        command: "(workspace trust)",
        stage: "other",
        success: false,
        output: "Verification stopped because the workspace is no longer trusted.",
        durationMs: 0,
      });
      break;
    }
    if (Date.now() - totalStartedAt > 15 * 60_000) {
      steps.push({
        command: "(budget)",
        stage: "other",
        success: false,
        output: "Verification total time budget exceeded.",
        durationMs: Date.now() - totalStartedAt,
      });
      break;
    }
    const startedAt = Date.now();
    output.appendLine(`[${new Date().toISOString()}] Verification: ${command}`);
    try {
      const { stdout, stderr } = await runConfiguredCommand(command, {
        cwd: root,
        timeout: 180_000,
        maxBuffer: 8 * 1024 * 1024,
        signal,
      });
      signal?.throwIfAborted();
      steps.push({
        command,
        stage: verificationStage(command),
        success: true,
        output: compactOutput(`${stdout}${stderr ? `\n${stderr}` : ""}`),
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      signal?.throwIfAborted();
      const failure = error as Error & { stdout?: string; stderr?: string };
      steps.push({
        command,
        stage: verificationStage(command),
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

export function verificationStage(command: string): VerificationStage {
  const normalized = command.toLowerCase();
  if (/\be2e\b|playwright|cypress|selenium/.test(normalized)) {
    return "e2e";
  }
  if (/\btest\b|vitest|jest|mocha|pytest|phpunit|cargo test|go test/.test(normalized)) {
    return "test";
  }
  if (/\blint\b|eslint|ruff|clippy|golangci/.test(normalized)) {
    return "lint";
  }
  if (/\bbuild\b|\bcompile\b|\btsc\b|cargo check/.test(normalized)) {
    return "build";
  }
  return "other";
}

function verificationStageLabel(stage: VerificationStage, japanese: boolean): string {
  const labels: Record<VerificationStage, [string, string]> = {
    build: ["Build", "ビルド"],
    lint: ["Lint", "Lint"],
    test: ["Test", "テスト"],
    e2e: ["E2E", "E2E"],
    other: ["Check", "チェック"],
  };
  return labels[stage][japanese ? 1 : 0];
}

export function formatSessionComparison(
  current: ChangeSessionSnapshot,
  previous: ChangeSessionSnapshot,
): string {
  const relative = (session: ChangeSessionSnapshot, file: string) =>
    path.relative(session.root, file).replaceAll("\\", "/");
  const currentFiles = new Set(current.files.map((file) => relative(current, file)));
  const previousFiles = new Set(previous.files.map((file) => relative(previous, file)));
  const added = [...currentFiles].filter((file) => !previousFiles.has(file)).sort();
  const removed = [...previousFiles].filter((file) => !currentFiles.has(file)).sort();
  const shared = [...currentFiles].filter((file) => previousFiles.has(file)).sort();
  const lines = [
    `# Change session comparison`,
    "",
    `- Current: ${current.goal} (${new Date(current.startedAt).toISOString()})`,
    `- Previous: ${previous.goal} (${new Date(previous.startedAt).toISOString()})`,
    `- Verification: ${current.verification?.success ? "passed" : current.verification ? "failed" : "not run"} / ${previous.verification?.success ? "passed" : previous.verification ? "failed" : "not run"}`,
    "",
    `## Added to current (${added.length})`,
    "",
    ...(added.length ? added.map((file) => `- \`${file}\``) : ["_None._"]),
    "",
    `## Shared (${shared.length})`,
    "",
    ...(shared.length ? shared.map((file) => `- \`${file}\``) : ["_None._"]),
    "",
    `## Only in previous (${removed.length})`,
    "",
    ...(removed.length ? removed.map((file) => `- \`${file}\``) : ["_None._"]),
  ];
  return lines.join("\n");
}

export async function listWorkspaceChanges(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      gitExecOptions(root, { maxBuffer: 8 * 1024 * 1024 }),
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
