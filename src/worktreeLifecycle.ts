import { execFile as execFileCallback } from "node:child_process";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { minimalShellEnv } from "./shellEnv.js";

const execFileAsync = promisify(execFileCallback);
const MAX_GIT_OUTPUT = 32 * 1024 * 1024;
const UNLEASED_WORKTREE_GRACE_MS = 10 * 60 * 1000;

interface WorktreeLease {
  pid: number;
  root: string;
  createdAt: number;
  parentIdentity?: DirectoryIdentity;
  worktreeIdentity?: DirectoryIdentity;
}

interface DirectoryIdentity {
  canonicalPath: string;
  dev: string;
  ino: string;
}

export interface ManagedWorktreeOptions {
  id: string;
  root: string;
  worktreesHomeSegment: string;
  worktreesRoot?: string;
  onLog?: (message: string) => void;
}

export interface OrphanCleanupOptions {
  now?: number;
  isProcessAlive?: (pid: number) => boolean;
  managedRoots?: readonly string[];
}

export async function runGit(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    windowsHide: true,
    maxBuffer: MAX_GIT_OUTPUT,
    encoding: "utf8",
    env: minimalShellEnv(),
  });
  return stdout;
}

export function managedWorktreesRoot(segment: string): string {
  return path.join(homedir(), ...segment.split(/[/\\]+/));
}

