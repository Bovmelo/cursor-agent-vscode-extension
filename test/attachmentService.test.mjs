import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  coerceUploadBytes,
  normalizeAttachedFilePath,
} from "../out/attachmentUtils.js";
import {
  DEFAULT_ATTACHMENT_RETENTION_MS,
  isDangerousAttachmentName,
  isDirectChildPath,
  MAX_ATTACHMENT_BATCH_BYTES,
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_ATTACHMENT_FILES,
  sanitizeAttachmentFileName,
} from "../out/attachmentPolicy.js";

test("normalizeAttachedFilePath keeps workspace paths and absolute clipboard staging paths", () => {
  const workspaceFile = path.resolve("/workspace/src/a.png");
  assert.equal(
    normalizeAttachedFilePath("src/a.png", workspaceFile),
    workspaceFile,
  );

  const pending = path.resolve(
    "/user/globalStorage/pending-attachments/abcd1234efgh-clipboard-image-1.png",
  );
  assert.equal(normalizeAttachedFilePath(pending, undefined), pending);

  assert.equal(normalizeAttachedFilePath("relative/only.png", undefined), undefined);
});

test("coerceUploadBytes revives typed arrays, buffers, and plain byte arrays", () => {
  const bytes = Uint8Array.from([137, 80, 78, 71]);
  assert.deepEqual([...coerceUploadBytes(bytes)], [137, 80, 78, 71]);
  assert.deepEqual([...coerceUploadBytes(bytes.buffer)], [137, 80, 78, 71]);
  assert.deepEqual([...coerceUploadBytes([137, 80, 78, 71])], [137, 80, 78, 71]);
  assert.deepEqual(
    [...coerceUploadBytes({ type: "Buffer", data: [137, 80, 78, 71] })],
    [137, 80, 78, 71],
  );
  assert.deepEqual(
    [...coerceUploadBytes({ 0: 137, 1: 80, 2: 78, 3: 71, length: 4 })],
    [137, 80, 78, 71],
  );
  assert.deepEqual(
    [...coerceUploadBytes({ 0: 137, 1: 80, 2: 78, 3: 71 })],
    [137, 80, 78, 71],
  );
  assert.equal(coerceUploadBytes(undefined), undefined);
  assert.equal(coerceUploadBytes({ foo: 1 }), undefined);
});

test("attachment policy uses bounded batches and a backward-compatible denylist", () => {
  assert.equal(MAX_ATTACHMENT_FILE_BYTES, 20 * 1024 * 1024);
  assert.equal(MAX_ATTACHMENT_BATCH_BYTES, 80 * 1024 * 1024);
  assert.equal(MAX_ATTACHMENT_FILES, 20);
  assert.equal(DEFAULT_ATTACHMENT_RETENTION_MS, 30 * 24 * 60 * 60 * 1000);

  for (const name of ["run.exe", "open.LNK", "setup.ps1", "payload.sh", "launch.command", "run.cmd. "]) {
    assert.equal(isDangerousAttachmentName(name), true, name);
  }
  for (const name of ["report.pdf", "archive.zip", "photo.png", "source.ts", "README"]) {
    assert.equal(isDangerousAttachmentName(name), false, name);
  }
});

test("attachment names are portable path segments and preserve useful names", () => {
  assert.equal(sanitizeAttachmentFileName("../../report?.pdf. "), "report_.pdf");
  assert.equal(sanitizeAttachmentFileName("C:\\temp\\CON.txt"), "_CON.txt");
  assert.equal(sanitizeAttachmentFileName("CON .txt"), "_CON .txt");
  assert.equal(sanitizeAttachmentFileName(".."), "attachment");
  assert.equal(sanitizeAttachmentFileName("photo.png"), "photo.png");
  assert.ok(sanitizeAttachmentFileName(`${"a".repeat(300)}.txt`).length <= 180);
});

test("managed attachment roots must be immediate children", () => {
  const root = path.resolve("/storage/attachments");
  assert.equal(isDirectChildPath(root, path.join(root, "conversation-1")), true);
  assert.equal(isDirectChildPath(root, root), false);
  assert.equal(isDirectChildPath(root, path.join(root, "conversation-1", "nested")), false);
  assert.equal(isDirectChildPath(root, path.resolve(root, "..", "elsewhere")), false);
});
