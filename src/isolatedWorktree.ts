import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  canApplyAgainstBaseline,
  hashBytes,
  isPathInside,
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

  const mainFile = await safePathResolved(session.root, change.relative, pathEscapeLabel);
  const currentMain = await fileState(mainFile);
  const proposed = await safePathResolved(
    session.worktreePath,
    change.relative,
    pathEscapeLabel,
  );
  const proposedState = await fileState(proposed);
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
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(mainFile)));
        await vscode.workspace.fs.writeFile(vscode.Uri.file(mainFile), merged.bytes);
        return "merged";
      }
    }
    throw new Error(
      options?.conflictMessage
        ?? "The file changed after the isolated task started. Review and merge it manually.",
    );
  }

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
  const snapshots: Array<{ relative: string; previous: { exists: boolean; bytes?: Uint8Array } }> = [];
  const transactional = options?.transactional !== false;
  const pathEscapeLabel = options?.pathEscapeLabel ?? "isolated worktree";

  for (const change of changes) {
    if (options?.skip?.(change)) {
      continue;
    }
    try {
      const mainFile = await safePathResolved(
        session.root,
        change.relative,
        pathEscapeLabel,
      );
      const previous = await fileState(mainFile);
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
            const target = await safePathResolved(
              session.root,
              entry.relative,
              pathEscapeLabel,
            );
            if (entry.previous.exists && entry.previous.bytes) {
              await vscode.workspace.fs.createDirectory(
                vscode.Uri.file(path.dirname(target)),
              );
              await vscode.workspace.fs.writeFile(
                vscode.Uri.file(target),
                entry.previous.bytes,
              );
            } else {
              try {
                await vscode.workspace.fs.delete(vscode.Uri.file(target), {
                  recursive: false,
                });
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
  const mainFile = await safePathResolved(session.root, relative, pathEscapeLabel);
  const proposedFile = await safePathResolved(
    session.worktreePath,
    relative,
    pathEscapeLabel,
  );
  const currentMain = await fileState(mainFile);
  const proposed = await fileState(proposedFile);
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
  await vscode.workspace.fs.writeFile(vscode.Uri.file(proposedFile), merge.bytes);
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
  const mainFile = await safePathResolved(
    session.root,
    prepared.relative,
    pathEscapeLabel,
  );
  const proposedFile = await safePathResolved(
    session.worktreePath,
    prepared.relative,
    pathEscapeLabel,
  );
  const currentMain = await fileState(mainFile);
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
  const resolved = await fileState(proposedFile);
  if (!resolved.exists || !resolved.bytes || hasConflictMarkers(resolved.bytes)) {
    throw new Error(
      options?.markersMessage
        ?? "The AI did not remove every conflict marker.",
    );
  }
  await vscode.workspace.fs.writeFile(vscode.Uri.file(mainFile), resolved.bytes);
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
