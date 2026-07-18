export const WORKER_HEARTBEAT_MAX_AGE_MS = 15_000;
export const WORKER_STARTUP_GRACE_MS = 30_000;
export const WORKER_HARD_STOP_GRACE_MS = 10_000;

export type BackgroundWorkerCancellationReason =
  | "user"
  | "deadline"
  | "unresponsive"
  | "orphan";

export interface BackgroundWorkerHeartbeat {
  token: string;
  pid: number;
  /** Wall-clock start time chosen once by the worker and persisted on its job. */
  startedAt?: number;
  /** Stable OS process creation marker; absent means the PID cannot be safely recovered. */
  processStartId?: string;
  updatedAt: number;
}

export interface BackgroundWorkerCancellation {
  token: string;
  requestedAt: number;
  reason?: BackgroundWorkerCancellationReason;
}

export type BackgroundWorkerRecoveryDecision =
  | { action: "none" }
  | { action: "request-stop"; reason: Exclude<BackgroundWorkerCancellationReason, "user"> }
  | { action: "await-grace"; reason: BackgroundWorkerCancellationReason }
  | { action: "hard-stop"; reason: BackgroundWorkerCancellationReason };

export interface BackgroundWorkerRecoveryState {
  active: boolean;
  createdAt: number;
  updatedAt: number;
  workerStartedAt?: number;
  maxMinutes: number;
  hasFreshHeartbeat: boolean;
  hasRecoverableWorker: boolean;
  cancellation?: BackgroundWorkerCancellation;
  now?: number;
}

export function backgroundWorkerProtocolPaths(jobFile: string): {
  heartbeat: string;
  cancellation: string;
} {
  return {
    heartbeat: `${jobFile}.heartbeat.json`,
    cancellation: `${jobFile}.cancel.json`,
  };
}

/** Sidecars share the .json suffix, so restore only the durable job document. */
export function isBackgroundJobDocument(fileName: string): boolean {
  return fileName.endsWith(".json")
    && !fileName.endsWith(".heartbeat.json")
    && !fileName.endsWith(".cancel.json");
}

export function isAuthenticatedWorkerHeartbeat(
  expectedToken: string | undefined,
  expectedPid: number | undefined,
  heartbeat: BackgroundWorkerHeartbeat,
  now = Date.now(),
): boolean {
  return Boolean(
    isAuthenticatedWorkerHeartbeatIdentity(expectedToken, expectedPid, heartbeat)
      && heartbeat.updatedAt <= now
      && now - heartbeat.updatedAt <= WORKER_HEARTBEAT_MAX_AGE_MS,
  );
}

/** Authenticate the sidecar without requiring it to still be fresh. */
export function isAuthenticatedWorkerHeartbeatIdentity(
  expectedToken: string | undefined,
  expectedPid: number | undefined,
  heartbeat: BackgroundWorkerHeartbeat,
): boolean {
  return Boolean(
    expectedToken
      && heartbeat.token === expectedToken
      && Number.isSafeInteger(heartbeat.pid)
      && heartbeat.pid > 0
      && (!expectedPid || heartbeat.pid === expectedPid)
      && Number.isFinite(heartbeat.updatedAt),
  );
}

/** Require the persisted worker start time in addition to token and PID. */
export function isAuthenticatedWorkerInstance(
  expectedToken: string | undefined,
  expectedPid: number | undefined,
  expectedStartedAt: number | undefined,
  heartbeat: BackgroundWorkerHeartbeat,
): boolean {
  return Boolean(
    Number.isFinite(expectedStartedAt)
      && expectedStartedAt! > 0
      && heartbeat.startedAt === expectedStartedAt
      && isAuthenticatedWorkerHeartbeatIdentity(expectedToken, expectedPid, heartbeat),
  );
}

export function isAuthenticatedWorkerCancellation(
  expectedToken: string,
  cancellation: BackgroundWorkerCancellation,
): boolean {
  return Boolean(
    cancellation.token === expectedToken
      && Number.isFinite(cancellation.requestedAt)
      && cancellation.requestedAt > 0
      && (
        cancellation.reason === undefined
        || ["user", "deadline", "unresponsive", "orphan"].includes(cancellation.reason)
      ),
  );
}

/** Orphan cleanup must not invalidate a result the worker already completed. */
export function cancellationInvalidatesCompletedResult(
  expectedToken: string,
  cancellation: BackgroundWorkerCancellation,
): boolean {
  return isAuthenticatedWorkerCancellation(expectedToken, cancellation)
    && cancellation.reason !== "orphan";
}

/**
 * Decide recovery timing without touching files or processes. The caller is
 * responsible for authenticating the supplied heartbeat and cancellation.
 */
export function decideBackgroundWorkerRecovery(
  state: BackgroundWorkerRecoveryState,
): BackgroundWorkerRecoveryDecision {
  const now = state.now ?? Date.now();
  if (state.cancellation) {
    const reason = state.cancellation.reason ?? "user";
    return now - state.cancellation.requestedAt >= WORKER_HARD_STOP_GRACE_MS
      ? { action: "hard-stop", reason }
      : { action: "await-grace", reason };
  }

  if (state.active) {
    const startedAt = Number.isFinite(state.workerStartedAt)
      ? state.workerStartedAt!
      : state.createdAt;
    const maxMinutes = Number.isFinite(state.maxMinutes) ? Math.max(1, state.maxMinutes) : 1;
    if (now - startedAt >= maxMinutes * 60_000) {
      return { action: "request-stop", reason: "deadline" };
    }
    if (!state.hasFreshHeartbeat && now - startedAt >= WORKER_STARTUP_GRACE_MS) {
      return { action: "request-stop", reason: "unresponsive" };
    }
    return { action: "none" };
  }

  if (!state.hasRecoverableWorker) {
    return { action: "none" };
  }
  // A worker saves its terminal result before disposing the SDK agent and
  // removing sidecars. Let normal cleanup finish before treating it as orphaned.
  return now - state.updatedAt >= WORKER_HARD_STOP_GRACE_MS
    ? { action: "request-stop", reason: "orphan" }
    : { action: "none" };
}
