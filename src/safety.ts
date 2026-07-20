import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import * as path from "node:path";

/** True when `candidate` is equal to or under `root`. */
export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Resolve symlinks when possible. For missing paths, canonicalize the longest
 * existing ancestor and rejoin the remainder so apply targets cannot escape via
 * intermediate symlinks.
 */
export async function resolveCanonicalPath(candidate: string): Promise<string> {
  const absolute = path.resolve(candidate);
  try {
    return await realpath(absolute);
  } catch {
    let current = absolute;
    const missing: string[] = [];
    while (true) {
      const parent = path.dirname(current);
      if (parent === current) {
        return absolute;
      }
      missing.unshift(path.basename(current));
      try {
        return path.join(await realpath(parent), ...missing);
      } catch {
        current = parent;
      }
    }
  }
}

/** Symlink-aware containment check for apply / open boundaries. */
export async function isPathInsideResolved(
  root: string,
  candidate: string,
): Promise<boolean> {
  const [rootReal, candidateReal] = await Promise.all([
    resolveCanonicalPath(root),
    resolveCanonicalPath(candidate),
  ]);
  return isPathInside(rootReal, candidateReal);
}

/** Reject absolute paths and any relative segment that escapes with `..`. */
export function isSafeRelativePath(relative: string): boolean {
  if (!relative || path.isAbsolute(relative)) {
    return false;
  }
  const normalized = relative.replaceAll("\\", "/");
  // Also reject Windows drive / UNC forms when running on non-Windows hosts.
  if (/^[a-zA-Z]:\//.test(normalized) || normalized.startsWith("//")) {
    return false;
  }
  if (normalized.startsWith("..") || normalized.includes("/../") || normalized.endsWith("/..")) {
    return false;
  }
  if (normalized.split("/").includes("..")) {
    return false;
  }
  return true;
}

/**
 * Resolve `relative` under `root`, throwing if the result escapes the root.
 * Used before Supervisor apply/discard writes.
 */
export function safeResolvePath(root: string, relative: string): string {
  if (!isSafeRelativePath(relative)) {
    throw new Error(`Path escapes the workspace: ${relative}`);
  }
  const candidate = path.resolve(root, relative);
  if (!isPathInside(root, candidate)) {
    throw new Error(`Path escapes the workspace: ${relative}`);
  }
  return candidate;
}

/**
 * Lexical safeResolvePath plus symlink/realpath containment.
 * Prefer this on write paths (apply, overlay, baseline).
 */
