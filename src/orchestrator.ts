import { randomUUID } from "node:crypto";

export interface OrchestratorActivity {
  text: string;
  path?: string;
}

export interface OrchestratorSubtask {
  id: string;
  title: string;
  prompt: string;
  conversationId?: string;
  status: "pending" | "running" | "completed" | "failed";
}

export interface OrchestratorExperiment {
  id: string;
  prompt: string;
  createdAt: number;
  planAttempts?: number;
  planConversationId?: string;
  synthesisConversationId?: string;
  subtasks: OrchestratorSubtask[];
  status: "planning" | "running" | "synthesizing" | "completed" | "failed";
  error?: string;
}

export function createOrchestratorExperiment(prompt: string): OrchestratorExperiment {
  return {
    id: randomUUID(),
    prompt,
    createdAt: Date.now(),
    planAttempts: 1,
    subtasks: [],
    status: "planning",
  };
}

function parseSubtaskArray(candidate: string): Array<{ title: string; prompt: string }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate) as unknown;
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as { title?: unknown; prompt?: unknown };
    const title = typeof record.title === "string" ? record.title.trim() : "";
    const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
    if (!title || !prompt) {
      return [];
    }
    return [{ title: title.slice(0, 80), prompt }];
  }).slice(0, 8);
}

export function parseOrchestratorSubtasks(text: string): Array<{ title: string; prompt: string }> {
  const taggedBlocks = [...text.matchAll(/<ORCHESTRATOR_SUBTASKS>\s*([\s\S]*?)\s*<\/ORCHESTRATOR_SUBTASKS>/gi)]
    .map((match) => match[1]?.trim())
    .filter((block): block is string => Boolean(block));
  // When tagged blocks are present, only accept those (avoid incidental JSON arrays).
  if (taggedBlocks.length > 0) {
    for (const candidate of taggedBlocks) {
      const subtasks = parseSubtaskArray(candidate);
      if (subtasks.length > 0) {
        return subtasks;
      }
    }
    return [];
  }

  const fencedBlocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)]
    .map((match) => match[1]?.trim())
    .filter((block): block is string => Boolean(block));
  for (const candidate of [...fencedBlocks, ...extractJsonArrays(text)]) {
    const subtasks = parseSubtaskArray(candidate);
    if (subtasks.length > 0) {
      return subtasks;
    }
  }
  return [];
}

function extractJsonArrays(text: string): string[] {
  const arrays: string[] = [];
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== "[") {
      continue;
    }
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const character = text[index];
      if (quoted) {
        if (escaped) {
          escaped = false;
        } else if (character === "\\") {
          escaped = true;
        } else if (character === '"') {
          quoted = false;
        }
        continue;
      }
      if (character === '"') {
        quoted = true;
      } else if (character === "[") {
        depth += 1;
      } else if (character === "]") {
        depth -= 1;
        if (depth === 0) {
          arrays.push(text.slice(start, index + 1));
          start = index;
          break;
        }
      }
    }
  }
  return arrays;
}

export function buildOrchestratorPlanPrompt(prompt: string, retry = false): string {
  return [
    retry
      ? "Your previous response omitted the required machine-readable subtask list."
      : "Create a parallel execution plan for the request below.",
    "Original request:",
    prompt,
    "",
    "Return only this exact structure, with 2-8 independent executable subtasks:",
    "<ORCHESTRATOR_SUBTASKS>",
    '[{"title":"first task","prompt":"complete standalone agent instructions"},{"title":"second task","prompt":"complete standalone agent instructions"}]',
    "</ORCHESTRATOR_SUBTASKS>",
    "Do not include commentary outside the tags. Do not edit files during planning.",
  ].join("\n");
}

export type OrchestratorPlanResolution =
  | { kind: "ready"; experiment: OrchestratorExperiment; usedFallback: boolean }
  | { kind: "retry"; experiment: OrchestratorExperiment; prompt: string };

export function resolveOrchestratorPlan(
  experiment: OrchestratorExperiment,
  assistantText: string,
): OrchestratorPlanResolution {
  const parsed = parseOrchestratorSubtasks(assistantText);
  if (parsed.length > 0) {
    return { kind: "ready", experiment: attachSubtasks(experiment, parsed), usedFallback: false };
  }
  if ((experiment.planAttempts ?? 1) < 2) {
    return {
      kind: "retry",
      experiment: { ...experiment, planAttempts: (experiment.planAttempts ?? 1) + 1 },
      prompt: buildOrchestratorPlanPrompt(experiment.prompt, true),
    };
  }
  return {
    kind: "ready",
    experiment: attachSubtasks(experiment, [{
      title: "Execute request",
      prompt: experiment.prompt,
    }]),
    usedFallback: true,
  };
}

export function attachSubtasks(
  experiment: OrchestratorExperiment,
  items: Array<{ title: string; prompt: string }>,
): OrchestratorExperiment {
  return {
    ...experiment,
    status: items.length > 0 ? "running" : "failed",
    error: items.length > 0 ? undefined : "No subtasks were produced by the planning step.",
    subtasks: items.map((item) => ({
      id: randomUUID(),
      title: item.title,
      prompt: item.prompt,
      status: "pending" as const,
    })),
  };
}

export function markSubtaskConversation(
  experiment: OrchestratorExperiment,
  subtaskId: string,
  conversationId: string,
): OrchestratorExperiment {
  return {
    ...experiment,
    subtasks: experiment.subtasks.map((subtask) =>
      subtask.id === subtaskId
        ? { ...subtask, conversationId, status: "pending" as const }
        : subtask
    ),
  };
}

