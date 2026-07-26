import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { AsyncLifecycle, ExtensionDeactivation } from "../out/asyncLifecycle.js";

const extensionSource = await readFile(new URL("../src/extension.ts", import.meta.url), "utf8");

test("AsyncLifecycle starts cleanup once and returns the same promise", async () => {
  const lifecycle = new AsyncLifecycle();
  let cleanupCount = 0;
  let finishCleanup;
  const cleanupBlocked = new Promise((resolve) => {
    finishCleanup = resolve;
  });

  const first = lifecycle.dispose(async () => {
    cleanupCount += 1;
    await cleanupBlocked;
  });
  const second = lifecycle.dispose(async () => {
    cleanupCount += 1;
  });

  assert.equal(lifecycle.isDisposing, true);
  assert.strictEqual(second, first);
  await Promise.resolve();
  assert.equal(cleanupCount, 1);

  finishCleanup();
  await first;
  assert.equal(cleanupCount, 1);
});

test("AsyncLifecycle cancels owned deferred work and rejects new work during shutdown", async () => {
  const lifecycle = new AsyncLifecycle();
  let deferredRuns = 0;

  lifecycle.defer(() => {
    deferredRuns += 1;
  });
  await lifecycle.dispose(async () => {});
  lifecycle.defer(() => {
    deferredRuns += 1;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(deferredRuns, 0);
});

test("AsyncLifecycle runs deferred work normally before shutdown", async () => {
  const lifecycle = new AsyncLifecycle();
  let deferredRuns = 0;

  lifecycle.defer(() => {
    deferredRuns += 1;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(deferredRuns, 1);
  await lifecycle.dispose(async () => {});
});

test("ExtensionDeactivation returns and awaits the active provider cleanup", async () => {
  const deactivation = new ExtensionDeactivation();
  let finishCleanup;
  const cleanupBlocked = new Promise((resolve) => {
    finishCleanup = resolve;
  });
  let cleanupFinished = false;
  const provider = {
    async dispose() {
      await cleanupBlocked;
      cleanupFinished = true;
    },
  };
  deactivation.setActive(provider);

  const pending = deactivation.deactivate();
  assert.equal(cleanupFinished, false);
  finishCleanup();
  await pending;
  assert.equal(cleanupFinished, true);

  await deactivation.deactivate();
  assert.equal(cleanupFinished, true);
});

test("provider shutdown joins tracked send pipelines before disposing subscriptions", () => {
  const sendStart = extensionSource.indexOf("  private async send(");
  const sendEnd = extensionSource.indexOf(
    "  private async reviewAutopilotEdits",
    sendStart,
  );
  assert.ok(sendStart >= 0 && sendEnd > sendStart);
  const sendMethod = extensionSource.slice(sendStart, sendEnd);
  assert.ok(
    sendMethod.indexOf("activeSendOperations.add(trackedSend)")
      < sendMethod.indexOf("await this.ensureTokenBudgetAllows()"),
  );
  assert.match(
    sendMethod,
    /activeSendOperations\.add\(trackedSend\)[\s\S]*?finishSend\(\);/u,
  );
  assert.match(
    sendMethod,
    /await this\.bindConversationWorkspace[\s\S]*?this\.lifecycle\.isDisposing[\s\S]*?this\.runtimeFor/u,
  );
  assert.match(
    sendMethod,
    /prepareIsolatedWorktree\([\s\S]*?assertPreparationActive\("preparing the isolated worktree"\)/u,
  );
  assert.match(
    sendMethod,
    /resolveAttachedFiles\([\s\S]*?preparationAbort\.signal[\s\S]*?assertPreparationActive\("resolving attached files"\)/u,
  );
  assert.match(
    sendMethod,
    /stageExternalAttachments\([\s\S]*?preparationAbort\.signal[\s\S]*?assertPreparationActive\("staging attached files"\)/u,
  );
  assert.match(
    sendMethod,
    /loadAttachedImages\([\s\S]*?preparationAbort\.signal[\s\S]*?assertPreparationActive\("loading attached images"\)/u,
  );
  assert.match(
    sendMethod,
    /changeSessions\.begin\([\s\S]*?preparationAbort\.signal[\s\S]*?assertPreparationActive\("creating the change-session checkpoint"\)/u,
  );
  assert.match(
    sendMethod,
    /runConfiguredHooks\([\s\S]*?preparationAbort\.signal[\s\S]*?assertPreparationActive\("running pre-edit hooks"\)/u,
  );
  assert.match(
    sendMethod,
    /result \?\?= await resultPromise;\s*assertPreparationActive\("finalizing the Cursor run"\)/u,
  );
  assert.match(
    sendMethod,
    /candidateVerification = await runVerification\([\s\S]*?preparationAbort\.signal[\s\S]*?assertPreparationActive\("verifying the isolated candidate"\)/u,
  );
  assert.match(
    sendMethod,
    /verificationResult = await runVerification\([\s\S]*?preparationAbort\.signal[\s\S]*?assertPreparationActive\("running automatic verification"\)/u,
  );
  assert.match(
    sendMethod,
    /Late completion must only release local resources[\s\S]*?if \(!this\.lifecycle\.isDisposing\) \{[\s\S]*?conversation\.transcript\.push[\s\S]*?await this\.saveConversations\(\)/u,
  );
  assert.match(
    extensionSource,
    /this\.waitForShutdownOperation\([\s\S]*?this\.cancelAllChats\(\)[\s\S]*?await this\.disposeAgentsForShutdown\(\);[\s\S]*?Promise\.allSettled\(this\.activeSendOperations\)[\s\S]*?await this\.waitForPendingPreparationOperations\(\);[\s\S]*?for \(const disposable of this\.disposables\)/u,
  );
  assert.match(
    extensionSource,
    /Promise\.resolve\(\)\.then\(\(\) => agent\[Symbol\.asyncDispose\]\(\)\)/u,
  );
});
