import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, access } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { Uri } from "vscode";
import {
  applyIsolatedChanges,
  cleanupIsolatedWorktree,
  collectIsolatedChanges,
  prepareIsolatedWorktree,
} from "../out/isolatedWorktree.js";
import { runGit } from "../out/worktreeLifecycle.js";

async function isMissing(file) {
  try {
    await access(file);
    return false;
  } catch {
    return true;
  }
}

const temporary = await mkdtemp(path.join(tmpdir(), "cursor-isolated-worktree-test-"));
const repository = path.join(temporary, "repository");
const storage = path.join(temporary, "storage");
const managedRoot = path.join(temporary, "managed-worktrees");

try {
  await runGit(temporary, ["init", repository]);
  await runGit(repository, ["config", "user.email", "test@example.com"]);
  await runGit(repository, ["config", "user.name", "Isolated Worktree Test"]);
  await writeFile(path.join(repository, "tracked.txt"), "baseline\n", "utf8");
  await runGit(repository, ["add", "tracked.txt"]);
  await runGit(repository, ["commit", "-m", "baseline"]);

  // This dirty change must be captured as the main-workspace baseline, not overwritten on apply.
  await writeFile(path.join(repository, "tracked.txt"), "dirty baseline\n", "utf8");
  const session = await prepareIsolatedWorktree({
    id: "integration",
    root: repository,
    storageRoot: Uri.file(storage),
    worktreesHomeSegment: path.relative(homedir(), managedRoot),
    baselinesFolder: "baselines",
  });
  assert.equal(await readFile(path.join(session.worktreePath, "tracked.txt"), "utf8"), "dirty baseline\n");

  await writeFile(path.join(session.worktreePath, "tracked.txt"), "agent edit\n", "utf8");
  await writeFile(path.join(session.worktreePath, "added.txt"), "added\n", "utf8");
  const changes = await collectIsolatedChanges(session, Uri.file(storage));
  assert.deepEqual(changes.map((change) => [change.relative, change.kind]), [
    ["added.txt", "added"],
    ["tracked.txt", "modified"],
  ]);

  const applied = await applyIsolatedChanges(session, Uri.file(storage), changes);
  assert.deepEqual(applied, {
    applied: ["added.txt", "tracked.txt"],
    merged: [],
    conflicts: [],
  });
  assert.equal(await readFile(path.join(repository, "tracked.txt"), "utf8"), "agent edit\n");
  assert.equal(await readFile(path.join(repository, "added.txt"), "utf8"), "added\n");

  await cleanupIsolatedWorktree(session, Uri.file(storage));
  assert.equal(await isMissing(session.worktreePath), true);
  assert.equal(await isMissing(path.join(storage, "baselines", session.id)), true);
  assert.doesNotMatch(await runGit(repository, ["worktree", "list", "--porcelain"]), /integration/);
} finally {
  try {
    await runGit(repository, ["worktree", "prune"]);
  } catch {
    // Setup failures can occur before Git has initialized the repository.
  }
  await rm(temporary, { recursive: true, force: true });
}
