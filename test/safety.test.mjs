import assert from "node:assert/strict";
import test from "node:test";
import {
  baselineKey,
  canApplyAgainstBaseline,
  canQueueOrRunSupervisorTask,
  canStartAnotherParallelAgent,
  computeOverlappedMutationFlags,
  conversationRunState,
  defaultSafetyApprovalMode,
  decideBaselineRestoreAction,
  enqueueChatMessage,
  findConflictingFiles,
  hashBytes,
  isPathInside,
  isSafeRelativePath,
  nextSupervisorStatusAfterBusy,
  nextSupervisorStatusAfterDecisions,
  nextSupervisorStatusAfterRun,
  parseWebviewMessage,
  removeQueuedMessages,
  safeResolvePath,
  shouldUseIsolatedWorktree,
  shouldCancelOnInterrupt,
  takeNextQueuedMessage,
  worktreeMatchesProposed,
} from "../out/safety.js";
import { hasConflictMarkers, threeWayMergeBytes } from "../out/threeWayMerge.js";

test("dirty baseline restore decides restore/remove/skip correctly", () => {
  const baselineHash = hashBytes(Buffer.from("original"));
  assert.equal(
    decideBaselineRestoreAction(
      { worktreeExisted: true, hash: baselineHash },
      { existed: true, hash: hashBytes(Buffer.from("edited")) },
    ),
    "restore",
  );
  assert.equal(
    decideBaselineRestoreAction(
      { worktreeExisted: true, hash: baselineHash },
      { existed: true, hash: baselineHash },
    ),
    "skip",
  );
  assert.equal(
    decideBaselineRestoreAction(
      { worktreeExisted: false },
      { existed: true, hash: hashBytes(Buffer.from("created-by-agent")) },
    ),
    "remove",
  );
  assert.equal(
    decideBaselineRestoreAction(
      { worktreeExisted: false },
      { existed: false },
    ),
    "skip",
  );
});

test("dirty baseline restore refuses when proposed snapshot no longer matches", () => {
  const proposed = {
    existed: true,
    hash: hashBytes(Buffer.from("ai-edit")),
    indexMode: "100644",
    indexOid: "abc",
  };
  assert.equal(
    worktreeMatchesProposed(
      { ...proposed },
      proposed,
    ),
    true,
  );
  assert.equal(
    worktreeMatchesProposed(
      { ...proposed, hash: hashBytes(Buffer.from("user-edited-after")) },
      proposed,
    ),
    false,
  );
  assert.equal(
    worktreeMatchesProposed(
      { ...proposed, indexOid: "def" },
      proposed,
    ),
    false,
  );
  assert.equal(
    worktreeMatchesProposed(
      { existed: false },
      proposed,
    ),
    false,
  );
});

test("baselineKey normalizes separators and optional win32 case folding", () => {
  assert.equal(baselineKey("Src\\Foo.ts", false), "Src/Foo.ts");
  assert.equal(baselineKey("Src\\Foo.ts", true), "src/foo.ts");
});

test("path traversal is rejected by isSafeRelativePath and safeResolvePath", () => {
  assert.equal(isSafeRelativePath("src/ok.ts"), true);
  assert.equal(isSafeRelativePath("../secret"), false);
  assert.equal(isSafeRelativePath("foo/../../etc/passwd"), false);
  assert.equal(isSafeRelativePath("/abs/path"), false);
  assert.equal(isSafeRelativePath("C:\\abs\\path"), false);

  const root = process.platform === "win32" ? "C:\\workspace" : "/workspace";
  assert.equal(
    safeResolvePath(root, "src/a.ts"),
    process.platform === "win32" ? "C:\\workspace\\src\\a.ts" : "/workspace/src/a.ts",
  );
  assert.throws(() => safeResolvePath(root, "../outside.ts"), /Path escapes/);
  assert.throws(() => safeResolvePath(root, "nested/../../outside.ts"), /Path escapes/);
  assert.equal(isPathInside(root, safeResolvePath(root, "nested/file.ts")), true);
});

test("Supervisor apply-time conflict detection compares baseline vs main", () => {
  const hash = hashBytes(Buffer.from("baseline"));
  assert.equal(
    canApplyAgainstBaseline({ exists: true, hash }, { exists: true, hash }),
    true,
  );
  assert.equal(
    canApplyAgainstBaseline(
      { exists: true, hash },
      { exists: true, hash: hashBytes(Buffer.from("changed")) },
    ),
    false,
  );
  assert.equal(
    canApplyAgainstBaseline({ exists: false }, { exists: false }),
    true,
  );
  assert.equal(
    canApplyAgainstBaseline({ exists: false }, { exists: true, hash }),
    false,
  );
  assert.equal(
    canApplyAgainstBaseline({ exists: true, hash }, { exists: false }),
    false,
  );
});

