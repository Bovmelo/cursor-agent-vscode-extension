import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveTerminalJob } from "../out/backgroundWorker.js";
import {
  backgroundWorkerProtocolPaths,
  cancellationInvalidatesCompletedResult,
  decideBackgroundWorkerRecovery,
  isAuthenticatedWorkerCancellation,
  isAuthenticatedWorkerHeartbeat,
  isAuthenticatedWorkerInstance,
  isBackgroundJobDocument,
  WORKER_HARD_STOP_GRACE_MS,
  WORKER_HEARTBEAT_MAX_AGE_MS,
} from "../out/backgroundWorkerProtocol.js";

const backgroundJobsSource = await readFile(
  new URL("../src/backgroundJobs.ts", import.meta.url),
  "utf8",
);
const backgroundWorkerSource = await readFile(
  new URL("../src/backgroundWorker.ts", import.meta.url),
  "utf8",
);

test("background worker protocol uses sidecar files per job", () => {
  assert.deepEqual(backgroundWorkerProtocolPaths("job.json"), {
    heartbeat: "job.json.heartbeat.json",
    cancellation: "job.json.cancel.json",
  });
  assert.equal(isBackgroundJobDocument("job.json"), true);
  assert.equal(isBackgroundJobDocument("job.json.heartbeat.json"), false);
  assert.equal(isBackgroundJobDocument("job.json.cancel.json"), false);
});

test("worker heartbeat requires token, pid, and freshness", () => {
  const now = 100_000;
  const heartbeat = {
    token: "secret",
    pid: 42,
    startedAt: 50_000,
    processStartId: "linux:123",
    updatedAt: now - 1_000,
  };
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
  assert.equal(isAuthenticatedWorkerInstance("secret", 42, 50_000, heartbeat), true);
  assert.equal(isAuthenticatedWorkerInstance("secret", 42, 50_001, heartbeat), false);
});

test("worker cancellation requires the unguessable job token", () => {
  const cancellation = { token: "secret", requestedAt: Date.now(), reason: "user" };
  assert.equal(isAuthenticatedWorkerCancellation("secret", cancellation), true);
  assert.equal(isAuthenticatedWorkerCancellation("other", cancellation), false);
  assert.equal(
    isAuthenticatedWorkerCancellation("secret", { ...cancellation, reason: "invalid" }),
    false,
  );
  assert.equal(cancellationInvalidatesCompletedResult("secret", cancellation), true);
  assert.equal(
    cancellationInvalidatesCompletedResult("secret", { ...cancellation, reason: "orphan" }),
    false,
  );
});

test("worker recovery requests cooperative stop before hard stop", () => {
  const now = 1_000_000;
  const base = {
    active: true,
    createdAt: now - 1_000,
    updatedAt: now - 1_000,
    workerStartedAt: now - 1_000,
    maxMinutes: 60,
    hasFreshHeartbeat: true,
    hasRecoverableWorker: true,
    now,
  };
  assert.deepEqual(decideBackgroundWorkerRecovery(base), { action: "none" });
  assert.deepEqual(decideBackgroundWorkerRecovery({
    ...base,
    workerStartedAt: now - 60_001,
    maxMinutes: 1,
  }), { action: "request-stop", reason: "deadline" });
  assert.deepEqual(decideBackgroundWorkerRecovery({
    ...base,
    workerStartedAt: now - 30_001,
    hasFreshHeartbeat: false,
  }), { action: "request-stop", reason: "unresponsive" });
  assert.deepEqual(decideBackgroundWorkerRecovery({
    ...base,
    active: false,
  }), { action: "none" });
  assert.deepEqual(decideBackgroundWorkerRecovery({
    ...base,
    active: false,
    updatedAt: now - WORKER_HARD_STOP_GRACE_MS,
  }), { action: "request-stop", reason: "orphan" });

  const cancellation = { token: "secret", requestedAt: now - 1, reason: "user" };
  assert.deepEqual(decideBackgroundWorkerRecovery({
    ...base,
    cancellation,
  }), { action: "await-grace", reason: "user" });
  assert.deepEqual(decideBackgroundWorkerRecovery({
    ...base,
    cancellation: {
      ...cancellation,
      requestedAt: now - WORKER_HARD_STOP_GRACE_MS,
    },
  }), { action: "hard-stop", reason: "user" });
});

