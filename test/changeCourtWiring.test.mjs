import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("Change Court reviews saved snapshots from a workspace-detached Plan run", async () => {
  const extensionSource = await readFile(new URL("src/extension.ts", root), "utf8");
  const method = extensionSource.slice(
    extensionSource.indexOf("public async reviewChangeSession("),
    extensionSource.indexOf("public async analyzeDebugContext("),
  );

  assert.match(method, /baselineContent\(session\.id, file\)/u);
  assert.match(method, /proposedContent\(session\.id, file\)/u);
  assert.match(method, /baselineFileExists\(session\.id, file\)/u);
  assert.match(method, /beforeExists === undefined/u);
  assert.match(method, /unavailableFiles\.push\(relative\)/u);
  assert.match(method, /beforeExists,/u);
  assert.match(method, /afterExists: proposed\.worktreeExisted/u);
  assert.match(method, /createExcludedPathMatcher\(vscode\.Uri\.file\(session\.root\)\)/u);
  assert.match(method, /mode: "plan"/u);
  assert.match(method, /cwd: reviewRoot\.fsPath/u);
  assert.doesNotMatch(method, /cwd: session\.root/u);
  assert.match(method, /settingSources: \[\]/u);
});

test("change sessions expose the Change Court command", async () => {
  const source = await readFile(new URL("src/aiNative.ts", root), "utf8");

  assert.match(source, /command: "cursorSubscription\.reviewChangeSession"/u);
  assert.match(source, /arguments: \[session\.id\]/u);
});

test("Change Court preserves unknown baselines and canonical Git path casing", async () => {
  const source = await readFile(new URL("src/aiNative.ts", root), "utf8");

  assert.match(source, /Promise<boolean \| undefined>/u);
  assert.match(source, /captureIgnoredWorkspaceIndex\(\s*session\.root,\s*signal,/u);
  assert.match(source, /"--directory"/u);
  assert.match(source, /wasIgnoredAtCheckpoint\(session, relative\) !== false/u);
  assert.match(source, /revisionPathsAtCheckpoint\(session\)/u);
  assert.match(source, /trackedRelativePath\(relative, revisionPaths\)/u);
  assert.match(source, /!\(session\.checkpointReady \?\? session\.baselineClean\)/u);
  assert.match(source, /for \(const file of \[\.\.\.candidateHints, \.\.\.postRunChanges\]\)/u);
  assert.match(source, /baselineRelative\s+\?\? trackedRelativePath/u);
  assert.match(source, /this\.revisionPathCache\.delete\(session\.id\)/u);
  assert.match(source, /this\.ignoredPathIndexCache\.delete\(sessionId\)/u);
  assert.match(source, /this\.evictSessionCaches\(sessionId\)/u);
});
