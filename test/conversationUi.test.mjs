import assert from "node:assert/strict";
import test from "node:test";
import {
  conversationSummaries,
  conversationToMarkdown,
  findConversationForRetry,
} from "../out/conversationUi.js";

function conversation(overrides = {}) {
  return {
    id: "c1",
    title: "Auth fix",
    createdAt: 1,
    updatedAt: 10,
    transcript: [{ role: "user", text: "fix login" }],
    ...overrides,
  };
}

test("conversationSummaries filters, pins, and marks busy/queued", () => {
  const items = [
    conversation({ id: "older", title: "Older", updatedAt: 1, pinned: false }),
    conversation({
      id: "pinned",
      title: "Pinned chat",
      updatedAt: 2,
      pinned: true,
      transcript: [{ role: "user", text: "needle in transcript" }],
    }),
    conversation({ id: "busy", title: "Busy", updatedAt: 3 }),
  ];

  const summaries = conversationSummaries(items, "needle", {
    isBusy: (id) => id === "busy" || id === "pinned",
    isQueued: (id) => id === "pinned",
    orchestratorFinalResultLinks: new Map([["pinned", "synthesis"]]),
  });

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].id, "pinned");
  assert.equal(summaries[0].running, true);
  assert.equal(summaries[0].queued, true);
  assert.equal(summaries[0].pinned, true);
  assert.equal(summaries[0].orchestratorFinalResultConversationId, "synthesis");
});

test("conversationToMarkdown includes roles and edited files", () => {
  const markdown = conversationToMarkdown(
    conversation({
      title: "Export me",
      createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
      updatedAt: Date.parse("2026-01-02T00:00:00.000Z"),
      tokenUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      transcript: [
        { role: "user", text: "please edit" },
        { role: "assistant", text: "done", files: ["src/a.ts"] },
      ],
    }),
  );
  assert.match(markdown, /^# Export me/u);
  assert.match(markdown, /## User/u);
  assert.match(markdown, /## Assistant/u);
  assert.match(markdown, /- src\/a\.ts/u);
  assert.match(markdown, /Tokens: 3/u);
});

test("findConversationForRetry prefers active then latest with a user prompt", () => {
  const items = [
    conversation({ id: "old", updatedAt: 1, transcript: [{ role: "user", text: "old prompt" }] }),
    conversation({
      id: "active",
      updatedAt: 2,
      transcript: [
        { role: "user", text: "retry me" },
        { role: "assistant", text: "ok" },
      ],
    }),
    conversation({ id: "empty", updatedAt: 99, transcript: [] }),
  ];

  const active = findConversationForRetry(items, "active");
  assert.equal(active?.conversation.id, "active");
  assert.equal(active?.lastUserPrompt.text, "retry me");

  const latest = findConversationForRetry(items, undefined);
  assert.equal(latest?.conversation.id, "active");

  assert.equal(findConversationForRetry([conversation({ transcript: [] })], undefined), undefined);
});
