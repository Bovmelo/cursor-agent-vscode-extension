import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  type FileHandle,
  rmdir,
  unlink,
} from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  canApplyAgainstBaseline,
  hashBytes,
  isPathInside,
  resolveCanonicalPath,
  safeResolvePath,
  safeResolvePathResolved,
} from "./safety.js";
import { createSecretContentMatcher } from "./sensitivePathMatch.js";
import { minimalShellEnv } from "./shellEnv.js";
import { hasConflictMarkers, threeWayMergeBytes } from "./threeWayMerge.js";
import {
  linkManagedNodeModules,
  removeManagedWorktree,
  runGit,
  withManagedWorktree,
} from "./worktreeLifecycle.js";

const MAX_GIT_OUTPUT = 32 * 1024 * 1024;

export interface IsolatedBaselineFile {
  existed: boolean;
  hash?: string;
  backupName?: string;
}

export interface IsolatedWorktreeSession {
  id: string;
  root: string;
  worktreePath: string;
  baselineCommit: string;
  baselineFiles: Record<string, IsolatedBaselineFile>;
  initialChangedFiles: string[];
  baselinesFolder: string;
}

export interface IsolatedChange {
  relative: string;
  kind: "added" | "modified" | "deleted";
  added: number;
  deleted: number;
}

export interface PrepareIsolatedWorktreeOptions {
  id: string;
  root: string;
  storageRoot: vscode.Uri;
  /** Short home-relative segment, e.g. `.cursor-supervisor/worktrees`. */
  worktreesHomeSegment: string;
  /** Folder under storageRoot for baseline byte backups. */
  baselinesFolder: string;
  isExcluded?: (relative: string) => boolean;
  onLog?: (message: string) => void;
  pathEscapeLabel?: string;
  beforeCaptureBaseline?: (worktreePath: string) => Promise<void>;
}

export { hashBytes };

