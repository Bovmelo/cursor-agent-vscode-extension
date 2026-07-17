import assert from "node:assert/strict";
import test from "node:test";
import {
  createBestOfNExperiment,
  experimentCandidates,
  pickWinner,
} from "../out/bestOfN.js";
import {
  buildContextPreview,
  estimateTokens,
} from "../out/contextEstimate.js";
import {
  addTokenUsage,
  dayKey,
  emptyUsage,
  formatTokenCount,
  recordUsage,
  summarizeUsage,
} from "../out/usageStats.js";

test("estimateTokens scales with text length", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("a".repeat(40)), 10);
});

test("buildContextPreview includes memory, files, and estimate chips", () => {
  const preview = buildContextPreview({
    prompt: "fix the bug",
    profile: "plan",
    includeProjectMemory: true,
    attachContext: true,
    contextLabel: "src/a.ts",
    files: ["src/a.ts", "src/b.ts"],
    skills: ["review"],
    commandId: "review",
    commandBodyLength: 100,
  });
  assert.ok(preview.estimatedTokens > 0);
  assert.ok(preview.chips.some((chip) => chip.kind === "profile"));
  assert.ok(preview.chips.some((chip) => chip.kind === "memory"));
  assert.ok(preview.chips.some((chip) => chip.kind === "files"));
  assert.ok(preview.chips.some((chip) => chip.kind === "estimate"));
});

test("usage ledger aggregates chat and supervisor by day", () => {
  const usage = addTokenUsage(emptyUsage(), {
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 15,
  });
  let ledger = recordUsage(undefined, "chat", usage);
  ledger = recordUsage(ledger, "supervisor", {
    ...emptyUsage(),
    totalTokens: 7,
    inputTokens: 7,
  });
  const summary = summarizeUsage([{ tokenUsage: usage }], ledger);
  assert.equal(summary.today.chat, 15);
  assert.equal(summary.today.supervisor, 7);
  assert.equal(summary.today.total, 22);
  assert.equal(summary.conversationTotal, 15);
  assert.equal(dayKey().length, 10);
  assert.equal(formatTokenCount(1500), "1.5k");
});

test("best-of-N pickWinner and candidate summaries", () => {
  const experiment = createBestOfNExperiment("compare me", ["a", "b"]);
  const withWinner = pickWinner(experiment, "b");
  assert.equal(withWinner.winnerId, "b");
  assert.equal(pickWinner(experiment, "missing").winnerId, undefined);

  const candidates = experimentCandidates(
    withWinner,
    [
      {
        id: "a",
        title: "A",
        tokenUsage: { totalTokens: 11 },
        transcript: [{ role: "assistant", text: "first answer" }],
      },
      {
        id: "b",
        title: "B",
        tokenUsage: { totalTokens: 22 },
        transcript: [{ role: "assistant", text: "second answer" }],
      },
    ],
    new Set(["a"]),
  );
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].running, true);
  assert.equal(candidates[1].isWinner, true);
  assert.equal(candidates[1].lastAssistant, "second answer");
});
