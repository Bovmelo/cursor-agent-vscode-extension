import assert from "node:assert/strict";
import test from "node:test";
import {
  availableParallelSlots,
  canStartAnotherParallelAgent,
  enqueueChatMessage,
  normalizeMaxParallelAgents,
  queuedConversationIds,
  requeueUnstartedMessage,
  requeueUnstartedMessages,
  selectParallelLaunchCandidates,
  takeParallelLaunchBatch,
} from "../out/chatSendQueue.js";

test("normalizeMaxParallelAgents and availableParallelSlots", () => {
  assert.equal(normalizeMaxParallelAgents(0), 1);
  assert.equal(normalizeMaxParallelAgents(-2), 1);
  assert.equal(normalizeMaxParallelAgents(3), 3);
  assert.equal(availableParallelSlots(0, 3), 3);
  assert.equal(availableParallelSlots(2, 3), 1);
  assert.equal(availableParallelSlots(3, 3), 0);
  assert.equal(availableParallelSlots(5, 3), 0);
  assert.equal(availableParallelSlots(0, 0), 1);
  assert.equal(canStartAnotherParallelAgent(0, 0), true);
});

test("selectParallelLaunchCandidates filters ids, interrupts, and active chat", () => {
  const queue = [
    { id: "a1", conversationId: "a", kind: "queued" },
    { id: "a2", conversationId: "a", kind: "interrupt" },
    { id: "b1", conversationId: "b", kind: "queued" },
    { id: "a3", conversationId: "a", kind: "queued" },
  ];
  assert.deepEqual(
    selectParallelLaunchCandidates(queue, ["a1", "a2", "a3", "missing"], "a").map(
      (item) => item.id,
    ),
    ["a1", "a3"],
  );
  assert.deepEqual(
    selectParallelLaunchCandidates(queue, ["a1", "b1"], null).map((item) => item.id),
    ["a1", "b1"],
  );
  assert.deepEqual(
    selectParallelLaunchCandidates(queue, ["", "a1"], "a").map((item) => item.id),
    ["a1"],
  );
  assert.deepEqual(selectParallelLaunchCandidates(queue, [], "a"), []);
});

test("takeParallelLaunchBatch respects available slots", () => {
  const items = [
    { id: "1", conversationId: "a", kind: "queued" },
    { id: "2", conversationId: "a", kind: "queued" },
    { id: "3", conversationId: "a", kind: "queued" },
  ];
  assert.deepEqual(takeParallelLaunchBatch(items, 2), {
    launchable: items.slice(0, 2),
    skippedForLimit: 1,
  });
  assert.deepEqual(takeParallelLaunchBatch(items, 0), {
    launchable: [],
    skippedForLimit: 3,
  });
  assert.deepEqual(takeParallelLaunchBatch(items, 5), {
    launchable: items,
    skippedForLimit: 0,
  });
});

test("queuedConversationIds preserves first-seen order", () => {
  assert.deepEqual(
    queuedConversationIds([
      { id: "1", conversationId: "b", kind: "queued" },
      { id: "2", conversationId: "a", kind: "queued" },
      { id: "3", conversationId: "b", kind: "interrupt" },
      { id: "4", conversationId: "c", kind: "queued" },
    ]),
    ["b", "a", "c"],
  );
});

test("batch requeue preserves original same-conversation order", () => {
  const queue = [
    { id: "b1", conversationId: "b", kind: "queued" },
    { id: "a3", conversationId: "a", kind: "queued" },
  ];
  const pending = [
    { id: "a1", conversationId: "a", kind: "queued" },
    { id: "a2", conversationId: "a", kind: "queued" },
  ];

  // Naïve forward requeue reverses same-conversation batches.
  let reversed = queue;
  for (const item of pending) {
    reversed = requeueUnstartedMessage(reversed, item);
  }
  assert.deepEqual(reversed.map((item) => item.id), ["b1", "a2", "a1", "a3"]);

  const restored = requeueUnstartedMessages(queue, pending);
  assert.deepEqual(restored.map((item) => item.id), ["b1", "a1", "a2", "a3"]);
});

test("enqueue interrupt stays ahead of queued work", () => {
  let queue = enqueueChatMessage([], {
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
});
