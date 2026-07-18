import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, type LocalAgentOptions, type RunResult } from "@cursor/sdk";
import type { BackgroundJob, BackgroundJobStatus, BackgroundWorkerInput } from "./backgroundJobTypes.js";
import { inspectBackgroundProcess } from "./backgroundProcess.js";
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
const WORKER_STARTED_AT = Date.now();
const DEADLINE_ERROR = "The background agent exceeded its execution-time budget.";
const UNRESPONSIVE_ERROR = "The detached background worker stopped responding before reporting a result.";
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
  const cancellation = await readCancellationRequest(jobFile, workerToken);
  if (cancellation) {
    if (applyCancellation(latest, cancellation)) {
      await saveJob(latest);
    }
    return;
  }
  latest.status = status;
  Object.assign(latest, update);
  await saveJob(latest);

  // The host creates the authenticated sidecar before persisting `cancelled`.
  // Checking again after the atomic rename closes the window where the worker
  // loaded `running`, the host saved `cancelled`, and the worker then replaced it.
  const lateCancellation = await readCancellationRequest(jobFile, workerToken);
  if (!lateCancellation) {
    return;
  }
  latest = await loadJob(jobFile);
  if (latest.workerToken !== workerToken || latest.status === "cancelled") {
    return;
  }
  if (applyCancellation(latest, lateCancellation)) {
    await saveJob(latest);
  }
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

function applyCancellation(
  job: BackgroundJob,
  cancellation: BackgroundWorkerCancellation,
): boolean {
  if (
    cancellation.reason === "orphan"
    && !["starting", "running"].includes(job.status)
  ) {
    return false;
  }
  if (cancellation.reason === "deadline") {
    job.status = "error";
    job.error = DEADLINE_ERROR;
  } else if (cancellation.reason === "unresponsive") {
    job.status = "error";
    job.error = UNRESPONSIVE_ERROR;
  } else {
    job.status = "cancelled";
    job.error = undefined;
  }
  return true;
}

async function readCancellationRequest(
  jobFile: string,
  workerToken: string,
): Promise<BackgroundWorkerCancellation | undefined> {
  try {
    const file = backgroundWorkerProtocolPaths(jobFile).cancellation;
    const cancellation = JSON.parse(await readFile(file, "utf8")) as BackgroundWorkerCancellation;
    return isAuthenticatedWorkerCancellation(workerToken, cancellation) ? cancellation : undefined;
  } catch {
    return undefined;
  }
}

async function cancellationRequested(jobFile: string, workerToken: string): Promise<boolean> {
  return (await readCancellationRequest(jobFile, workerToken)) !== undefined;
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
  if (input.workspaceTrustedAtLaunch !== true) {
    apiKey = undefined;
    await saveTerminalJob(jobFile, workerToken, "error", {
      error: "Background worker launch was rejected because trusted-workspace authorization is missing.",
    });
    return;
  }
  if (await cancellationRequested(jobFile, workerToken)) {
    apiKey = undefined;
    await saveTerminalJob(jobFile, workerToken, "cancelled");
    return;
  }
  const processInspection = await inspectBackgroundProcess(process.pid);
  job.pid = process.pid;
  job.workerStartedAt = WORKER_STARTED_AT;
  job.workerProcessStartId = processInspection.state === "running"
    ? processInspection.identity.startId
    : undefined;
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
        startedAt: WORKER_STARTED_AT,
        processStartId: job.workerProcessStartId,
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
    settingSources: input.workspaceTrustedAtLaunch ? ["all"] : [],
  };
  let agent: Awaited<ReturnType<typeof Agent.create>> | undefined;
  let run: Awaited<ReturnType<Awaited<ReturnType<typeof Agent.create>>["send"]>> | undefined;
  let cancellationReason: "requested" | "timeout" | "unresponsive" | undefined;
  let hardExitTimer: ReturnType<typeof setTimeout> | undefined;
  const cancellationTerminal = (): {
    status: BackgroundJobStatus;
    update: Partial<Pick<BackgroundJob, "error">>;
    exitCode: number;
  } => {
    if (cancellationReason === "timeout") {
      return { status: "error", update: { error: DEADLINE_ERROR }, exitCode: 124 };
    }
    if (cancellationReason === "unresponsive") {
      return { status: "error", update: { error: UNRESPONSIVE_ERROR }, exitCode: 125 };
    }
    return { status: "cancelled", update: {}, exitCode: 130 };
  };
  const requestCancellation = (reason: "requested" | "timeout" | "unresponsive"): void => {
    cancellationReason ??= reason;
    if (run?.supports("cancel")) {
      void run.cancel().catch(() => {});
    }
    if (!hardExitTimer) {
      const terminal = cancellationTerminal();
      void saveTerminalJob(jobFile, workerToken, terminal.status, terminal.update).catch(() => {});
      hardExitTimer = setTimeout(() => {
        process.exit(cancellationTerminal().exitCode);
      }, HARD_CANCEL_GRACE_MS);
    }
  };
  process.once("SIGTERM", () => requestCancellation("requested"));
  process.once("SIGINT", () => requestCancellation("requested"));

  let cancellationCheck = Promise.resolve();
  const checkCancellation = (): Promise<void> => {
    cancellationCheck = cancellationCheck.catch(() => {}).then(async () => {
      const cancellation = await readCancellationRequest(jobFile, workerToken);
      if (cancellation) {
        requestCancellation(
          cancellation.reason === "deadline"
            ? "timeout"
            : cancellation.reason === "unresponsive" ? "unresponsive" : "requested",
        );
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
      const terminal = cancellationTerminal();
      await saveTerminalJob(jobFile, workerToken, terminal.status, terminal.update);
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
      const terminal = cancellationTerminal();
      await saveTerminalJob(jobFile, workerToken, terminal.status, terminal.update);
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