export function markSubtaskLaunch(
  experiment: OrchestratorExperiment,
  conversationId: string,
  status: "running" | "failed",
  error?: string,
): OrchestratorExperiment {
  const subtasks = experiment.subtasks.map((subtask) =>
    subtask.conversationId === conversationId
      ? { ...subtask, status }
      : subtask
  );
  const allFailed = subtasks.length > 0
    && subtasks.every((subtask) => subtask.status === "failed");
  return {
    ...experiment,
    subtasks,
    status: allFailed ? "failed" : experiment.status,
    error: allFailed
      ? (error ?? "All subtasks failed to launch.")
      : experiment.error,
  };
}

export function markSubtaskStatus(
  experiment: OrchestratorExperiment,
  conversationId: string,
  status: "completed" | "failed",
): OrchestratorExperiment {
  const subtasks = experiment.subtasks.map((subtask) =>
    subtask.conversationId === conversationId
      ? { ...subtask, status }
      : subtask
  );
  const allDone = subtasks.length > 0
    && subtasks.every((subtask) => subtask.status === "completed" || subtask.status === "failed");
  const allFailed = allDone
    && subtasks.every((subtask) => subtask.status === "failed");
  return {
    ...experiment,
    subtasks,
    status: allDone
      ? (allFailed ? "failed" : "synthesizing")
      : experiment.status,
    error: allFailed ? (experiment.error ?? "All subtasks failed.") : experiment.error,
  };
}

export async function launchOrchestratorSubtasks<T>(
  launches: readonly T[],
  persistPreparedState: () => Promise<void>,
  launch: (item: T) => Promise<void>,
  maxConcurrency: number,
): Promise<void> {
  // Completion callbacks resolve conversations through persisted orchestrator
  // state, so every conversation id must be visible before any launch starts.
  await persistPreparedState();

  let nextIndex = 0;
  const workerCount = Math.min(
    launches.length,
    Math.max(0, Math.floor(maxConcurrency)),
  );
  if (workerCount === 0) {
    return;
  }
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < launches.length) {
      const index = nextIndex;
      nextIndex += 1;
      await launch(launches[index]);
    }
  }));
}

export function buildSynthesisPrompt(experiment: OrchestratorExperiment): string {
  const lines = experiment.subtasks.map((subtask, index) =>
    `${index + 1}. [${subtask.status}] ${subtask.title}`
  );
  return [
    "Integrate the parallel subtask results into one coherent outcome.",
    "Resolve overlaps, keep the smallest coherent change set, and report remaining risks.",
    "Original request:",
    experiment.prompt,
    "",
    "Subtasks:",
    ...lines,
  ].join("\n");
}

export function orchestratorSummaries(
  experiments: ReadonlyArray<OrchestratorExperiment>,
): Array<{
  id: string;
  prompt: string;
  status: OrchestratorExperiment["status"];
  createdAt: number;
  subtaskCount: number;
  completedCount: number;
}> {
  return experiments.map((experiment) => ({
    id: experiment.id,
    prompt: experiment.prompt,
    status: experiment.status,
    createdAt: experiment.createdAt,
    subtaskCount: experiment.subtasks.length,
    completedCount: experiment.subtasks.filter((subtask) => subtask.status === "completed").length,
  }));
}

export function buildOrchestratorDetail(
  experiment: OrchestratorExperiment,
  busyIds: ReadonlySet<string>,
  activities: ReadonlyMap<string, OrchestratorActivity> = new Map(),
): {
  id: string;
  prompt: string;
  status: OrchestratorExperiment["status"];
  createdAt: number;
  error?: string;
  plan: {
    conversationId?: string;
    running: boolean;
    activity?: OrchestratorActivity;
  };
  synthesis: {
    conversationId?: string;
    running: boolean;
    activity?: OrchestratorActivity;
  };
  subtasks: Array<{
    id: string;
    title: string;
    status: OrchestratorSubtask["status"];
    conversationId?: string;
    running: boolean;
    activity?: OrchestratorActivity;
  }>;
} {
  const activityFor = (conversationId?: string): OrchestratorActivity | undefined =>
    conversationId ? activities.get(conversationId) : undefined;

  return {
    id: experiment.id,
    prompt: experiment.prompt,
    status: experiment.status,
    createdAt: experiment.createdAt,
    error: experiment.error,
    plan: {
      conversationId: experiment.planConversationId,
      running: experiment.planConversationId
        ? busyIds.has(experiment.planConversationId)
        : false,
      activity: activityFor(experiment.planConversationId),
    },
    synthesis: {
      conversationId: experiment.synthesisConversationId,
      running: experiment.synthesisConversationId
        ? busyIds.has(experiment.synthesisConversationId)
        : false,
      activity: activityFor(experiment.synthesisConversationId),
    },
    subtasks: experiment.subtasks.map((subtask) => ({
      id: subtask.id,
      title: subtask.title,
      status: subtask.status,
      conversationId: subtask.conversationId,
      running: subtask.conversationId ? busyIds.has(subtask.conversationId) : false,
      activity: activityFor(subtask.conversationId),
    })),
  };
}

/** Extract a short SDK subagent label from tool args when present. */
export function extractSubagentName(args: unknown): string | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const record = args as Record<string, unknown>;
  for (const key of ["subagent_type", "subagentType", "name", "agent", "type"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim().slice(0, 40);
    }
  }
  const description = record.description;
  if (typeof description === "string" && description.trim()) {
    const token = description.trim().split(/\s+/)[0];
    if (token) {
      return token.slice(0, 40);
    }
  }
  return undefined;
}
