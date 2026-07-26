import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCommandLine,
  quoteForCmd,
  runConfiguredCommand,
  runExecutableCommand,
  toExecFileInvocation,
} from "../out/shellCommand.js";
import { githubCliEnv, minimalShellEnv } from "../out/shellEnv.js";
import { isPathInside, resolveCanonicalPath, safeResolvePathResolved } from "../out/safety.js";
import { mkdtemp, mkdir, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

test("parseCommandLine tokenizes quotes and rejects shell metacharacters", () => {
  assert.deepEqual(parseCommandLine("npm test"), {
    file: process.platform === "win32" ? "npm.cmd" : "npm",
    args: ["test"],
  });
  assert.deepEqual(parseCommandLine('node "./scripts/run.js" --flag'), {
    file: "node",
    args: ["./scripts/run.js", "--flag"],
  });
  assert.throws(() => parseCommandLine("npm test && rm -rf /"), /shell metacharacters/i);
  assert.throws(() => parseCommandLine("echo $(whoami)"), /shell metacharacters/i);
  assert.throws(() => parseCommandLine("cat file | grep x"), /shell metacharacters/i);
  assert.throws(() => parseCommandLine("echo 'unterminated"), /unmatched quote/i);
});

test("toExecFileInvocation routes Windows batch files through cmd.exe", () => {
  assert.equal(quoteForCmd("plain"), '^"plain^"');
  assert.equal(quoteForCmd("has space"), '^"has^ space^"');
  assert.doesNotMatch(quoteForCmd('say "hi" & done'), /(^|[^\^])["&]/);

  const npm = parseCommandLine("npm run validate");
  const invocation = toExecFileInvocation(npm);
  if (process.platform === "win32") {
    assert.equal(invocation.file.toLowerCase().endsWith("cmd.exe"), true);
    assert.deepEqual(invocation.args.slice(0, 4), ["/d", "/s", "/v:off", "/c"]);
    assert.match(invocation.args[4], /npm/);
    assert.equal(invocation.windowsVerbatimArguments, true);
  } else {
    assert.deepEqual(invocation, npm);
  }

  const node = parseCommandLine("node ./scripts/run.js");
  assert.deepEqual(toExecFileInvocation(node), node);
});

test("toExecFileInvocation treats a bare gh command as a Windows shim", () => {
  const invocation = toExecFileInvocation({
    file: "gh",
    args: ["pr", "create", "--title", "fix & verify"],
  }, "win32");
  assert.equal(invocation.file.toLowerCase().endsWith("cmd.exe"), true);
  assert.deepEqual(invocation.args.slice(0, 4), ["/d", "/s", "/v:off", "/c"]);
  assert.equal(invocation.windowsVerbatimArguments, true);
  assert.match(invocation.args[4], /^"gh /);
  assert.doesNotMatch(invocation.args[4], /[^\^]&/);
  assert.throws(
    () => toExecFileInvocation({ file: "gh", args: ["line 1\nline 2"] }, "win32"),
    /line breaks/i,
  );
});

test("runExecutableCommand preserves arguments passed to a gh.cmd shim", async () => {
  if (process.platform !== "win32") {
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "cursor-gh-shim-"));
  try {
    const probe = path.join(root, "probe.mjs");
    await writeFile(probe, "console.log(JSON.stringify(process.argv.slice(2)));\n");
    await writeFile(
      path.join(root, "gh.cmd"),
      `@echo off\r\n@"${process.execPath}" "${probe}" %*\r\n`,
    );
    const env = minimalShellEnv();
    delete env.Path;
    env.PATH = root;
    const { stdout } = await runExecutableCommand(
      "gh",
      ["hello world", "fix & verify", 'say "hi"', "%PATH% !bang!"],
      {
        cwd: root,
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        env,
      },
    );
    assert.deepEqual(JSON.parse(stdout), [
      "hello world",
      "fix & verify",
      'say "hi"',
      "%PATH% !bang!",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runConfiguredCommand can spawn a platform command without EINVAL", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cursor-command-"));
  try {
    const script = path.join(root, process.platform === "win32" ? "probe.cmd" : "probe.mjs");
    await writeFile(
      script,
      process.platform === "win32" ? "@echo 1.2.3\r\n" : "console.log('1.2.3');\n",
    );
    const command = process.platform === "win32"
      ? `"${script}"`
      : `"${process.execPath}" "${script}"`;
    const { stdout } = await runConfiguredCommand(command, {
      cwd: root,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(stdout.trim(), "1.2.3");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runExecutableCommand stops an active child when its signal aborts", async () => {
  const controller = new AbortController();
  const command = runExecutableCommand(
    process.execPath,
    ["-e", "setInterval(() => {}, 1_000)"],
    {
      cwd: tmpdir(),
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      signal: controller.signal,
    },
  );
  setTimeout(() => controller.abort(), 50);

  await assert.rejects(
    () => command,
    (error) => {
      assert.equal(error?.name, "AbortError");
      return true;
    },
  );
});

test("runConfiguredCommand forwards a pre-aborted signal", async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => runConfiguredCommand(`"${process.execPath}" --version`, {
      cwd: tmpdir(),
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      signal: controller.signal,
    }),
    (error) => {
      assert.equal(error?.name, "AbortError");
      return true;
    },
  );
});

test("GitHub CLI environment forwards auth without unrelated secrets", () => {
  const previousToken = process.env.GH_TOKEN;
  const previousUnrelated = process.env.CURSOR_TEST_UNRELATED_SECRET;
  try {
    process.env.GH_TOKEN = "test-token";
    process.env.CURSOR_TEST_UNRELATED_SECRET = "do-not-forward";
    const env = githubCliEnv();
    assert.equal(env.GH_TOKEN, "test-token");
    assert.equal(env.CURSOR_TEST_UNRELATED_SECRET, undefined);
  } finally {
    if (previousToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousToken;
    if (previousUnrelated === undefined) delete process.env.CURSOR_TEST_UNRELATED_SECRET;
    else process.env.CURSOR_TEST_UNRELATED_SECRET = previousUnrelated;
  }
});

test("minimalShellEnv forwards only an allowlisted subset", () => {
  const env = minimalShellEnv();
  assert.ok(env.PATH || env.Path);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.GITHUB_TOKEN, undefined);
  assert.equal(env.CURSOR_API_KEY, undefined);
});

test("safeResolvePathResolved rejects symlink escapes outside root", async () => {
  if (process.platform === "win32") {
    // Symlink creation may require elevation on Windows CI; skip when unavailable.
    const root = await mkdtemp(path.join(tmpdir(), "cursor-safe-root-"));
    const outside = await mkdtemp(path.join(tmpdir(), "cursor-safe-out-"));
    try {
      await writeFile(path.join(outside, "secret.txt"), "secret");
      try {
        await symlink(outside, path.join(root, "link"), "junction");
      } catch {
        return;
      }
      await assert.rejects(
        () => safeResolvePathResolved(root, "link/secret.txt"),
        /Path escapes/,
      );
      assert.equal(
        isPathInside(root, path.join(root, "link", "secret.txt")),
        true,
      );
      const canonical = await resolveCanonicalPath(path.join(root, "link", "secret.txt"));
      assert.equal(isPathInside(root, canonical), false);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
    return;
  }

  const root = await mkdtemp(path.join(tmpdir(), "cursor-safe-root-"));
  const outside = await mkdtemp(path.join(tmpdir(), "cursor-safe-out-"));
  try {
    await writeFile(path.join(outside, "secret.txt"), "secret");
    await mkdir(path.join(root, "nested"), { recursive: true });
    await symlink(outside, path.join(root, "nested", "link"), "dir");
    await assert.rejects(
      () => safeResolvePathResolved(root, "nested/link/secret.txt"),
      /Path escapes/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
