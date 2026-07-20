import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveTerminalJob } from "../out/backgroundWorker.js";
import {
  BackgroundJobWriteConflictError,
  FileBackgroundJobRepository,
} from "../out/backgroundJobRepository.js";
import { isBackgroundJob } from "../out/backgroundJobTypes.js";
import {
  ACTIVE_POLL_MAX_DELAY_MS,
  ACTIVE_POLL_MIN_DELAY_MS,
  IDLE_POLL_MAX_DELAY_MS,
  IDLE_POLL_MIN_DELAY_MS,
  INACTIVE_WINDOW_MULTIPLIER,
  nextBackgroundJobPollDelay,
} from "../out/backgroundJobScheduler.js";
import { reduceBackgroundJobState } from "../out/backgroundJobState.js";
import { backgroundWorkerProtocolPaths } from "../out/backgroundWorkerProtocol.js";

const messages = {
  deadline: "deadline",
  unresponsive: "unresponsive",
};

const backgroundJobsSource = await readFile(
  new URL("../src/backgroundJobs.ts", import.meta.url),
  "utf8",
);

test("background job state machine keeps cancellation and terminal races fail closed", () => {
  const completed = { status: "completed", error: undefined };
  assert.equal(
    reduceBackgroundJobState(completed, { type: "cancel", reason: "orphan" }, messages),
    undefined,
    "orphan recovery must not invalidate a completed result",
  );
  assert.deepEqual(
    reduceBackgroundJobState(completed, { type: "cancel", reason: "user" }, messages),
    { status: "cancelled", error: undefined },
    "an authenticated user cancellation must win a completion race",
  );
  assert.equal(completed.status, "completed", "the reducer must not mutate its input");
  assert.equal(
    reduceBackgroundJobState({ status: "running" }, { type: "cancel", reason: "orphan" }, messages),
    undefined,
    "the host must not persist orphan cancellation before worker exit",
  );
  assert.deepEqual(
    reduceBackgroundJobState(
      { status: "running" },
      { type: "cancel", reason: "orphan", workerExitConfirmed: true },
      messages,
    ),
    { status: "cancelled", error: undefined },
  );

  assert.deepEqual(
    reduceBackgroundJobState(
      { status: "running" },
      { type: "cancel", reason: "deadline" },
      messages,
    ),
    { status: "error", error: "deadline" },
  );
  assert.deepEqual(
    reduceBackgroundJobState(
      { status: "starting" },
      { type: "cancel", reason: "unresponsive" },
      messages,
    ),
    { status: "error", error: "unresponsive" },
  );
  assert.equal(
    reduceBackgroundJobState({ status: "applied" }, { type: "cancel", reason: "user" }, messages),
    undefined,
  );
});

test("background job state machine permits only ordered apply and discard transitions", () => {
  assert.deepEqual(
    reduceBackgroundJobState(
      { status: "completed", error: "old" },
      { type: "begin-apply" },
      messages,
    ),
    { status: "applying", error: undefined },
  );
  assert.deepEqual(
    reduceBackgroundJobState({ status: "applying" }, { type: "apply-succeeded" }, messages),
    { status: "applied", error: undefined },
  );
  assert.deepEqual(
    reduceBackgroundJobState(
      { status: "applying" },
      { type: "apply-failed", error: "conflict" },
      messages,
    ),
    { status: "completed", error: "conflict" },
  );
  assert.deepEqual(
    reduceBackgroundJobState(
      { status: "applied" },
      { type: "applied-cleanup-failed", error: "cleanup failed" },
      messages,
    ),
    { status: "applied", error: "cleanup failed" },
    "cleanup failures after apply must never advertise retryable work",
  );
  assert.deepEqual(
    reduceBackgroundJobState(
      { status: "applying" },
      { type: "apply-uncertain", error: "manual recovery required" },
      messages,
    ),
    { status: "error", error: "manual recovery required" },
    "a throwing apply callback may have mutated files and must not be retryable",
  );
  assert.deepEqual(
    reduceBackgroundJobState(
      { status: "applying" },
      { type: "recover-interrupted-apply", error: "manual recovery required" },
      messages,
    ),
    { status: "error", error: "manual recovery required" },
    "a durable applying state has uncertain workspace effects and must not become retryable",
  );
  assert.deepEqual(
    reduceBackgroundJobState(
      { status: "applied", error: "cleanup failed" },
      { type: "applied-cleanup-succeeded" },
      messages,
    ),
    { status: "applied", error: undefined },
    "cleanup recovery must retain the applied terminal state",
  );
  assert.equal(
    reduceBackgroundJobState({ status: "running" }, { type: "begin-apply" }, messages),
    undefined,
  );
  assert.deepEqual(
    reduceBackgroundJobState({ status: "error", error: "failed" }, { type: "discard" }, messages),
    { status: "discarded", error: "failed" },
  );
});

