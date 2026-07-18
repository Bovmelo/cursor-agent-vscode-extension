import assert from "node:assert/strict";
import test from "node:test";
import {
  buildBestOfNJudgePrompt,
  createBestOfNExperiment,
  experimentCandidates,
  parseBestOfNWinnerVerdict,
  pickWinner,
  scoreBestOfNCandidate,
  selectBestOfNWinner,
  shouldAbortBestOfNAutoSelect,
} from "../out/bestOfN.js";
import { buildAutoRepairPrompt } from "../out/autoRepair.js";
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

test("best-of-N auto-select prefers verified candidates", () => {
  const selection = selectBestOfNWinner([
    {
      conversationId: "a",
      title: "A",
      completed: true,
      failed: false,
      hasArtifact: true,
      changedFileCount: 4,
      verificationSuccess: false,
      totalTokens: 1_000,
      lastAssistant: "broad rewrite",
    },
    {
      conversationId: "b",
      title: "B",
      completed: true,
      failed: false,
      hasArtifact: true,
      changedFileCount: 2,
      verificationSuccess: true,
      totalTokens: 1_200,
      lastAssistant: "focused fix",
    },
  ]);
  assert.equal(selection?.winnerId, "b");
  assert.equal(selection?.tied, false);
  assert.ok(scoreBestOfNCandidate({
    conversationId: "b",
    title: "B",
    completed: true,
    failed: false,
    hasArtifact: true,
    changedFileCount: 2,
    verificationSuccess: true,
    totalTokens: 1_200,
  }).score > 0);

  const prompt = buildBestOfNJudgePrompt("fix flaky test", [{
    conversationId: "a",
    title: "A",
    completed: true,
    failed: false,
    hasArtifact: true,
    changedFileCount: 1,
    verificationSuccess: true,
    totalTokens: 10,
    lastAssistant: "patched timeout",
  }]);
  assert.match(prompt, /BEST_OF_N_WINNER/);
  assert.match(prompt, /patched timeout/);

  const verdict = parseBestOfNWinnerVerdict(
    '<BEST_OF_N_WINNER>{"winnerId":"a","reasons":["passes verify"]}</BEST_OF_N_WINNER>',
    ["a", "b"],
  );
  assert.equal(verdict?.winnerId, "a");
  assert.equal(verdict?.reasons[0], "passes verify");
  assert.equal(
    parseBestOfNWinnerVerdict(
      '<BEST_OF_N_WINNER>{"winnerId":"missing","reasons":[]}</BEST_OF_N_WINNER>',
      ["a"],
    ),
    undefined,
  );
});

test("best-of-N auto-select aborts when a winner is already set after judge await", () => {
  const open = createBestOfNExperiment("compare", ["a", "b"]);
  assert.equal(
    shouldAbortBestOfNAutoSelect(open, { autoSelectEnabled: true }),
    false,
  );
  assert.equal(
    shouldAbortBestOfNAutoSelect(pickWinner(open, "a"), { autoSelectEnabled: true }),
    true,
  );
  assert.equal(
    shouldAbortBestOfNAutoSelect(
      { ...open, appliedWinnerId: "b" },
      { autoSelectEnabled: true },
    ),
    true,
  );
  assert.equal(
    shouldAbortBestOfNAutoSelect(open, { autoSelectEnabled: false }),
    true,
  );
  assert.equal(
    shouldAbortBestOfNAutoSelect(open, {
      autoSelectEnabled: true,
      requireAutoJudge: true,
      autoJudgeEnabled: false,
    }),
    true,
  );
  assert.equal(
    shouldAbortBestOfNAutoSelect(undefined, { autoSelectEnabled: true }),
    true,
  );

  assert.equal(
    selectBestOfNWinner([
      {
        conversationId: "a",
        title: "A",
        completed: true,
        failed: true,
        hasArtifact: false,
        changedFileCount: 0,
        totalTokens: 10,
      },
      {
        conversationId: "b",
        title: "B",
        completed: true,
        failed: true,
        hasArtifact: false,
        changedFileCount: 0,
        totalTokens: 10,
      },
    ]),
    undefined,
  );
});

test("best-of-N auto-select skips artifact-less completed candidates", () => {
  assert.equal(
    selectBestOfNWinner([
      {
        conversationId: "a",
        title: "A",
        completed: true,
        failed: false,
        hasArtifact: false,
        changedFileCount: 0,
        totalTokens: 10,
        lastAssistant: "done, no files",
      },
      {
        conversationId: "b",
        title: "B",
        completed: true,
        failed: false,
        hasArtifact: false,
        changedFileCount: 0,
        totalTokens: 20,
        lastAssistant: "also done, no files",
      },
    ]),
    undefined,
  );

  const selection = selectBestOfNWinner([
    {
      conversationId: "empty",
      title: "Empty",
      completed: true,
      failed: false,
      hasArtifact: false,
      changedFileCount: 0,
      verificationSuccess: true,
      totalTokens: 5,
      lastAssistant: "no changes",
    },
    {
      conversationId: "with-files",
      title: "With files",
      completed: true,
      failed: false,
      hasArtifact: true,
      changedFileCount: 1,
      verificationSuccess: false,
      totalTokens: 50,
      lastAssistant: "patched one file",
    },
  ]);
  assert.equal(selection?.winnerId, "with-files");
  assert.equal(selection?.tied, false);
});

test("auto-repair prompt stays scoped to verification failures", () => {
  const prompt = buildAutoRepairPrompt({
    attempt: 1,
    maxAttempts: 2,
    failures: "$ npm test\nAssertionError: expected 1",
    editedFiles: ["src/foo.ts"],
  });
  assert.match(prompt, /repair attempt 1\/2/);
  assert.match(prompt, /src\/foo\.ts/);
  assert.match(prompt, /Do not expand scope/);
  assert.match(prompt, /AssertionError/);
});
