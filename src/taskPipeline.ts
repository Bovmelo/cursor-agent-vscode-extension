export function buildPipelineGoalFromIssue(issue: {
  title: string;
  body: string;
  url: string;
}): string {
  return [issue.title, issue.body, issue.url].filter(Boolean).join("\n\n");
}

export function buildPipelineGoalFromTodo(options: {
  relativePath: string;
  line: number;
  text: string;
}): { title: string; goal: string } {
  return {
    title: options.text,
    goal: [
      `Resolve this TODO(ai) in ${options.relativePath}:${options.line}`,
      options.text,
    ].join("\n\n"),
  };
}

export function buildPendingPipelinePr(options: {
  pipelineAutoKeep: boolean;
  title: string;
  body: string;
  root: string;
}): { title: string; body: string; root: string; files: string[] } | undefined {
  if (!options.pipelineAutoKeep) {
    return undefined;
  }
  return {
    title: options.title,
    body: options.body,
    root: options.root,
    files: [],
  };
}

export function buildTaskPipelinePrompt(options: {
  goal: string;
  automaticVerification: boolean;
  reviewChanges: boolean;
}): string {
  return [
    options.goal,
    "",
    "Run this as an autonomous change session through the task pipeline.",
    "Investigate the repository, make the smallest coherent implementation, and review the resulting diff.",
    options.automaticVerification
      ? options.reviewChanges
        ? "Do not run final validation; the extension will run it after the user accepts the proposed file changes."
        : "Do not run final validation; the extension will run it after the edit finishes."
      : "Run the relevant validation before reporting completion.",
    "Do not stop after describing code: complete the change and report remaining risks.",
  ].join("\n");
}

export function buildPipelinePullRequestBody(
  pipelineBody: string,
  verificationSummary: string,
): string {
  return [pipelineBody, "", verificationSummary].join("\n");
}