export function normalizedRelative(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function isInside(root: string, candidate: string): boolean {
  return isPathInside(root, candidate);
}

export function safePath(
  root: string,
  relative: string,
  pathEscapeLabel = "isolated worktree",
): string {
  try {
    return safeResolvePath(root, relative);
  } catch {
    throw new Error(`Path escapes the ${pathEscapeLabel} workspace: ${relative}`);
  }
}

async function safePathResolved(
  root: string,
  relative: string,
  pathEscapeLabel = "isolated worktree",
): Promise<string> {
  try {
    return await safeResolvePathResolved(root, relative);
  } catch {
    throw new Error(`Path escapes the ${pathEscapeLabel} workspace: ${relative}`);
  }
}

interface FileSnapshot {
  exists: boolean;
  bytes?: Uint8Array;
  mode?: number;
}

interface AnchoredMutationTarget {
  canonicalRoot: string;
  lexicalPath: string;
  operationPath: string;
  parentHandle?: FileHandle;
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function pathChangedError(relative: string): Error {
  return new Error(`The apply target changed while it was being validated: ${relative}`);
}

function pathEscapeError(relative: string, pathEscapeLabel: string): Error {
  return new Error(`Path escapes the ${pathEscapeLabel} workspace: ${relative}`);
}

async function removeCreatedMutationDirectory(
  directory: string,
  identity: BigIntStats,
): Promise<void> {
  try {
    const canonical = await resolveCanonicalPath(directory);
    const current = await lstat(canonical, { bigint: true });
    if (current.isDirectory() && sameFileIdentity(identity, current)) {
      await rmdir(canonical);
    }
  } catch {
    // Best effort: never remove a directory whose identity no longer matches.
  }
}

/**
 * Create missing parent directories one component at a time and reject symlink
 * ancestors. The target is revalidated again after its parent is opened below.
 */
async function ensureMutationParent(
  canonicalRoot: string,
  relative: string,
  pathEscapeLabel: string,
): Promise<string> {
  const lexicalTarget = safePath(canonicalRoot, relative, pathEscapeLabel);
  const parent = path.dirname(lexicalTarget);
  const parentRelative = path.relative(canonicalRoot, parent);
  if (!parentRelative) {
    return canonicalRoot;
  }

  let current = canonicalRoot;
  for (const segment of parentRelative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let createdByUs: BigIntStats | undefined;
    try {
      const state = await lstat(current, { bigint: true });
      if (state.isSymbolicLink() || !state.isDirectory()) {
        throw pathEscapeError(relative, pathEscapeLabel);
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        throw error;
      }
      const currentRelative = path.relative(canonicalRoot, current);
      await safePathResolved(canonicalRoot, currentRelative, pathEscapeLabel);
      try {
        await mkdir(current);
      } catch (mkdirError) {
        if (!isNodeError(mkdirError, "EEXIST")) {
          throw mkdirError;
        }
      }
      const created = await lstat(current, { bigint: true });
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw pathEscapeError(relative, pathEscapeLabel);
      }
      createdByUs = created;
    }
    try {
      await safePathResolved(
        canonicalRoot,
        path.relative(canonicalRoot, current),
        pathEscapeLabel,
      );
    } catch (error) {
      if (createdByUs) {
        await removeCreatedMutationDirectory(current, createdByUs);
      }
      throw error;
    }
  }
  return parent;
}

async function verifyHandleMatchesPath(
  handle: FileHandle,
  file: string,
  requireDirectory: boolean,
): Promise<void> {
  const [opened, current] = await Promise.all([
    handle.stat({ bigint: true }),
    lstat(file, { bigint: true }),
  ]);
  const correctType = requireDirectory
    ? opened.isDirectory() && current.isDirectory()
    : opened.isFile() && current.isFile();
  if (
    !correctType
    || current.isSymbolicLink()
    || !sameFileIdentity(opened, current)
    || (!requireDirectory && opened.nlink !== 1n)
  ) {
    throw new Error("The filesystem entry changed while it was being validated.");
  }
}

/**
 * Anchor mutations to a verified directory handle on Linux. Other platforms
 * still verify the opened file handle against the re-resolved path before any
 * bytes are changed.
 */
async function mutationTarget(
  root: string,
  relative: string,
  pathEscapeLabel: string,
): Promise<AnchoredMutationTarget> {
  const canonicalRoot = await resolveCanonicalPath(root);
  const lexicalPath = safePath(canonicalRoot, relative, pathEscapeLabel);
  const parent = await ensureMutationParent(canonicalRoot, relative, pathEscapeLabel);
  await safePathResolved(canonicalRoot, relative, pathEscapeLabel);

  if (process.platform !== "linux") {
    return { canonicalRoot, lexicalPath, operationPath: lexicalPath };
  }

  const directoryFlags = fsConstants.O_RDONLY
    | (fsConstants.O_DIRECTORY ?? 0)
    | (fsConstants.O_NOFOLLOW ?? 0);
  const parentHandle = await open(parent, directoryFlags);
  try {
    await safePathResolved(
      canonicalRoot,
      path.relative(canonicalRoot, parent) || ".",
      pathEscapeLabel,
    );
    await verifyHandleMatchesPath(parentHandle, parent, true);
    return {
      canonicalRoot,
      lexicalPath,
      operationPath: `/proc/self/fd/${parentHandle.fd}/${path.basename(lexicalPath)}`,
      parentHandle,
    };
  } catch (error) {
    await parentHandle.close();
    throw error;
  }
}

async function verifyMutationHandle(
  target: AnchoredMutationTarget,
  relative: string,
  pathEscapeLabel: string,
  handle: FileHandle,
): Promise<void> {
  await safePathResolved(target.canonicalRoot, relative, pathEscapeLabel);
  await verifyHandleMatchesPath(handle, target.operationPath, false);
  await verifyHandleMatchesPath(handle, target.lexicalPath, false);
}

async function readHandle(handle: FileHandle): Promise<Uint8Array> {
  return new Uint8Array(await handle.readFile());
}

/** Read content and mode from the same verified handle so a source swap cannot import outside data. */
async function readValidatedFile(
  root: string,
  relative: string,
  pathEscapeLabel: string,
): Promise<FileSnapshot> {
  const canonicalRoot = await resolveCanonicalPath(root);
  const lexicalPath = safePath(canonicalRoot, relative, pathEscapeLabel);
  let handle: FileHandle | undefined;
  try {
    await safePathResolved(canonicalRoot, relative, pathEscapeLabel);
    handle = await open(
      lexicalPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    await safePathResolved(canonicalRoot, relative, pathEscapeLabel);
    await verifyHandleMatchesPath(handle, lexicalPath, false);
    const [bytes, state] = await Promise.all([readHandle(handle), handle.stat()]);
    return { exists: true, bytes, mode: state.mode };
  } catch (error) {
    if (isNodeError(error, "ENOENT") && !handle) {
      return { exists: false };
    }
    if (isNodeError(error, "ENOENT") || isNodeError(error, "ELOOP")) {
      throw pathChangedError(relative);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

async function removeCreatedMutationFile(
  target: AnchoredMutationTarget,
  handle: FileHandle,
): Promise<void> {
  try {
    const [opened, canonical] = await Promise.all([
      handle.stat({ bigint: true }),
      resolveCanonicalPath(target.lexicalPath),
    ]);
    const current = await lstat(canonical, { bigint: true });
    if (current.isFile() && sameFileIdentity(opened, current)) {
      await unlink(canonical);
    }
  } catch {
    // Best effort: only remove a path that still identifies the file this call created.
  }
}

async function writeHandle(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  await handle.truncate(0);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(
      bytes,
      offset,
      bytes.byteLength - offset,
      offset,
    );
    if (result.bytesWritten <= 0) {
      throw new Error("Unable to finish writing the apply target.");
    }
    offset += result.bytesWritten;
  }
}

function snapshotMatches(
  actual: Uint8Array,
  expected: FileSnapshot | undefined,
  created: boolean,
): boolean {
  if (!expected) {
    return true;
  }
  if (!expected.exists) {
    return created && actual.byteLength === 0;
  }
  return Boolean(expected.bytes)
    && hashBytes(actual) === hashBytes(expected.bytes!);
}

async function writeMutationFile(
  root: string,
  relative: string,
  bytes: Uint8Array,
  expected: FileSnapshot | undefined,
  pathEscapeLabel: string,
  desiredMode?: number,
): Promise<void> {
  const target = await mutationTarget(root, relative, pathEscapeLabel);
  let handle: FileHandle | undefined;
  let created = false;
  try {
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    if (expected?.exists === false) {
      handle = await open(
        target.operationPath,
        fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
        0o666,
      );
      created = true;
    } else {
      try {
        handle = await open(target.operationPath, fsConstants.O_RDWR | noFollow);
      } catch (error) {
        if (expected || !isNodeError(error, "ENOENT")) {
          throw error;
        }
        handle = await open(
          target.operationPath,
          fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow,
          0o666,
        );
        created = true;
      }
    }
    await verifyMutationHandle(target, relative, pathEscapeLabel, handle);
    const actual = await readHandle(handle);
    if (!snapshotMatches(actual, expected, created)) {
      throw pathChangedError(relative);
    }
    await writeHandle(handle, bytes);
    if (desiredMode !== undefined && process.platform !== "win32") {
      const written = await handle.stat();
      const nextMode = (written.mode & ~0o111) | (desiredMode & 0o111);
      if (nextMode !== written.mode) {
        await handle.chmod(nextMode);
      }
    }
  } catch (error) {
    if (created && handle) {
      await removeCreatedMutationFile(target, handle);
    }
    if (
      isNodeError(error, "EEXIST")
      || isNodeError(error, "ENOENT")
      || isNodeError(error, "ELOOP")
    ) {
      throw pathChangedError(relative);
    }
    throw error;
  } finally {
    await handle?.close();
    await target.parentHandle?.close();
  }
}

async function deleteMutationFile(
  root: string,
  relative: string,
  expected: FileSnapshot | undefined,
  pathEscapeLabel: string,
): Promise<void> {
  const target = await mutationTarget(root, relative, pathEscapeLabel);
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      target.operationPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    await verifyMutationHandle(target, relative, pathEscapeLabel, handle);
    const actual = await readHandle(handle);
    if (!snapshotMatches(actual, expected, false)) {
      throw pathChangedError(relative);
    }
    // Repeat the identity checks immediately before the path-based unlink. On
    // Linux operationPath is anchored to the already verified parent handle.
    await verifyMutationHandle(target, relative, pathEscapeLabel, handle);
    await unlink(target.operationPath);
  } catch (error) {
    if (
      isNodeError(error, "ENOENT")
      || isNodeError(error, "ELOOP")
    ) {
      throw pathChangedError(relative);
    }
    throw error;
  } finally {
    await handle?.close();
    await target.parentHandle?.close();
  }
}

function splitNull(value: string): string[] {
  return value.split("\0").filter((item) => item.length > 0).map(normalizedRelative);
}

export function lineDiffCounts(
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

async function git(root: string, args: string[]): Promise<string> {
  return runGit(root, args);
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
        env: minimalShellEnv(),
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

export async function fileState(file: string): Promise<{ exists: boolean; bytes?: Uint8Array }> {
  try {
    return {
      exists: true,
      bytes: await vscode.workspace.fs.readFile(vscode.Uri.file(file)),
    };
  } catch {
    return { exists: false };
  }
}

async function overlayCurrentWorkspace(
  root: string,
  worktree: string,
  isExcluded: ((relative: string) => boolean) | undefined,
  pathEscapeLabel: string,
): Promise<void> {
  const tracked = splitNull(await git(root, ["ls-files", "-z"]));
  const untracked = splitNull(await git(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]));
  for (const relative of new Set([...tracked, ...untracked])) {
    if (isExcluded?.(relative)) {
      continue;
    }
    const source = await safePathResolved(root, relative, pathEscapeLabel);
    const target = await safePathResolved(worktree, relative, pathEscapeLabel);
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

/**
 * Delete secret-bearing files that arrived via HEAD so agents cannot read them.
 * Runs after overlay (which already skips copying live workspace secrets).
 */
async function scrubSecretContent(
  worktree: string,
  pathEscapeLabel: string,
): Promise<void> {
  const isSecret = createSecretContentMatcher();
  const tracked = splitNull(await git(worktree, ["ls-files", "-z"]));
  const untracked = splitNull(await git(worktree, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]));
  for (const relative of new Set([...tracked, ...untracked])) {
    if (!isSecret(relative)) {
      continue;
    }
    const target = await safePathResolved(worktree, relative, pathEscapeLabel);
    try {
      await vscode.workspace.fs.delete(vscode.Uri.file(target), { recursive: false });
    } catch {
      // Already absent or not a plain file.
    }
  }
}

async function captureBaseline(
  session: IsolatedWorktreeSession,
  storageRoot: vscode.Uri,
  isExcluded?: (relative: string) => boolean,
): Promise<void> {
  const changed = splitNull(await git(session.worktreePath, [
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    session.baselineCommit,
  ]));
  const untracked = splitNull(await git(session.worktreePath, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]));
  // Skip sensitive paths so their bytes are never persisted to extension storage.
  session.initialChangedFiles = [...new Set([...changed, ...untracked])]
    .filter((relative) => !isExcluded?.(relative));
  session.baselineFiles = {};
  const backupRoot = vscode.Uri.joinPath(
    storageRoot,
    session.baselinesFolder,
    session.id,
  );
  await vscode.workspace.fs.createDirectory(backupRoot);
  for (const relative of session.initialChangedFiles) {
    const current = await fileState(
      await safePathResolved(session.worktreePath, relative),
    );
    if (!current.exists || !current.bytes) {
      session.baselineFiles[relative] = { existed: false };
      continue;
    }
    const backupName = createHash("sha256").update(relative).digest("hex");
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(backupRoot, backupName),
      current.bytes,
    );
    session.baselineFiles[relative] = {
      existed: true,
      hash: hashBytes(current.bytes),
      backupName,
    };
  }
}

/**
 * Create a detached git worktree, overlay dirty main-tree files, capture baselines,
 * and symlink node_modules. Cursor SDK state paths stay short via a home-dir checkout.
 */
export async function prepareIsolatedWorktree(
  options: PrepareIsolatedWorktreeOptions,
): Promise<IsolatedWorktreeSession> {
  const pathEscapeLabel = options.pathEscapeLabel ?? "isolated worktree";
  await vscode.workspace.fs.createDirectory(options.storageRoot);
  try {
    return await withManagedWorktree(options, async (worktree) => {
      await overlayCurrentWorkspace(
        options.root,
        worktree,
        options.isExcluded,
        pathEscapeLabel,
      );
      await scrubSecretContent(worktree, pathEscapeLabel);
      await options.beforeCaptureBaseline?.(worktree);
      const baselineCommit = (await git(worktree, ["rev-parse", "HEAD"])).trim();
      const session: IsolatedWorktreeSession = {
        id: options.id,
        root: options.root,
        worktreePath: worktree,
        baselineCommit,
        baselineFiles: {},
        initialChangedFiles: [],
        baselinesFolder: options.baselinesFolder,
      };
      await captureBaseline(session, options.storageRoot, options.isExcluded);
      await linkManagedNodeModules(options.root, worktree, options.onLog);
      return session;
    });
  } catch (error) {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(
        options.storageRoot,
        options.baselinesFolder,
        options.id,
      ), { recursive: true });
    } catch {
      // Baseline capture may have failed before creating its storage folder.
    }
    throw error;
  }
}

export async function readIsolatedBaseline(
  session: IsolatedWorktreeSession,
  storageRoot: vscode.Uri,
  relative: string,
  missingBaselineMessage?: (relative: string) => string,
): Promise<{ exists: boolean; bytes?: Uint8Array }> {
  const snapshot = session.baselineFiles[relative];
  if (snapshot) {
    if (!snapshot.existed || !snapshot.backupName) {
      return { exists: false };
    }
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(
        storageRoot,
        session.baselinesFolder,
        session.id,
        snapshot.backupName,
      ));
      return { exists: true, bytes };
    } catch {
      throw new Error(
        missingBaselineMessage?.(relative)
          ?? `The isolated baseline for ${relative} is unavailable.`,
      );
    }
  }
  try {
    return {
      exists: true,
      bytes: await gitBytes(session.worktreePath, [
        "show",
        `${session.baselineCommit}:${relative}`,
      ]),
    };
  } catch {
    return { exists: false };
  }
}

