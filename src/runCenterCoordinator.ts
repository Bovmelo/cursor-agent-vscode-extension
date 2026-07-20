import * as path from "node:path";
import type { RunCenterState } from "./runCenterModel.js";

/** Relative POSIX path that stays correct when session roots use Windows paths on POSIX CI hosts. */
export function runCenterRelativePath(root: string, file: string): string {
  const looksWindows =
    /^[A-Za-z]:[\\/]/.test(root) ||
    /^[A-Za-z]:[\\/]/.test(file) ||
    root.includes("\\") ||
    file.includes("\\");
  return (looksWindows ? path.win32 : path).relative(root, file).replaceAll("\\", "/");
}

export interface RunCenterTranscriptSnapshot {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly error?: boolean;
  readonly progress?: readonly RunCenterToolProgressSnapshot[];
  readonly progressState?: "completed" | "stopped" | "error";
}

export interface RunCenterConversationSnapshot {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: number;
  readonly transcript: readonly RunCenterTranscriptSnapshot[];
}

export interface RunCenterToolProgressSnapshot {
  readonly id: string;
  readonly text: string;
  readonly status: "running" | "completed" | "error" | "stopped";
}

export interface RunCenterLiveSnapshot {
  readonly assistantText: string;
  readonly progressSteps: readonly RunCenterToolProgressSnapshot[];
  readonly progressState: "completed" | "stopped" | "error";
}

export interface RunCenterRuntimeSnapshot {
  readonly conversationId: string;
  readonly busy: boolean;
  readonly live?: RunCenterLiveSnapshot;
}

export interface RunCenterVerificationStepSnapshot {
  readonly command: string;
  readonly success: boolean;
  readonly output: string;
}

export interface RunCenterVerificationSnapshot {
  readonly success: boolean;
  readonly steps: readonly RunCenterVerificationStepSnapshot[];
}

export interface RunCenterSessionSnapshot {
  readonly id: string;
  readonly goal: string;
  readonly root: string;
  readonly files: readonly string[];
  readonly pendingFiles?: readonly string[];
  readonly verification?: RunCenterVerificationSnapshot;
}

export interface RunCenterPlanStepSnapshot {
  readonly id: string;
  readonly title: string;
  readonly status: "pending" | "running" | "completed" | "failed";
  readonly error?: string;
}

export interface RunCenterPlanSnapshot {
  readonly steps: readonly RunCenterPlanStepSnapshot[];
}

export type BackgroundRunStatus =
  | "starting"
  | "running"
  | "completed"
  | "applying"
  | "applied"
  | "cancelled"
  | "discarded"
  | "error";

export interface BackgroundChangeSnapshot {
  readonly relative: string;
  readonly kind: "added" | "modified" | "deleted";
  readonly added: number;
  readonly deleted: number;
}

export interface BackgroundRunSnapshot {
  readonly id: string;
  readonly title: string;
  readonly status: BackgroundRunStatus;
  readonly updatedAt: number;
  readonly assistantText?: string;
  readonly error?: string;
  readonly changes?: readonly BackgroundChangeSnapshot[];
}

export type SupervisorRunStatus =
  | "detected"
  | "queued"
  | "running"
  | "review"
  | "blocked"
  | "applying"
  | "completed"
  | "failed"
  | "dismissed";

export interface SupervisorChangeSnapshot {
  readonly relative: string;
  readonly added: number;
  readonly deleted: number;
}

export interface SupervisorRunSnapshot {
  readonly id: string;
  readonly title: string;
  readonly status: SupervisorRunStatus;
  readonly updatedAt: number;
  readonly dependencyIds?: readonly string[];
  readonly changes?: readonly SupervisorChangeSnapshot[];
  readonly verification?: RunCenterVerificationSnapshot;
  readonly blockedReasons?: readonly string[];
  readonly error?: string;
}