test("background polling backs off by supervision and window activity", () => {
  assert.equal(
    nextBackgroundJobPollDelay({
      requiresSupervision: true,
      windowActive: true,
      unchangedPolls: 0,
    }),
    ACTIVE_POLL_MIN_DELAY_MS,
  );
  assert.equal(
    nextBackgroundJobPollDelay({
      requiresSupervision: true,
      windowActive: true,
      unchangedPolls: 20,
    }),
    ACTIVE_POLL_MAX_DELAY_MS,
  );
  assert.equal(
    nextBackgroundJobPollDelay({
      requiresSupervision: true,
      windowActive: false,
      unchangedPolls: 0,
    }),
    ACTIVE_POLL_MIN_DELAY_MS * INACTIVE_WINDOW_MULTIPLIER,
  );
  assert.equal(
    nextBackgroundJobPollDelay({
      requiresSupervision: false,
      windowActive: true,
      unchangedPolls: 0,
    }),
    IDLE_POLL_MIN_DELAY_MS,
  );
  assert.equal(
    nextBackgroundJobPollDelay({
      requiresSupervision: false,
      windowActive: false,
      unchangedPolls: 20,
    }),
    IDLE_POLL_MAX_DELAY_MS * INACTIVE_WINDOW_MULTIPLIER,
  );
  assert.doesNotMatch(backgroundJobsSource, /setInterval\(/u);
  assert.match(backgroundJobsSource, /onDidChangeWindowState/u);
  assert.match(backgroundJobsSource, /nextBackgroundJobPollDelay/u);
});

test("background snapshots are detached and sorted for read-only consumers", () => {
  const snapshotsSource = backgroundJobsSource.slice(
    backgroundJobsSource.indexOf("public snapshots("),
    backgroundJobsSource.indexOf("public async create("),
  );
  assert.match(snapshotsSource, /right\.updatedAt - left\.updatedAt/u);
  assert.match(snapshotsSource, /\.map\(\(job\) => structuredClone\(job\)\)/u);
});

test("background apply, cancel, and discard claim the latest durable job", () => {
  for (const [start, end] of [
    ["public async apply(", "public async cancel("],
    ["public async cancel(", "public async discard("],
    ["public async discard(", "public getTreeItem("],
  ]) {
    const operationSource = backgroundJobsSource.slice(
      backgroundJobsSource.indexOf(start),
      backgroundJobsSource.indexOf(end),
    );
    assert.match(operationSource, /beginJobOperation\(job\.id\)/u);
    assert.match(operationSource, /repository\.read\(job\.jobFile\)/u);
    assert.match(operationSource, /finishJobOperation\(job\.id\)/u);
  }
  const applySource = backgroundJobsSource.slice(
    backgroundJobsSource.indexOf("public async apply("),
    backgroundJobsSource.indexOf("public async cancel("),
  );
  assert.match(
    applySource,
    /applyJob\(job, applyable\)[\s\S]*?apply-succeeded[\s\S]*?save\(job\)[\s\S]*?cleanupIsolatedWorktree/u,
  );
  assert.match(
    applySource,
    /applyStarted = true[\s\S]*?applyJob\(job, applyable\)[\s\S]*?apply-uncertain/u,
  );
  assert.match(applySource, /validateOperationalBoundaries\(job\)/u);
});

test("interrupted apply recovery fails closed and applied cleanup never reapplies", () => {
  const pollSource = backgroundJobsSource.slice(
    backgroundJobsSource.indexOf("private async poll("),
    backgroundJobsSource.indexOf("private requestPoll("),
  );
  const recoverySource = backgroundJobsSource.slice(
    backgroundJobsSource.indexOf("private async recoverInterruptedApply("),
    backgroundJobsSource.indexOf("/** Never delete a worktree"),
  );
  const cleanupSource = backgroundJobsSource.slice(
    backgroundJobsSource.indexOf("public async cleanupApplied("),
    backgroundJobsSource.indexOf("public async discard("),
  );

  assert.match(pollSource, /recoverInterruptedApply\(current\)/u);
  assert.match(recoverySource, /job\.status !== "applying"/u);
  assert.match(recoverySource, /activeJobOperations\.has\(job\.id\)/u);
  assert.match(recoverySource, /recover-interrupted-apply[\s\S]*?await this\.save\(job\)/u);
  assert.match(cleanupSource, /job\.status !== "applied"/u);
  assert.match(cleanupSource, /isWorkerExitConfirmed\(job\)/u);
  assert.match(cleanupSource, /validateOperationalBoundaries\(job\)/u);
  assert.match(cleanupSource, /cleanupIsolatedWorktree[\s\S]*?cleanupWorkerProtocol/u);
  assert.match(cleanupSource, /applied-cleanup-succeeded[\s\S]*?save\(job\)/u);
  assert.doesNotMatch(cleanupSource, /applyJob\(/u);
});

test("orphan recovery reconciles the latest job only after confirmed worker exit", () => {
  const synchronizeSource = backgroundJobsSource.slice(
    backgroundJobsSource.indexOf("private async synchronizeCancellationStatus("),
    backgroundJobsSource.indexOf("private async recoverWorker("),
  );
  const exitedSource = backgroundJobsSource.slice(
    backgroundJobsSource.indexOf('if (result === "already-exited")'),
    backgroundJobsSource.indexOf('if (result === "signalled")'),
  );
  assert.match(synchronizeSource, /reason === "orphan"[\s\S]*?return false/u);
  assert.match(exitedSource, /repository\.read\(job\.jobFile\)[\s\S]*?workerExitConfirmed: true/u);
});

test("background repository restores jobs independently and rejects stale atomic saves", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cursor-background-repository-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const jobsRoot = join(directory, "background-jobs");
  const worktreesRoot = join(directory, "worktrees");
  await mkdir(join(worktreesRoot, "job"), { recursive: true });
  const repository = new FileBackgroundJobRepository(jobsRoot, {
    storageRoot: directory,
    worktreesRoot,
  });
  await repository.initialize();
  const jobFile = join(jobsRoot, "job.json");
  const base = {
    id: "job",
    title: "job",
    prompt: "prompt",
    workspaceRoot: directory,
    storageRoot: directory,
    jobFile,
    session: {
      id: "job",
      root: directory,
      worktreePath: join(worktreesRoot, "job"),
      baselineCommit: "a".repeat(40),
      baselineFiles: {},
      initialChangedFiles: [],
      baselinesFolder: "background-baselines",
    },
    status: "running",
    createdAt: 1,
    updatedAt: 1,
    workerToken: "secret",
  };

  assert.equal(isBackgroundJob({ ...base, session: {} }), false);
  assert.equal(
    isBackgroundJob({
      ...base,
      session: { ...base.session, id: "another-job" },
    }),
    false,
  );
  await assert.rejects(
    repository.save({ ...base, storageRoot: join(directory, "other-storage") }),
    /storage root/u,
  );
  await assert.rejects(
    repository.save({
      ...base,
      session: { ...base.session, worktreePath: join(directory, "outside", "job") },
    }),
    /worktree/u,
  );

  const backupName = "b".repeat(64);
  const fakeBackup = join(directory, "background-baselines", "job", backupName);
  await mkdir(fakeBackup, { recursive: true });
  await assert.rejects(
    repository.validateOperationalBoundaries({
      ...base,
      session: {
        ...base.session,
        baselineFiles: {
          "tracked.txt": {
            existed: true,
            hash: "c".repeat(64),
            backupName,
          },
        },
      },
    }),
    /stable file/u,
  );
  await rm(fakeBackup, { recursive: true, force: true });

  await repository.save(base);
  await repository.validateOperationalBoundaries(base);
  const first = await repository.read(jobFile);
  const second = await repository.read(jobFile);
  first.assistantText = "first";
  second.assistantText = "stale second";
  await repository.save(first);
  await assert.rejects(repository.save(second), BackgroundJobWriteConflictError);
  assert.equal((await repository.read(jobFile)).assistantText, "first");

  const cancellationFile = backgroundWorkerProtocolPaths(jobFile).cancellation;
  const terminalUpdate = {};
  Object.defineProperty(terminalUpdate, "assistantText", {
    enumerable: true,
    get() {
      writeFileSync(
        cancellationFile,
        JSON.stringify({
          token: "secret",
          requestedAt: Date.now(),
          reason: "orphan",
        }),
        "utf8",
      );
      return "completed despite orphan cleanup";
    },
  });
  await saveTerminalJob(jobFile, "secret", "completed", terminalUpdate);
  assert.equal((await repository.read(jobFile)).status, "completed");

  await writeFile(`${jobFile}.heartbeat.json`, "{}", "utf8");
  await writeFile(join(jobsRoot, "broken.json"), "{", "utf8");
  const restored = await repository.list();
  assert.equal(restored.filter((entry) => entry.ok).length, 1);
  assert.equal(restored.filter((entry) => !entry.ok).length, 1);
  assert.deepEqual(
    (await readdir(jobsRoot)).filter((file) => file.endsWith(".tmp")),
    [],
  );
});