export async function collectIsolatedChanges(
  session: IsolatedWorktreeSession,
  storageRoot: vscode.Uri,
  options?: {
    isExcluded?: (relative: string) => boolean;
    missingBaselineMessage?: (relative: string) => string;
    pathEscapeLabel?: string;
  },
): Promise<Array<IsolatedChange & { excluded: boolean }>> {
  const pathEscapeLabel = options?.pathEscapeLabel ?? "isolated worktree";
  const changed = splitNull(await git(session.worktreePath, [
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    session.baselineCommit,
  ]));
  const untracked = splitNull(await git(session.worktreePath, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]));
  const paths = [...new Set([
    ...session.initialChangedFiles,
    ...changed,
    ...untracked,
  ])];

  const result: Array<IsolatedChange & { excluded: boolean }> = [];
  for (const relative of paths) {
    const baseline = await readIsolatedBaseline(
      session,
      storageRoot,
      relative,
      options?.missingBaselineMessage,
    );
    const current = await fileState(
      safePath(session.worktreePath, relative, pathEscapeLabel),
    );
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
      excluded: options?.isExcluded?.(relative) === true,
    });
  }
  return result.sort((left, right) => left.relative.localeCompare(right.relative));
}

export async function applyIsolatedChange(
  session: IsolatedWorktreeSession,
  storageRoot: vscode.Uri,
  change: Pick<IsolatedChange, "relative">,
  options?: {
    conflictMessage?: string;
    unavailableMessage?: string;
    missingBaselineMessage?: (relative: string) => string;
    pathEscapeLabel?: string;
    autoMerge?: boolean;
  },
): Promise<"applied" | "merged" | "already-applied"> {
  const pathEscapeLabel = options?.pathEscapeLabel ?? "isolated worktree";
  if (!session.worktreePath || !session.baselineCommit) {
    throw new Error(options?.unavailableMessage ?? "The isolated worktree is unavailable.");
  }
  const baseline = await readIsolatedBaseline(
    session,
    storageRoot,
    change.relative,
    options?.missingBaselineMessage,
  );

  const currentMain = await readValidatedFile(session.root, change.relative, pathEscapeLabel);
  const proposedState = await readValidatedFile(
    session.worktreePath,
    change.relative,
    pathEscapeLabel,
  );
  const unchanged = canApplyAgainstBaseline(
    {
      exists: baseline.exists,
      hash: baseline.bytes ? hashBytes(baseline.bytes) : undefined,
    },
    {
      exists: currentMain.exists,
      hash: currentMain.bytes ? hashBytes(currentMain.bytes) : undefined,
    },
  );
  if (!unchanged) {
    const alreadyApplied = currentMain.exists === proposedState.exists
      && (!currentMain.exists || Boolean(
        currentMain.bytes
        && proposedState.bytes
        && hashBytes(currentMain.bytes) === hashBytes(proposedState.bytes),
      ));
    if (alreadyApplied) {
      return "already-applied";
    }
    if (
      options?.autoMerge
      && baseline.exists
      && baseline.bytes
      && currentMain.exists
      && currentMain.bytes
      && proposedState.exists
      && proposedState.bytes
    ) {
      const merged = await threeWayMergeBytes(
        currentMain.bytes,
        baseline.bytes,
        proposedState.bytes,
        change.relative,
      );
      if (
        merged.clean
        && merged.bytes
        && !hasConflictMarkers(merged.bytes)
      ) {
        await writeMutationFile(
          session.root,
          change.relative,
          merged.bytes,
          currentMain,
          pathEscapeLabel,
          proposedState.mode,
        );
        return "merged";
      }
    }
    throw new Error(
      options?.conflictMessage
        ?? "The file changed after the isolated task started. Review and merge it manually.",
    );
  }

  if (proposedState.exists) {
    if (!proposedState.bytes) {
      throw pathChangedError(change.relative);
    }
    await writeMutationFile(
      session.root,
      change.relative,
      proposedState.bytes,
      currentMain,
      pathEscapeLabel,
      proposedState.mode,
    );
  } else if (currentMain.exists) {
    await deleteMutationFile(
      session.root,
      change.relative,
      currentMain,
      pathEscapeLabel,
    );
  }
  return "applied";
}