export interface RunCenterSnapshot {
  readonly conversations?: readonly RunCenterConversationSnapshot[];
  readonly runtimes?: readonly RunCenterRuntimeSnapshot[];
  readonly activeConversationId?: string;
  readonly queuedConversationIds?: readonly string[];
  readonly session?: RunCenterSessionSnapshot;
  readonly plan?: RunCenterPlanSnapshot;
  readonly backgroundJobs?: readonly BackgroundRunSnapshot[];
  readonly supervisorTasks?: readonly SupervisorRunSnapshot[];
  readonly now?: number;
}

const BACKGROUND_VISIBLE = new Set<BackgroundRunStatus>([
  "starting",
  "running",
  "completed",
  "applying",
  "error",
]);
const BACKGROUND_ACTIVE = new Set<BackgroundRunStatus>(["starting", "running", "applying"]);
const SUPERVISOR_VISIBLE = new Set<SupervisorRunStatus>([
  "queued",
  "running",
  "review",
  "blocked",
  "applying",
  "failed",
]);
const SUPERVISOR_ACTIVE = new Set<SupervisorRunStatus>(["queued", "running", "applying"]);

/** Projects host-owned snapshots into a Run Center state without importing VS Code. */
export class RunCenterCoordinator {
  public constructor(private readonly japanese = false) {}

  public buildState(snapshot: RunCenterSnapshot): RunCenterState {
    const runtimes = new Map(
      (snapshot.runtimes ?? []).map((runtime) => [runtime.conversationId, runtime]),
    );
    const conversation = [...(snapshot.conversations ?? [])].sort((left, right) => {
      const busyDelta =
        Number(runtimes.get(right.id)?.busy === true) -
        Number(runtimes.get(left.id)?.busy === true);
      if (busyDelta) return busyDelta;
      if (left.id === snapshot.activeConversationId) return -1;
      if (right.id === snapshot.activeConversationId) return 1;
      return right.updatedAt - left.updatedAt;
    })[0];

    const background = this.latestVisibleBackground(snapshot.backgroundJobs ?? []);
    const supervisor = this.latestVisibleSupervisor(snapshot.supervisorTasks ?? []);
    const operational = [
      background
        ? { kind: "background" as const, updatedAt: background.updatedAt, value: background }
        : undefined,
      supervisor
        ? { kind: "supervisor" as const, updatedAt: supervisor.updatedAt, value: supervisor }
        : undefined,
    ]
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined)
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    const operationalActive =
      operational?.kind === "background"
        ? BACKGROUND_ACTIVE.has(operational.value.status)
        : operational?.kind === "supervisor"
          ? SUPERVISOR_ACTIVE.has(operational.value.status)
          : false;
    if (
      operational &&
      (operationalActive || operational.updatedAt >= (conversation?.updatedAt ?? 0))
    ) {
      return operational.kind === "background"
        ? this.backgroundRunCenterState(operational.value)
        : this.supervisorRunCenterState(operational.value, snapshot.supervisorTasks ?? []);
    }

    const runtime = conversation ? runtimes.get(conversation.id) : undefined;
    const assistant: RunCenterTranscriptSnapshot | undefined = runtime?.live
      ? {
          role: "assistant",
          text: runtime.live.assistantText,
          error: runtime.live.progressState === "error",
          progress: runtime.live.progressSteps,
          progressState: runtime.live.progressState,
        }
      : conversation
        ? [...conversation.transcript].reverse().find((entry) => entry.role === "assistant")
        : undefined;
    const session = snapshot.session;
    const recoveryActions: Array<NonNullable<RunCenterState["recoveryActions"]>[number]> = [];
    if (assistant?.error || assistant?.progressState === "error") {
      recoveryActions.push(
        {
          id: "retry",
          label: this.localize("Retry last run", "直前の実行を再試行"),
          command: "cursorSubscription.retryLastRun",
          description: this.localize(
            "Run the most recent user prompt again",
            "直前のユーザープロンプトを再実行",
          ),
        },
        {
          id: "logs",
          label: this.localize("Open Agent logs", "Agentログを開く"),
          command: "cursorSubscription.openOutput",
        },
        {
          id: "diagnostics",
          label: this.localize("Export diagnostics", "診断をエクスポート"),
          command: "cursorSubscription.exportDiagnostics",
        },
        {
          id: "runCenter",
          label: this.localize("Open Run Center", "実行センターを開く"),
          command: "cursorSubscription.openRunCenter",
        },
      );
    }
    if (session?.pendingFiles && session.pendingFiles.length > 0) {
      recoveryActions.push({
        id: "review",
        label: this.localize("Review pending changes", "確認待ち変更をレビュー"),
        command: "cursorSubscription.focusWorkspaceSessions",
      });
    }
    if (session?.verification && !session.verification.success) {
      recoveryActions.push({
        id: "verify",
        label: this.localize("Run verification again", "検証を再実行"),
        command: "cursorSubscription.verifyChanges",
      });
    }

