import { execFile as execFileCallback } from "node:child_process";
import { mkdir, readFile, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCallback);
const MAX_GIT_OUTPUT = 32 * 1024 * 1024;
const UNLEASED_WORKTREE_GRACE_MS = 10 * 60 * 1000;

interface WorktreeLease {
  pid: number;
  root: string;
  createdAt: number;
}

export interface ManagedWorktreeOptions {
  id: string;
  root: string;
  worktreesHomeSegment: string;
  onLog?: (message: string) => void;
}

export async function runGit(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    windowsHide: true,
    maxBuffer: MAX_GIT_OUTPUT,
    encoding: "utf8",
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
      return parsed as WorktreeLease;
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

export async function removeManagedWorktree(
  root: string,
  worktreePath: string,
  onLog?: (message: string) => void,
): Promise<boolean> {
  try {
    try {
      await unlink(path.join(worktreePath, "node_modules"));
    } catch {
      // node_modules may not have been linked.
    }
    await runGit(root, ["worktree", "remove", "--force", worktreePath]);
  } catch (error) {
    onLog?.(
      `[${new Date().toISOString()}] Could not remove worktree ${worktreePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return false;
  }
  try {
    await runGit(root, ["worktree", "prune"]);
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
  const worktreesRoot = managedWorktreesRoot(options.worktreesHomeSegment);
  await mkdir(worktreesRoot, { recursive: true });
  const worktreePath = path.join(worktreesRoot, options.id);
  await writeFile(
    worktreeLeasePath(worktreePath),
    JSON.stringify({ pid: process.pid, root: path.resolve(options.root), createdAt: Date.now() }),
    "utf8",
  );
  try {
    await runGit(options.root, ["worktree", "add", "--detach", worktreePath, "HEAD"]);
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

export async function linkManagedNodeModules(
  root: string,
  worktreePath: string,
  onLog?: (message: string) => void,
): Promise<void> {
  const source = path.join(root, "node_modules");
  const target = path.join(worktreePath, "node_modules");
  try {
    const sourceStat = await stat(source);
    if (!sourceStat.isDirectory()) {
      return;
    }
  } catch {
    return;
  }
  try {
    await symlink(source, target, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    onLog?.(
      `[${new Date().toISOString()}] Could not link node_modules: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
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
  now = Date.now(),
): Promise<string[]> {
  let porcelain: string;
  try {
    porcelain = await runGit(root, ["worktree", "list", "--porcelain"]);
  } catch {
    return [];
  }
  const managedRoots = worktreesHomeSegments.map(managedWorktreesRoot);
  const removed: string[] = [];
  for (const worktreePath of parseWorktreePaths(porcelain)) {
    if (!managedRoots.some((managedRoot) => isInside(managedRoot, worktreePath))) {
      continue;
    }
    const lease = await readLease(worktreePath);
    if (lease && processIsAlive(lease.pid)) {
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
