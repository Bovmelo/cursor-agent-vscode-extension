import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBackgroundRunCenterState,
  buildRunCenterState,
  buildSupervisorRunCenterState,
} from "../out/runCenterCoordinator.js";

function conversation(id, title, updatedAt, assistant = {}) {
  return {
    id,
    title,
    updatedAt,
    transcript: [
      {
        role: "assistant",
        text: assistant.text ?? "Done",
        error: assistant.error,
        progressState: assistant.progressState ?? "completed",
      },
    ],
  };
}

test("conversation projection combines runtime, plan, session, and verification snapshots", () => {
  const state = buildRunCenterState({
    conversations: [
      conversation("active", "Active but idle", 200),
      conversation("busy", "Busy run", 100),
    ],
    activeConversationId: "active",
    runtimes: [
      {
        conversationId: "busy",
        busy: true,
        live: {
          assistantText: "Working",
          progressState: "completed",
          progressSteps: [
            { id: "one", text: "Inspect", status: "completed" },
            { id: "two", text: "Implement", status: "running" },
          ],
        },
      },
    ],
    plan: { steps: [{ id: "step", title: "Implement", status: "failed", error: "Nope" }] },
    session: {
      id: "session",
      goal: "Change code",
      root: "C:\\repo",
      files: ["C:\\repo\\src\\feature.ts"],
      pendingFiles: ["C:\\repo\\src\\feature.ts"],
      verification: {
        success: false,
        steps: [{ command: "npm test", success: false, output: "failure" }],
      },
    },
    now: 500,
  });

  assert.equal(state.runId, "busy");
  assert.equal(state.title, "Busy run");
  assert.deepEqual(state.progress, {
    message: "Implement",
    status: "running",
    completed: 1,
    total: 2,
  });
  assert.equal(state.plan[0].status, "blocked");
  assert.equal(state.changes[0].path, "src/feature.ts");
  assert.equal(state.verification[0].status, "failed");
  assert.deepEqual(
    state.recoveryActions.map((action) => action.id),
    ["review", "verify"],
  );
  assert.equal(state.updatedAt, 500);
});

test("an active background run takes precedence over a newer conversation", () => {
  const state = buildRunCenterState({
    conversations: [conversation("chat", "Chat", 1_000)],
    backgroundJobs: [
      {
        id: "job",
        title: "Background",
        status: "running",
        updatedAt: 100,
        assistantText: "Still working",
      },
    ],
  });

  assert.equal(state.runId, "job");
  assert.equal(state.progress.status, "running");
  assert.equal(state.recoveryActions[0].command, "cursorSubscription.cancelBackgroundJob");
});

test("completed background results expose apply and discard actions", () => {
  const state = buildBackgroundRunCenterState({
    id: "job",
    title: "Background",
    status: "completed",
    updatedAt: 200,
  });

  assert.equal(state.progress.status, "completed");
  assert.deepEqual(
    state.recoveryActions.map((action) => action.command),
    ["cursorSubscription.applyBackgroundJob", "cursorSubscription.discardBackgroundJob"],
  );
  assert.deepEqual(state.recoveryActions[0].arguments, ["job"]);
});

test("failed background recovery accurately offers a new agent", () => {
  const state = buildBackgroundRunCenterState({
    id: "job",
    title: "Background",
    status: "error",
    updatedAt: 200,
    error: "failed",
  });
  const japanese = buildBackgroundRunCenterState(
    {
      id: "job",
      title: "Background",
      status: "error",
      updatedAt: 200,
      error: "failed",
    },
    true,
  );

  assert.equal(state.recoveryActions[0].label, "Start a new background agent");
  assert.equal(japanese.recoveryActions[0].label, "新しいバックグラウンドAgentを開始");
  assert.equal(state.recoveryActions[0].command, "cursorSubscription.startBackgroundJob");
});

test("older completed operational results yield to the current conversation", () => {
  const state = buildRunCenterState({
    conversations: [conversation("chat", "Current chat", 300)],
    backgroundJobs: [
      {
        id: "job",
        title: "Old result",
        status: "completed",
        updatedAt: 200,
      },
    ],
  });

  assert.equal(state.runId, "chat");
  assert.equal(state.title, "Current chat");
});

test("supervisor projection resolves dependency and blocked recovery state", () => {
  const dependency = {
    id: "dependency",
    title: "Prepare",
    status: "completed",
    updatedAt: 100,
  };
  const task = {
    id: "task",
    title: "Apply",
    status: "blocked",
    updatedAt: 200,
    dependencyIds: ["dependency", "missing"],
    blockedReasons: ["Owned by another task"],
    changes: [{ relative: "src/app.ts", added: 4, deleted: 1 }],
  };
  const state = buildSupervisorRunCenterState(task, [task, dependency]);

  assert.deepEqual(
    state.plan.map((item) => item.status),
    ["completed", "pending", "blocked"],
  );
  assert.equal(state.progress.status, "paused");
  assert.deepEqual(state.changes[0], {
    path: "src/app.ts",
    status: "modified",
    additions: 4,
    deletions: 1,
  });
  assert.equal(state.error.message, "Owned by another task");
  assert.deepEqual(
    state.recoveryActions.map((action) => action.command),
    [
      "cursorSubscription.applyAllSupervisorChanges",
      "cursorSubscription.discardAllSupervisorChanges",
    ],
  );
});