test("background launch, restored trust, and discard boundaries fail closed", () => {
  const createSource = backgroundJobsSource.slice(
    backgroundJobsSource.indexOf("public async create("),
    backgroundJobsSource.indexOf("public async apply("),
  );
  const launchSource = backgroundJobsSource.slice(
    backgroundJobsSource.indexOf("private launch("),
    backgroundJobsSource.indexOf("private workerFile("),
  );
  const initializeSource = backgroundJobsSource.slice(
    backgroundJobsSource.indexOf("private async initialize("),
    backgroundJobsSource.indexOf("private async poll("),
  );
  const discardSource = backgroundJobsSource.slice(
    backgroundJobsSource.indexOf("public async discard("),
    backgroundJobsSource.indexOf("public getTreeItem("),
  );
  const applySource = backgroundJobsSource.slice(
    backgroundJobsSource.indexOf("public async apply("),
    backgroundJobsSource.indexOf("public async cancel("),
  );

  assert.match(createSource, /workspaceTrustedAtLaunch = vscode\.workspace\.isTrusted[\s\S]*?this\.launch/u);
  assert.match(createSource, /beforeCaptureBaseline[\s\S]*?!vscode\.workspace\.isTrusted[\s\S]*?runConfiguredHooks/u);
  assert.match(launchSource, /!input\.workspaceTrustedAtLaunch \|\| !vscode\.workspace\.isTrusted[\s\S]*?spawn\(/u);
  assert.match(initializeSource, /!vscode\.workspace\.isTrusted[\s\S]*?requestWorkerStop\(job, "orphan"\)/u);
  assert.match(discardSource, /recoverWorker\(job\)[\s\S]*?isWorkerExitConfirmed\(job\)[\s\S]*?cleanupIsolatedWorktree/u);
  assert.match(applySource, /recoverWorker\(job\)[\s\S]*?isWorkerExitConfirmed\(job\)[\s\S]*?collectIsolatedChanges/u);
  assert.match(applySource, /recoverWorker\(job\)[\s\S]*?job\.status !== "completed"[\s\S]*?isWorkerExitConfirmed/u);
  assert.match(backgroundJobsSource, /job\.status !== "completed" \|\| reason === "orphan"[\s\S]*?await this\.save\(job\)/u);
  assert.match(backgroundWorkerSource, /input\.workspaceTrustedAtLaunch !== true[\s\S]*?saveTerminalJob/u);
  assert.match(backgroundWorkerSource, /settingSources: input\.workspaceTrustedAtLaunch \? \["all"\] : \[\]/u);
});

test("background jobs never persist API keys; workers receive them on stdin only", () => {
  const createSource = backgroundJobsSource.slice(
    backgroundJobsSource.indexOf("public async create("),
    backgroundJobsSource.indexOf("public async apply("),
  );
  const launchSource = backgroundJobsSource.slice(
    backgroundJobsSource.indexOf("private launch("),
    backgroundJobsSource.indexOf("private workerFile("),
  );
  const jobLiteral = createSource.slice(
    createSource.indexOf("const job: BackgroundJob"),
    createSource.indexOf("this.jobs.set(id, job)"),
  );

  assert.equal(
    /apiKey\s*:/.test(jobLiteral),
    false,
    "BackgroundJob documents must not include an apiKey field",
  );
  assert.match(launchSource, /minimalShellEnv\(\)/u);
  assert.match(launchSource, /child\.stdin\.end\(JSON\.stringify\(input\)\)/u);
  assert.match(backgroundWorkerSource, /let apiKey: string \| undefined = input\.apiKey/u);
  assert.match(backgroundWorkerSource, /input\.apiKey = ""/u);
  assert.match(
    backgroundWorkerSource,
    /apiKey,\s*[\s\S]*?apiKey = undefined/u,
  );
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

test("deadline cancellation is preserved as an execution-budget error", async (t) => {
  const jobFile = await createJob(t, "running");
  const cancellationFile = backgroundWorkerProtocolPaths(jobFile).cancellation;
  await writeFile(cancellationFile, JSON.stringify({
    token: "secret",
    requestedAt: Date.now(),
    reason: "deadline",
  }), "utf8");

  await saveTerminalJob(jobFile, "secret", "cancelled");

  const saved = await readJob(jobFile);
  assert.equal(saved.status, "error");
  assert.match(saved.error, /execution-time budget/u);
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
