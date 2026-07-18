export function buildAutoRepairPrompt(options: {
  attempt: number;
  maxAttempts: number;
  failures: string;
  editedFiles?: readonly string[];
}): string {
  const attempt = Math.max(1, Math.floor(options.attempt));
  const maxAttempts = Math.max(attempt, Math.floor(options.maxAttempts));
  const files = (options.editedFiles ?? [])
    .map((file) => file.trim())
    .filter((file) => file.length > 0)
    .slice(0, 40);
  const failureBlock = options.failures.trim().slice(0, 12_000) || "(no command output captured)";
  return [
    `Automatic verification failed (repair attempt ${attempt}/${maxAttempts}).`,
    "Diagnose the failure, make the smallest correction that restores a verified workspace, and stop.",
    "Do not expand scope, refactor unrelated code, or reopen finished work.",
    "Prefer fixing the failing command output below over speculative edits.",
    files.length > 0
      ? `Files already edited in this session:\n${files.map((file) => `- ${file}`).join("\n")}`
      : "No edited-file list was recorded for this session.",
    "",
    "Failing verification output:",
    failureBlock,
  ].join("\n");
}
