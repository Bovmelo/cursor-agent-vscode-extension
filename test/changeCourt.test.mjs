import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANGE_COURT_MAX_PROMPT_CHARACTERS,
  buildChangeCourtPrompt,
  formatChangeCourtMarkdown,
  parseChangeCourtReview,
} from "../out/changeCourt.js";

const completeReview = {
  verdict: "concerns",
  summary: "The change mostly works.",
  intent: "Keep sessions reliable.",
  evidence: ["The new branch is covered."],
  impact: ["Retry behavior changes."],
  counterarguments: [{
    claim: "Retries are safe.",
    risk: "Duplicate writes are possible.",
    test: "Simulate a timeout after the write.",
  }],
  missingTests: ["A timeout regression test."],
  rollback: ["Restore the previous retry policy."],
  findings: [{
    file: "src/retry.ts",
    line: 12,
    endLine: 14,
    severity: "warning",
    message: "A retry may duplicate a write.",
    suggestion: "Add an idempotency key.",
  }],
};

test("parseChangeCourtReview parses plain and fenced JSON objects", () => {
  const plain = parseChangeCourtReview(JSON.stringify(completeReview));
  const fenced = parseChangeCourtReview(
    `\n\`\`\`json\n${JSON.stringify(completeReview)}\n\`\`\`\n`,
  );

  assert.deepEqual(plain, completeReview);
  assert.deepEqual(fenced, completeReview);
});

test("parseChangeCourtReview sanitizes unknown enums and text values", () => {
  const parsed = parseChangeCourtReview(JSON.stringify({
    ...completeReview,
    verdict: "maybe",
    summary: " trimmed summary ",
    intent: " trimmed intent ",
    evidence: [" usable ", ""],
    counterarguments: [{ claim: " claim ", risk: " risk ", test: " test " }],
    findings: [{
      file: " src/example.ts ",
      line: 5,
      severity: "fatal",
      message: " message ",
    }],
  }));

  assert.deepEqual(parsed, {
    verdict: "concerns",
    summary: "trimmed summary",
    intent: "trimmed intent",
    evidence: ["usable"],
    impact: completeReview.impact,
    counterarguments: [{ claim: "claim", risk: "risk", test: "test" }],
    missingTests: completeReview.missingTests,
    rollback: completeReview.rollback,
    findings: [{
      file: "src/example.ts",
      line: 5,
      severity: "info",
      message: "message",
    }],
  });
});

test("parseChangeCourtReview rejects missing or malformed required structure", () => {
  const cases = [
    [{}, /missing required property "verdict"/],
    [{ ...completeReview, summary: " " }, /review\.summary must not be empty/],
    [{ ...completeReview, intent: undefined }, /missing required property "intent"/],
    [{ ...completeReview, evidence: "not an array" }, /review\.evidence must be an array/],
    [{ ...completeReview, evidence: ["valid", null] }, /review\.evidence\[1\] must be a string/],
    [{ ...completeReview, rollback: null }, /review\.rollback must be an array/],
    [{
      ...completeReview,
      findings: [{ ...completeReview.findings[0], file: "" }],
    }, /review\.findings\[0\]\.file must not be empty/],
    [{
      ...completeReview,
      findings: [{ ...completeReview.findings[0], message: " " }],
    }, /review\.findings\[0\]\.message must not be empty/],
    [{
      ...completeReview,
      counterarguments: [{ claim: "", risk: "risk", test: "test" }],
    }, /review\.counterarguments\[0\]\.claim must not be empty/],
  ];

  for (const [review, expected] of cases) {
    assert.throws(() => parseChangeCourtReview(JSON.stringify(review)), expected);
  }
});

test("parseChangeCourtReview rejects malformed or non-object JSON clearly", () => {
  assert.throws(
    () => parseChangeCourtReview("```json\n{not json}\n```"),
    /Invalid Change Court review JSON.*expected one plain or fenced JSON object/,
  );
  assert.throws(
    () => parseChangeCourtReview("[]"),
    /JSON value is not an object/,
  );
  assert.throws(
    () => parseChangeCourtReview("  "),
    /response was empty/,
  );
});

test("buildChangeCourtPrompt keeps complete file boundaries within its budget", () => {
  const small = { relative: "src/small.ts", before: "old", after: "new" };
  const huge = {
    relative: "src/huge.ts",
    before: "x".repeat(10_000),
    after: "y".repeat(10_000),
  };
  const budget = 3_000;
  const result = buildChangeCourtPrompt({
    goal: "Review the retry change.",
    verification: "Unit tests passed.",
    files: [small, huge],
  }, budget);

  assert.ok(result.prompt.length <= budget);
  assert.deepEqual(result.includedFiles, ["src/small.ts"]);
  assert.deepEqual(result.skippedFiles, ["src/huge.ts"]);
  assert.match(result.prompt, /Do not edit files/);
  assert.match(result.prompt, /Use only the session goal/);
  assert.match(result.prompt, /Prefer falsification/);
  assert.match(result.prompt, /Return exactly one JSON object/);
  assert.match(result.prompt, /src\/small\.ts/);
  assert.doesNotMatch(result.prompt, /src\/huge\.ts/);
  assert.equal(
    (result.prompt.match(/BEGIN COMPLETE FILE EVIDENCE/g) ?? []).length,
    (result.prompt.match(/END COMPLETE FILE EVIDENCE/g) ?? []).length,
  );
  assert.ok(CHANGE_COURT_MAX_PROMPT_CHARACTERS > budget);
});

test("formatChangeCourtMarkdown renders English sections and escapes evidence", () => {
  const markdown = formatChangeCourtMarkdown({
    goal: "Fix *retry* <script>",
    review: completeReview,
    verification: "npm test",
    includedFiles: ["src/retry.ts"],
    skippedFiles: ["secrets/[local].txt"],
    reviewedAt: "2026-07-20T10:00:00Z",
  });

  for (const heading of [
    "## Summary",
    "## Intent",
    "## Evidence",
    "## Impact",
    "## Counterarguments",
    "## Missing tests",
    "## Rollback",
    "## Findings",
    "## Included files",
    "## Skipped files",
  ]) {
    assert.match(markdown, new RegExp(heading));
  }
  assert.match(markdown, /`CONCERNS`/);
  assert.ok(markdown.includes("Fix \\*retry\\* &lt;script&gt;"));
  assert.ok(markdown.includes("secrets/\\[local\\].txt"));
});

test("formatChangeCourtMarkdown renders Japanese labels", () => {
  const markdown = formatChangeCourtMarkdown({
    goal: "再試行を安全にする",
    review: completeReview,
    verification: "テスト成功",
    includedFiles: ["src/retry.ts"],
    skippedFiles: [],
    japanese: true,
  });

  assert.match(markdown, /^# Change Court レビュー/m);
  assert.match(markdown, /\*\*判定:\*\*/);
  assert.match(markdown, /## 根拠/);
  assert.match(markdown, /## 反証/);
  assert.match(markdown, /## 不足しているテスト/);
  assert.match(markdown, /## 含めたファイル/);
  assert.match(markdown, /## 省略したファイル/);
  assert.match(markdown, /_なし_/);
});
