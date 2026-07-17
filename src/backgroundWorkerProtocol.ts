export const WORKER_HEARTBEAT_MAX_AGE_MS = 15_000;
export const WORKER_STARTUP_GRACE_MS = 30_000;

export interface BackgroundWorkerHeartbeat {
  token: string;
  pid: number;
  updatedAt: number;
}

export interface BackgroundWorkerCancellation {
  token: string;
  requestedAt: number;
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

export function isAuthenticatedWorkerHeartbeat(
  expectedToken: string | undefined,
  expectedPid: number | undefined,
  heartbeat: BackgroundWorkerHeartbeat,
  now = Date.now(),
): boolean {
  return Boolean(
    expectedToken
      && heartbeat.token === expectedToken
      && Number.isSafeInteger(heartbeat.pid)
      && heartbeat.pid > 0
      && (!expectedPid || heartbeat.pid === expectedPid)
      && heartbeat.updatedAt <= now
      && now - heartbeat.updatedAt <= WORKER_HEARTBEAT_MAX_AGE_MS,
  );
}

export function isAuthenticatedWorkerCancellation(
  expectedToken: string,
  cancellation: BackgroundWorkerCancellation,
): boolean {
  return cancellation.token === expectedToken && Number.isFinite(cancellation.requestedAt);
}
