import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  parseGitHubSupervisorSignals,
  scanCurrentGitHubPullRequest,
} from "../out/githubTriggers.js";

const PR_VIEW_JSON_FIELDS = [
  "number",
  "title",
  "url",
  "comments",
  "reviews",
  "statusCheckRollup",
];

function fingerprintKey(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertPrViewJsonContract(args) {
  const jsonFlagIndex = args.indexOf("--json");
  assert.ok(jsonFlagIndex >= 0, "gh pr view must pass --json");
  const fieldsArg = args[jsonFlagIndex + 1] ?? "";
  const fields = new Set(
    fieldsArg.split(",").map((field) => field.trim()).filter(Boolean),
  );
  for (const required of PR_VIEW_JSON_FIELDS) {
    assert.ok(
      fields.has(required),
      `gh pr view --json missing field: ${required} (got ${fieldsArg})`,
    );
  }
}

/** Shared pr-view arg contract check embedded in gh shims (exits 3 on mismatch). */
function prViewContractShimPrelude(argsProbePath) {
  return [
    "const args = process.argv.slice(2);",
    "const joined = args.join(' ');",
    "if (args[0] === 'pr' && args[1] === 'view') {",
    `  const { writeFileSync } = await import('node:fs');`,
    `  writeFileSync(${JSON.stringify(argsProbePath)}, JSON.stringify(args));`,
    "  if (!args.includes('--json')) {",
    "    console.error('missing --json');",
    "    process.exit(3);",
    "  }",
    "  const fieldsArg = args[args.indexOf('--json') + 1] ?? '';",
    "  const fields = new Set(fieldsArg.split(',').map((f) => f.trim()).filter(Boolean));",
    `  for (const required of ${JSON.stringify(PR_VIEW_JSON_FIELDS)}) {`,
    "    if (!fields.has(required)) {",
    "      console.error('missing --json field: ' + required);",
    "      process.exit(3);",
    "    }",
    "  }",
    "}",
  ].join("\n");
}

test("parseGitHubSupervisorSignals rejects invalid JSON", () => {
  assert.throws(() => parseGitHubSupervisorSignals("not-json"), SyntaxError);
  assert.throws(() => parseGitHubSupervisorSignals("{"), SyntaxError);
});

test("parseGitHubSupervisorSignals keeps failed check states and skips healthy ones", () => {
  const signals = parseGitHubSupervisorSignals(JSON.stringify({
    number: 7,
    title: "CI matrix",
    statusCheckRollup: [
      { name: "unit", conclusion: "FAILURE", completedAt: "2026-07-17" },
      { name: "lint", conclusion: "SUCCESS" },
      { workflowName: "build", state: "ERROR" },
      { name: "typecheck", conclusion: "TIMED_OUT" },
      { name: "gate-action", conclusion: "ACTION_REQUIRED" },
      { name: "gate-cancel", conclusion: "CANCELLED" },
      { name: "gate-startup", state: "STARTUP_FAILURE" },
      { name: "neutral", conclusion: "NEUTRAL" },
      { name: "pending", state: "IN_PROGRESS" },
    ],
  }));
  assert.deepEqual(
    signals.map((signal) => signal.title),
    [
      "Fix failed CI: unit",
      "Fix failed CI: build",
      "Fix failed CI: typecheck",
      "Fix failed CI: gate-action",
      "Fix failed CI: gate-cancel",
      "Fix failed CI: gate-startup",
    ],
  );
  assert.equal(signals.every((signal) => signal.source === "ci"), true);
  assert.equal(signals.every((signal) => signal.priority === "high"), true);
});

test("parseGitHubSupervisorSignals recognizes actionable comments and review priorities", () => {
  const signals = parseGitHubSupervisorSignals(JSON.stringify({
    title: "No number yet",
    comments: [
      { id: "c1", body: "[cursor] please tighten validation", author: { login: "alice" } },
      { id: "c2", body: "TODO(ai): add coverage", author: { login: "bob" } },
      { id: "c3", body: "/CursorFoo is not a marker", author: { login: "eve" } },
      { id: "c4", body: "looks good", author: { login: "carol" } },
    ],
    reviews: [
      {
        id: "r1",
        state: "CHANGES_REQUESTED",
        body: "",
        author: { login: "dana" },
      },
      {
        id: "r2",
        state: "COMMENTED",
        body: "/cursor fix the edge case",
        author: { login: "erin" },
      },
      {
        id: "r3",
        state: "COMMENTED",
        body: "nit: naming",
        author: { login: "frank" },
      },
    ],
  }));
  assert.equal(signals.length, 4);
  assert.match(signals[0].detail, /^current PR/);
  assert.match(signals[0].detail, /tighten validation/);
  assert.match(signals[1].detail, /add coverage/);
  assert.equal(signals[2].priority, "high");
  assert.equal(signals[3].priority, "normal");
  assert.match(signals[2].title, /dana/);
  assert.match(signals[3].detail, /edge case/);
});

test("parseGitHubSupervisorSignals marker matching is case-insensitive", () => {
  const signals = parseGitHubSupervisorSignals(JSON.stringify({
    number: 3,
    comments: [
      { id: "c1", body: "[CURSOR] please retry", author: { login: "alice" } },
      { id: "c2", body: "/Cursor fix windows path", author: { login: "bob" } },
      { id: "c3", body: "TODO(AI): cover retry", author: { login: "carol" } },
    ],
  }));
  assert.equal(signals.length, 3);
  assert.deepEqual(
    signals.map((signal) => signal.fingerprint),
    [
      fingerprintKey("comment:3:c1"),
      fingerprintKey("comment:3:c2"),
      fingerprintKey("comment:3:c3"),
    ],
  );
});

test("parseGitHubSupervisorSignals empty CHANGES_REQUESTED body stays actionable", () => {
  const signals = parseGitHubSupervisorSignals(JSON.stringify({
    number: 4,
    reviews: [
      {
        id: "r-empty",
        state: "CHANGES_REQUESTED",
        body: "   ",
        author: { login: "dana" },
      },
    ],
  }));
  assert.equal(signals.length, 1);
  assert.equal(signals[0].priority, "high");
  assert.equal(signals[0].fingerprint, fingerprintKey("review:4:r-empty"));
});

test("parseGitHubSupervisorSignals fingerprints pin key material and fallbacks", () => {
  const payload = {
    number: 9,
    statusCheckRollup: [
      { name: "unit", conclusion: "FAILURE", completedAt: "2026-07-17" },
      { name: "gate", conclusion: "ACTION_REQUIRED" },
    ],
    comments: [
      { id: "c1", body: "/cursor please retry", author: { login: "alice" } },
      {
        url: "https://example.test/c-url",
        body: "[cursor] via url fallback",
        author: { login: "bob" },
      },
      {
        body: "[cursor] via body fallback",
        author: { login: "carol" },
      },
    ],
    reviews: [
      {
        id: "r1",
        state: "CHANGES_REQUESTED",
        body: "needs work",
        author: { login: "dana" },
      },
      {
        url: "https://example.test/r-url",
        state: "COMMENTED",
        body: "/cursor review url fallback",
        author: { login: "erin" },
      },
      {
        submittedAt: "2026-07-17T00:00:00Z",
        state: "COMMENTED",
        body: "/cursor review submittedAt fallback",
        author: { login: "frank" },
      },
      {
        state: "COMMENTED",
        body: "/cursor review body fallback",
        author: { login: "gina" },
      },
    ],
  };
  const signals = parseGitHubSupervisorSignals(JSON.stringify(payload));
  const again = parseGitHubSupervisorSignals(JSON.stringify(payload));
  assert.deepEqual(
    signals.map((signal) => signal.fingerprint),
    again.map((signal) => signal.fingerprint),
  );

  const expected = [
    fingerprintKey("ci:9:unit:FAILURE:2026-07-17"),
    fingerprintKey("ci:9:gate:ACTION_REQUIRED:"),
    fingerprintKey("comment:9:c1"),
    fingerprintKey("comment:9:https://example.test/c-url"),
    fingerprintKey("comment:9:[cursor] via body fallback"),
    fingerprintKey("review:9:r1"),
    fingerprintKey("review:9:https://example.test/r-url"),
    fingerprintKey("review:9:2026-07-17T00:00:00Z"),
    fingerprintKey("review:9:/cursor review body fallback"),
  ];
  assert.deepEqual(
    signals.map((signal) => signal.fingerprint),
    expected,
  );
  assert.equal(new Set(expected).size, expected.length);
  assert.equal(signals[0].fingerprint.length, 64);
});

async function withGhShim(scriptSource, run, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "cursor-gh-triggers-"));
  const probe = path.join(root, "gh-shim.mjs");
  // Top-level await so shims may use dynamic import for fs probes.
  await writeFile(probe, scriptSource);
  if (process.platform === "win32") {
    await writeFile(
      path.join(root, "gh.cmd"),
      `@echo off\r\n@"${process.execPath}" "${probe}" %*\r\n`,
    );
  } else {
    const shim = path.join(root, "gh");
    await writeFile(
      shim,
      `#!/bin/sh\nexec "${process.execPath}" "${probe}" "$@"\n`,
    );
    await chmod(shim, 0o755);
  }

  const previousPath = process.env.PATH;
  const previousPathWin = process.env.Path;
  const nextPath = `${root}${path.delimiter}${previousPath ?? previousPathWin ?? ""}`;
  process.env.PATH = nextPath;
  process.env.Path = nextPath;

  const previousExtra = new Map();
  for (const [key, value] of Object.entries(options.env ?? {})) {
    previousExtra.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    return await run(root);
  } finally {
    for (const [key, value] of previousExtra) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousPathWin === undefined) delete process.env.Path;
    else process.env.Path = previousPathWin;
    await rm(root, { recursive: true, force: true });
  }
}