test("Supervisor status transitions for queue, run, and apply decisions", () => {
  assert.equal(canQueueOrRunSupervisorTask("detected"), true);
  assert.equal(canQueueOrRunSupervisorTask("review"), false);
  assert.equal(nextSupervisorStatusAfterBusy("detected", true), "queued");
  assert.equal(nextSupervisorStatusAfterBusy("queued", false), "running");
  assert.equal(nextSupervisorStatusAfterBusy("review", true), "review");
  assert.equal(nextSupervisorStatusAfterRun("unavailable", false, false), "queued");
  assert.equal(nextSupervisorStatusAfterRun("cancelled", true, false), "failed");
  assert.equal(nextSupervisorStatusAfterRun("finished", false, false), "completed");
  assert.equal(nextSupervisorStatusAfterRun("finished", true, true), "blocked");
  assert.equal(nextSupervisorStatusAfterRun("finished", true, false), "review");
  assert.equal(nextSupervisorStatusAfterDecisions(true, true), "blocked");
  assert.equal(nextSupervisorStatusAfterDecisions(true, false), "review");
  assert.equal(nextSupervisorStatusAfterDecisions(false, true), "completed");
});

test("cancel / interrupt / queue state transitions", () => {
  let queue = [];
  queue = enqueueChatMessage(queue, {
    id: "1",
    conversationId: "a",
    kind: "queued",
  });
  queue = enqueueChatMessage(queue, {
    id: "2",
    conversationId: "a",
    kind: "interrupt",
  });
  assert.deepEqual(queue.map((item) => item.id), ["2", "1"]);
  assert.equal(shouldCancelOnInterrupt(true, "interrupt"), true);
  assert.equal(shouldCancelOnInterrupt(false, "interrupt"), false);
  assert.equal(shouldCancelOnInterrupt(true, "queued"), false);

  const taken = takeNextQueuedMessage(queue, "a");
  assert.equal(taken.next?.id, "2");
  assert.deepEqual(taken.remaining.map((item) => item.id), ["1"]);

  const cleared = removeQueuedMessages(taken.remaining, (item) => item.conversationId === "a");
  assert.deepEqual(cleared, []);

  assert.equal(
    conversationRunState({ busy: true, pendingCancel: true, queueCount: 2 }),
    "cancelling",
  );
  assert.equal(
    conversationRunState({ busy: true, pendingCancel: false, queueCount: 0 }),
    "running",
  );
  assert.equal(
    conversationRunState({ busy: false, pendingCancel: false, queueCount: 1 }),
    "queued",
  );
  assert.equal(
    conversationRunState({ busy: false, pendingCancel: false, queueCount: 0 }),
    "idle",
  );
  assert.equal(canStartAnotherParallelAgent(2, 3), true);
  assert.equal(canStartAnotherParallelAgent(3, 3), false);
});

test("multiple agents editing the same file are detected as conflicts", () => {
  const root = process.platform === "win32" ? "C:\\ws" : "/ws";
  const shared = `${root}/src/shared.ts`;
  const onlyA = `${root}/src/a.ts`;
  const onlyB = `${root}/src/b.ts`;
  const conflicts = findConflictingFiles([
    [shared, onlyA],
    [shared, onlyB],
  ]);
  assert.equal(conflicts.length, 1);
  assert.equal(
    conflicts[0].toLowerCase().replaceAll("\\", "/"),
    shared.toLowerCase().replaceAll("\\", "/"),
  );
  assert.deepEqual(findConflictingFiles([[onlyA], [onlyB]]), []);

  const flags = computeOverlappedMutationFlags(
    [
      { id: "a", busy: true, mutating: true },
      { id: "b", busy: false, mutating: false },
    ],
    "b",
    true,
  );
  assert.equal(flags.get("b"), true);
  assert.equal(flags.get("a"), true);

  const solo = computeOverlappedMutationFlags(
    [{ id: "c", busy: false, mutating: false }],
    "c",
    true,
  );
  assert.equal(solo.get("c"), false);

  const firstAlone = computeOverlappedMutationFlags([], "a", true);
  assert.equal(firstAlone.get("a"), false);
});

