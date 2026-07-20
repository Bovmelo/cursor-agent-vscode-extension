/**
 * PATH-shim integration tests for gitWorkflow.
 *
 * Uses a vscode module loader mock for trust/config, system `git` against a
 * local bare remote, and Windows-compatible `gh.cmd` / `git.cmd` shims so no
 * real GitHub credentials are required.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

register(new URL("./gitWorkflow.vscode-loader.mjs", import.meta.url), import.meta.url);

const [
  {
    createBranchCommitAndPullRequest,
    retryPullRequestCreation,
    PullRequestCreationError,
  },
  { workspace, resetGitWorkflowVscodeMock },
] = await Promise.all([
  import("../out/gitWorkflow.js"),
  import("./gitWorkflow.vscode-mock.mjs"),
]);

async function runGit(cwd, args) {
  const { stdout, stderr } = await execFileAsync("git", args, {
    cwd,
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return { stdout, stderr };
}

/**
 * Prepend a temp directory with platform shims (`name` / `name.cmd`) that
 * exec Node scripts. Restores PATH afterward.
 *
 * @param {Record<string, string>} shims map of executable name → JS source
 * @param {(shimRoot: string) => Promise<T>} run
 * @returns {Promise<T>}
 * @template T
 */
async function withPathShims(shims, run) {
  const root = await mkdtemp(path.join(tmpdir(), "cursor-git-workflow-shim-"));
  for (const [name, scriptSource] of Object.entries(shims)) {
    const probe = path.join(root, `${name}-shim.mjs`);
    await writeFile(probe, scriptSource);
    if (process.platform === "win32") {
      await writeFile(
        path.join(root, `${name}.cmd`),
        `@echo off\r\n@"${process.execPath}" "${probe}" %*\r\n`,
      );
    } else {
      const shim = path.join(root, name);
      await writeFile(
        shim,
        `#!/bin/sh\nexec "${process.execPath}" "${probe}" "$@"\n`,
      );
      await chmod(shim, 0o755);
    }
  }

  const previousPath = process.env.PATH;
  const previousPathWin = process.env.Path;
  const nextPath = `${root}${path.delimiter}${previousPath ?? previousPathWin ?? ""}`;
  process.env.PATH = nextPath;
  process.env.Path = nextPath;

  try {
    return await run(root);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousPathWin === undefined) delete process.env.Path;
    else process.env.Path = previousPathWin;
    await rm(root, { recursive: true, force: true });
  }
}

async function withGhShim(scriptSource, run) {
  return withPathShims({ gh: scriptSource }, run);
}

/**
 * Temp clone + bare origin remote. HEAD is on `main` and matches origin/main.
 * Leaves one uncommitted change so createBranchCommitAndPullRequest can commit.
 */
