import assert from "node:assert/strict";
import test from "node:test";
import { ConversationStore } from "../out/conversationStore.js";

function memory(initial = []) {
  let value = initial;
  return {
    get(_key, fallback) {
      return value ?? fallback;
    },
    async update(_key, next) {
      value = next;
    },
    read() {
      return value;
    },
  };
}

test("ConversationStore owns creation, selection, removal, and persistence", async () => {
  const state = memory();
  const store = new ConversationStore(state, "conversations");

  const conversation = store.create("A title that is deliberately longer than forty characters");
  assert.equal(store.active(), conversation);
  assert.equal(store.items.length, 1);
  assert.match(conversation.title, /…$/);

  await store.save();
  assert.equal(state.read()[0], conversation);

  assert.equal(store.remove(conversation.id), conversation);
  assert.equal(store.activeId, undefined);
  assert.deepEqual(store.items, []);
});
