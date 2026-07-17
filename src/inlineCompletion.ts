export interface InlineCompletionLimits {
  maxCharacters: number;
  maxLines: number;
}

export interface InlineCompletionStats {
  suggested: number;
  accepted: number;
}

export function shouldRequestInlineCompletion(
  before: string,
  after: string,
  minimumPrefixCharacters: number,
): boolean {
  const currentLine = before.slice(before.lastIndexOf("\n") + 1);
  if (currentLine.trim().length >= minimumPrefixCharacters) {
    return true;
  }
  return currentLine.trim().length > 0 && after.trimStart().length > 0;
}

export function sanitizeInlineCompletion(
  raw: string,
  before: string,
  after: string,
  limits: InlineCompletionLimits,
): string {
  let completion = raw
    .replace(/^```[\w.+-]*\s*/u, "")
    .replace(/\s*```\s*$/u, "")
    .replace(/^<completion>\s*/iu, "")
    .replace(/\s*<\/completion>$/iu, "")
    .replace(/\r\n/g, "\n");

  // Models sometimes repeat the existing prefix or suffix. Trim only sizeable,
  // unambiguous overlaps so indentation and closing braces are preserved.
  const prefixWindow = before.slice(-500);
  for (let length = Math.min(prefixWindow.length, completion.length); length >= 12; length -= 1) {
    if (completion.startsWith(prefixWindow.slice(-length))) {
      completion = completion.slice(length);
      break;
    }
  }
  const suffixWindow = after.slice(0, 500);
  for (let length = Math.min(suffixWindow.length, completion.length); length >= 12; length -= 1) {
    if (completion.endsWith(suffixWindow.slice(0, length))) {
      completion = completion.slice(0, -length);
      break;
    }
  }

  const lines = completion.split("\n").slice(0, Math.max(1, limits.maxLines));
  return lines.join("\n").slice(0, Math.max(1, limits.maxCharacters)).replace(/\s+$/u, "");
}

export function inlineCompletionAcceptanceRate(stats: InlineCompletionStats): number {
  return stats.suggested > 0 ? stats.accepted / stats.suggested : 0;
}
