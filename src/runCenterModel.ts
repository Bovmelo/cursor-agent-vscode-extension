export type RunCenterPlanStatus =
  | "pending"
  | "running"
  | "completed"
  | "blocked"
  | "skipped";

export interface RunCenterPlanItem {
  readonly id: string;
  readonly label: string;
  readonly status: RunCenterPlanStatus;
  readonly detail?: string;
}

export type RunCenterProgressStatus =
  | "queued"
  | "running"
  | "paused"
  | "completed";

export interface RunCenterProgress {
  readonly message: string;
  readonly status: RunCenterProgressStatus;
  readonly completed?: number;
  readonly total?: number;
  readonly percent?: number;
  readonly detail?: string;
}

export type RunCenterChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface RunCenterChangeOpenTarget {
  readonly command: string;
  readonly arguments?: readonly unknown[];
}

export interface RunCenterChange {
  readonly path: string;
  readonly status: RunCenterChangeStatus;
  readonly additions?: number;
  readonly deletions?: number;
  readonly previousPath?: string;
  readonly open?: RunCenterChangeOpenTarget;
}

export type RunCenterVerificationStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "skipped";

export interface RunCenterVerification {
  readonly id: string;
  readonly label: string;
  readonly status: RunCenterVerificationStatus;
  readonly detail?: string;
}

export interface RunCenterError {
  readonly message: string;
  readonly code?: string;
  readonly detail?: string;
}

export interface RunCenterRecoveryAction {
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly arguments?: readonly unknown[];
  readonly description?: string;
}

/** A host-owned snapshot. All fields are optional so producers can publish incrementally. */
export interface RunCenterState {
  readonly runId?: string;
  readonly title?: string;
  readonly plan?: readonly RunCenterPlanItem[];
  readonly progress?: RunCenterProgress;
  readonly changes?: readonly RunCenterChange[];
  readonly verification?: readonly RunCenterVerification[];
  readonly error?: RunCenterError;
  readonly recoveryActions?: readonly RunCenterRecoveryAction[];
  readonly updatedAt?: number;
}

export type RunCenterSectionId =
  | "plan"
  | "progress"
  | "changes"
  | "verification"
  | "error"
  | "recovery";

export interface RunCenterSectionNode {
  readonly kind: "section";
  readonly sectionId: RunCenterSectionId;
}

export interface RunCenterPlanNode {
  readonly kind: "plan";
  readonly item: RunCenterPlanItem;
}

export interface RunCenterProgressNode {
  readonly kind: "progress";
  readonly progress: RunCenterProgress;
}

export interface RunCenterChangeNode {
  readonly kind: "change";
  readonly change: RunCenterChange;
}

export interface RunCenterVerificationNode {
  readonly kind: "verification";
  readonly verification: RunCenterVerification;
}

export interface RunCenterErrorNode {
  readonly kind: "error";
  readonly error: RunCenterError;
}

export interface RunCenterRecoveryNode {
  readonly kind: "recovery";
  readonly action: RunCenterRecoveryAction;
}

export type RunCenterEntryNode =
  | RunCenterPlanNode
  | RunCenterProgressNode
  | RunCenterChangeNode
  | RunCenterVerificationNode
  | RunCenterErrorNode
  | RunCenterRecoveryNode;

export type RunCenterTreeNode = RunCenterSectionNode | RunCenterEntryNode;

export const RUN_CENTER_SECTION_ORDER: readonly RunCenterSectionId[] = [
  "plan",
  "progress",
  "changes",
  "verification",
  "error",
  "recovery",
];

export function runCenterEntries(
  state: RunCenterState,
  sectionId: RunCenterSectionId,
): RunCenterEntryNode[] {
  switch (sectionId) {
    case "plan":
      return (state.plan ?? []).map((item) => ({ kind: "plan", item }));
    case "progress":
      return state.progress ? [{ kind: "progress", progress: state.progress }] : [];
    case "changes":
      return (state.changes ?? []).map((change) => ({ kind: "change", change }));
    case "verification":
      return (state.verification ?? []).map((verification) => ({
        kind: "verification",
        verification,
      }));
    case "error":
      return state.error ? [{ kind: "error", error: state.error }] : [];
    case "recovery":
      return (state.recoveryActions ?? []).map((action) => ({ kind: "recovery", action }));
  }
}

export function runCenterSections(state: RunCenterState): RunCenterSectionNode[] {
  return RUN_CENTER_SECTION_ORDER
    .filter((sectionId) => runCenterEntries(state, sectionId).length > 0)
    .map((sectionId) => ({ kind: "section", sectionId }));
}

export function runCenterSectionLabel(
  sectionId: RunCenterSectionId,
  japanese: boolean,
): string {
  const labels: Record<RunCenterSectionId, [string, string]> = {
    plan: ["Plan", "計画"],
    progress: ["Progress", "進行状況"],
    changes: ["Changes", "変更"],
    verification: ["Verification", "検証"],
    error: ["Error", "エラー"],
    recovery: ["Recovery", "復旧アクション"],
  };
  return japanese ? labels[sectionId][1] : labels[sectionId][0];
}

export function runCenterSectionIcon(sectionId: RunCenterSectionId): string {
  const icons: Record<RunCenterSectionId, string> = {
    plan: "list-ordered",
    progress: "pulse",
    changes: "diff",
    verification: "beaker",
    error: "error",
    recovery: "debug-restart",
  };
  return icons[sectionId];
}

export function runCenterProgressDescription(progress: RunCenterProgress): string {
  if (progress.total !== undefined && progress.total > 0 && progress.completed !== undefined) {
    const completed = Math.min(progress.total, Math.max(0, Math.trunc(progress.completed)));
    return `${completed}/${Math.trunc(progress.total)}`;
  }
  if (progress.percent !== undefined) {
    const percent = Math.min(100, Math.max(0, Math.round(progress.percent)));
    return `${percent}%`;
  }
  return progress.status;
}

export function cloneRunCenterState(state: RunCenterState): RunCenterState {
  return {
    ...state,
    plan: state.plan?.map((item) => ({ ...item })),
    progress: state.progress ? { ...state.progress } : undefined,
    changes: state.changes?.map((change) => ({
      ...change,
      open: change.open
        ? {
            ...change.open,
            arguments: change.open.arguments ? [...change.open.arguments] : undefined,
          }
        : undefined,
    })),
    verification: state.verification?.map((verification) => ({ ...verification })),
    error: state.error ? { ...state.error } : undefined,
    recoveryActions: state.recoveryActions?.map((action) => ({
      ...action,
      arguments: action.arguments ? [...action.arguments] : undefined,
    })),
  };
}
