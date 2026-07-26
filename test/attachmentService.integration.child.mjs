import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttachmentService } from "../out/attachmentService.js";
import { Uri, workspace } from "vscode";

const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cursor-attachment-service-"));
try {
  const globalStorage = path.join(tempRoot, "global");
  const workspaceRoot = path.join(tempRoot, "workspace");
  const externalRoot = path.join(tempRoot, "external");
  await Promise.all([mkdir(globalStorage), mkdir(workspaceRoot), mkdir(externalRoot)]);
  const context = { globalStorageUri: Uri.file(globalStorage) };
  let saves = 0;
  const service = new AttachmentService(context, false, async () => { saves += 1; });
  const workspaceFolder = { uri: Uri.file(workspaceRoot), name: "workspace", index: 0 };
  workspace.workspaceFolders = [workspaceFolder];

  const external = path.join(externalRoot, "report.txt");
  const executable = path.join(externalRoot, "run.cmd");
  await writeFile(external, "safe payload");
  await writeFile(executable, "echo unsafe");
  const conversation = conversationRecord("conversation-1");
  const references = await service.stageExternalAttachments(
    [external, executable],
    workspaceFolder,
    conversation,
  );
  assert.equal(references.length, 1);
  assert.equal(references[0].external, true);
  assert.match(references[0].agentPath, /-report\.txt$/u);
  assert.equal(await readFile(references[0].agentPath, "utf8"), "safe payload");
  assert.equal(conversation.attachmentRoot, path.join(globalStorage, "attachments", "conversation-1"));
  assert.equal(saves, 1);

  await assertWorkspaceImageBoundary(service, workspaceFolder, workspaceRoot, externalRoot);
  await assertExternalSymlinkRejected(service, workspaceFolder, externalRoot);

  const parsed = service.parseDroppedFileUploads([
    { name: "safe.txt", data: Uint8Array.of(1) },
    { name: "unsafe.ps1", data: Uint8Array.of(2) },
  ]);
  assert.deepEqual(parsed.map((upload) => upload.name), ["safe.txt"]);
  assert.equal(await service.stageDroppedFileUpload({
    name: "launch.lnk",
    data: Uint8Array.of(1),
  }), undefined);
  const directDropped = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    service.stageDroppedFileUpload({ name: `drop-${index}.txt`, data: Uint8Array.of(index) })));
  assert.equal(directDropped.every(Boolean), true);
  assert.equal(await service.stageDroppedFileUpload({
    name: "drop-over-limit.txt",
    data: Uint8Array.of(21),
  }), undefined);

  await assertExternalBatchLimits(context, workspaceFolder, externalRoot, globalStorage);
  await assertResolutionAbort(service, workspaceFolder, externalRoot);
  await assertImageLoadingAbort(service, workspaceFolder, externalRoot);
  await assertExternalStagingAbort(context, workspaceFolder, externalRoot, globalStorage);
  await assertAbortPreservesExistingAttachments(
    context,
    workspaceFolder,
    externalRoot,
    globalStorage,
  );
  await assertCleanupScope(service, globalStorage, tempRoot, conversation);
  await assertRecoveryRootValidation(service, globalStorage, tempRoot);
  await assertConversationDeletion(service, globalStorage, tempRoot);
  await service.dispose();
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}

async function assertExternalBatchLimits(context, workspaceFolder, externalRoot, globalStorage) {
  const service = new AttachmentService(context, false, async () => {}, {
    maxFiles: 20,
    maxFileBytes: 10,
    maxBatchBytes: 40,
  });
  const files = [];
  for (let index = 0; index < 6; index += 1) {
    const file = path.resolve(externalRoot, `virtual-${index}.bin`);
    await writeFile(file, Buffer.alloc(10, index));
    files.push(file);
  }
  const conversation = conversationRecord("batch-limit");
  const references = await service.stageExternalAttachments(files, workspaceFolder, conversation);
  assert.equal(references.length, 4, "only the configured aggregate byte limit is staged");
  assert.equal(conversation.attachmentRoot, path.join(globalStorage, "attachments", "batch-limit"));
}

