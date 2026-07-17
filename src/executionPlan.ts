import { randomUUID } from "node:crypto";

export interface ExecutionPlanStep {
  id: string;
  title: string;
  prompt: string;
  status: "pending" | "running" | "completed" | "failed";
  checkpointSessionId?: string;
  error?: string;
}

export interface ExecutionPlan {
  id: string;
  prompt: string;
  createdAt: number;
  sourceConversationId: string;
  status: "pending" | "running" | "completed" | "failed";
  steps: ExecutionPlanStep[];
}

export function parseExecutionPlanSteps(text: string): Array<{ title: string; prompt: string }> {
  const block = /<CURSOR_EXECUTION_PLAN>\s*([\s\S]*?)\s*<\/CURSOR_EXECUTION_PLAN>/i
    .exec(text)?.[1]?.trim();
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
      const record = item as Record<string, unknown>;
      const title = typeof record.title === "string" ? record.title.trim() : "";
      const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
      return title && prompt ? [{ title: title.slice(0, 80), prompt }] : [];
    }).slice(0, 12);
  } catch {
    return [];
  }
}

export function createExecutionPlan(
  prompt: string,
  sourceConversationId: string,
  steps: Array<{ title: string; prompt: string }>,
): ExecutionPlan {
  return {
    id: randomUUID(),
    prompt,
    createdAt: Date.now(),
    sourceConversationId,
    status: "pending",
    steps: steps.map((step) => ({
      id: randomUUID(),
      title: step.title,
      prompt: step.prompt,
      status: "pending",
    })),
  };
}
