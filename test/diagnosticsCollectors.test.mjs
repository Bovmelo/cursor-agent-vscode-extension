import assert from "node:assert/strict";
import test from "node:test";
import {
  summarizeBackgroundJobs,
  summarizeRunCenter,
  summarizeSupervisorTasks,
} from "../out/diagnosticsCollectors.js";

test("summarizeBackgroundJobs redacts secrets and omits prompts", () => {
  const summaries = summarizeBackgroundJobs(
    [
      {
        id: "job-1",
        title: "Fix api_key=super-secret",
        prompt: "NEVER INCLUDE THIS PROMPT with Bearer abcdefghijklmnop",
        workspaceRoot: "C:/workspace",
        storageRoot: "C:/storage",
        jobFile: "C:/storage/job.json",
        session: {},
        status: "error",
        createdAt: 1,
        updatedAt: Date.UTC(2026, 6, 20, 0, 0, 0),
        error: "Authorization: Bearer abcdefghijklmnop",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      },
      {
        id: "job-2",
        title: "Second",
        prompt: "also secret",
        workspaceRoot: "C:/workspace",
        storageRoot: "C:/storage",
        jobFile: "C:/storage/job2.json",
        session: {},
        status: "running",
        createdAt: 2,
        updatedAt: Date.UTC(2026, 6, 20, 1, 0, 0),
      },
    ],
    1,
  );

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].id, "job-1");
  assert.equal(summaries[0].title, "Fix api_key=<redacted>");
  assert.equal(summaries[0].error, "Authorization: Bearer <redacted>");
  assert.equal(summaries[0].usage?.totalTokens, 15);
  assert.equal("prompt" in summaries[0], false);
  assert.doesNotMatch(JSON.stringify(summaries), /NEVER INCLUDE|super-secret|abcdefghijklmnop/u);
});

test("summarizeRunCenter keeps structural fields and redacts text", () => {
  const summary = summarizeRunCenter({
    runId: "run-1",
    title: "token=leaked-value",
    progress: {
      message: "Running with password=hunter2",
      status: "running",
      percent: 40,
      detail: "https://user:pass@example.com/path",
    },
    plan: [{ id: "p1", label: "Plan step", status: "completed" }],
    changes: [{ path: "a.ts", status: "modified" }],
    verification: [{ id: "v1", label: "npm test", status: "passed" }],
    error: { message: "Bearer abcdefghijklmnop failed" },
    updatedAt: Date.UTC(2026, 6, 20, 2, 0, 0),
  });

  assert.equal(summary.runId, "run-1");
  assert.equal(summary.title, "token=<redacted>");
  assert.equal(summary.progress?.message, "Running with password=<redacted>");
  assert.equal(summary.progress?.detail, "https://<redacted>@example.com/path");
  assert.equal(summary.changeCount, 1);
  assert.equal(summary.verificationSummary?.[0].status, "passed");
  assert.match(summary.error ?? "", /Bearer <redacted>/u);
  assert.doesNotMatch(JSON.stringify(summary), /leaked-value|hunter2|user:pass/u);
});

test("summarizeSupervisorTasks omits detail/diagnostics and applies limits", () => {
  const summaries = summarizeSupervisorTasks(
    [
      {
        id: "task-1",
        title: "Repair secret=abc12345",
        detail: "PROMPT-LIKE DETAIL must not appear",
        root: "C:/workspace",
        source: "manual",
        fingerprint: "fp",
        createdAt: 1,
        updatedAt: Date.UTC(2026, 6, 20, 3, 0, 0),
        status: "failed",
        diagnostics: ["api_key=should-not-export"],
        error: "cookie=session-value",
        blockedReasons: ["token=blocked"],
        changes: [{ relative: "a.ts", kind: "modified", added: 1, deleted: 0, excluded: false }],
        reviewVerdict: "reject",
      },
      {
        id: "task-2",
        title: "Other",
        detail: "skip",
        root: "C:/workspace",
        source: "todo",
        fingerprint: "fp2",
        createdAt: 2,
        updatedAt: Date.UTC(2026, 6, 20, 4, 0, 0),
        status: "queued",
      },
    ],
    1,
  );

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].title, "Repair secret=<redacted>");
  assert.equal(summaries[0].error, "cookie=<redacted>");
  assert.deepEqual(summaries[0].blockedReasons, ["token=<redacted>"]);
  assert.equal(summaries[0].changeCount, 1);
  assert.equal(summaries[0].reviewVerdict, "reject");
  assert.equal("detail" in summaries[0], false);
  assert.equal("diagnostics" in summaries[0], false);
  assert.doesNotMatch(JSON.stringify(summaries), /PROMPT-LIKE|should-not-export|abc12345/u);
});
