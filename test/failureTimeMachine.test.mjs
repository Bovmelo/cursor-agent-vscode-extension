import assert from "node:assert/strict";
import test from "node:test";

import {
  analyzeFailureTimeMachine,
  failureSignature,
  formatFailureTimeMachineMarkdown,
} from "../out/failureTimeMachine.js";

function run(at, { success, skipped = false, command = "npm test", output = "", durationMs = 100 }) {
  return {
    at,
    success,
    skipped,
    steps: skipped ? [] : [{ command, stage: "test", success, output, durationMs }],
  };
}

function session(overrides) {
  return {
    id: overrides.id,
    goal: overrides.goal ?? overrides.id,
    root: overrides.root ?? "C:\\repo",
    startedAt: overrides.startedAt,
    finishedAt: overrides.finishedAt,
    phase: overrides.phase ?? "failed",
    baselineClean: true,
    checkpointReady: true,
    files: overrides.files ?? [],
    fileDecisions: overrides.fileDecisions,
    verification: overrides.verification,
    verificationHistory: overrides.verificationHistory,
    repair: overrides.repair,
  };
}

test("analyzeFailureTimeMachine finds the pass-to-first-failure boundary chronologically", () => {
  const sessions = [
    session({
      id: "target",
      startedAt: 300,
      files: ["C:\\repo\\src\\target.ts"],
      verificationHistory: [run(350, { success: false, output: "FAIL target" })],
    }),
    session({
      id: "middle",
      startedAt: 200,
      files: ["C:\\repo\\src\\middle.ts"],
      verificationHistory: [run(250, { success: true, skipped: true })],
    }),
    session({
      id: "passing",
      startedAt: 100,
      phase: "review",
      files: ["C:\\repo\\src\\passing.ts"],
      verificationHistory: [run(150, { success: true })],
    }),
  ];

  const report = analyzeFailureTimeMachine({ sessions, auditEntries: [] });
  assert.ok(report);
  assert.equal(report.targetSessionId, "target");
  assert.equal(report.lastRecordedPass?.sessionId, "passing");
  assert.equal(report.firstRecordedFailure.sessionId, "target");
  assert.deepEqual(report.timeline.map((item) => item.status), ["passed", "skipped", "failed"]);
  assert.equal(report.boundaryConfidence, "medium");
  assert.deepEqual(
    report.candidateFiles.map((item) => item.relative),
    ["src/target.ts", "src/middle.ts"],
  );
});

test("verification history preserves fail then pass while targeting the recorded failure", () => {
  const report = analyzeFailureTimeMachine({
    sessions: [session({
      id: "rerun",
      startedAt: 100,
      phase: "review",
      files: ["C:\\repo\\src\\fixed.ts"],
      verification: run(300, { success: true }),
      verificationHistory: [
        run(200, { success: false, output: "Assertion failed" }),
        run(300, { success: true }),
      ],
    })],
    auditEntries: [],
    targetSessionId: "rerun",
  });

  assert.ok(report);
  assert.equal(report.targetFailure.at, 200);
  assert.deepEqual(report.timeline.map((item) => item.status), ["failed"]);
});

test("recurrence signatures normalize paths, ids, and line numbers", () => {
  const left = failureSignature({
    command: "npm test",
    stage: "test",
    success: false,
    durationMs: 1,
    output: "C:\\repo\\src\\a.ts:42 failed id abcdef123456",
  });
  const right = failureSignature({
    command: "  NPM   TEST ",
    stage: "test",
    success: false,
    durationMs: 1,
    output: "D:\\work\\src\\b.ts:91 failed id deadbeef9999",
  });
  assert.equal(left, right);

  const report = analyzeFailureTimeMachine({
    sessions: [
      session({
        id: "new",
        startedAt: 200,
        verificationHistory: [run(210, { success: false, output: "D:\\work\\src\\b.ts:91 failed id deadbeef9999" })],
      }),
      session({
        id: "old",
        startedAt: 100,
        verificationHistory: [run(110, { success: false, output: "C:\\repo\\src\\a.ts:42 failed id abcdef123456" })],
      }),
    ],
    auditEntries: [],
  });
  assert.equal(report?.recurrence.count, 2);
});

test("analysis keeps roots separate and joins matching audit entries oldest first", () => {
  const sessions = [
    session({
      id: "target",
      root: "C:\\repo-a",
      startedAt: 200,
      files: ["C:\\repo-a\\src\\same.ts"],
      verificationHistory: [run(220, { success: false, output: "fail" })],
    }),
    session({
      id: "other-root",
      root: "C:\\repo-b",
      startedAt: 150,
      files: ["C:\\repo-b\\src\\same.ts"],
      verificationHistory: [run(170, { success: false, output: "fail" })],
    }),
  ];
  const report = analyzeFailureTimeMachine({
    sessions,
    auditEntries: [
      { id: "2", at: 300, action: "session.restore", summary: "later", sessionId: "target" },
      { id: "x", at: 250, action: "session.keep", summary: "other", sessionId: "other-root" },
      { id: "1", at: 240, action: "session.keep", summary: "earlier", sessionId: "target" },
    ],
  });
  assert.ok(report);
  assert.deepEqual(report.candidateFiles.map((item) => item.relative), ["src/same.ts"]);
  assert.deepEqual(report.auditEntries.map((item) => item.id), ["1", "2"]);
});

test("failure output is redacted, bounded, and markdown avoids root-cause claims", () => {
  const secret = "authorization: super-secret-token";
  const report = analyzeFailureTimeMachine({
    sessions: [session({
      id: "target",
      startedAt: 100,
      verificationHistory: [run(120, {
        success: false,
        output: `${secret}\n${"x".repeat(6_000)}`,
      })],
    })],
    auditEntries: [],
  });
  assert.ok(report);
  assert.doesNotMatch(report.failureOutput, /super-secret-token/u);
  assert.match(report.failureOutput, /<redacted>/u);
  assert.ok(report.failureOutput.length < 4_100);

  const english = formatFailureTimeMachineMarkdown(report, false);
  const japanese = formatFailureTimeMachineMarkdown(report, true);
  assert.match(english, /First recorded failure/u);
  assert.match(english, /not a complete execution trace or a root-cause determination/u);
  assert.match(japanese, /最初に記録された失敗/u);
  assert.match(japanese, /root causeの断定でもありません/u);
});

test("failure output cannot break out of its markdown code fence", () => {
  const report = analyzeFailureTimeMachine({
    sessions: [session({
      id: "markdown",
      startedAt: 100,
      verificationHistory: [run(120, {
        success: false,
        output: "before\n````\n[unsafe](command:cursorSubscription.openSettings)\nafter",
      })],
    })],
    auditEntries: [],
  });
  assert.ok(report);

  const markdown = formatFailureTimeMachineMarkdown(report, false);
  const openingFence = markdown.match(/^(`{5,})text$/mu)?.[1];
  assert.ok(openingFence);
  assert.match(markdown, new RegExp(`^${openingFence}$`, "mu"));
  assert.ok(openingFence.length > 4);
});

test("legacy verification and missing finish time remain analyzable", () => {
  const legacy = run(100, { success: false, output: "legacy failure" });
  const { at: _at, ...verification } = legacy;
  const report = analyzeFailureTimeMachine({
    sessions: [session({
      id: "legacy",
      startedAt: 100,
      finishedAt: undefined,
      verification,
    })],
    auditEntries: [],
  });
  assert.ok(report);
  assert.equal(report.targetFailure.at, 100);
  assert.match(formatFailureTimeMachineMarkdown(report, false), /Finished:\*\* None recorded/u);
});
