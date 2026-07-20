import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  CONVERSATION_STORE_SCHEMA_VERSION,
  ConversationStore,
} from "../out/conversationStore.js";

function memory(initial = []) {
  let value = initial;
  const updates = [];
  return {
    get(_key, fallback) {
      return value ?? fallback;
    },
    async update(_key, next) {
      updates.push(next);
      value = next;
    },
    read() {
      return value;
    },
    updates,
  };
}

function storedConversation(id, updatedAt, transcript = []) {
  return {
    id,
    title: id,
    createdAt: updatedAt,
    updatedAt,
    transcript: transcript.map((text, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      text,
    })),
  };
}

test("ConversationStore owns creation, selection, removal, and versioned persistence", async () => {
  const state = memory();
  const store = new ConversationStore(state, "conversations", { saveDebounceMs: 0 });

  const conversation = store.create("A title that is deliberately longer than forty characters");
  assert.equal(store.active(), conversation);
  assert.equal(store.items.length, 1);
  assert.match(conversation.title, /…$/u);

  await store.save();
  assert.equal(state.read().schemaVersion, CONVERSATION_STORE_SCHEMA_VERSION);
  assert.deepEqual(
    state.read().conversations,
    JSON.parse(JSON.stringify([conversation])),
  );

  assert.equal(store.remove(conversation.id), conversation);
  assert.equal(store.activeId, undefined);
  assert.deepEqual(store.items, []);
});

test("legacy arrays migrate while malformed and future payloads fail closed", async () => {
  const legacy = storedConversation("legacy", 1, ["hello"]);
  const state = memory([legacy, { id: "broken" }, { ...legacy }]);
  const store = new ConversationStore(state, "conversations", { saveDebounceMs: 0 });

  assert.deepEqual(store.items.map(({ id }) => id), ["legacy"]);
  assert.notEqual(store.items[0], legacy, "restored records are detached from Memento data");
  await store.save();
  assert.deepEqual(state.read(), {
    schemaVersion: 1,
    conversations: [legacy],
  });

  const future = new ConversationStore(memory({
    schemaVersion: 99,
    conversations: [legacy],
  }), "conversations");
  assert.deepEqual(future.items, []);
  assert.deepEqual(new ConversationStore(memory(null), "conversations").items, []);
});

test("count limits prune the oldest unpinned conversation before pinned history", () => {
  const pinned = { ...storedConversation("pinned", 1), pinned: true };
  const old = storedConversation("old", 2);
  const current = storedConversation("current", 3);
  const store = new ConversationStore(memory([pinned, current, old]), "conversations", {
    maxConversations: 2,
  });

  assert.deepEqual(store.items.map(({ id }) => id), ["pinned", "current"]);
});

test("UTF-8 byte limits prune oldest transcript entries and keep the newest tail", async () => {
  const state = memory([
    storedConversation("large", 1, ["a".repeat(120), "b".repeat(120), "c".repeat(120)]),
  ]);
  const store = new ConversationStore(state, "conversations", {
    maxSerializedBytes: 500,
    saveDebounceMs: 0,
  });

  assert.ok(store.items[0].transcript.length < 3);
  assert.equal(store.items[0].transcript.at(-1)?.text, "c".repeat(120));
  await store.save();
  assert.ok(Buffer.byteLength(JSON.stringify(state.read()), "utf8") <= 500);
});

test("overlapping saves are serialized and persist detached snapshots in order", async () => {
  let value;
  let activeWrites = 0;
  let maxActiveWrites = 0;
  let notifyFirstStarted;
  const firstStarted = new Promise((resolve) => { notifyFirstStarted = resolve; });
  const writes = [];
  const state = {
    get(_key, fallback) { return value ?? fallback; },
    async update(_key, next) {
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      writes.push(next);
      if (writes.length === 1) notifyFirstStarted();
      await delay(15);
      value = next;
      activeWrites -= 1;
    },
  };
  const store = new ConversationStore(state, "conversations", { saveDebounceMs: 1_000 });
  const conversation = store.create("first");

  const firstSave = store.save();
  const firstFlush = store.flush();
  await firstStarted;
  conversation.title = "second";
  const secondSave = store.save();
  conversation.title = "mutated after snapshot";
  await Promise.all([firstSave, firstFlush, secondSave]);

  assert.equal(maxActiveWrites, 1);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].conversations[0].title, "first");
  assert.equal(writes[1].conversations[0].title, "second");
  assert.equal(value.conversations[0].title, "second");
});

test("debounce coalesces rapid saves and settles every caller after the latest write", async () => {
  const state = memory();
  const store = new ConversationStore(state, "conversations", { saveDebounceMs: 10 });
  const conversation = store.create("first");
  const first = store.save();
  conversation.title = "latest";
  const second = store.save();

  await Promise.all([first, second]);
  assert.equal(state.updates.length, 1);
  assert.equal(state.read().conversations[0].title, "latest");
});

test("a failed update rejects its callers without poisoning later saves", async () => {
  let attempts = 0;
  let value = [];
  const state = {
    get() { return value; },
    async update(_key, next) {
      attempts += 1;
      if (attempts === 1) throw new Error("storage unavailable");
      value = next;
    },
  };
  const store = new ConversationStore(state, "conversations", { saveDebounceMs: 0 });
  store.create("retry");

  await assert.rejects(store.save(), /storage unavailable/u);
  await store.save();
  assert.equal(attempts, 2);
  assert.equal(value.conversations[0].title, "retry");
});

test("serialization errors do not partially overwrite persisted state", async () => {
  const state = memory();
  const store = new ConversationStore(state, "conversations", { saveDebounceMs: 0 });
  const conversation = store.create("circular");
  conversation.circular = conversation;

  await assert.rejects(store.save(), /circular|cyclic/iu);
  assert.deepEqual(state.read(), []);
  assert.equal(state.updates.length, 0);
});
