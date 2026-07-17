export interface TodoAiMatch {
  line: number;
  text: string;
  detail: string;
}

const TODO_AI_PATTERN = /(?:\/\/|#|\/\*|\*|<!--)?\s*TODO\s*\(\s*ai\s*\)\s*:?\s*(.+?)(?:\*\/|-->)?\s*$/i;

export function scanTodoAiComments(source: string, maximum = 20): TodoAiMatch[] {
  const matches: TodoAiMatch[] = [];
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = TODO_AI_PATTERN.exec(line);
    if (!match) {
      continue;
    }
    const text = match[1].trim();
    if (!text) {
      continue;
    }
    matches.push({
      line: index + 1,
      text,
      detail: `L${index + 1}: TODO(ai): ${text}`,
    });
    if (matches.length >= maximum) {
      break;
    }
  }
  return matches;
}

export function parseSupervisorReviewVerdict(text: string): {
  verdict: "approve" | "reject";
  reasons: string[];
} | undefined {
  const block = /<SUPERVISOR_REVIEW_VERDICT>\s*([\s\S]*?)\s*<\/SUPERVISOR_REVIEW_VERDICT>/i
    .exec(text)
    ?.at(1)
    ?.trim();
  if (!block) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(block) as {
      verdict?: unknown;
      reasons?: unknown;
    };
    const verdict = parsed.verdict === "approve" || parsed.verdict === "reject"
      ? parsed.verdict
      : undefined;
    if (!verdict) {
      return undefined;
    }
    const reasons = Array.isArray(parsed.reasons)
      ? parsed.reasons
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
        .slice(0, 10)
      : [];
    return { verdict, reasons };
  } catch {
    return undefined;
  }
}
