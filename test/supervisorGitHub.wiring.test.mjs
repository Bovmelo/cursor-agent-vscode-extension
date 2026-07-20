import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const supervisorSource = await readFile(
  new URL("../src/supervisor.ts", import.meta.url),
  "utf8",
);
const extensionSource = await readFile(
  new URL("../src/extension.ts", import.meta.url),
  "utf8",
);

test("Supervisor GitHub scan requires trust before calling gh", () => {
  const scanSource = supervisorSource.slice(
    supervisorSource.indexOf("public async scanGitHubSignals("),
    supervisorSource.indexOf("public async observeDocument("),
  );
  const createTaskSource = supervisorSource.slice(
    supervisorSource.indexOf("}): Promise<SupervisorTask | undefined> {"),
    supervisorSource.indexOf("public async scanDiagnostics("),
  );

  assert.match(
    scanSource,
    /!vscode\.workspace\.isTrusted[\s\S]*?GitHub Supervisor scans require a trusted workspace/u,
  );
  assert.match(
    scanSource,
    /!vscode\.workspace\.isTrusted[\s\S]*?scanCurrentGitHubPullRequest/u,
  );
  assert.match(
    scanSource,
    /scanCurrentGitHubPullRequest\(root\)[\s\S]*?createTask\(/u,
  );
  assert.match(
    createTaskSource,
    /fingerprint === options\.fingerprint/u,
  );
});

test("Task Pipeline wires issue list helpers and verify-success PR creation", () => {
  const pipelineSource = extensionSource.slice(
    extensionSource.indexOf("public async runTaskPipeline("),
    extensionSource.indexOf("public async executeLastPlan("),
  );

  assert.match(pipelineSource, /listGhIssues\(/u);
  assert.match(pipelineSource, /buildPipelineGoalFromIssue\(/u);
  assert.match(pipelineSource, /buildPendingPipelinePr\(/u);
  assert.match(pipelineSource, /buildTaskPipelinePrompt\(/u);
  assert.match(pipelineSource, /!vscode\.workspace\.isTrusted/u);

  assert.match(
    extensionSource,
    /if \(this\.pendingPipelinePr\)[\s\S]*?createPipelinePullRequest\([\s\S]*?buildPipelinePullRequestBody\(/u,
  );
  assert.match(
    extensionSource,
    /private async createPipelinePullRequest\([\s\S]*?createBranchCommitAndPullRequest\(/u,
  );
});
