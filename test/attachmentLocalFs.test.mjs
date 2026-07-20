import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readStableLocalFile,
  removeStableLocalDirectory,
  writeStableLocalFile,
} from "../out/attachmentLocalFs.js";

test("stable attachment reads reject a path replacement after its handle opens", async () => {
  await withTempRoot(async (tempRoot) => {
    const allowedRoot = path.join(tempRoot, "allowed");
    const source = path.join(allowedRoot, "source.txt");
    const displaced = path.join(allowedRoot, "source-original.txt");
    await mkdir(allowedRoot);
    await writeFile(source, "trusted");

    await assert.rejects(
      readStableLocalFile(allowedRoot, source, 100, {
        afterOpen: async () => {
          await rename(source, displaced);
          await writeFile(source, "replacement");
        },
      }),
      /changed/u,
    );
    assert.equal(await readFile(displaced, "utf8"), "trusted");
    assert.equal(await readFile(source, "utf8"), "replacement");
  });
});

test("stable attachment reads reject in-place changes during validation", async () => {
  await withTempRoot(async (tempRoot) => {
    const allowedRoot = path.join(tempRoot, "allowed");
    const source = path.join(allowedRoot, "source.txt");
    await mkdir(allowedRoot);
    await writeFile(source, "trusted");

    await assert.rejects(
      readStableLocalFile(allowedRoot, source, 100, {
        afterOpen: async () => writeFile(source, "modified-content"),
      }),
      /changed/u,
    );
  });
});

test("stable managed deletion refuses a directory replacement immediately before remove", async () => {
  await withTempRoot(async (tempRoot) => {
    const managedParent = path.join(tempRoot, "attachments");
    const candidate = path.join(managedParent, "conversation");
    const displaced = path.join(managedParent, "conversation-original");
    await mkdir(candidate, { recursive: true });
    await writeFile(path.join(candidate, "original.txt"), "original");

    const removed = await removeStableLocalDirectory(
      managedParent,
      candidate,
      undefined,
      undefined,
      {
        beforeRemove: async () => {
          await rename(candidate, displaced);
          await mkdir(candidate);
          await writeFile(path.join(candidate, "replacement.txt"), "replacement");
        },
      },
    );

    assert.equal(removed, false);
    assert.equal(await readFile(path.join(displaced, "original.txt"), "utf8"), "original");
    assert.equal(await readFile(path.join(candidate, "replacement.txt"), "utf8"), "replacement");
  });
});

test("stable local writes and recursive deletion do not follow managed links", async () => {
  await withTempRoot(async (tempRoot) => {
    const managedParent = path.join(tempRoot, "attachments");
    const candidate = path.join(managedParent, "conversation");
    const outside = path.join(tempRoot, "outside");
    await Promise.all([mkdir(candidate, { recursive: true }), mkdir(outside)]);
    const outsideFile = path.join(outside, "outside.txt");
    await writeFile(outsideFile, "outside");

    const targetLink = path.join(candidate, "target.txt");
    let linked = false;
    try {
      await symlink(outsideFile, targetLink, "file");
      linked = true;
    } catch {
      // Some Windows environments do not grant file-symlink privileges.
    }
    if (linked) {
      assert.equal(await writeStableLocalFile(candidate, targetLink, Buffer.from("changed")), false);
      assert.equal(await readFile(outsideFile, "utf8"), "outside");
    }

    const directoryLink = path.join(candidate, "outside-link");
    try {
      await symlink(outside, directoryLink, process.platform === "win32" ? "junction" : "dir");
    } catch {
      // The identity and replacement tests above remain deterministic.
    }
    assert.equal(await removeStableLocalDirectory(managedParent, candidate), true);
    assert.equal(await readFile(outsideFile, "utf8"), "outside");
  });
});

async function withTempRoot(callback) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cursor-attachment-race-"));
  try {
    await callback(tempRoot);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}
