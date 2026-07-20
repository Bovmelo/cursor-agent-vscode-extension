/** First http(s) URL line from `gh pr create` stdout (warnings may wrap it). */
export function extractPullRequestUrl(stdout: string): string | undefined {
  return stdout.trim().split(/\r?\n/).find((line) => /^https?:\/\//.test(line));
}

/** Collapse newlines and bound length for `gh pr create --title`. */
export function sanitizePullRequestTitle(title: string): string {
  return title.replace(/[\r\n]+/g, " ").slice(0, 120);
}

/**
 * Reject ref names unsafe to pass as git CLI args.
 * Covers option injection (`-` prefix) and common `git check-ref-format` rejects
 * (empty/whitespace, `..`, `@{`, control chars, spaces, and shell/glob metacharacters).
 */
export function isUnsafeGitRefName(name: string): boolean {
  if (!name || !name.trim()) {
    return true;
  }
  if (name.startsWith("-")) {
    return true;
  }
  // check-ref-format-ish: option-injection-adjacent and argv-unsafe characters
  if (
    name.includes("..") ||
    name.includes("@{") ||
    name.includes(" ") ||
    name.includes("~") ||
    name.includes("^") ||
    name.includes(":") ||
    name.includes("?") ||
    name.includes("*") ||
    name.includes("[") ||
    name.includes("\\") ||
    /[\x00-\x1f\x7f]/.test(name)
  ) {
    return true;
  }
  return false;
}