export function worktreeLeasePath(worktreePath: string): string {
  return `${worktreePath}.lease.json`;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function canonicalPath(candidate: string): Promise<string> {
  try {
    return await realpath(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLease(worktreePath: string): Promise<WorktreeLease | undefined> {
  try {
    const parsed = JSON.parse(await readFile(worktreeLeasePath(worktreePath), "utf8")) as Partial<WorktreeLease>;
    if (
      typeof parsed.pid === "number"
      && typeof parsed.root === "string"
      && typeof parsed.createdAt === "number"
    ) {
      return {
        pid: parsed.pid,
        root: parsed.root,
        createdAt: parsed.createdAt,
        parentIdentity: isDirectoryIdentity(parsed.parentIdentity)
          ? parsed.parentIdentity
          : undefined,
        worktreeIdentity: isDirectoryIdentity(parsed.worktreeIdentity)
          ? parsed.worktreeIdentity
          : undefined,
      };
    }
  } catch {
    // Missing and malformed leases are handled using the directory-age grace period.
  }
  return undefined;
}

async function removeLease(worktreePath: string): Promise<void> {
  try {
    await unlink(worktreeLeasePath(worktreePath));
  } catch {
    // The lease may not have been created or may already be gone.
  }
}

function isMissingError(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isDirectoryIdentity(value: unknown): value is DirectoryIdentity {
  return Boolean(
    value
    && typeof value === "object"
    && "canonicalPath" in value
    && typeof value.canonicalPath === "string"
    && "dev" in value
    && typeof value.dev === "string"
    && "ino" in value
    && typeof value.ino === "string",
  );
}

async function captureDirectoryIdentity(
  candidate: string,
): Promise<DirectoryIdentity | undefined> {
  try {
    const details = await lstat(candidate, { bigint: true });
    if (details.isSymbolicLink() || !details.isDirectory() || details.ino === 0n) {
      throw new Error(`Managed worktree path is not a stable directory: ${candidate}`);
    }
    return {
      canonicalPath: await realpath(candidate),
      dev: String(details.dev),
      ino: String(details.ino),
    };
  } catch (error) {
    if (isMissingError(error)) {
      return undefined;
    }
    throw error;
  }
}

function sameDirectoryIdentity(
  expected: DirectoryIdentity,
  current: DirectoryIdentity | undefined,
): boolean {
  return Boolean(
    current
    && path.relative(expected.canonicalPath, current.canonicalPath) === ""
    && expected.dev === current.dev
    && expected.ino === current.ino,
  );
}

async function requireDirectoryIdentity(
  candidate: string,
  expected: DirectoryIdentity,
): Promise<void> {
  const current = await captureDirectoryIdentity(candidate);
  if (!sameDirectoryIdentity(expected, current)) {
    throw new Error(`Managed worktree path changed before cleanup: ${candidate}`);
  }
}

/**
 * Remove links before recursively deleting an agent-controlled worktree.
 * Git for Windows can traverse directory junctions during worktree removal,
 * so Git is only asked to prune its registration after this directory is gone.
 */
async function unlinkWorktreeLinks(
  worktreePath: string,
  parentIdentity: DirectoryIdentity,
  worktreeIdentity: DirectoryIdentity,
): Promise<void> {
  await requireDirectoryIdentity(path.dirname(worktreePath), parentIdentity);
  await requireDirectoryIdentity(worktreePath, worktreeIdentity);
  const canonicalRoot = worktreeIdentity.canonicalPath;
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isMissingError(error)) {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      let details;
      try {
        details = await lstat(candidate);
      } catch (error) {
        if (isMissingError(error)) {
          continue;
        }
        throw error;
      }
      if (details.isSymbolicLink()) {
        await unlink(candidate);
        continue;
      }
      if (!details.isDirectory()) {
        continue;
      }
      const canonicalDirectory = await realpath(candidate);
      if (!isInside(canonicalRoot, canonicalDirectory)) {
        throw new Error(`Managed worktree directory resolves outside its root: ${candidate}`);
      }
      await visit(candidate);
    }
  };

  await visit(canonicalRoot);
  await requireDirectoryIdentity(path.dirname(worktreePath), parentIdentity);
  await requireDirectoryIdentity(worktreePath, worktreeIdentity);
}

export async function removeManagedWorktree(
  root: string,
  worktreePath: string,
  onLog?: (message: string) => void,
): Promise<boolean> {
  try {
    const lease = await readLease(worktreePath);
    const currentParent = await captureDirectoryIdentity(path.dirname(worktreePath));
    if (!currentParent) {
      throw new Error(`Managed worktree parent is missing: ${path.dirname(worktreePath)}`);
    }
    if (lease?.parentIdentity && !sameDirectoryIdentity(lease.parentIdentity, currentParent)) {
      throw new Error(`Managed worktree parent changed before cleanup: ${worktreePath}`);
    }
    const currentWorktree = await captureDirectoryIdentity(worktreePath);
    if (currentWorktree) {
      const parentIdentity = lease?.parentIdentity;
      const worktreeIdentity = lease?.worktreeIdentity;
      if (!parentIdentity || !worktreeIdentity) {
        throw new Error(`Managed worktree identity lease is unavailable: ${worktreePath}`);
      }
      if (!sameDirectoryIdentity(worktreeIdentity, currentWorktree)) {
        throw new Error(`Managed worktree changed before cleanup: ${worktreePath}`);
      }
      await unlinkWorktreeLinks(
        worktreePath,
        parentIdentity,
        worktreeIdentity,
      );
      // Node's recursive removal unlinks symlinks and Windows junctions instead
      // of traversing their targets. Identity is rechecked immediately above,
      // after every link has been removed from the agent-controlled tree.
      await rm(worktreePath, { recursive: true, force: true });
    }
  } catch (error) {
    onLog?.(
      `[${new Date().toISOString()}] Could not remove worktree ${worktreePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
  try {
    // The worktree directory is already gone, so Git only removes its internal
    // registration and cannot traverse agent-controlled filesystem entries.
    await runGit(root, ["worktree", "prune", "--expire", "now"]);
  } catch (error) {
    onLog?.(
      `[${new Date().toISOString()}] Worktree was removed but Git prune failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  await removeLease(worktreePath);
  return true;
}

/** Register a detached worktree and a process lease that crash recovery can inspect. */
export async function createManagedWorktree(
  options: ManagedWorktreeOptions,
): Promise<string> {
  const worktreesRoot = options.worktreesRoot
    ?? managedWorktreesRoot(options.worktreesHomeSegment);
  await mkdir(worktreesRoot, { recursive: true });
  const parentIdentity = await captureDirectoryIdentity(worktreesRoot);
  if (!parentIdentity) {
    throw new Error(`Managed worktree parent is unavailable: ${worktreesRoot}`);
  }
  const worktreePath = path.join(worktreesRoot, options.id);
  const lease: WorktreeLease = {
    pid: process.pid,
    root: path.resolve(options.root),
    createdAt: Date.now(),
    parentIdentity,
  };
  await writeFile(
    worktreeLeasePath(worktreePath),
    JSON.stringify(lease),
    "utf8",
  );
  try {
    await runGit(options.root, ["worktree", "add", "--detach", worktreePath, "HEAD"]);
    const worktreeIdentity = await captureDirectoryIdentity(worktreePath);
    if (!worktreeIdentity) {
      throw new Error(`Managed worktree was not created: ${worktreePath}`);
    }
    await writeFile(
      worktreeLeasePath(worktreePath),
      JSON.stringify({ ...lease, worktreeIdentity }),
      "utf8",
    );
    return worktreePath;
  } catch (error) {
    const removed = await removeManagedWorktree(options.root, worktreePath, options.onLog);
    if (!removed) {
      try {
        const registered = parseWorktreePaths(
          await runGit(options.root, ["worktree", "list", "--porcelain"]),
        ).some((candidate) => path.resolve(candidate) === path.resolve(worktreePath));
        if (!registered) {
          await removeLease(worktreePath);
        }
      } catch {
        // Keep the lease so a later startup can recover a partially registered worktree.
      }
    }
    throw error;
  }
}

/** Run preparation against a registered worktree and remove it if preparation fails. */
export async function withManagedWorktree<T>(
  options: ManagedWorktreeOptions,
  prepare: (worktreePath: string) => Promise<T>,
): Promise<T> {
  const worktreePath = await createManagedWorktree(options);
  try {
    return await prepare(worktreePath);
  } catch (error) {
    await removeManagedWorktree(options.root, worktreePath, options.onLog);
    throw error;
  }
}

/**
 * Intentionally does not junction/symlink host `node_modules` into the worktree.
 * A writable link would let agent edits mutate the main workspace before apply.
 */
export async function linkManagedNodeModules(
  root: string,
  worktreePath: string,
  onLog?: (message: string) => void,
): Promise<void> {
  const source = path.join(root, "node_modules");
  try {
    const sourceStat = await stat(source);
    if (!sourceStat.isDirectory()) {
      return;
    }
  } catch {
    return;
  }
  onLog?.(
    `[${new Date().toISOString()}] Skipping node_modules link into ${worktreePath} to preserve worktree isolation.`,
  );
}

function parseWorktreePaths(porcelain: string): string[] {
  return porcelain
    .split(/\r?\n/)
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length).trim())
    .filter(Boolean);
}

async function unleasedWorktreeIsOld(worktreePath: string, now: number): Promise<boolean> {
  try {
    const details = await stat(worktreePath);
    return now - details.mtimeMs >= UNLEASED_WORKTREE_GRACE_MS;
  } catch {
    return true;
  }
}

/** Remove managed chat worktrees whose owning extension-host process is no longer alive. */
export async function cleanupOrphanedManagedWorktrees(
  root: string,
  worktreesHomeSegments: readonly string[],
  onLog?: (message: string) => void,
  options: OrphanCleanupOptions = {},
): Promise<string[]> {
  let porcelain: string;
  try {
    porcelain = await runGit(root, ["worktree", "list", "--porcelain"]);
  } catch {
    return [];
  }
  const configuredManagedRoots = options.managedRoots?.map((managedRoot) => path.resolve(managedRoot))
    ?? worktreesHomeSegments.map(managedWorktreesRoot);
  const managedRoots = await Promise.all(configuredManagedRoots.map(canonicalPath));
  const now = options.now ?? Date.now();
  const isProcessAlive = options.isProcessAlive ?? processIsAlive;
  const removed: string[] = [];
  for (const worktreePath of parseWorktreePaths(porcelain)) {
    const canonicalWorktreePath = await canonicalPath(worktreePath);
    if (!managedRoots.some((managedRoot) => isInside(managedRoot, canonicalWorktreePath))) {
      continue;
    }
    const lease = await readLease(worktreePath);
    if (lease && isProcessAlive(lease.pid)) {
      continue;
    }
    if (!lease && !(await unleasedWorktreeIsOld(worktreePath, now))) {
      continue;
    }
    if (await removeManagedWorktree(root, worktreePath, onLog)) {
      removed.push(worktreePath);
    }
  }
  return removed;
}
