import type { BackgroundJob } from "./backgroundJobTypes.js";
import { redactDiagnosticText } from "./diagnosticsBundle.js";
import type { RunCenterState } from "./runCenterModel.js";
import type { SupervisorTask } from "./supervisor.js";

const DEFAULT_LIMIT = 10;
const ERROR_MAX_CHARS = 500;

export interface DiagnosticsBackgroundJobSummary {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly error?: string;
  readonly usage?: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly totalTokens?: number;
  };
}

export interface DiagnosticsRunCenterSummary {
  readonly runId?: string;
  readonly title?: string;
  readonly progress?: {
    readonly message: string;
    readonly status: string;
    readonly percent?: number;
    readonly detail?: string;
  };
  readonly planSteps?: readonly {
    readonly label: string;
    readonly status: string;
  }[];
  readonly changeCount?: number;
  readonly verificationSummary?: readonly {
    readonly label: string;
    readonly status: string;
  }[];
  readonly error?: string;
  readonly updatedAt?: string;
}

export interface DiagnosticsSupervisorTaskSummary {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly source: string;
  readonly updatedAt: string;
  readonly error?: string;
  readonly blockedReasons?: readonly string[];
  readonly changeCount?: number;
  readonly reviewVerdict?: string;
}

function truncateAndRedact(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const clipped = value.length > ERROR_MAX_CHARS ? value.slice(0, ERROR_MAX_CHARS) : value;
  return redactDiagnosticText(clipped);
}

/** Map background jobs to redacted summaries. Never includes prompts. */
export function summarizeBackgroundJobs(
  jobs: readonly BackgroundJob[],
  limit = DEFAULT_LIMIT,
): DiagnosticsBackgroundJobSummary[] {
  return jobs.slice(0, Math.max(0, limit)).map((job) => ({
    id: job.id,
    title: redactDiagnosticText(job.title),
    status: job.status,
    updatedAt: new Date(job.updatedAt).toISOString(),
    error: truncateAndRedact(job.error),
    usage: job.usage
      ? {
          inputTokens: job.usage.inputTokens,
          outputTokens: job.usage.outputTokens,
          totalTokens: job.usage.totalTokens,
        }
      : undefined,
  }));
}

/** Map a Run Center snapshot to a redacted summary without recovery payloads. */
export function summarizeRunCenter(state: RunCenterState): DiagnosticsRunCenterSummary {
  return {
    runId: state.runId,
    title: state.title === undefined ? undefined : redactDiagnosticText(state.title),
    progress: state.progress
      ? {
          message: redactDiagnosticText(state.progress.message),
          status: state.progress.status,
          percent: state.progress.percent,
          detail: truncateAndRedact(state.progress.detail),
        }
      : undefined,
    planSteps: state.plan?.map((step) => ({
      label: redactDiagnosticText(step.label),
      status: step.status,
    })),
    changeCount: state.changes?.length,
    verificationSummary: state.verification?.map((item) => ({
      label: redactDiagnosticText(item.label),
      status: item.status,
    })),
    error: truncateAndRedact(state.error?.message),
    updatedAt: state.updatedAt === undefined
      ? undefined
      : new Date(state.updatedAt).toISOString(),
  };
}

/** Map supervisor tasks to redacted summaries. Never includes prompts or details. */
export function summarizeSupervisorTasks(
  tasks: readonly SupervisorTask[],
  limit = DEFAULT_LIMIT,
): DiagnosticsSupervisorTaskSummary[] {
  return tasks.slice(0, Math.max(0, limit)).map((task) => ({
    id: task.id,
    title: redactDiagnosticText(task.title),
    status: task.status,
    source: task.source,
    updatedAt: new Date(task.updatedAt).toISOString(),
    error: truncateAndRedact(task.error),
    blockedReasons: task.blockedReasons?.map((reason) => redactDiagnosticText(reason)),
    changeCount: task.changes?.length,
    reviewVerdict: task.reviewVerdict,
  }));
}