test("safe execution defaults to a worktree when the sandbox is unavailable", () => {
  assert.equal(defaultSafetyApprovalMode(true), "auto-review");
  assert.equal(defaultSafetyApprovalMode(false), "safe-worktree");

  assert.equal(shouldUseIsolatedWorktree({
    approvalMode: "safe-worktree",
    mutating: true,
    overlappedMutation: false,
    sandboxSupported: false,
  }), true);
  assert.equal(shouldUseIsolatedWorktree({
    approvalMode: "auto-review",
    mutating: true,
    overlappedMutation: false,
    sandboxSupported: false,
  }), false);
  assert.equal(shouldUseIsolatedWorktree({
    approvalMode: "safe-worktree",
    mutating: false,
    overlappedMutation: false,
    sandboxSupported: false,
  }), false);
  assert.equal(shouldUseIsolatedWorktree({
    approvalMode: "auto-review",
    mutating: true,
    overlappedMutation: true,
    sandboxSupported: true,
  }), true);
});

test("parallel edits on separate hunks are merged without conflict markers", async () => {
  const baseline = Buffer.from("first: old\nshared\nlast: old\n");
  const current = Buffer.from("first: workspace\nshared\nlast: old\n");
  const proposed = Buffer.from("first: old\nshared\nlast: agent\n");
  const result = await threeWayMergeBytes(current, baseline, proposed, "sample.txt");
  assert.equal(result.clean, true);
  assert.equal(Buffer.from(result.bytes).toString("utf8"), "first: workspace\nshared\nlast: agent\n");
});

test("parallel edits on the same hunk remain unresolved", async () => {
  const baseline = Buffer.from("value: old\n");
  const current = Buffer.from("value: workspace\n");
  const proposed = Buffer.from("value: agent\n");
  const result = await threeWayMergeBytes(current, baseline, proposed, "sample.txt");
  assert.equal(result.clean, false);
  assert.equal(hasConflictMarkers(result.bytes), true);
});

test("conflict marker detection only flags complete marker lines", () => {
  assert.equal(hasConflictMarkers(Buffer.from("<<<<<<< workspace\na\n=======\nb\n>>>>>>> agent\n")), true);
  assert.equal(hasConflictMarkers(Buffer.from("const prefix = '<<<<<<<';\n")), false);
  assert.equal(hasConflictMarkers(Buffer.from("heading\n=======\nbody\n")), false);
});

test("webview message schema validation accepts known shapes and rejects junk", () => {
  assert.equal(parseWebviewMessage(null), undefined);
  assert.equal(parseWebviewMessage({ type: "not-a-real-type" }), undefined);
  assert.equal(parseWebviewMessage({ type: "send" }), undefined);
  assert.equal(parseWebviewMessage({ type: "send", prompt: 12 }), undefined);
  assert.equal(parseWebviewMessage({ type: "cancelConversation" }), undefined);
  assert.equal(parseWebviewMessage({ type: "setAlertSetting", setting: "x" }), undefined);
  assert.equal(parseWebviewMessage({ type: "openFile" }), undefined);

  const send = parseWebviewMessage({
    type: "send",
    prompt: " hello ",
    attachContext: true,
    files: ["a.ts", 3, "b.ts"],
    skills: ["review"],
    profile: "agent",
    includeProjectMemory: false,
  });
  assert.equal(send?.type, "send");
  assert.equal(send?.prompt, " hello ");
  assert.deepEqual(send?.files, ["a.ts", "b.ts"]);
  assert.equal(send?.attachContext, true);
  assert.equal(send?.includeProjectMemory, false);

  const interrupt = parseWebviewMessage({
    type: "interruptMessage",
    prompt: "stop and do this",
  });
  assert.equal(interrupt?.type, "interruptMessage");

  const cancel = parseWebviewMessage({
    type: "cancelConversation",
    id: "conv-1",
  });
  assert.equal(cancel?.id, "conv-1");

  const setting = parseWebviewMessage({
    type: "setAlertSetting",
    setting: "notifyOnComplete",
    enabled: true,
  });
  assert.equal(setting?.enabled, true);

  const ready = parseWebviewMessage({ type: "ready" });
  assert.equal(ready?.type, "ready");

  const pickWorkspace = parseWebviewMessage({ type: "pickWorkspaceFolder" });
  assert.equal(pickWorkspace?.type, "pickWorkspaceFolder");
});
