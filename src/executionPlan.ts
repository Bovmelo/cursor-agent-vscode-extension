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
  const taggedBlock = /<CURSOR_EXECUTION_PLAN>\s*([\s\S]*?)\s*<\/CURSOR_EXECUTION_PLAN>/i
    .exec(text)?.[1]?.trim();
  const fencedBlocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)]
    .map((match) => match[1]?.trim())
    .filter((block): block is string => Boolean(block));
  const candidates = [taggedBlock, ...fencedBlocks, ...extractJsonArrays(text)]
    .filter((block): block is string => Boolean(block));

  for (const candidate of candidates) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate) as unknown;
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) {
      continue;
    }
    const steps = parsed.flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }
      const record = item as Record<string, unknown>;
      const title = typeof record.title === "string" ? record.title.trim() : "";
      const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
      return title && prompt ? [{ title: title.slice(0, 80), prompt }] : [];
    }).slice(0, 12);
    if (steps.length > 0) {
      return steps;
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