async function withTempGitRepo(run) {
  const root = await mkdtemp(path.join(tmpdir(), "cursor-git-workflow-repo-"));
  const remote = path.join(root, "remote.git");
  const work = path.join(root, "work");
  try {
    await runGit(root, ["init", "--bare", "-b", "main", remote]);
    await runGit(root, ["clone", remote, work]);
    await runGit(work, ["config", "user.email", "git-workflow-test@example.com"]);
    await runGit(work, ["config", "user.name", "Git Workflow Test"]);
    await writeFile(path.join(work, "README.md"), "baseline\n", "utf8");
    await runGit(work, ["add", "README.md"]);
    await runGit(work, ["commit", "-m", "baseline"]);
    await runGit(work, ["push", "-u", "origin", "HEAD"]);
    await writeFile(path.join(work, "change.txt"), "pending change\n", "utf8");
    return await run(work);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("untrusted workspace throws trust error before git", async () => {
  resetGitWorkflowVscodeMock({ isTrusted: false });
  const gitProbe = path.join(
    await mkdtemp(path.join(tmpdir(), "cursor-git-workflow-probe-")),
    "git-invoked.json",
  );
  try {
    await withPathShims(
      {
        git: [
          "const { writeFileSync } = await import('node:fs');",
          `writeFileSync(${JSON.stringify(gitProbe)}, JSON.stringify(process.argv.slice(2)));`,
          "console.error('git must not run before the trust gate');",
          "process.exit(99);",
        ].join("\n"),
      },
      async () => {
        await assert.rejects(
          () => createBranchCommitAndPullRequest({
            root: path.join(tmpdir(), "unused-untrusted-root"),
            title: "Should not reach git",
          }),
          (error) => {
            assert.ok(error instanceof Error);
            assert.match(error.message, /trusted workspace/i);
            return true;
          },
        );
      },
    );
    await assert.rejects(
      () => readFile(gitProbe, "utf8"),
      (error) => error && error.code === "ENOENT",
    );
  } finally {
    await rm(path.dirname(gitProbe), { recursive: true, force: true });
    resetGitWorkflowVscodeMock();
  }
});

test("happy path PR create with gh shim returning URL", async () => {
  resetGitWorkflowVscodeMock({ isTrusted: true });
  const argsProbeRoot = await mkdtemp(path.join(tmpdir(), "cursor-git-workflow-args-"));
  const argsProbe = path.join(argsProbeRoot, "pr-create-args.json");
  try {
    await withTempGitRepo(async (work) => {
      await withGhShim(
        [
          "const args = process.argv.slice(2);",
          "const { writeFileSync } = await import('node:fs');",
          `writeFileSync(${JSON.stringify(argsProbe)}, JSON.stringify(args));`,
          "if (args[0] === 'pr' && args[1] === 'create') {",
          "  process.stdout.write('https://github.com/example/repo/pull/99\\n');",
          "  process.exit(0);",
          "}",
          "console.error('unexpected gh invocation: ' + args.join(' '));",
          "process.exit(2);",
        ].join("\n"),
        async () => {
          const result = await createBranchCommitAndPullRequest({
            root: work,
            title: "Ship PATH shim PR",
            body: "integration body",
          });
          assert.match(result.branch, /^cursor\/\d{8}-ship-path-shim-pr-[0-9a-f]{6}$/);
          assert.equal(result.url, "https://github.com/example/repo/pull/99");

          const args = JSON.parse(await readFile(argsProbe, "utf8"));
          assert.equal(args[0], "pr");
          assert.equal(args[1], "create");
          assert.ok(args.includes("--title"));
          assert.ok(args.includes("--body-file"));
          assert.ok(args.includes("--base"));
          assert.ok(args.includes("main"));
          assert.ok(args.includes("--head"));
          assert.ok(args.includes(result.branch));

          const { stdout: remoteBranch } = await runGit(work, [
            "ls-remote",
            "--heads",
            "origin",
            result.branch,
          ]);
          assert.match(remoteBranch, new RegExp(result.branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        },
      );
    });
  } finally {
    await rm(argsProbeRoot, { recursive: true, force: true });
    resetGitWorkflowVscodeMock();
  }
});

test("PullRequestCreationError when gh fails after push", async () => {
  resetGitWorkflowVscodeMock({ isTrusted: true });
  try {
    await withTempGitRepo(async (work) => {
      await withGhShim(
        [
          "const args = process.argv.slice(2);",
          "if (args[0] === 'pr' && args[1] === 'create') {",
          "  process.stderr.write('gh: simulated auth failure\\n');",
          "  process.exit(1);",
          "}",
          "process.exit(2);",
        ].join("\n"),
        async () => {
          await assert.rejects(
            () => createBranchCommitAndPullRequest({
              root: work,
              title: "Fail after push",
            }),
            (error) => {
              assert.ok(error instanceof PullRequestCreationError);
              assert.equal(error.recovery.failureStage, "create-pull-request");
              assert.equal(error.recovery.pushStatus, "confirmed");
              assert.match(error.recovery.branch, /^cursor\//);
              assert.match(error.recovery.commit, /^[0-9a-f]{40}$/);
              assert.equal(error.recovery.originalBranch, "main");
              assert.match(error.message, /simulated auth failure|exit code 1|Command failed/i);
              assert.match(error.message, /preserved/i);
              return true;
            },
          );
        },
      );
    });
  } finally {
    resetGitWorkflowVscodeMock();
  }
});

test("retryPullRequestCreation success with gh shim", async () => {
  resetGitWorkflowVscodeMock({ isTrusted: true });
  try {
    await withTempGitRepo(async (work) => {
      let recovery;
      await withGhShim(
        [
          "process.stderr.write('gh: first attempt fails\\n');",
          "process.exit(1);",
        ].join("\n"),
        async () => {
          await assert.rejects(
            () => createBranchCommitAndPullRequest({
              root: work,
              title: "Retry after gh failure",
              body: "retry body",
            }),
            (error) => {
              assert.ok(error instanceof PullRequestCreationError);
              recovery = error.recovery;
              assert.equal(recovery.failureStage, "create-pull-request");
              assert.equal(recovery.pushStatus, "confirmed");
              return true;
            },
          );
        },
      );

      assert.ok(recovery);

      await withGhShim(
        [
          "const args = process.argv.slice(2);",
          "if (args[0] === 'pr' && args[1] === 'create') {",
          "  process.stdout.write('https://github.com/example/repo/pull/100\\n');",
          "  process.exit(0);",
          "}",
          "console.error('unexpected gh invocation: ' + args.join(' '));",
          "process.exit(2);",
        ].join("\n"),
        async () => {
          const result = await retryPullRequestCreation({
            root: work,
            title: "Retry after gh failure",
            body: "retry body",
            recovery,
          });
          assert.equal(result.branch, recovery.branch);
          assert.equal(result.url, "https://github.com/example/repo/pull/100");
        },
      );
    });
  } finally {
    resetGitWorkflowVscodeMock();
  }
});
