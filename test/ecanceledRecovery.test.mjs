import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isLocalRuntimeWriteCancelled } from "../out/pureUtils.js";

const extensionSource = await readFile(new URL("../src/extension.ts", import.meta.url), "utf8");
const sendSource = extensionSource.slice(
  extensionSource.indexOf("private async send("),
  extensionSource.indexOf("private async reviewAutopilotEdits("),
);
const failureFormattingSource = extensionSource.slice(
  extensionSource.indexOf("private formatLocalRuntimeInterruption("),
  extensionSource.indexOf("private formatBlockedProxyError("),
);

test("local runtime cancellation detection stays specific to ECANCELED", () => {
  assert.equal(isLocalRuntimeWriteCancelled("ECANCELED", "operation failed"), true);
  assert.equal(isLocalRuntimeWriteCancelled(undefined, "write ECANCELED"), true);
  assert.equal(isLocalRuntimeWriteCancelled("ERR_CANCELED", "operation cancelled"), false);
  assert.equal(isLocalRuntimeWriteCancelled("ABORT_ERR", "The operation was aborted"), false);
  assert.equal(isLocalRuntimeWriteCancelled("ECONNRESET", "socket closed"), false);
  assert.equal(isLocalRuntimeWriteCancelled(undefined, "write ECANCELED_EXTRA"), false);
});

test("send, wait, and stream rejections tag local-runtime write interruption", () => {
  assert.match(
    sendSource,
    /const noteInterruptedRuntimeError = \(error: unknown\): void => \{[\s\S]*?isLocalRuntimeWriteCancelled\(code, message\)[\s\S]*?interruptedRuntimeError = \{ code, message \}/u,
  );
  assert.match(
    sendSource,
    /if \(!this\.isAgentBusyError\(error\)\) \{\s*noteInterruptedRuntimeError\(error\);\s*throw error;/u,
  );
  assert.match(
    sendSource,
    /try \{\s*run = await sendRun\(\);\s*\} catch \(error\) \{\s*noteInterruptedRuntimeError\(error\);\s*throw error;/u,
  );
  assert.match(
    sendSource,
    /run\.wait\(\)\.catch\(\(error: unknown\) => \{\s*noteInterruptedRuntimeError\(error\);\s*throw error;/u,
  );
  assert.match(
    sendSource,
    /if \(outcome\.type === "streamError"\) \{\s*noteInterruptedRuntimeError\(outcome\.error\);\s*throw outcome\.error;/u,
  );

  // Avoid treating ECANCELED from hooks, verification, or filesystem work as
  // a broken SDK process: classification belongs only in the boundary marker
  // plus the explicit terminal RunResult path.
  assert.equal(sendSource.match(/isLocalRuntimeWriteCancelled\(/gu)?.length, 2);
});

test("thrown ECANCELED shares cancellation semantics, reconnect guidance, and disposal", () => {
  assert.match(
    sendSource,
    /const runtimeWriteCancelled = runtimeInterruption !== undefined;[\s\S]*?const requestedStop =[\s\S]*?preparationAbort\.signal\.aborted[\s\S]*?runtime\.pendingCancel[\s\S]*?runtime\.cancellation !== undefined/u,
  );
  assert.match(
    sendSource,
    /const wasCancelled = preparationFailure\?\.kind === "cancelled" \|\| requestedStop;[\s\S]*?resetInterruptedAgent = runtimeWriteCancelled && !requestedStop;/u,
  );
  assert.match(
    sendSource,
    /runtimeWriteCancelled\s*\? this\.formatLocalRuntimeInterruption\([\s\S]*?runtimeInterruption\.message[\s\S]*?runtimeInterruption\.code/u,
  );

  const resetSource = sendSource.slice(
    sendSource.indexOf("if (resetInterruptedAgent && runtime.agent && !runtime.isolatedWorktree)"),
    sendSource.indexOf("const isolated = runtime.isolatedWorktree;"),
  );
  assert.match(resetSource, /runtime\.agent = undefined;/u);
  assert.match(resetSource, /runtime\.rootsKey = undefined;/u);
  assert.match(resetSource, /interruptedAgent\[Symbol\.asyncDispose\]\(\)/u);
  assert.doesNotMatch(resetSource, /conversation\.agentId = undefined/u);

  assert.match(
    failureFormattingSource,
    /The extension will reconnect automatically on the next run; try the message again\./u,
  );
  assert.match(
    failureFormattingSource,
    /isLocalRuntimeWriteCancelled\(result\.error\?\.code, detail\)[\s\S]*?return this\.formatLocalRuntimeInterruption\(/u,
  );
});