export async function safeResolvePathResolved(
  root: string,
  relative: string,
): Promise<string> {
  const candidate = safeResolvePath(root, relative);
  if (!(await isPathInsideResolved(root, candidate))) {
    throw new Error(`Path escapes the workspace: ${relative}`);
  }
  return candidate;
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function baselineKey(relative: string, win32 = process.platform === "win32"): string {
  const normalized = relative.replaceAll("\\", "/");
  return win32 ? normalized.toLowerCase() : normalized;
}

export function fileIdentity(file: string, win32 = process.platform === "win32"): string {
  const absolute = path.resolve(file);
  return win32 ? absolute.toLowerCase() : absolute;
}

export interface FileContentState {
  existed: boolean;
  hash?: string;
  indexMode?: string;
  indexOid?: string;
}

/**
 * Dirty-baseline restore: refuse automatic restore when the worktree/index
 * no longer match the AI-proposed snapshot (user edited after the agent).
 */
export function worktreeMatchesProposed(
  current: FileContentState,
  proposed: FileContentState,
): boolean {
  return current.existed === proposed.existed
    && current.hash === proposed.hash
    && current.indexMode === proposed.indexMode
    && current.indexOid === proposed.indexOid;
}

/**
 * Decide how a single baseline entry should be restored into the worktree.
 * - restore: write backup bytes back
 * - remove: delete a file that did not exist at baseline
 * - skip: no-op when already matching
 */
export type RestoreAction = "restore" | "remove" | "skip";

export function decideBaselineRestoreAction(
  baseline: { worktreeExisted: boolean; hash?: string },
  current: { existed: boolean; hash?: string },
): RestoreAction {
  if (baseline.worktreeExisted) {
    if (current.existed && current.hash === baseline.hash) {
      return "skip";
    }
    return "restore";
  }
  if (!current.existed) {
    return "skip";
  }
  return "remove";
}

/**
 * Supervisor apply-time conflict check: main workspace must still match the
 * captured baseline (commit or dirty-file backup).
 */
export function canApplyAgainstBaseline(
  baseline: { exists: boolean; hash?: string },
  currentMain: { exists: boolean; hash?: string },
): boolean {
  if (baseline.exists) {
    return Boolean(
      currentMain.exists
      && currentMain.hash
      && baseline.hash
      && currentMain.hash === baseline.hash,
    );
  }
  return !currentMain.exists;
}

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

const SUPERVISOR_RUNNABLE: ReadonlySet<SupervisorTaskStatus> = new Set([
  "detected",
  "queued",
  "failed",
]);

export function canQueueOrRunSupervisorTask(status: SupervisorTaskStatus): boolean {
  return SUPERVISOR_RUNNABLE.has(status);
}

export function nextSupervisorStatusAfterBusy(
  current: SupervisorTaskStatus,
  busy: boolean,
): SupervisorTaskStatus {
  if (busy && canQueueOrRunSupervisorTask(current)) {
    return "queued";
  }
  if (!busy && canQueueOrRunSupervisorTask(current)) {
    return "running";
  }
  return current;
}

export function nextSupervisorStatusAfterRun(
  outcome: "finished" | "cancelled" | "error" | "unavailable",
  hasChanges: boolean,
  blocked: boolean,
): SupervisorTaskStatus {
  if (outcome === "unavailable") {
    return "queued";
  }
  if (outcome !== "finished") {
    return "failed";
  }
  if (!hasChanges) {
    return "completed";
  }
  return blocked ? "blocked" : "review";
}

export function nextSupervisorStatusAfterDecisions(
  remainingUndecided: boolean,
  blocked: boolean,
): SupervisorTaskStatus {
  if (remainingUndecided) {
    return blocked ? "blocked" : "review";
  }
  return "completed";
}

/** Re-export chat queue helpers for backward-compatible imports. */
export {
  canStartAnotherParallelAgent,
  conversationRunState,
  enqueueChatMessage,
  removeQueuedMessages,
  requeueUnstartedMessage,
  requeueUnstartedMessages,
  shouldCancelOnInterrupt,
  takeNextQueuedMessage,
  type ConversationRunState,
  type QueueKind,
  type QueueMessageItem,
} from "./chatSendQueue.js";

export type SafetyApprovalMode = "safe-worktree" | "auto-review" | "full-access";

/** Prefer a reviewable worktree when the SDK sandbox is unavailable. */
export function defaultSafetyApprovalMode(
  sandboxSupported: boolean,
): SafetyApprovalMode {
  return sandboxSupported ? "auto-review" : "safe-worktree";
}

export function shouldMigrateToSafeWorktree(
  sandboxSupported: boolean,
  migrationApplied: boolean,
): boolean {
  return !sandboxSupported && !migrationApplied;
}

/**
 * Safe mode isolates mutating runs when the SDK sandbox is unavailable.
 * Parallel mutations remain isolated on every platform.
 */
export function shouldUseIsolatedWorktree(input: {
  approvalMode: SafetyApprovalMode;
  mutating: boolean;
  overlappedMutation: boolean;
  sandboxSupported: boolean;
}): boolean {
  return input.mutating && (
    input.overlappedMutation
    || (!input.sandboxSupported && input.approvalMode === "safe-worktree")
  );
}

/**
 * Parallel mutating agents: mark overlap so change detection restricts to
 * each agent's own edited-file hints (avoids attributing peer edits).
 */
export function computeOverlappedMutationFlags(
  runtimes: ReadonlyArray<{ id: string; busy: boolean; mutating: boolean }>,
  startingId: string,
  startingMutating: boolean,
): Map<string, boolean> {
  const flags = new Map<string, boolean>();
  const otherMutating = runtimes.filter(
    (runtime) => runtime.id !== startingId && runtime.busy && runtime.mutating,
  );
  const overlapped = startingMutating && otherMutating.length > 0;
  flags.set(startingId, overlapped);
  if (overlapped) {
    for (const runtime of otherMutating) {
      flags.set(runtime.id, true);
    }
  }
  return flags;
}

/** Same-file conflict across parallel agents' edited file sets. */
export function findConflictingFiles(
  agentFiles: ReadonlyArray<readonly string[]>,
  win32 = process.platform === "win32",
): string[] {
  const counts = new Map<string, { count: number; display: string }>();
  for (const files of agentFiles) {
    const seen = new Set<string>();
    for (const file of files) {
      const identity = fileIdentity(file, win32);
      if (seen.has(identity)) {
        continue;
      }
      seen.add(identity);
      const existing = counts.get(identity);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(identity, { count: 1, display: path.resolve(file) });
      }
    }
  }
  return [...counts.values()]
    .filter((entry) => entry.count > 1)
    .map((entry) => entry.display);
}

export {
  parseWebviewMessage,
  type ParsedWebviewMessage,
  type WebviewIncomingType,
} from "./webviewMessages.js";
