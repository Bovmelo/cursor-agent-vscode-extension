export type SchedulableSupervisorStatus =
  | "detected"
  | "queued"
  | "running"
  | "review"
  | "blocked"
  | "applying"
  | "completed"
  | "failed"
  | "dismissed";

export interface SchedulableSupervisorTask {
  id: string;
  createdAt: number;
  priority?: "high" | "normal" | "low";
  status: SchedulableSupervisorStatus;
  dependencyIds?: string[];
  file?: string;
  ownedFiles?: string[];
}

export interface DependencyReadiness {
  ready: boolean;
  waiting: string[];
  failed: string[];
  missing: string[];
}

const PRIORITY_RANK: Record<NonNullable<SchedulableSupervisorTask["priority"]>, number> = {
  high: 0,
  normal: 1,
  low: 2,
};

export function dependencyReadiness(
  task: SchedulableSupervisorTask,
  tasks: readonly SchedulableSupervisorTask[],
): DependencyReadiness {
  const byId = new Map(tasks.map((candidate) => [candidate.id, candidate]));
  const waiting: string[] = [];
  const failed: string[] = [];
  const missing: string[] = [];
  if (hasDependencyCycle(task.id, byId)) {
    failed.push(task.id);
  }
  for (const dependencyId of [...new Set(task.dependencyIds ?? [])]) {
    if (dependencyId === task.id) {
      failed.push(dependencyId);
      continue;
    }
    const dependency = byId.get(dependencyId);
    if (!dependency || dependency.status === "dismissed") {
      missing.push(dependencyId);
    } else if (dependency.status === "failed" || dependency.status === "blocked") {
      failed.push(dependencyId);
    } else if (dependency.status !== "completed") {
      waiting.push(dependencyId);
    }
  }
  return {
    ready: waiting.length === 0 && failed.length === 0 && missing.length === 0,
    waiting,
    failed,
    missing,
  };
}

export function supervisorFileClaims(task: SchedulableSupervisorTask): string[] {
  return [...new Set([task.file, ...(task.ownedFiles ?? [])]
    .filter((file): file is string => Boolean(file))
    .map((file) => file.replaceAll("\\", "/").toLowerCase()))];
}

export function overlappingTaskIds(
  task: SchedulableSupervisorTask,
  tasks: readonly SchedulableSupervisorTask[],
): string[] {
  const claims = new Set(supervisorFileClaims(task));
  if (claims.size === 0) {
    return [];
  }
  return tasks
    .filter((candidate) => candidate.id !== task.id)
    .filter((candidate) => ["running", "review", "blocked", "applying"].includes(candidate.status))
    .filter((candidate) => supervisorFileClaims(candidate).some((file) => claims.has(file)))
    .map((candidate) => candidate.id);
}

export function selectRunnableSupervisorTasks(
  tasks: readonly SchedulableSupervisorTask[],
  maximum: number,
): SchedulableSupervisorTask[] {
  const selected: SchedulableSupervisorTask[] = [];
  const candidates = tasks
    .filter((task) => task.status === "queued" || task.status === "detected")
    .filter((task) => dependencyReadiness(task, tasks).ready)
    .sort((left, right) => {
      const priorityDelta = PRIORITY_RANK[left.priority ?? "normal"]
        - PRIORITY_RANK[right.priority ?? "normal"];
      return priorityDelta || left.createdAt - right.createdAt;
    });
  for (const candidate of candidates) {
    if (selected.length >= Math.max(0, maximum)) {
      break;
    }
    const selectedClaims = new Set(selected.flatMap(supervisorFileClaims));
    if (
      overlappingTaskIds(candidate, tasks).length === 0
      && supervisorFileClaims(candidate).every((claim) => !selectedClaims.has(claim))
    ) {
      selected.push(candidate);
    }
  }
  return selected;
}

function hasDependencyCycle(
  startId: string,
  byId: ReadonlyMap<string, SchedulableSupervisorTask>,
): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) {
      return true;
    }
    if (visited.has(id)) {
      return false;
    }
    visiting.add(id);
    const task = byId.get(id);
    for (const dependencyId of task?.dependencyIds ?? []) {
      if (byId.has(dependencyId) && visit(dependencyId)) {
        return true;
      }
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return visit(startId);
}
