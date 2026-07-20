import assert from "node:assert/strict";
import test from "node:test";
import {
  buildConfigurationSnapshot,
  buildRecentAuditSnapshot,
  buildRecentRunsFromConversations,
} from "../out/diagnosticsCollect.js";

test("buildRecentRunsFromConversations extracts assistant outcomes", () => {
  const runs = buildRecentRunsFromConversations([
    {
      id: "c1",
      title: "Failed run",
      createdAt: 1,
      updatedAt: 20,
      transcript: [
        { role: "user", text: "do work" },
        {
          role: "assistant",
          text: "Something failed\nRun: run-123",
          error: true,
          progressState: "error",
        },
      ],
    },
    {
      id: "c2",
      title: "No assistant",
      createdAt: 1,
      updatedAt: 10,
      transcript: [{ role: "user", text: "hi" }],
    },
  ]);

  assert.equal(runs.length, 1);
  assert.equal(runs[0].title, "Failed run");
  assert.equal(runs[0].state, "error");
  assert.equal(runs[0].runId, "run-123");
  assert.match(runs[0].detail ?? "", /Something failed/u);
});

test("buildRecentAuditSnapshot formats timestamps", () => {
  const entries = buildRecentAuditSnapshot([
    {
      id: "a1",
      at: Date.parse("2026-07-20T00:00:00.000Z"),
      action: "chat.send",
      summary: "sent",
      taskId: "t1",
      sessionId: "s1",
    },
  ]);
  assert.deepEqual(entries, [
    {
      at: "2026-07-20T00:00:00.000Z",
      action: "chat.send",
      summary: "sent",
      taskId: "t1",
      sessionId: "s1",
    },
  ]);
});

test("buildConfigurationSnapshot lists known non-secret settings", () => {
  const checks = buildConfigurationSnapshot(
    {
      enableAiSupervisor: true,
      supervisorMode: "observe",
      maxParallelChatAgents: 3,
    },
    [{ label: "approvalMode", status: "ok", detail: "auto-review" }],
  );
  assert.ok(checks.some((check) => check.label === "enableAiSupervisor" && check.detail === "true"));
  assert.ok(checks.some((check) => check.label === "supervisorMode" && check.detail === "observe"));
  assert.ok(checks.some((check) => check.label === "autoRepair" && check.status === "unknown"));
  assert.ok(checks.some((check) => check.label === "approvalMode" && check.detail === "auto-review"));
});
