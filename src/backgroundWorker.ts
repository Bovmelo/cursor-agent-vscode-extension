import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, type LocalAgentOptions, type RunResult } from "@cursor/sdk";
import type { BackgroundJob, BackgroundJobStatus, BackgroundWorkerInput } from "./backgroundJobTypes.js";
import {
  backgroundWorkerProtocolPaths,
  isAuthenticatedWorkerCancellation,
  type BackgroundWorkerCancellation,
  type BackgroundWorkerHeartbeat,
} from "./backgroundWorkerProtocol.js";

const SUPPORTS_LOCAL_SANDBOX = process.platform !== "win32";
const HEARTBEAT_INTERVAL_MS = 5_000;
const CANCELLATION_POLL_MS = 1_000;
const HARD_CANCEL_GRACE_MS = 5_000;
const terminalSaveQueues = new Map<string, Promise<void>>();

async function readStandardInput(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function loadJob(jobFile: string): Promise<BackgroundJob> {
  return JSON.parse(await readFile(jobFile, "utf8")) as BackgroundJob;
}

async function saveJob(job: BackgroundJob): Promise<void> {
  job.updatedAt = Date.now();
  const temporary = `${job.jobFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(job, undefined, 2), "utf8");
  await rename(temporary, job.jobFile);
}

async function saveTerminalJobNow(
  jobFile: string,
  workerToken: string,
  status: BackgroundJobStatus,
  update: Partial<Pick<BackgroundJob, "assistantText" | "usage" | "error">> = {},
): Promise<void> {
  let latest = await loadJob(jobFile);
  if (latest.workerToken !== workerToken || latest.status === "cancelled") {
    return;
  }
  if (status !== "cancelled" && await cancellationRequested(jobFile, workerToken)) {
    latest.status = "cancelled";
    latest.error = undefined;
    await saveJob(latest);
    return;
  }
  latest.status = status;
  Object.assign(latest, update);
  await saveJob(latest);

  // The host creates the authenticated sidecar before persisting `cancelled`.
  // Checking again after the atomic rename closes the window where the worker
  // loaded `running`, the host saved `cancelled`, and the worker then replaced it.
  if (status === "cancelled" || !(await cancellationRequested(jobFile, workerToken))) {
    return;
  }
  latest = await loadJob(jobFile);
  if (latest.workerToken !== workerToken || latest.status === "cancelled") {
    return;
  }
  latest.status = "cancelled";
  latest.error = undefined;
  await saveJob(latest);
}

export async function saveTerminalJob(
  jobFile: string,
  workerToken: string,
  status: BackgroundJobStatus,
  update: Partial<Pick<BackgroundJob, "assistantText" | "usage" | "error">> = {},
): Promise<void> {
  const previous = terminalSaveQueues.get(jobFile) ?? Promise.resolve();
  const operation = previous.then(() => saveTerminalJobNow(jobFile, workerToken, status, update));
  const queued = operation.catch(() => {});
  terminalSaveQueues.set(jobFile, queued);
  try {
    await operation;
  } finally {
    if (terminalSaveQueues.get(jobFile) === queued) {
      terminalSaveQueues.delete(jobFile);
    }
  }
}

async function cancellationRequested(jobFile: string, workerToken: string): Promise<boolean> {
  try {
    const file = backgroundWorkerProtocolPaths(jobFile).cancellation;
    const cancellation = JSON.parse(await readFile(file, "utf8")) as BackgroundWorkerCancellation;
    return isAuthenticatedWorkerCancellation(workerToken, cancellation);
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const jobFile = process.argv[2];
  const workerToken = process.argv[3];
  if (!jobFile || !workerToken) {
    throw new Error("Background worker job file or identity token is missing.");
  }
  const input = JSON.parse(await readStandardInput()) as BackgroundWorkerInput;
  let apiKey: string | undefined = input.apiKey;
  input.apiKey = "";
  const model = input.model;
  const approvalMode = input.approvalMode;
  const maxMinutes = input.maxMinutes;
  const job = await loadJob(jobFile);
  if (job.workerToken !== workerToken) {
    throw new Error("Background worker identity does not match the job.");
  }
  if (job.status !== "starting") {
    apiKey = undefined;
    return;
  }
  if (await cancellationRequested(jobFile, workerToken)) {
    apiKey = undefined;
    await saveTerminalJob(jobFile, workerToken, "cancelled");
    return;
  }
  job.pid = process.pid;
  job.status = "running";
  await saveJob(job);
  if (await cancellationRequested(jobFile, workerToken)) {
    apiKey = undefined;
    await saveTerminalJob(jobFile, workerToken, "cancelled");
    return;
  }

  const protocol = backgroundWorkerProtocolPaths(jobFile);
  let heartbeatQueue = Promise.resolve();
  const queueHeartbeat = (): void => {
    heartbeatQueue = heartbeatQueue.catch(() => {}).then(async () => {
      const heartbeat: BackgroundWorkerHeartbeat = {
        token: workerToken,
        pid: process.pid,
        updatedAt: Date.now(),
      };
      const temporary = `${protocol.heartbeat}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify(heartbeat), "utf8");
      await rename(temporary, protocol.heartbeat);
    });
  };
  queueHeartbeat();
  const heartbeatTimer = setInterval(queueHeartbeat, HEARTBEAT_INTERVAL_MS);

  const local: LocalAgentOptions = {
    cwd: job.session.worktreePath,
    autoReview: approvalMode !== "full-access",
    sandboxOptions: {
      enabled: SUPPORTS_LOCAL_SANDBOX && approvalMode !== "full-access",
    },
    settingSources: ["all"],
  };
  let agent: Awaited<ReturnType<typeof Agent.create>> | undefined;
  let run: Awaited<ReturnType<Awaited<ReturnType<typeof Agent.create>>["send"]>> | undefined;
  let cancellationReason: "requested" | "timeout" | undefined;
  let hardExitTimer: ReturnType<typeof setTimeout> | undefined;
  const requestCancellation = (reason: "requested" | "timeout"): void => {
    cancellationReason ??= reason;
    if (run?.supports("cancel")) {
      void run.cancel().catch(() => {});
    }
    if (!hardExitTimer) {
      void saveTerminalJob(
        jobFile,
        workerToken,
        cancellationReason === "timeout" ? "error" : "cancelled",
        cancellationReason === "timeout"
          ? { error: "The background agent exceeded its execution-time budget." }
          : {},
      ).catch(() => {});
      hardExitTimer = setTimeout(() => {
        process.exit(cancellationReason === "timeout" ? 124 : 130);
      }, HARD_CANCEL_GRACE_MS);
    }
  };
  process.once("SIGTERM", () => requestCancellation("requested"));
  process.once("SIGINT", () => requestCancellation("requested"));

  let cancellationCheck = Promise.resolve();
  const checkCancellation = (): Promise<void> => {
    cancellationCheck = cancellationCheck.catch(() => {}).then(async () => {
      if (await cancellationRequested(jobFile, workerToken)) {
        requestCancellation("requested");
      }
    });
    return cancellationCheck;
  };
  const cancellationTimer = setInterval(() => void checkCancellation(), CANCELLATION_POLL_MS);
  const executionTimer = setTimeout(
    () => requestCancellation("timeout"),
    Math.max(1, maxMinutes) * 60 * 1000,
  );

  try {
    await checkCancellation();
    if (cancellationReason) {
      return;
    }
    if (!apiKey) {
      throw new Error("Background worker API key is missing.");
    }
    agent = await Agent.create({
      apiKey,
      model,
      local,
      name: `Background: ${job.title}`,
    });
    apiKey = undefined;
    if (cancellationReason) {
      return;
    }
    run = await agent.send(job.prompt, { model, mode: "agent" });
    if (cancellationReason && run.supports("cancel")) {
      await run.cancel().catch(() => {});
    }
    let assistantText = "";
    const stream = run.stream();
    const resultPromise = run.wait();
    const terminal = resultPromise.then((result) => ({ type: "result" as const, result }));
    let result: RunResult | undefined;
    while (!result && !cancellationReason) {
      const next = await Promise.race([
        stream.next().then((event) => ({ type: "event" as const, event })),
        terminal,
      ]);
      if (next.type === "result") {
        result = next.result;
        void stream.return(undefined).catch(() => {});
        break;
      }
      if (next.event.done) {
        break;
      }
      if (next.event.value.type === "assistant") {
        for (const block of next.event.value.message.content) {
          if (block.type === "text" && block.text) {
            assistantText += block.text;
          }
        }
      }
    }
    if (cancellationReason) {
      await saveTerminalJob(
        jobFile,
        workerToken,
        cancellationReason === "timeout" ? "error" : "cancelled",
        cancellationReason === "timeout"
          ? { error: "The background agent exceeded its execution-time budget." }
          : {},
      );
      return;
    }
    result ??= await resultPromise;
    if (result.status === "cancelled") {
      await saveTerminalJob(jobFile, workerToken, "cancelled", {
        assistantText,
        usage: result.usage,
      });
    } else if (result.status === "finished") {
      await saveTerminalJob(jobFile, workerToken, "completed", {
        assistantText,
        usage: result.usage,
        error: undefined,
      });
    } else {
      await saveTerminalJob(jobFile, workerToken, "error", {
        assistantText,
        usage: result.usage,
        error: result.error?.message || "The background agent failed.",
      });
    }
  } catch (error) {
    if (cancellationReason) {
      await saveTerminalJob(
        jobFile,
        workerToken,
        cancellationReason === "timeout" ? "error" : "cancelled",
        cancellationReason === "timeout"
          ? { error: "The background agent exceeded its execution-time budget." }
          : {},
      );
      return;
    }
    throw error;
  } finally {
    clearTimeout(executionTimer);
    clearInterval(cancellationTimer);
    clearInterval(heartbeatTimer);
    await cancellationCheck.catch(() => {});
    if (agent) {
      await agent[Symbol.asyncDispose]().catch(() => {});
    }
    if (hardExitTimer) {
      clearTimeout(hardExitTimer);
    }
    await heartbeatQueue.catch(() => {});
    await Promise.all([
      unlink(protocol.heartbeat).catch(() => undefined),
      unlink(protocol.cancellation).catch(() => undefined),
    ]);
  }
}

async function reportFatalWorkerError(error: unknown): Promise<void> {
  const jobFile = process.argv[2];
  const workerToken = process.argv[3];
  if (!jobFile || !workerToken) {
    process.exitCode = 1;
    return;
  }
  try {
    await saveTerminalJob(jobFile, workerToken, "error", {
      error: error instanceof Error ? error.message : String(error),
    });
  } catch {
    // The parent will report an unreadable or unresponsive job file.
  }
  process.exitCode = 1;
}

const workerEntrypoint = process.argv[1];
const currentModule = fileURLToPath(import.meta.url);
function canonicalEntrypoint(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return resolve(file);
  }
}
const isDirectExecution = workerEntrypoint !== undefined
  && (process.platform === "win32"
    ? canonicalEntrypoint(workerEntrypoint).toLowerCase()
      === canonicalEntrypoint(currentModule).toLowerCase()
    : canonicalEntrypoint(workerEntrypoint) === canonicalEntrypoint(currentModule));
if (isDirectExecution) {
  void main().catch(reportFatalWorkerError);
}