async function assertResolutionAbort(service, workspaceFolder, externalRoot) {
  const first = path.resolve(externalRoot, "resolve-abort-first.txt");
  const second = path.resolve(externalRoot, "resolve-abort-second.txt");
  await Promise.all([writeFile(first, "first"), writeFile(second, "second")]);
  const controller = new AbortController();
  const originalUriFile = Uri.file;
  const originalStat = workspace.fs.stat;
  let firstStats = 0;
  let secondStats = 0;
  Uri.file = (candidate) => {
    const resolved = path.resolve(candidate);
    return resolved === first || resolved === second
      ? new Uri(candidate, "test-provider")
      : originalUriFile(candidate);
  };
  workspace.fs.stat = async (uri) => {
    const stat = await originalStat(uri);
    const resolved = path.resolve(uri.fsPath);
    if (resolved === first) {
      firstStats += 1;
      controller.abort();
    } else if (resolved === second) {
      secondStats += 1;
    }
    return stat;
  };
  try {
    assert.deepEqual(
      await service.resolveAttachedFiles(
        [first, second],
        workspaceFolder,
        controller.signal,
      ),
      [],
    );
  } finally {
    Uri.file = originalUriFile;
    workspace.fs.stat = originalStat;
  }
  assert.equal(firstStats, 1, "the in-flight stat completes before cancellation");
  assert.equal(secondStats, 0, "cancellation prevents the next file stat");
}

async function assertImageLoadingAbort(service, workspaceFolder, externalRoot) {
  const first = path.resolve(externalRoot, "image-abort-first.png");
  const second = path.resolve(externalRoot, "image-abort-second.png");
  await Promise.all([
    writeFile(first, Buffer.from([137, 80, 78, 71])),
    writeFile(second, Buffer.from([137, 80, 78, 71, 1])),
  ]);
  const controller = new AbortController();
  const originalUriFile = Uri.file;
  const originalReadFile = workspace.fs.readFile;
  const originalStat = workspace.fs.stat;
  let firstReads = 0;
  let firstStats = 0;
  let secondReads = 0;
  let secondStats = 0;
  Uri.file = (candidate) => {
    const resolved = path.resolve(candidate);
    return resolved === first || resolved === second
      ? new Uri(candidate, "test-provider")
      : originalUriFile(candidate);
  };
  workspace.fs.stat = async (uri) => {
    const stat = await originalStat(uri);
    const resolved = path.resolve(uri.fsPath);
    if (resolved === first) firstStats += 1;
    if (resolved === second) secondStats += 1;
    return stat;
  };
  workspace.fs.readFile = async (uri) => {
    const data = await originalReadFile(uri);
    const resolved = path.resolve(uri.fsPath);
    if (resolved === first) {
      firstReads += 1;
      controller.abort();
    } else if (resolved === second) {
      secondReads += 1;
    }
    return data;
  };
  try {
    assert.deepEqual(
      await service.loadAttachedImages(
        [first, second],
        workspaceFolder,
        controller.signal,
      ),
      [],
    );
  } finally {
    Uri.file = originalUriFile;
    workspace.fs.readFile = originalReadFile;
    workspace.fs.stat = originalStat;
  }
  assert.equal(firstReads, 1, "the in-flight image read completes before cancellation");
  assert.equal(firstStats, 1, "no post-read stability stat runs after cancellation");
  assert.equal(secondReads, 0, "cancellation prevents the next image read");
  assert.equal(secondStats, 0, "cancellation prevents the next image stat");
}

async function assertExternalStagingAbort(context, workspaceFolder, externalRoot, globalStorage) {
  const first = path.resolve(externalRoot, "stage-abort-first.txt");
  const second = path.resolve(externalRoot, "stage-abort-second.txt");
  await Promise.all([writeFile(first, "first"), writeFile(second, "second")]);
  const conversation = conversationRecord("stage-abort");
  const attachmentRoot = path.join(globalStorage, "attachments", conversation.id);
  const stagedFirst = path.join(
    attachmentRoot,
    `${createHash("sha256").update(first).digest("hex").slice(0, 12)}-${path.basename(first)}`,
  );
  const controller = new AbortController();
  const signal = {
    get aborted() {
      if (!controller.signal.aborted && existsSync(stagedFirst)) controller.abort();
      return controller.signal.aborted;
    },
  };
  const originalUriFile = Uri.file;
  const originalReadFile = workspace.fs.readFile;
  let secondReads = 0;
  Uri.file = (candidate) => path.resolve(candidate) === second
    ? new Uri(candidate, "test-provider")
    : originalUriFile(candidate);
  workspace.fs.readFile = async (uri) => {
    if (path.resolve(uri.fsPath) === second) secondReads += 1;
    return originalReadFile(uri);
  };
  let saves = 0;
  const service = new AttachmentService(context, false, async () => { saves += 1; });
  try {
    assert.deepEqual(
      await service.stageExternalAttachments(
        [first, second],
        workspaceFolder,
        conversation,
        signal,
      ),
      [],
    );
  } finally {
    Uri.file = originalUriFile;
    workspace.fs.readFile = originalReadFile;
  }
  assert.equal(controller.signal.aborted, true, "the signal aborts after the first write");
  assert.equal(secondReads, 0, "cancellation prevents reading the next external file");
  assert.equal(saves, 0, "an aborted staging pass does not save conversations");
  assert.equal(conversation.attachmentRoot, undefined);
  assert.equal(
    await exists(attachmentRoot),
    false,
    "a newly created staging root is removed after cancellation",
  );
}

