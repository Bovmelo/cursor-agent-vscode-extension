import { randomUUID } from "node:crypto";

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
  subtaskCount: number;
  completedCount: number;
}> {
  return experiments.map((experiment) => ({
    id: experiment.id,
    prompt: experiment.prompt,
    status: experiment.status,
    subtaskCount: experiment.subtasks.length,
    completedCount: experiment.subtasks.filter((subtask) => subtask.status === "completed").length,
  }));
}
