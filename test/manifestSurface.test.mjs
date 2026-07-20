import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("every contributed command is registered by the extension host", async () => {
  const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  const extensionSource = await readFile(new URL("src/extension.ts", root), "utf8");
  const contributed = manifest.contributes.commands.map((entry) => entry.command);
  const registered = new Set(
    [...extensionSource.matchAll(/register(?:TextEditor)?Command\(\s*["']([^"']+)["']/gu)]
      .map((match) => match[1]),
  );

  assert.deepEqual(
    contributed.filter((command) => !registered.has(command)),
    [],
    "Command Palette entries must have an extension-host handler",
  );
});

test("manifest localization references exist in both supported locales", async () => {
  const [manifestText, english, japanese] = await Promise.all([
    readFile(new URL("package.json", root), "utf8"),
    readFile(new URL("package.nls.json", root), "utf8").then(JSON.parse),
    readFile(new URL("package.nls.ja.json", root), "utf8").then(JSON.parse),
  ]);
  const references = new Set(
    [...manifestText.matchAll(/%([^%]+)%/gu)].map((match) => match[1]),
  );

  assert.deepEqual(
    [...references].filter((key) => !(key in english)),
    [],
  );
  assert.deepEqual(
    [...references].filter((key) => !(key in japanese)),
    [],
  );
  assert.deepEqual(Object.keys(japanese).sort(), Object.keys(english).sort());
});

test("workspace mutations that can execute or apply agent output require trust", async () => {
  const [extensionSource, backgroundSource, gitWorkflowSource] = await Promise.all([
    readFile(new URL("src/extension.ts", root), "utf8"),
    readFile(new URL("src/backgroundJobs.ts", root), "utf8"),
    readFile(new URL("src/gitWorkflow.ts", root), "utf8"),
  ]);

  const pullRequestPath = extensionSource.slice(
    extensionSource.indexOf("private async offerCreatePullRequest("),
    extensionSource.indexOf("public async newChat("),
  );
  const createPullRequestCommand = extensionSource.slice(
    extensionSource.indexOf("public async createPullRequestFromWorkspace("),
    extensionSource.indexOf("private async offerCreatePullRequest("),
  );
  const taskPipelinePath = extensionSource.slice(
    extensionSource.indexOf("public async runTaskPipeline("),
    extensionSource.indexOf("public async executeLastPlan("),
  );
  const backgroundApplyPath = backgroundSource.slice(
    backgroundSource.indexOf("public async apply("),
    backgroundSource.indexOf("public async cancel("),
  );

  assert.match(pullRequestPath, /!vscode\.workspace\.isTrusted/u);
  assert.match(createPullRequestCommand, /!vscode\.workspace\.isTrusted/u);
  assert.match(taskPipelinePath, /!vscode\.workspace\.isTrusted/u);
  assert.match(backgroundApplyPath, /!vscode\.workspace\.isTrusted/u);
  assert.match(backgroundApplyPath, /cancellationInvalidatesCompletedResult/u);
  assert.match(
    gitWorkflowSource.slice(gitWorkflowSource.indexOf("createBranchCommitAndPullRequest")),
    /!vscode\.workspace\.isTrusted/u,
  );
});