async function assertAbortPreservesExistingAttachments(
  context,
  workspaceFolder,
  externalRoot,
  globalStorage,
) {
  const source = path.resolve(externalRoot, "stage-abort-existing.txt");
  await writeFile(source, "new");
  const conversation = conversationRecord("stage-abort-existing");
  const attachmentRoot = path.join(globalStorage, "attachments", conversation.id);
  const existing = path.join(attachmentRoot, "existing.txt");
  await mkdir(attachmentRoot);
  await writeFile(existing, "keep");
  const stagedSource = path.join(
    attachmentRoot,
    `${createHash("sha256").update(source).digest("hex").slice(0, 12)}-${path.basename(source)}`,
  );
  const controller = new AbortController();
  const signal = {
    get aborted() {
      if (!controller.signal.aborted && existsSync(stagedSource)) controller.abort();
      return controller.signal.aborted;
    },
  };
  let saves = 0;
  const service = new AttachmentService(context, false, async () => { saves += 1; });
  assert.deepEqual(
    await service.stageExternalAttachments(
      [source],
      workspaceFolder,
      conversation,
      signal,
    ),
    [],
  );
  assert.equal(saves, 0);
  assert.equal(conversation.attachmentRoot, undefined);
  assert.equal(await readFile(existing, "utf8"), "keep");
  assert.equal(
    await exists(stagedSource),
    false,
    "a file created by the aborted call is removed from an existing root",
  );

  const sameNameSource = path.resolve(externalRoot, "stage-abort-same-name.txt");
  await writeFile(sameNameSource, "replacement");
  const sameNameTarget = path.join(
    attachmentRoot,
    `${createHash("sha256").update(sameNameSource).digest("hex").slice(0, 12)}-${
      path.basename(sameNameSource)
    }`,
  );
  await writeFile(sameNameTarget, "original");
  const sameNameController = new AbortController();
  const sameNameSignal = {
    get aborted() {
      if (!sameNameController.signal.aborted
        && readFileSync(sameNameTarget, "utf8") === "replacement") {
        sameNameController.abort();
      }
      return sameNameController.signal.aborted;
    },
  };
  assert.deepEqual(
    await service.stageExternalAttachments(
      [sameNameSource],
      workspaceFolder,
      conversationRecord(conversation.id),
      sameNameSignal,
    ),
    [],
  );
  assert.equal(
    await readFile(sameNameTarget, "utf8"),
    "replacement",
    "a same-name attachment that existed before the call is never deleted",
  );
  assert.equal(saves, 0);
  await rm(attachmentRoot, { recursive: true });
}

async function assertWorkspaceImageBoundary(service, workspaceFolder, workspaceRoot, externalRoot) {
  const workspaceImage = path.join(workspaceRoot, "inside.png");
  const outsideImage = path.join(externalRoot, "outside.png");
  const linkedImage = path.join(workspaceRoot, "linked.png");
  await Promise.all([
    writeFile(workspaceImage, Buffer.from([137, 80, 78, 71])),
    writeFile(outsideImage, Buffer.from([137, 80, 78, 71, 1])),
  ]);
  assert.equal((await service.loadAttachedImages(["inside.png"], workspaceFolder)).length, 1);
  let linked = false;
  try {
    await symlink(outsideImage, linkedImage, "file");
    linked = true;
  } catch {
    // File symlinks may require an elevated Windows token.
  }
  if (linked) {
    assert.deepEqual(await service.loadAttachedImages(["linked.png"], workspaceFolder), []);
  }
}

