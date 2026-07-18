import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveTerminalJob } from "../out/backgroundWorker.js";
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

async function createJob(t, status) {
  const directory = await mkdtemp(join(tmpdir(), "cursor-background-worker-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const jobFile = join(directory, "job.json");
  await writeFile(jobFile, JSON.stringify({
    jobFile,
    workerToken: "secret",
    status,
    updatedAt: 1,
  }), "utf8");
  return jobFile;
}

async function readJob(jobFile) {
  return JSON.parse(await readFile(jobFile, "utf8"));
}

test("worker terminal save never replaces a host-cancelled job", async (t) => {
  const jobFile = await createJob(t, "cancelled");

  await saveTerminalJob(jobFile, "secret", "completed", {
    assistantText: "late result",
  });

  const saved = await readJob(jobFile);
  assert.equal(saved.status, "cancelled");
  assert.equal(saved.assistantText, undefined);
  assert.equal(saved.updatedAt, 1);
});

test("authenticated cancellation sidecar wins over a worker completion", async (t) => {
  const jobFile = await createJob(t, "running");
  const cancellationFile = backgroundWorkerProtocolPaths(jobFile).cancellation;
  await writeFile(cancellationFile, JSON.stringify({
    token: "secret",
    requestedAt: Date.now(),
  }), "utf8");

  await saveTerminalJob(jobFile, "secret", "completed", {
    assistantText: "late result",
  });

  const saved = await readJob(jobFile);
  assert.equal(saved.status, "cancelled");
  assert.equal(saved.assistantText, undefined);
});

test("cancellation arriving during a worker terminal save wins the race", async (t) => {
  const jobFile = await createJob(t, "running");
  const cancellationFile = backgroundWorkerProtocolPaths(jobFile).cancellation;
  const update = {};
  Object.defineProperty(update, "assistantText", {
    enumerable: true,
    get() {
      writeFileSync(cancellationFile, JSON.stringify({
        token: "secret",
        requestedAt: Date.now(),
      }), "utf8");
      return "late result";
    },
  });

  await saveTerminalJob(jobFile, "secret", "completed", update);

  const saved = await readJob(jobFile);
  assert.equal(saved.status, "cancelled");
});