    const runningProgress = assistant?.progress
      ?.filter((entry) => entry.status === "running")
      .at(-1);
    const queued = conversation
      ? (snapshot.queuedConversationIds ?? []).includes(conversation.id)
      : false;
    const progress = runtime?.busy
      ? {
          message: runningProgress?.text ?? this.localize("Agent is working", "Agentが実行中です"),
          status: "running" as const,
          completed: assistant?.progress?.filter((entry) => entry.status === "completed").length,
          total: assistant?.progress?.length,
        }
      : conversation && queued
        ? {
            message: this.localize(
              "Waiting for an available agent slot",
              "Agentの空きスロットを待機中",
            ),
            status: "queued" as const,
          }
        : assistant
          ? {
              message: assistant.error
                ? this.localize("Run failed", "実行に失敗")
                : assistant.progressState === "stopped"
                  ? this.localize("Run stopped", "実行を停止")
                  : this.localize("Run completed", "実行完了"),
              status:
                assistant.error || assistant.progressState === "stopped"
                  ? ("paused" as const)
                  : ("completed" as const),
            }
          : undefined;
    const errorText = assistant?.error ? assistant.text.trim() : undefined;
    return {
      runId: errorText ? /(?:^|\n)Run:\s*([^\s]+)/u.exec(errorText)?.[1] : conversation?.id,
      title: conversation?.title ?? session?.goal,
      plan: snapshot.plan?.steps.map((step) => ({
        id: step.id,
        label: step.title,
        status: step.status === "failed" ? "blocked" : step.status,
        detail: step.error,
      })),
      progress,
      changes: session?.files.map((file) => ({
        path: runCenterRelativePath(session.root, file),
        status: "modified" as const,
        open: {
          command: "cursorSubscription.openSessionFile",
          arguments: [session.id, file],
        },
      })),
      verification: session?.verification?.steps.map((step, index) => ({
        id: `${session.id}:${index}`,
        label: step.command,
        status: step.success ? ("passed" as const) : ("failed" as const),
        detail: step.output.slice(0, 1_000),
      })),
      error: errorText
        ? {
            message:
              errorText.split(/\r?\n/u).find(Boolean)?.slice(0, 240) ??
              this.localize("The run failed", "実行に失敗しました"),
            detail: errorText.slice(0, 2_000),
          }
        : undefined,
      recoveryActions,
      updatedAt: snapshot.now ?? Date.now(),
    };
  }

  public backgroundRunCenterState(job: BackgroundRunSnapshot): RunCenterState {
    const active = BACKGROUND_ACTIVE.has(job.status);
    const cleanupFailed = job.status === "applied" && Boolean(job.error);
    const failed = job.status === "error" || cleanupFailed;
    const recoveryActions: Array<NonNullable<RunCenterState["recoveryActions"]>[number]> = [];
    if (job.status === "completed") {
      recoveryActions.push(
        {
          id: `background-apply:${job.id}`,
          label: this.localize("Apply background changes", "バックグラウンド変更を適用"),
          command: "cursorSubscription.applyBackgroundJob",
          arguments: [job.id],
        },
        {
          id: `background-discard:${job.id}`,
          label: this.localize("Discard background result", "バックグラウンド結果を破棄"),
          command: "cursorSubscription.discardBackgroundJob",
          arguments: [job.id],
        },
      );
    } else if (job.status === "starting" || job.status === "running") {
      recoveryActions.push({
        id: `background-cancel:${job.id}`,
        label: this.localize("Cancel background agent", "バックグラウンドAgentを中止"),
        command: "cursorSubscription.cancelBackgroundJob",
        arguments: [job.id],
      });
    } else if (job.status === "applied") {
      recoveryActions.push({
        id: `background-cleanup:${job.id}`,
        label: this.localize(
          cleanupFailed ? "Retry applied-job cleanup" : "Clean up applied background job",
          cleanupFailed
            ? "適用済みジョブのクリーンアップを再試行"
            : "適用済みバックグラウンドジョブをクリーンアップ",
        ),
        command: "cursorSubscription.cleanupAppliedBackgroundJob",
        arguments: [job.id],
      });
    } else if (failed) {
      recoveryActions.push(
        {
          id: "background-retry",
          label: this.localize("Start a new background agent", "新しいバックグラウンドAgentを開始"),
          command: "cursorSubscription.startBackgroundJob",
        },
        {
          id: "background-logs",
          label: this.localize("Open Agent logs", "Agentログを開く"),
          command: "cursorSubscription.openOutput",
        },
        {
          id: "background-diagnostics",
          label: this.localize("Export diagnostics", "診断をエクスポート"),
          command: "cursorSubscription.exportDiagnostics",
        },
      );
    }
    return {
      runId: job.id,
      title: job.title,
      progress: {
        message: active
          ? this.localize("Background agent is working", "バックグラウンドAgentが実行中")
          : cleanupFailed
            ? this.localize(
                "Applied background-job cleanup needs attention",
                "適用済みバックグラウンドジョブのクリーンアップを確認してください",
              )
            : failed
            ? this.localize("Background agent failed", "バックグラウンドAgentが失敗")
            : this.localize("Background agent finished", "バックグラウンドAgentが完了"),
        status: active ? "running" : failed ? "paused" : "completed",
        detail: job.assistantText?.slice(0, 1_000),
      },
      changes:
        job.status === "completed"
          ? job.changes?.map((change) => ({
              path: change.relative,
              status: change.kind,
              additions: change.added,
              deletions: change.deleted,
              open: {
                command: "cursorSubscription.openBackgroundChange",
                arguments: [{ jobId: job.id, relative: change.relative }],
              },
            }))
          : undefined,
      error: job.error ? { message: job.error.split(/\r?\n/u)[0], detail: job.error } : undefined,
      recoveryActions,
      updatedAt: job.updatedAt,
    };
  }

  public supervisorRunCenterState(
    task: SupervisorRunSnapshot,
    tasks: readonly SupervisorRunSnapshot[],
  ): RunCenterState {
    const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
    const active = SUPERVISOR_ACTIVE.has(task.status);
    const failed = task.status === "failed" || task.status === "blocked";
    const recoveryActions: Array<NonNullable<RunCenterState["recoveryActions"]>[number]> = [];
    if (task.status === "review" || task.status === "blocked") {
      recoveryActions.push(
        {
          id: `supervisor-apply:${task.id}`,
          label: this.localize("Apply reviewed changes", "レビュー済み変更を適用"),
          command: "cursorSubscription.applyAllSupervisorChanges",
          arguments: [{ taskId: task.id }],
        },
        {
          id: `supervisor-discard:${task.id}`,
          label: this.localize("Discard Supervisor changes", "Supervisor変更を破棄"),
          command: "cursorSubscription.discardAllSupervisorChanges",
          arguments: [{ taskId: task.id }],
        },
      );
    }
    if (task.status === "failed") {
      recoveryActions.push(
        {
          id: `supervisor-retry:${task.id}`,
          label: this.localize("Run Supervisor task again", "Supervisorタスクを再実行"),
          command: "cursorSubscription.runSupervisorTask",
          arguments: [{ taskId: task.id }],
        },
        {
          id: "supervisor-logs",
          label: this.localize("Open Agent logs", "Agentログを開く"),
          command: "cursorSubscription.openOutput",
        },
      );
    }
    return {
      runId: task.id,
      title: task.title,
      plan: [
        ...(task.dependencyIds ?? []).map((dependencyId) => {
          const dependency = byId.get(dependencyId);
          return {
            id: dependencyId,
            label: dependency?.title ?? dependencyId,
            status:
              dependency?.status === "completed"
                ? ("completed" as const)
                : dependency?.status === "failed" || dependency?.status === "blocked"
                  ? ("blocked" as const)
                  : ("pending" as const),
          };
        }),
        {
          id: task.id,
          label: task.title,
          status:
            task.status === "completed"
              ? ("completed" as const)
              : failed
                ? ("blocked" as const)
                : active
                  ? ("running" as const)
                  : ("pending" as const),
        },
      ],
      progress: {
        message: active
          ? this.localize("Supervisor task is running", "Supervisorタスクが実行中")
          : failed
            ? this.localize("Supervisor task needs attention", "Supervisorタスクの確認が必要")
            : this.localize(
                "Supervisor task is ready for review",
                "Supervisorタスクをレビューできます",
              ),
        status: active ? "running" : failed ? "paused" : "completed",
      },
      changes: task.changes?.map((change) => ({
        path: change.relative,
        status: "modified" as const,
        additions: change.added,
        deletions: change.deleted,
        open: {
          command: "cursorSubscription.openSupervisorChange",
          arguments: [{ taskId: task.id, relative: change.relative }],
        },
      })),
      verification: task.verification?.steps.map((step, index) => ({
        id: `${task.id}:${index}`,
        label: step.command,
        status: step.success ? ("passed" as const) : ("failed" as const),
        detail: step.output.slice(0, 1_000),
      })),
      error:
        task.error || task.blockedReasons?.length
          ? {
              message:
                task.error ??
                task.blockedReasons?.[0] ??
                this.localize("Task blocked", "タスクがブロックされました"),
              detail: [task.error, ...(task.blockedReasons ?? [])].filter(Boolean).join("\n"),
            }
          : undefined,
      recoveryActions,
      updatedAt: task.updatedAt,
    };
  }

  private latestVisibleBackground(
    jobs: readonly BackgroundRunSnapshot[],
  ): BackgroundRunSnapshot | undefined {
    return jobs
      .filter(
        (job) =>
          BACKGROUND_VISIBLE.has(job.status) ||
          (job.status === "applied" && Boolean(job.error)),
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
  }

  private latestVisibleSupervisor(
    tasks: readonly SupervisorRunSnapshot[],
  ): SupervisorRunSnapshot | undefined {
    return tasks
      .filter((task) => SUPERVISOR_VISIBLE.has(task.status))
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
  }

  private localize(english: string, japanese: string): string {
    return this.japanese ? japanese : english;
  }
}

export function buildRunCenterState(snapshot: RunCenterSnapshot, japanese = false): RunCenterState {
  return new RunCenterCoordinator(japanese).buildState(snapshot);
}

export function buildBackgroundRunCenterState(
  job: BackgroundRunSnapshot,
  japanese = false,
): RunCenterState {
  return new RunCenterCoordinator(japanese).backgroundRunCenterState(job);
}

export function buildSupervisorRunCenterState(
  task: SupervisorRunSnapshot,
  tasks: readonly SupervisorRunSnapshot[],
  japanese = false,
): RunCenterState {
  return new RunCenterCoordinator(japanese).supervisorRunCenterState(task, tasks);
}
