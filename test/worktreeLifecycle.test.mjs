import assert from "node:assert/strict";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  cleanupOrphanedManagedWorktrees,
  createManagedWorktree,
  linkManagedNodeModules,
  runGit,
  withManagedWorktree,
  worktreeLeasePath,
} from "../out/worktreeLifecycle.js";

async function missing(file) {
  try {
    await access(file);
    return false;
  } catch {
    return true;
  }
}

test("managed worktrees clean up preparation failures and dead-process orphans", async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), "cursor-agent-worktree-test-"));
  const repository = path.join(temporary, "repository");
  const managedRoot = path.join(temporary, "managed-worktrees");
  const homeSegment = path.relative(homedir(), managedRoot);
  await mkdir(repository, { recursive: true });
  try {
    await runGit(repository, ["init"]);
    await runGit(repository, ["config", "user.email", "test@example.com"]);
    await runGit(repository, ["config", "user.name", "Worktree Test"]);
    await writeFile(path.join(repository, "tracked.txt"), "baseline\n", "utf8");
    await runGit(repository, ["add", "tracked.txt"]);
    await runGit(repository, ["commit", "-m", "baseline"]);

    const failedPath = path.join(managedRoot, "preparation-failure");
    await assert.rejects(
      withManagedWorktree(
        {
          id: "preparation-failure",
          root: repository,
          worktreesHomeSegment: homeSegment,
          worktreesRoot: managedRoot,
        },
        async () => {
          throw new Error("simulated baseline failure");
        },
      ),
      /simulated baseline failure/,
    );
    assert.equal(await missing(failedPath), true);
    assert.equal(await missing(worktreeLeasePath(failedPath)), true);
    assert.doesNotMatch(
      await runGit(repository, ["worktree", "list", "--porcelain"]),
      /preparation-failure/,
    );

    await mkdir(path.join(repository, "node_modules"), { recursive: true });
    await writeFile(path.join(repository, "node_modules", "marker.txt"), "linked\n", "utf8");
    const orphanPath = await createManagedWorktree({
      id: "orphaned-run",
      root: repository,
      worktreesHomeSegment: homeSegment,
      worktreesRoot: managedRoot,
    });
    await linkManagedNodeModules(repository, orphanPath);
    assert.equal((await lstat(path.join(orphanPath, "node_modules"))).isSymbolicLink(), true);
    assert.equal(
      await readFile(path.join(orphanPath, "node_modules", "marker.txt"), "utf8"),
      "linked\n",
    );
    assert.deepEqual(
      await cleanupOrphanedManagedWorktrees(repository, [homeSegment], undefined, {
        managedRoots: [managedRoot],
      }),
      [],
      "a live extension-host lease must protect another window's worktree",
    );

    await writeFile(
      worktreeLeasePath(orphanPath),
      JSON.stringify({ pid: 2_147_483_647, root: repository, createdAt: Date.now() }),
      "utf8",
    );
    const removed = await cleanupOrphanedManagedWorktrees(repository, [homeSegment], undefined, {
      managedRoots: [managedRoot],
      isProcessAlive: () => false,
    });
    assert.deepEqual(removed.map((item) => path.resolve(item)), [path.resolve(orphanPath)]);
    assert.equal(await missing(orphanPath), true);
    assert.equal(await missing(worktreeLeasePath(orphanPath)), true);
    assert.doesNotMatch(
      await runGit(repository, ["worktree", "list", "--porcelain"]),
      /orphaned-run/,
    );
  } finally {
    try {
      const worktrees = await runGit(repository, ["worktree", "list", "--porcelain"]);
      for (const line of worktrees.split(/\r?\n/)) {
        if (line.startsWith("worktree ") && line.includes("managed-worktrees")) {
          await runGit(repository, ["worktree", "remove", "--force", line.slice(9)]);
        }
      }
    } catch {
      // Repository setup may have failed before worktrees were registered.
    }
    await rm(temporary, { recursive: true, force: true });
  }
});
