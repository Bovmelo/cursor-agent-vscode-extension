import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  coerceUploadBytes,
  normalizeAttachedFilePath,
} from "../out/attachmentUtils.js";

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
