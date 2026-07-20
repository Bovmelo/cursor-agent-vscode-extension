import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPendingPipelinePr,
  buildPipelineGoalFromIssue,
  buildPipelineGoalFromTodo,
  buildPipelinePullRequestBody,
  buildTaskPipelinePrompt,
} from "../out/taskPipeline.js";

test("buildPipelineGoalFromIssue joins non-empty fields with blank lines", () => {
  assert.equal(
    buildPipelineGoalFromIssue({
      title: "Fix login",
      body: "Users cannot sign in",
      url: "https://example.test/issues/1",
    }),
    ["Fix login", "Users cannot sign in", "https://example.test/issues/1"].join("\n\n"),
  );
  assert.equal(
    buildPipelineGoalFromIssue({
      title: "Title only",
      body: "",
      url: "",
    }),
    "Title only",
  );
  assert.equal(
    buildPipelineGoalFromIssue({
      title: "Keep title",
      body: "",
      url: "https://example.test/2",
    }),
    ["Keep title", "https://example.test/2"].join("\n\n"),
  );
});

test("buildPipelineGoalFromTodo builds title and resolve goal", () => {
  assert.deepEqual(
    buildPipelineGoalFromTodo({
      relativePath: "src/a.ts",
      line: 12,
      text: "TODO(ai): cover edge case",
    }),
    {
      title: "TODO(ai): cover edge case",
      goal: [
        "Resolve this TODO(ai) in src/a.ts:12",
        "TODO(ai): cover edge case",
      ].join("\n\n"),
    },
  );
});

test("buildPendingPipelinePr is undefined unless pipelineAutoKeep", () => {
  assert.equal(
    buildPendingPipelinePr({
      pipelineAutoKeep: false,
      title: "Ship it",
      body: "goal text",
      root: "/repo",
    }),
    undefined,
  );
  assert.deepEqual(
    buildPendingPipelinePr({
      pipelineAutoKeep: true,
      title: "Ship it",
      body: "goal text",
      root: "/repo",
    }),
    {
      title: "Ship it",
      body: "goal text",
      root: "/repo",
      files: [],
    },
  );
});

test("buildTaskPipelinePrompt matches verification and review branches", () => {
  const goal = "Implement helpers";
  assert.equal(
    buildTaskPipelinePrompt({
      goal,
      automaticVerification: true,
      reviewChanges: true,
    }),
    [
      goal,
      "",
      "Run this as an autonomous change session through the task pipeline.",
      "Investigate the repository, make the smallest coherent implementation, and review the resulting diff.",
      "Do not run final validation; the extension will run it after the user accepts the proposed file changes.",
      "Do not stop after describing code: complete the change and report remaining risks.",
    ].join("\n"),
  );
  assert.equal(
    buildTaskPipelinePrompt({
      goal,
      automaticVerification: true,
      reviewChanges: false,
    }),
    [
      goal,
      "",
      "Run this as an autonomous change session through the task pipeline.",
      "Investigate the repository, make the smallest coherent implementation, and review the resulting diff.",
      "Do not run final validation; the extension will run it after the edit finishes.",
      "Do not stop after describing code: complete the change and report remaining risks.",
    ].join("\n"),
  );
  assert.equal(
    buildTaskPipelinePrompt({
      goal,
      automaticVerification: false,
      reviewChanges: true,
    }),
    [
      goal,
      "",
      "Run this as an autonomous change session through the task pipeline.",
      "Investigate the repository, make the smallest coherent implementation, and review the resulting diff.",
      "Run the relevant validation before reporting completion.",
      "Do not stop after describing code: complete the change and report remaining risks.",
    ].join("\n"),
  );
});

test("buildPipelinePullRequestBody joins body and verification summary", () => {
  assert.equal(
    buildPipelinePullRequestBody("pipeline goal", "Verification: passed"),
    ["pipeline goal", "", "Verification: passed"].join("\n"),
  );
});
