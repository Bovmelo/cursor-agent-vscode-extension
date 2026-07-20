import type { BackgroundJobStatus } from "./backgroundJobTypes.js";
import type { BackgroundWorkerCancellationReason } from "./backgroundWorkerProtocol.js";

export interface BackgroundJobState {
  status: BackgroundJobStatus;
  error?: string;
}

export type BackgroundJobStateEvent =
  | { type: "launch-failed"; error: string }
  | {
      type: "cancel";
      reason: BackgroundWorkerCancellationReason;
      workerExitConfirmed?: boolean;
    }
  | { type: "begin-apply" }
  | { type: "apply-succeeded" }
  | { type: "apply-failed"; error: string }
  | { type: "apply-uncertain"; error: string }
  | { type: "applied-cleanup-failed"; error: string }
  | { type: "discard" };

export interface BackgroundJobStateUpdate {
  status: BackgroundJobStatus;
  error: string | undefined;
}

export interface BackgroundJobStateMachineMessages {
  deadline: string;
  unresponsive: string;
}

const ACTIVE_STATUSES: ReadonlySet<BackgroundJobStatus> = new Set(["starting", "running"]);
const DISCARDABLE_STATUSES: ReadonlySet<BackgroundJobStatus> = new Set([
  "completed",
  "error",
  "cancelled",
]);

export function isActiveBackgroundJobStatus(status: BackgroundJobStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

/**
 * Pure host-side state machine. Persistence and worker/process effects belong
 * to the controller/repository boundary and are deliberately not performed here.
 */
export function reduceBackgroundJobState(
  current: Readonly<BackgroundJobState>,
  event: Readonly<BackgroundJobStateEvent>,
  messages: Readonly<BackgroundJobStateMachineMessages>,
): BackgroundJobStateUpdate | undefined {
  switch (event.type) {
    case "launch-failed":
      return isActiveBackgroundJobStatus(current.status)
        ? { status: "error", error: event.error }
        : undefined;
    case "cancel": {
      if (event.reason === "orphan" && event.workerExitConfirmed !== true) {
        return undefined;
      }
      // An orphan cleanup is maintenance after a terminal worker save. It must
      // never turn an applyable completed result into a cancellation.
      if (
        !isActiveBackgroundJobStatus(current.status) &&
        (current.status !== "completed" || event.reason === "orphan")
      ) {
        return undefined;
      }
      if (event.reason === "deadline") {
        return { status: "error", error: messages.deadline };
      }
      if (event.reason === "unresponsive") {
        return { status: "error", error: messages.unresponsive };
      }
      return { status: "cancelled", error: undefined };
    }
    case "begin-apply":
      return current.status === "completed" ? { status: "applying", error: undefined } : undefined;
    case "apply-succeeded":
      return current.status === "applying" ? { status: "applied", error: undefined } : undefined;
    case "apply-failed":
      return current.status === "applying"
        ? { status: "completed", error: event.error }
        : undefined;
    case "apply-uncertain":
      return current.status === "applying" ? { status: "error", error: event.error } : undefined;
    case "applied-cleanup-failed":
      return current.status === "applied" ? { status: "applied", error: event.error } : undefined;
    case "discard":
      return DISCARDABLE_STATUSES.has(current.status)
        ? { status: "discarded", error: current.error }
        : undefined;
  }
}