export async function applyIsolatedChanges(
  session: IsolatedWorktreeSession,
  storageRoot: vscode.Uri,
  changes: readonly Pick<IsolatedChange, "relative">[],
  options?: {
    conflictMessage?: string;
    unavailableMessage?: string;
    missingBaselineMessage?: (relative: string) => string;
    pathEscapeLabel?: string;
    skip?: (change: Pick<IsolatedChange, "relative">) => boolean;
    autoMerge?: boolean;
    /** When true (default), roll back earlier writes in this batch if any apply fails. */
    transactional?: boolean;
  },
): Promise<{
  applied: string[];
  merged: string[];
  conflicts: Array<{ relative: string; error: string }>;
  rolledBack?: string[];
}> {
  const applied: string[] = [];
  const merged: string[] = [];
  const conflicts: Array<{ relative: string; error: string }> = [];
  const snapshots: Array<{ relative: string; previous: FileSnapshot }> = [];
  const transactional = options?.transactional !== false;
  const pathEscapeLabel = options?.pathEscapeLabel ?? "isolated worktree";

  for (const change of changes) {
    if (options?.skip?.(change)) {
      continue;
    }
    try {
      const previous = await readValidatedFile(session.root, change.relative, pathEscapeLabel);
      const outcome = await applyIsolatedChange(session, storageRoot, change, options);
      if (outcome !== "already-applied") {
        snapshots.push({ relative: change.relative, previous });
      }
      applied.push(change.relative);
      if (outcome === "merged") {
        merged.push(change.relative);
      }
    } catch (error) {
      conflicts.push({
        relative: change.relative,
        error: error instanceof Error ? error.message : String(error),
      });
      if (transactional && snapshots.length > 0) {
        const rolledBack: string[] = [];
        for (const entry of [...snapshots].reverse()) {
          try {
            if (entry.previous.exists && entry.previous.bytes) {
              await writeMutationFile(
                session.root,
                entry.relative,
                entry.previous.bytes,
                undefined,
                pathEscapeLabel,
                entry.previous.mode,
              );
            } else {
              try {
                await deleteMutationFile(
                  session.root,
                  entry.relative,
                  undefined,
                  pathEscapeLabel,
                );
              } catch {
                // File may already be absent.
              }
            }
            rolledBack.push(entry.relative);
          } catch {
            // Best-effort rollback; surface the original conflict.
          }
        }
        return {
          applied: [],
          merged: [],
          conflicts,
          rolledBack,
        };
      }
    }
  }
  return { applied, merged, conflicts };
}

