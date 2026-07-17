import assert from "node:assert/strict";
import test from "node:test";
import {
  backgroundWorkerProtocolPaths,
  isAuthenticatedWorkerCancellation,
  isAuthenticatedWorkerHeartbeat,
  WORKER_HEARTBEAT_MAX_AGE_MS,
} from "../out/backgroundWorkerProtocol.js";

test("background worker protocol uses sidecar files per job", () => {
  assert.deepEqual(backgroundWorkerProtocolPaths("job.json"), {
    heartbeat: "job.json.heartbeat.json",
    cancellation: "job.json.cancel.json",
  });
});

test("worker heartbeat requires token, pid, and freshness", () => {
  const now = 100_000;
  const heartbeat = { token: "secret", pid: 42, updatedAt: now - 1_000 };
  assert.equal(isAuthenticatedWorkerHeartbeat("secret", 42, heartbeat, now), true);
  assert.equal(isAuthenticatedWorkerHeartbeat("other", 42, heartbeat, now), false);
  assert.equal(isAuthenticatedWorkerHeartbeat("secret", 43, heartbeat, now), false);
  assert.equal(
    isAuthenticatedWorkerHeartbeat(
      "secret",
      42,
      { ...heartbeat, updatedAt: now - WORKER_HEARTBEAT_MAX_AGE_MS - 1 },
      now,
    ),
    false,
  );
  assert.equal(
    isAuthenticatedWorkerHeartbeat("secret", 42, { ...heartbeat, updatedAt: now + 1 }, now),
    false,
  );
});

test("worker cancellation requires the unguessable job token", () => {
  const cancellation = { token: "secret", requestedAt: Date.now() };
  assert.equal(isAuthenticatedWorkerCancellation("secret", cancellation), true);
  assert.equal(isAuthenticatedWorkerCancellation("other", cancellation), false);
});