async function assertExternalSymlinkRejected(service, workspaceFolder, externalRoot) {
  const target = path.join(externalRoot, "symlink-target.txt");
  const link = path.join(externalRoot, "symlink-source.txt");
  await writeFile(target, "outside");
  try {
    await symlink(target, link, "file");
  } catch {
    return;
  }
  const conversation = conversationRecord("symlink-source");
  assert.deepEqual(
    await service.stageExternalAttachments([link], workspaceFolder, conversation),
    [],
  );
  assert.equal(conversation.attachmentRoot, undefined);
}

async function assertCleanupScope(service, globalStorage, tempRoot, referencedConversation) {
  const attachmentRoot = path.join(globalStorage, "attachments");
  const orphan = path.join(attachmentRoot, "old-orphan");
  const recent = path.join(attachmentRoot, "recent-orphan");
  const outside = path.join(tempRoot, "outside-must-survive");
  const link = path.join(attachmentRoot, "linked-outside");
  await Promise.all([mkdir(orphan), mkdir(recent), mkdir(outside)]);
  const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  await utimes(orphan, old, old);
  try { await symlink(outside, link, process.platform === "win32" ? "junction" : "dir"); } catch {}

  const recentConversation = conversationRecord("recent-orphan");
  recentConversation.attachmentRoot = recent;
  const removed = await service.cleanupOrphanedAttachments(
    [referencedConversation, recentConversation],
    { retentionMs: 0, now: Date.now() + 1_000 },
  );
  assert.deepEqual(new Set(removed), new Set([
    path.join(attachmentRoot, "batch-limit").replaceAll("\\", "/"),
    orphan.replaceAll("\\", "/"),
  ]));
  await workspace.fs.stat(Uri.file(recent));
  await workspace.fs.stat(Uri.file(referencedConversation.attachmentRoot));
  await workspace.fs.stat(Uri.file(outside));
  if (await exists(link)) await workspace.fs.stat(Uri.file(link));
}

async function assertRecoveryRootValidation(service, globalStorage, tempRoot) {
  const outsideRoot = path.join(tempRoot, "outside-recovery");
  await mkdir(outsideRoot);
  await writeFile(path.join(outsideRoot, "secret.txt"), "secret");
  const unsafeConversation = conversationRecord("unsafe-recovery");
  unsafeConversation.attachmentRoot = outsideRoot;
  assert.equal(await service.recoverStoredAttachment(
    path.join(tempRoot, "missing", "secret.txt"),
    [unsafeConversation],
  ), undefined);

  const safeRoot = path.join(globalStorage, "attachments", "safe-recovery");
  await mkdir(safeRoot);
  await writeFile(path.join(safeRoot, "abcdef123456-note.txt"), "note");
  const oldPath = path.join(tempRoot, "missing", "note.txt");
  const safeConversation = conversationRecord("safe-recovery");
  safeConversation.attachmentRoot = safeRoot;
  safeConversation.transcript[0].attachments = [oldPath];
  const recovered = await service.recoverStoredAttachment(oldPath, [safeConversation]);
  assert.equal(recovered.fsPath, path.join(safeRoot, "abcdef123456-note.txt"));
  assert.deepEqual(safeConversation.transcript[0].attachments, [{
    path: recovered.fsPath.replaceAll("\\", "/"),
    label: "note.txt",
  }]);
}

async function assertConversationDeletion(service, globalStorage, tempRoot) {
  const outside = path.join(tempRoot, "delete-outside");
  await mkdir(outside);
  const mismatched = conversationRecord("expected-root");
  mismatched.attachmentRoot = outside;
  assert.equal(await service.deleteConversationAttachments(mismatched), false);
  await workspace.fs.stat(Uri.file(outside));

  const managed = path.join(globalStorage, "attachments", "delete-me");
  await mkdir(managed);
  await writeFile(path.join(managed, "note.txt"), "note");
  const matching = conversationRecord("delete-me");
  matching.attachmentRoot = managed;
  assert.equal(await service.deleteConversationAttachments(matching), true);
  assert.equal(await exists(managed), false);
  assert.equal(await service.deleteConversationAttachments(matching), false);
}

async function exists(target) {
  try { await workspace.fs.stat(Uri.file(target)); return true; } catch { return false; }
}

function conversationRecord(id) {
  return {
    id,
    title: id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    transcript: [{ role: "user", text: "test" }],
  };
}
