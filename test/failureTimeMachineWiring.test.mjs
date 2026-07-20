import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("Failure Time Machine uses persisted sessions and local audit evidence", async () => {
  const source = await readFile(new URL("src/extension.ts", root), "utf8");
  const method = source.slice(
    source.indexOf("public async openFailureTimeMachine("),
    source.indexOf("public async analyzeDebugContext("),
  );

  assert.match(method, /this\.changeSessions\.history\(\)/u);
  assert.match(method, /workspaceState\.get<AuditEntry\[\]>\(AUDIT_LOG_KEY/u);
  assert.match(method, /formatFailureTimeMachineMarkdown\(report, IS_JAPANESE\)/u);
  assert.match(method, /failure-time-machine/u);
});

test("historical sessions cannot trigger verification against the current workspace", async () => {
  const source = await readFile(new URL("src/extension.ts", root), "utf8");
  const method = source.slice(
    source.indexOf("public async reverifyChangeSession("),
    source.indexOf("public async revertLastSession("),
  );

  assert.match(method, /session\.id !== this\.changeSessions\.snapshot\(\)\?\.id/u);
  assert.match(method, /!vscode\.workspace\.isTrusted/u);
  assert.match(method, /verifyCurrentChanges\(session\.id\)/u);
  assert.doesNotMatch(method, /retryLastRun/u);
});

test("failed change sessions expose timeline and latest-only reverify actions", async () => {
  const source = await readFile(new URL("src/aiNative.ts", root), "utf8");
  const start = source.indexOf("const hasRecordedFailure =");
  const failureActions = source.slice(
    start,
    source.indexOf("for (const file of session.files)", start),
  );

  assert.match(failureActions, /verificationHistory\.some/u);
  assert.match(failureActions, /if \(hasRecordedFailure\)/u);
  assert.match(failureActions, /cursorSubscription\.openFailureTimeMachine/u);
  assert.match(failureActions, /session\.id === this\.sessions\[0\]\?\.id/u);
  assert.match(failureActions, /cursorSubscription\.reverifyChangeSession/u);
});

test("verification reruns retain bounded history instead of erasing failures", async () => {
  const source = await readFile(new URL("src/aiNative.ts", root), "utf8");
  const method = source.slice(
    source.indexOf("public setVerification("),
    source.indexOf("public setRepairBudget("),
  );

  assert.match(method, /current\.verificationHistory/u);
  assert.match(method, /history\.push/u);
  assert.match(method, /slice\(-MAX_VERIFICATION_HISTORY\)/u);
  assert.match(method, /current\.verification = result/u);
});
