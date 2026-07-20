import type { BackgroundJobStatus } from "./backgroundJobTypes.js";
import type { IsolatedChange } from "./isolatedWorktree.js";

export type BackgroundPendingChange = IsolatedChange & { excluded: boolean };

export interface BackgroundChangeTarget {
  jobId: string;
  relative?: string;
}

export function canPreviewBackgroundChanges(status: BackgroundJobStatus): boolean {
  return status === "completed";
}

export function backgroundChangeDescription(
  change: BackgroundPendingChange,
  japanese: boolean,
): string {
  const stats = `${change.kind} +${change.added}/-${change.deleted}`;
  if (!change.excluded) {
    return stats;
  }
  return japanese ? `${stats} · 除外` : `${stats} · excluded`;
}

export function backgroundChangeContextValue(
  change: Pick<BackgroundPendingChange, "excluded">,
): string {
  return change.excluded ? "cursorBackground.change.excluded" : "cursorBackground.change.pending";
}

export interface BackgroundJobChildDraft {
  kind: "summary" | "change";
  label: string;
  description?: string;
  relative?: string;
  excluded?: boolean;
}

/** Sync tree children for a background job once pending-change cache state is known. */
export function buildBackgroundJobChildDrafts(input: {
  summaryLabel: string;
  workspaceRoot: string;
  changes?: readonly BackgroundPendingChange[];
  loadError?: string;
  loading: boolean;
  japanese: boolean;
}): BackgroundJobChildDraft[] {
  const children: BackgroundJobChildDraft[] = [
    {
      kind: "summary",
      label: input.summaryLabel,
      description: input.workspaceRoot,
    },
  ];
  if (input.loadError) {
    children.push({
      kind: "summary",
      label: input.loadError,
    });
    return children;
  }
  if (input.loading || input.changes === undefined) {
    children.push({
      kind: "summary",
      label: input.japanese ? "変更を読み込み中…" : "Loading changes…",
    });
    return children;
  }
  if (input.changes.length === 0) {
    children.push({
      kind: "summary",
      label: input.japanese ? "ファイル変更はありません" : "No file changes",
    });
    return children;
  }
  for (const change of input.changes) {
    children.push({
      kind: "change",
      label: change.relative,
      description: backgroundChangeDescription(change, input.japanese),
      relative: change.relative,
      excluded: change.excluded,
    });
  }
  return children;
}