export interface PreparedAiConflict {
  relative: string;
  expectedMainHash: string;
}

/**
 * Put a textual conflict into the isolated worktree for a follow-up agent.
 * The main workspace is read only and remains free of conflict markers.
 */
export async function prepareAiConflictResolution(
  session: IsolatedWorktreeSession,
  storageRoot: vscode.Uri,
  relative: string,
  options?: {
    missingBaselineMessage?: (relative: string) => string;
    pathEscapeLabel?: string;
  },
): Promise<PreparedAiConflict | undefined> {
  const pathEscapeLabel = options?.pathEscapeLabel ?? "isolated worktree";
  const baseline = await readIsolatedBaseline(
    session,
    storageRoot,
    relative,
    options?.missingBaselineMessage,
  );
  const currentMain = await readValidatedFile(session.root, relative, pathEscapeLabel);
  const proposed = await readValidatedFile(session.worktreePath, relative, pathEscapeLabel);
  if (
    !baseline.exists
    || !baseline.bytes
    || !currentMain.exists
    || !currentMain.bytes
    || !proposed.exists
    || !proposed.bytes
  ) {
    return undefined;
  }
  const merge = await threeWayMergeBytes(
    currentMain.bytes,
    baseline.bytes,
    proposed.bytes,
    relative,
  );
  if (merge.clean || !merge.bytes || !hasConflictMarkers(merge.bytes)) {
    return undefined;
  }
  await writeMutationFile(
    session.worktreePath,
    relative,
    merge.bytes,
    proposed,
    pathEscapeLabel,
    proposed.mode,
  );
  return {
    relative,
    expectedMainHash: hashBytes(currentMain.bytes),
  };
}

