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
    subtasks: [],
    status: "planning",
  };
}

export function parseOrchestratorSubtasks(text: string): Array<{ title: string; prompt: string }> {
  const block = /<ORCHESTRATOR_SUBTASKS>\s*([\s\S]*?)\s*<\/ORCHESTRATOR_SUBTASKS>/i
    .exec(text)
    ?.at(1)
    ?.trim();
  if (!block) {
    return [];
  }
  try {
    const parsed = JSON.parse(block) as unknown;
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
  } catch {
    return [];
  }
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
        ? { ...subtask, conversationId, status: "running" as const }
        : subtask
    ),
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
  const anyFailed = subtasks.some((subtask) => subtask.status === "failed");
  return {
    ...experiment,
    subtasks,
    status: allDone
      ? (anyFailed && subtasks.every((subtask) => subtask.status === "failed")
        ? "failed"
        : "synthesizing")
      : experiment.status,
  };
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
