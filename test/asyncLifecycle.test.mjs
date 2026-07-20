import assert from "node:assert/strict";
import test from "node:test";

import { AsyncLifecycle, ExtensionDeactivation } from "../out/asyncLifecycle.js";

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