test("scanCurrentGitHubPullRequest merges inline review comments on the happy path", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cursor-gh-scan-cwd-"));
  const argsProbe = path.join(cwd, "pr-view-args.json");
  try {
    await withGhShim(
      [
        prViewContractShimPrelude(argsProbe),
        "if (args[0] === 'pr' && args[1] === 'view') {",
        "  process.stdout.write(JSON.stringify({",
        "    number: 42,",
        "    title: 'Improve pipeline',",
        "    url: 'https://example.test/pr/42',",
        "    comments: [{ id: 'c1', body: '/cursor please add the missing test', author: { login: 'alice' } }],",
        "    reviews: [],",
        "    statusCheckRollup: [{ name: 'unit', conclusion: 'FAILURE', completedAt: '2026-07-17' }],",
        "  }));",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'api' && /\\/pulls\\/42\\/comments$/.test(args[1] ?? '')) {",
        "  process.stdout.write(JSON.stringify([{",
        "    id: 99,",
        "    body: 'needs a null check',",
        "    html_url: 'https://example.test/pr/42#discussion_r99',",
        "    path: 'src/a.ts',",
        "    line: 12,",
        "    user: { login: 'reviewer' },",
        "  }, {",
        "    body: '',",
        "    html_url: 'https://example.test/pr/42#discussion_r100',",
        "    path: 'src/b.ts',",
        "    line: 3,",
        "    user: { login: 'reviewer2' },",
        "  }]));",
        "  process.exit(0);",
        "}",
        "console.error('unexpected gh invocation: ' + joined);",
        "process.exit(2);",
      ].join("\n"),
      async () => {
        const signals = await scanCurrentGitHubPullRequest(cwd);
        const recordedArgs = JSON.parse(await readFile(argsProbe, "utf8"));
        assertPrViewJsonContract(recordedArgs);

        assert.equal(signals.some((signal) => signal.source === "ci"), true);
        assert.equal(
          signals.some((signal) => /missing test/.test(signal.detail)),
          true,
        );
        const inline = signals.find((signal) => /null check/.test(signal.detail));
        assert.ok(inline);
        assert.match(inline.detail, /src\/a\.ts:12/);
        assert.match(inline.detail, /\[cursor\] Inline review comment/);
        // Inline merge: id → fingerprint identity via String(comment.id ?? html_url).
        assert.equal(inline.fingerprint, fingerprintKey("comment:42:99"));

        const emptyBodyInline = signals.find((signal) =>
          /src\/b\.ts:3/.test(signal.detail)
        );
        assert.ok(emptyBodyInline, "empty inline body stays actionable via [cursor] prefix");
        assert.match(emptyBodyInline.detail, /\[cursor\] Inline review comment/);
        assert.equal(
          emptyBodyInline.fingerprint,
          fingerprintKey("comment:42:https://example.test/pr/42#discussion_r100"),
        );
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("scanCurrentGitHubPullRequest skips review-comments API failures gracefully", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cursor-gh-scan-skip-"));
  const argsProbe = path.join(cwd, "pr-view-args.json");
  try {
    await withGhShim(
      [
        prViewContractShimPrelude(argsProbe),
        "if (args[0] === 'pr' && args[1] === 'view') {",
        "  process.stdout.write(JSON.stringify({",
        "    number: 42,",
        "    title: 'Improve pipeline',",
        "    comments: [{ id: 'c1', body: '/cursor please add the missing test', author: { login: 'alice' } }],",
        "    reviews: [{ id: 'r1', state: 'CHANGES_REQUESTED', body: 'Handle the edge case', author: { login: 'carol' } }],",
        "    statusCheckRollup: [{ name: 'unit', conclusion: 'FAILURE', completedAt: '2026-07-17' }],",
        "  }));",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'api') {",
        "  process.stderr.write('HTTP 403: Resource not accessible by integration\\n');",
        "  process.exit(1);",
        "}",
        "process.exit(2);",
      ].join("\n"),
      async () => {
        const signals = await scanCurrentGitHubPullRequest(cwd);
        assertPrViewJsonContract(JSON.parse(await readFile(argsProbe, "utf8")));
        assert.deepEqual(
          signals.map((signal) => signal.source),
          ["ci", "pr-comment", "pr-comment"],
        );
        assert.match(signals[0].title, /unit/);
        assert.match(signals[1].detail, /missing test/);
        assert.match(signals[2].detail, /edge case/);
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("scanCurrentGitHubPullRequest skips invalid review-comments JSON gracefully", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cursor-gh-scan-bad-inline-"));
  try {
    await withGhShim(
      [
        "const args = process.argv.slice(2);",
        "if (args[0] === 'pr' && args[1] === 'view') {",
        "  process.stdout.write(JSON.stringify({",
        "    number: 8,",
        "    title: 'Parse skip',",
        "    comments: [{ id: 'c1', body: '/cursor keep going', author: { login: 'alice' } }],",
        "    reviews: [],",
        "    statusCheckRollup: [],",
        "  }));",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'api') {",
        "  process.stdout.write('{');",
        "  process.exit(0);",
        "}",
        "process.exit(2);",
      ].join("\n"),
      async () => {
        const signals = await scanCurrentGitHubPullRequest(cwd);
        assert.equal(signals.length, 1);
        assert.match(signals[0].detail, /keep going/);
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("scanCurrentGitHubPullRequest skips HTTP 200 non-array review-comments JSON", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cursor-gh-scan-obj-inline-"));
  try {
    await withGhShim(
      [
        "const args = process.argv.slice(2);",
        "if (args[0] === 'pr' && args[1] === 'view') {",
        "  process.stdout.write(JSON.stringify({",
        "    number: 11,",
        "    title: 'Object body',",
        "    comments: [{ id: 'c1', body: '/cursor keep pr comment', author: { login: 'alice' } }],",
        "    reviews: [],",
        "    statusCheckRollup: [{ name: 'unit', conclusion: 'FAILURE', completedAt: '2026-07-17' }],",
        "  }));",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'api') {",
        "  process.stdout.write(JSON.stringify({ message: 'Not Found' }));",
        "  process.exit(0);",
        "}",
        "process.exit(2);",
      ].join("\n"),
      async () => {
        const signals = await scanCurrentGitHubPullRequest(cwd);
        assert.deepEqual(
          signals.map((signal) => signal.source),
          ["ci", "pr-comment"],
        );
        assert.match(signals[1].detail, /keep pr comment/);
        assert.equal(
          signals.some((signal) => /Not Found/.test(signal.detail)),
          false,
        );
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("scanCurrentGitHubPullRequest skips inline api when snapshot.number is falsy", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cursor-gh-scan-no-number-"));
  try {
    await withGhShim(
      [
        "const args = process.argv.slice(2);",
        "if (args[0] === 'pr' && args[1] === 'view') {",
        "  process.stdout.write(JSON.stringify({",
        "    title: 'No number',",
        "    comments: [{ id: 'c1', body: '/cursor without number', author: { login: 'alice' } }],",
        "    reviews: [],",
        "    statusCheckRollup: [],",
        "  }));",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'api') {",
        "  console.error('inline api must not run without snapshot.number');",
        "  process.exit(2);",
        "}",
        "process.exit(2);",
      ].join("\n"),
      async () => {
        const signals = await scanCurrentGitHubPullRequest(cwd);
        assert.equal(signals.length, 1);
        assert.match(signals[0].detail, /^current PR/);
        assert.match(signals[0].detail, /without number/);
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("scanCurrentGitHubPullRequest forwards githubCliEnv auth to gh child", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cursor-gh-scan-env-"));
  const envProbe = path.join(cwd, "env-probe.json");
  try {
    await withGhShim(
      [
        "const args = process.argv.slice(2);",
        "const { writeFileSync } = await import('node:fs');",
        `writeFileSync(${JSON.stringify(envProbe)}, JSON.stringify({`,
        "  GH_TOKEN: process.env.GH_TOKEN ?? null,",
        "  CURSOR_TEST_UNRELATED_SECRET: process.env.CURSOR_TEST_UNRELATED_SECRET ?? null,",
        "}));",
        "if (args[0] === 'pr' && args[1] === 'view') {",
        "  process.stdout.write(JSON.stringify({",
        "    number: 1,",
        "    title: 'Env probe',",
        "    comments: [],",
        "    reviews: [],",
        "    statusCheckRollup: [],",
        "  }));",
        "  process.exit(0);",
        "}",
        "if (args[0] === 'api') {",
        "  process.stdout.write('[]');",
        "  process.exit(0);",
        "}",
        "process.exit(2);",
      ].join("\n"),
      async () => {
        const signals = await scanCurrentGitHubPullRequest(cwd);
        assert.deepEqual(signals, []);
        const seen = JSON.parse(await readFile(envProbe, "utf8"));
        assert.equal(seen.GH_TOKEN, "test-token-for-gh-env-probe");
        assert.equal(seen.CURSOR_TEST_UNRELATED_SECRET, null);
      },
      {
        env: {
          GH_TOKEN: "test-token-for-gh-env-probe",
          CURSOR_TEST_UNRELATED_SECRET: "do-not-forward",
        },
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("scanCurrentGitHubPullRequest surfaces pr view fetch failures", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cursor-gh-scan-fail-"));
  try {
    await withGhShim(
      [
        "process.stderr.write('gh: no pull requests found\\n');",
        "process.exit(1);",
      ].join("\n"),
      async () => {
        await assert.rejects(
          () => scanCurrentGitHubPullRequest(cwd),
          (error) => {
            assert.equal(error.code, 1);
            assert.match(String(error.message), /^Command failed:/);
            assert.match(String(error.stderr ?? ""), /no pull requests found/);
            return true;
          },
        );
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("scanCurrentGitHubPullRequest surfaces invalid pr view JSON", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cursor-gh-scan-bad-json-"));
  try {
    await withGhShim(
      [
        "const args = process.argv.slice(2);",
        "if (args[0] === 'pr' && args[1] === 'view') {",
        "  process.stdout.write('not-json');",
        "  process.exit(0);",
        "}",
        "process.exit(2);",
      ].join("\n"),
      async () => {
        await assert.rejects(
          () => scanCurrentGitHubPullRequest(cwd),
          SyntaxError,
        );
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
