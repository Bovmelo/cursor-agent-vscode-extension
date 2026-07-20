import assert from "node:assert/strict";
import test from "node:test";
import { buildRunCenterHostSnapshot } from "../out/runCenterSnapshot.js";

test("buildRunCenterHostSnapshot maps host state without prompts", () => {
  const snapshot = buildRunCenterHostSnapshot({
    conversations: [
      {
        id: "c1",
        title: "Chat",
        createdAt: 1,
        updatedAt: 2,
        transcript: [
          { role: "user", text: "secret prompt" },
          { role: "assistant", text: "ok", progressState: "completed" },
        ],
      },
    ],
    runtimes: [
      {
        conversationId: "c1",
        busy: true,
        live: {
          assistantText: "working",
          progressSteps: [{ id: "t1", text: "edit", status: "running" }],
          progressState: "error",
        },
      },
    ],
    activeConversationId: "c1",
    queuedConversationIds: ["c1"],
    session: {
      id: "s1",
      goal: "goal",
      root: "/tmp/ws",
      files: ["a.ts"],
      pendingFiles: ["a.ts"],
    },
    plan: {
      id: "p1",
      prompt: "plan prompt",
      createdAt: 1,
      sourceConversationId: "c1",
      status: "running",
      steps: [{ id: "step-1", title: "Step", prompt: "do it", status: "running" }],
    },
    backgroundJobs: [
      {
        id: "job-1",
        title: "Background",
        prompt: "job prompt",
        workspaceRoot: "/tmp",
        storageRoot: "/tmp/store",
        jobFile: "/tmp/job.json",
        session: {},
        status: "running",
        createdAt: 1,
        updatedAt: 3,
        assistantText: "bg",
        error: undefined,
      },
    ],
    supervisorTasks: [
      {
        id: "task-1",
        title: "Supervisor",
        detail: "detail",
        root: "/tmp",
        source: "manual",
        fingerprint: "fp",
        createdAt: 1,
        updatedAt: 4,
        status: "failed",
        error: "boom",
        blockedReasons: ["wait"],
      },
    ],
    now: 99,
  });

  assert.equal(snapshot.activeConversationId, "c1");
  assert.deepEqual(snapshot.queuedConversationIds, ["c1"]);
  assert.equal(snapshot.conversations?.[0]?.transcript?.[0]?.text, "secret prompt");
  assert.equal(snapshot.runtimes?.[0]?.busy, true);
  assert.equal(snapshot.plan?.steps[0]?.title, "Step");
  assert.equal(snapshot.backgroundJobs?.[0]?.status, "running");
  assert.equal(snapshot.supervisorTasks?.[0]?.error, "boom");
  assert.equal(snapshot.now, 99);
  // Host snapshot must not carry background job prompts into Run Center.
  assert.equal("prompt" in (snapshot.backgroundJobs?.[0] ?? {}), false);
});
