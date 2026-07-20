import type { BackgroundJob } from "./backgroundJobTypes.js";
import type { Conversation } from "./chatTypes.js";
import type { ExecutionPlan } from "./executionPlan.js";
import type {
  BackgroundRunSnapshot,
  RunCenterConversationSnapshot,
  RunCenterLiveSnapshot,
  RunCenterPlanSnapshot,
  RunCenterRuntimeSnapshot,
  RunCenterSessionSnapshot,
  RunCenterSnapshot,
  RunCenterToolProgressSnapshot,
  SupervisorRunSnapshot,
} from "./runCenterCoordinator.js";
import type { SupervisorTask } from "./supervisor.js";

export interface RunCenterHostRuntimeInput {
  readonly conversationId: string;
  readonly busy: boolean;
  readonly live?: {
    readonly assistantText: string;
    readonly progressSteps: readonly RunCenterToolProgressSnapshot[];
    readonly progressState: "completed" | "stopped" | "error";
  };
}

type HostBackgroundJob = BackgroundJob & {
  readonly changes?: BackgroundRunSnapshot["changes"];
};

export interface RunCenterHostSnapshotInput {
  readonly conversations: readonly Conversation[];
  readonly runtimes: readonly RunCenterHostRuntimeInput[];
  readonly activeConversationId?: string;
  readonly queuedConversationIds: readonly string[];
  readonly session?: RunCenterSessionSnapshot;
  readonly plan?: ExecutionPlan;
  readonly backgroundJobs: readonly HostBackgroundJob[];
  readonly supervisorTasks: readonly SupervisorTask[];
  readonly now?: number;
}

function toConversationSnapshot(conversation: Conversation): RunCenterConversationSnapshot {
  return {
    id: conversation.id,
    title: conversation.title,
    updatedAt: conversation.updatedAt,
    transcript: conversation.transcript.map((entry) => ({
      role: entry.role,
      text: entry.text,
      error: entry.error,
      progress: entry.progress,
      progressState: entry.progressState,
    })),
  };
}

function toRuntimeSnapshot(runtime: RunCenterHostRuntimeInput): RunCenterRuntimeSnapshot {
  const live: RunCenterLiveSnapshot | undefined = runtime.live
    ? {
        assistantText: runtime.live.assistantText,
        progressSteps: runtime.live.progressSteps,
        progressState: runtime.live.progressState,
      }
    : undefined;
  return {
    conversationId: runtime.conversationId,
    busy: runtime.busy,
    live,
  };
}

function toPlanSnapshot(plan: ExecutionPlan | undefined): RunCenterPlanSnapshot | undefined {
  if (!plan) {
    return undefined;
  }
  return {
    steps: plan.steps.map((step) => ({
      id: step.id,
      title: step.title,
      status: step.status,
      error: step.error,
    })),
  };
}

function toBackgroundSnapshot(job: HostBackgroundJob): BackgroundRunSnapshot {
  return {
    id: job.id,
    title: job.title,
    status: job.status,
    updatedAt: job.updatedAt,
    assistantText: job.assistantText,
    error: job.error,
    changes: job.changes?.map((change) => ({
      relative: change.relative,
      kind: change.kind,
      added: change.added,
      deleted: change.deleted,
    })),
  };
}

function toSupervisorSnapshot(task: SupervisorTask): SupervisorRunSnapshot {
  return {
    id: task.id,
    title: task.title,
    status: task.status,
    updatedAt: task.updatedAt,
    dependencyIds: task.dependencyIds,
    changes: task.changes?.map((change) => ({
      relative: change.relative,
      added: change.added,
      deleted: change.deleted,
    })),
    verification: task.verification
      ? {
          success: task.verification.success,
          steps: task.verification.steps.map((step) => ({
            command: step.command,
            success: step.success,
            output: step.output,
          })),
        }
      : undefined,
    blockedReasons: task.blockedReasons,
    error: task.error,
  };
}

/** Map host-owned chat/runtime/job state into a Run Center coordinator snapshot. */
export function buildRunCenterHostSnapshot(input: RunCenterHostSnapshotInput): RunCenterSnapshot {
  return {
    conversations: input.conversations.map(toConversationSnapshot),
    runtimes: input.runtimes.map(toRuntimeSnapshot),
    activeConversationId: input.activeConversationId,
    queuedConversationIds: input.queuedConversationIds,
    session: input.session,
    plan: toPlanSnapshot(input.plan),
    backgroundJobs: input.backgroundJobs.map(toBackgroundSnapshot),
    supervisorTasks: input.supervisorTasks.map(toSupervisorSnapshot),
    now: input.now,
  };
}