/** Apply an AI-resolved worktree file only while its reviewed workspace input is current. */
export async function applyAiConflictResolution(
  session: IsolatedWorktreeSession,
  prepared: PreparedAiConflict,
  options?: {
    changedMessage?: string;
    markersMessage?: string;
    pathEscapeLabel?: string;
  },
): Promise<void> {
  const pathEscapeLabel = options?.pathEscapeLabel ?? "isolated worktree";
  const currentMain = await readValidatedFile(
    session.root,
    prepared.relative,
    pathEscapeLabel,
  );
  if (
    !currentMain.exists
    || !currentMain.bytes
    || hashBytes(currentMain.bytes) !== prepared.expectedMainHash
  ) {
    throw new Error(
      options?.changedMessage
        ?? "The workspace file changed during AI conflict resolution.",
    );
  }
  const resolved = await readValidatedFile(
    session.worktreePath,
    prepared.relative,
    pathEscapeLabel,
  );
  if (!resolved.exists || !resolved.bytes || hasConflictMarkers(resolved.bytes)) {
    throw new Error(
      options?.markersMessage
        ?? "The AI did not remove every conflict marker.",
    );
  }
  await writeMutationFile(
    session.root,
    prepared.relative,
    resolved.bytes,
    currentMain,
    pathEscapeLabel,
    resolved.mode,
  );
}

export async function cleanupIsolatedWorktree(
  session: IsolatedWorktreeSession | undefined,
  storageRoot: vscode.Uri,
  onLog?: (message: string) => void,
): Promise<void> {
  if (!session?.worktreePath) {
    return;
  }
  const worktree = session.worktreePath;
  if (await removeManagedWorktree(session.root, worktree, onLog)) {
    try {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(
        storageRoot,
        session.baselinesFolder,
        session.id,
      ), { recursive: true });
    } catch {
      // The baseline directory may already have been cleaned up.
    }
  }
}

/** Map a path under the isolated worktree to the corresponding main-workspace path. */
export function mapWorktreePathToRoot(
  absolutePath: string,
  session: IsolatedWorktreeSession,
): string {
  const resolved = path.resolve(absolutePath);
  const worktree = path.resolve(session.worktreePath);
  if (resolved === worktree || isInside(worktree, resolved)) {
    const relative = path.relative(worktree, resolved);
    return path.resolve(session.root, relative);
  }
  return resolved;
}
