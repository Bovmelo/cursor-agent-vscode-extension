import assert from "node:assert/strict";
import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
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
const hardlinkVictim = path.join(temporary, "hardlink-victim.txt");

try {
  await runGit(temporary, ["init", repository]);
  await runGit(repository, ["config", "user.email", "test@example.com"]);
  await runGit(repository, ["config", "user.name", "Isolated Worktree Test"]);
  await mkdir(path.join(repository, "nested"));
  await writeFile(path.join(repository, "tracked.txt"), "baseline\n", "utf8");
  await writeFile(path.join(repository, "delete-me.txt"), "delete baseline\n", "utf8");
  await writeFile(path.join(repository, "nested", "victim.txt"), "victim baseline\n", "utf8");
  await writeFile(hardlinkVictim, "hardlink baseline\n", "utf8");
  await link(hardlinkVictim, path.join(repository, "hardlinked.txt"));
  await runGit(repository, [
    "add",
    "tracked.txt",
    "delete-me.txt",
    "hardlinked.txt",
    "nested/victim.txt",
  ]);
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
  await writeFile(path.join(session.worktreePath, "executable.sh"), "#!/bin/sh\necho ok\n", "utf8");
  if (process.platform !== "win32") {
    await chmod(path.join(session.worktreePath, "executable.sh"), 0o755);
  }
  await unlink(path.join(session.worktreePath, "delete-me.txt"));
  const changes = await collectIsolatedChanges(session, Uri.file(storage));
  assert.deepEqual(changes.map((change) => [change.relative, change.kind]), [
    ["added.txt", "added"],
    ["delete-me.txt", "deleted"],
    ["executable.sh", "added"],
    ["tracked.txt", "modified"],
  ]);

  const applied = await applyIsolatedChanges(session, Uri.file(storage), changes);
  assert.deepEqual(applied, {
    applied: ["added.txt", "delete-me.txt", "executable.sh", "tracked.txt"],
    merged: [],
    conflicts: [],
  });
  assert.equal(await readFile(path.join(repository, "tracked.txt"), "utf8"), "agent edit\n");
  assert.equal(await readFile(path.join(repository, "added.txt"), "utf8"), "added\n");
  assert.equal(await isMissing(path.join(repository, "delete-me.txt")), true);
  if (process.platform !== "win32") {
    assert.notEqual((await stat(path.join(repository, "executable.sh"))).mode & 0o111, 0);
  }

  await writeFile(path.join(session.worktreePath, "hardlinked.txt"), "agent payload\n", "utf8");
  const hardlinkRejected = await applyIsolatedChanges(
    session,
    Uri.file(storage),
    [{ relative: "hardlinked.txt" }],
  );
  assert.deepEqual(hardlinkRejected.applied, []);
  assert.equal(hardlinkRejected.conflicts.length, 1);
  assert.equal(await readFile(hardlinkVictim, "utf8"), "hardlink baseline\n");

  // A main-workspace parent redirected outside the root must be rejected at
  // mutation time and must never touch the external target.
  const outside = path.join(temporary, "outside");
  const displaced = path.join(repository, "nested-before-swap");
  const mainParent = path.join(repository, "nested");
  const proposedVictim = path.join(session.worktreePath, "nested", "victim.txt");
  const outsideVictim = path.join(outside, "victim.txt");
  await mkdir(outside);
  await writeFile(outsideVictim, "outside original\n", "utf8");
  await writeFile(proposedVictim, "agent attack payload\n", "utf8");

  let swapped = false;
  try {
    await rename(mainParent, displaced);
    await symlink(outside, mainParent, process.platform === "win32" ? "junction" : "dir");
    swapped = true;
    const rejected = await applyIsolatedChanges(
      session,
      Uri.file(storage),
      [{ relative: "nested/victim.txt" }],
    );
    assert.equal(swapped, true);
    assert.deepEqual(rejected.applied, []);
    assert.deepEqual(rejected.merged, []);
    assert.equal(rejected.conflicts.length, 1);
    assert.equal(rejected.conflicts[0].relative, "nested/victim.txt");
    assert.match(rejected.conflicts[0].error, /Path escapes|changed while it was being validated/);
    assert.equal(await readFile(outsideVictim, "utf8"), "outside original\n");
  } finally {
    if (swapped) {
      await unlink(mainParent);
      await rename(displaced, mainParent);
    }
  }

  // A proposal path redirected outside its isolated worktree must never be read
  // and copied back into the main workspace.
  const outsideSource = path.join(outside, "source");
  await mkdir(outsideSource);
  await writeFile(path.join(outsideSource, "payload.txt"), "outside secret\n", "utf8");
  await symlink(
    outsideSource,
    path.join(session.worktreePath, "source-parent"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const sourceRejected = await applyIsolatedChanges(
    session,
    Uri.file(storage),
    [{ relative: "source-parent/payload.txt" }],
  );
  assert.deepEqual(sourceRejected.applied, []);
  assert.equal(sourceRejected.conflicts.length, 1);
  assert.match(sourceRejected.conflicts[0].error, /Path escapes|changed while it was being validated/);
  assert.equal(await isMissing(path.join(repository, "source-parent", "payload.txt")), true);

  const failedCleanupSession = {
    ...session,
    id: "cleanup-failure",
    worktreePath: path.join(temporary, "missing-worktree-parent", "worktree"),
  };
  const retainedBaseline = path.join(
    storage,
    failedCleanupSession.baselinesFolder,
    failedCleanupSession.id,
    "baseline.txt",
  );
  await mkdir(path.dirname(retainedBaseline), { recursive: true });
  await writeFile(retainedBaseline, "retain after failed cleanup\n", "utf8");
  assert.equal(
    await cleanupIsolatedWorktree(failedCleanupSession, Uri.file(storage)),
    false,
  );
  assert.equal(await readFile(retainedBaseline, "utf8"), "retain after failed cleanup\n");

  assert.equal(await cleanupIsolatedWorktree(session, Uri.file(storage)), true);
  assert.equal(await isMissing(session.worktreePath), true);
  assert.equal(await isMissing(path.join(storage, "baselines", session.id)), true);
  assert.equal(await readFile(outsideVictim, "utf8"), "outside original\n");
  assert.equal(
    await readFile(path.join(outsideSource, "payload.txt"), "utf8"),
    "outside secret\n",
  );
  assert.doesNotMatch(await runGit(repository, ["worktree", "list", "--porcelain"]), /integration/);
} finally {
  try {
    await runGit(repository, ["worktree", "prune"]);
  } catch {
    // Setup failures can occur before Git has initialized the repository.
  }
  await rm(temporary, { recursive: true, force: true });
}
