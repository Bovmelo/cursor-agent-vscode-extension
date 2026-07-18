import assert from "node:assert/strict";
import test from "node:test";
import {
  RunPreparationError,
  waitForRunPreparation,
} from "../out/runPreparation.js";

test("waitForRunPreparation resolves an operation before the deadline", async () => {
  const controller = new AbortController();
  const result = await waitForRunPreparation(() => Promise.resolve("ready"), {
    signal: controller.signal,
    timeoutMs: 100,
    phase: "connecting",
  });
  assert.equal(result, "ready");
});

test("waitForRunPreparation aborts promptly and cleans up a late result", async () => {
  const controller = new AbortController();
  let resolveOperation;
  let lateValue;
  const operation = new Promise((resolve) => {
    resolveOperation = resolve;
  });
  const waiting = waitForRunPreparation(() => operation, {
    signal: controller.signal,
    timeoutMs: 1_000,
    phase: "starting",
    onLateResolve: (value) => {
      lateValue = value;
    },
  });

  controller.abort();
  await assert.rejects(waiting, (error) => {
    assert.ok(error instanceof RunPreparationError);
    assert.equal(error.kind, "cancelled");
    assert.equal(error.phase, "starting");
    return true;
  });

  resolveOperation("orphan");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lateValue, "orphan");
});

test("waitForRunPreparation times out and cleans up a late result", async () => {
  const controller = new AbortController();
  let resolveOperation;
  let lateValue;
  const operation = new Promise((resolve) => {
    resolveOperation = resolve;
  });
  const waiting = waitForRunPreparation(() => operation, {
    signal: controller.signal,
    timeoutMs: 5,
    phase: "waiting for response",
    onLateResolve: (value) => {
      lateValue = value;
    },
  });

  await assert.rejects(waiting, (error) => {
    assert.ok(error instanceof RunPreparationError);
    assert.equal(error.kind, "timeout");
    assert.equal(error.phase, "waiting for response");
    return true;
  });

  resolveOperation("late response");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lateValue, "late response");
});

test("waitForRunPreparation does not start an operation after cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  let started = false;

  await assert.rejects(
    waitForRunPreparation(() => {
      started = true;
      return Promise.resolve("unexpected");
    }, {
      signal: controller.signal,
      timeoutMs: 100,
      phase: "connecting",
    }),
    (error) => error instanceof RunPreparationError && error.kind === "cancelled",
  );
  assert.equal(started, false);
});
