import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { listGhIssues, parseGhIssueListStdout } from "../out/githubIssues.js";

const ISSUE_LIST_JSON_FIELDS = ["number", "title", "body", "url"];

function assertIssueListArgvContract(args) {
  assert.deepEqual(args.slice(0, 3), ["issue", "list", "--limit"]);
  assert.equal(args[3], "20");
  const jsonFlagIndex = args.indexOf("--json");
  assert.ok(jsonFlagIndex >= 0, "gh issue list must pass --json");
  const fieldsArg = args[jsonFlagIndex + 1] ?? "";
  const fields = new Set(
    fieldsArg.split(",").map((field) => field.trim()).filter(Boolean),
  );
  for (const required of ISSUE_LIST_JSON_FIELDS) {
    assert.ok(
      fields.has(required),
      `gh issue list --json missing field: ${required} (got ${fieldsArg})`,
    );
  }
  assert.deepEqual(
    args,
    ["issue", "list", "--limit", "20", "--json", "number,title,body,url"],
  );
}

async function withGhShim(scriptSource, run, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "cursor-gh-issues-"));
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

test("parseGhIssueListStdout keeps valid issues and defaults body/url", () => {
  const issues = parseGhIssueListStdout(JSON.stringify([
    { number: 1, title: "First", body: "details", url: "https://example.test/1" },
    { number: 2, title: "Second" },
    { number: 0, title: "Zero number" },
    { number: -1, title: "Negative" },
    { number: 3, title: "" },
    { number: 4, title: "No body/url", body: null, url: 12 },
    null,
    "skip",
    { title: "Missing number" },
  ]));
  assert.deepEqual(issues, [
    {
      number: 1,
      title: "First",
      body: "details",
      url: "https://example.test/1",
    },
    {
      number: 2,
      title: "Second",
      body: "",
      url: "",
    },
    {
      number: 4,
      title: "No body/url",
      body: "",
      url: "",
    },
  ]);
});

test("parseGhIssueListStdout returns [] for non-array JSON", () => {
  assert.deepEqual(parseGhIssueListStdout("{}"), []);
  assert.deepEqual(parseGhIssueListStdout("null"), []);
  assert.deepEqual(parseGhIssueListStdout("\"issues\""), []);
});

test("parseGhIssueListStdout throws on invalid JSON", () => {
  assert.throws(() => parseGhIssueListStdout("not-json"), SyntaxError);
  assert.throws(() => parseGhIssueListStdout("{"), SyntaxError);
});

test("listGhIssues argv contract and happy path", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cursor-gh-issues-cwd-"));
  const argsProbe = path.join(cwd, "issue-list-args.json");
  try {
    await withGhShim(
      [
        "const args = process.argv.slice(2);",
        "const { writeFileSync } = await import('node:fs');",
        `writeFileSync(${JSON.stringify(argsProbe)}, JSON.stringify(args));`,
        "if (args[0] === 'issue' && args[1] === 'list') {",
        "  process.stdout.write(JSON.stringify([",
        "    { number: 7, title: 'Ship pipeline helpers', body: 'extract pure helpers', url: 'https://example.test/7' },",
        "    { number: 0, title: 'skip' },",
        "  ]));",
        "  process.exit(0);",
        "}",
        "console.error('unexpected gh invocation: ' + args.join(' '));",
        "process.exit(2);",
      ].join("\n"),
      async () => {
        const issues = await listGhIssues(cwd);
        assertIssueListArgvContract(JSON.parse(await readFile(argsProbe, "utf8")));
        assert.deepEqual(issues, [
          {
            number: 7,
            title: "Ship pipeline helpers",
            body: "extract pure helpers",
            url: "https://example.test/7",
          },
        ]);
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("listGhIssues returns [] for non-array stdout", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cursor-gh-issues-nonarray-"));
  try {
    await withGhShim(
      [
        "const args = process.argv.slice(2);",
        "if (args[0] === 'issue' && args[1] === 'list') {",
        "  process.stdout.write(JSON.stringify({ message: 'Not Found' }));",
        "  process.exit(0);",
        "}",
        "process.exit(2);",
      ].join("\n"),
      async () => {
        assert.deepEqual(await listGhIssues(cwd), []);
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("listGhIssues returns [] when gh throws", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cursor-gh-issues-fail-"));
  try {
    await withGhShim(
      [
        "process.stderr.write('gh: not authenticated\\n');",
        "process.exit(1);",
      ].join("\n"),
      async () => {
        assert.deepEqual(await listGhIssues(cwd), []);
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("listGhIssues forwards GH_TOKEN via githubCliEnv", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "cursor-gh-issues-env-"));
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
        "if (args[0] === 'issue' && args[1] === 'list') {",
        "  process.stdout.write('[]');",
        "  process.exit(0);",
        "}",
        "process.exit(2);",
      ].join("\n"),
      async () => {
        assert.deepEqual(await listGhIssues(cwd), []);
        const seen = JSON.parse(await readFile(envProbe, "utf8"));
        assert.equal(seen.GH_TOKEN, "test-token-for-gh-issue-env-probe");
        assert.equal(seen.CURSOR_TEST_UNRELATED_SECRET, null);
      },
      {
        env: {
          GH_TOKEN: "test-token-for-gh-issue-env-probe",
          CURSOR_TEST_UNRELATED_SECRET: "do-not-forward",
        },
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
