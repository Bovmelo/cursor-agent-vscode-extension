import { rename, readFile, writeFile } from "node:fs/promises";
import { Agent, type LocalAgentOptions, type RunResult } from "@cursor/sdk";
import type { BackgroundJob, BackgroundWorkerInput } from "./backgroundJobTypes.js";

const SUPPORTS_LOCAL_SANDBOX = process.platform !== "win32";

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

async function main(): Promise<void> {
  const jobFile = process.argv[2];
  if (!jobFile) {
    throw new Error("Background job file argument is missing.");
  }
  const input = JSON.parse(await readStandardInput()) as BackgroundWorkerInput;
  const job = await loadJob(jobFile);
  job.pid = process.pid;
  job.status = "running";
  await saveJob(job);

  const local: LocalAgentOptions = {
    cwd: job.session.worktreePath,
    autoReview: input.approvalMode !== "full-access",
    sandboxOptions: {
      enabled: SUPPORTS_LOCAL_SANDBOX && input.approvalMode !== "full-access",
    },
    settingSources: ["all"],
  };
  let agent: Awaited<ReturnType<typeof Agent.create>> | undefined;
  let run: Awaited<ReturnType<Awaited<ReturnType<typeof Agent.create>>["send"]>> | undefined;
  let cancelled = false;
  const cancel = (): void => {
    cancelled = true;
    if (run?.supports("cancel")) {
      void run.cancel();
    }
  };
  process.once("SIGTERM", cancel);
  process.once("SIGINT", cancel);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    agent = await Agent.create({
      apiKey: input.apiKey,
      model: input.model,
      local,
      name: `Background: ${job.title}`,
    });
    if (cancelled) {
      job.status = "cancelled";
      await saveJob(job);
      return;
    }
    run = await agent.send(job.prompt, { model: input.model, mode: "agent" });
    if (cancelled && run.supports("cancel")) {
      await run.cancel();
    }
    timer = setTimeout(cancel, Math.max(1, input.maxMinutes) * 60 * 1000);
    let assistantText = "";
    const stream = run.stream();
    const resultPromise = run.wait();
    const terminal = resultPromise.then((result) => ({ type: "result" as const, result }));
    let result: RunResult | undefined;
    while (!result) {
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
    result ??= await resultPromise;
    job.assistantText = assistantText;
    job.usage = result.usage;
    if (cancelled || result.status === "cancelled") {
      job.status = "cancelled";
    } else if (result.status === "finished") {
      job.status = "completed";
    } else {
      job.status = "error";
      job.error = result.error?.message || "The background agent failed.";
    }
    await saveJob(job);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    if (agent) {
      await agent[Symbol.asyncDispose]().catch(() => {});
    }
  }
}

void main().catch(async (error) => {
  const jobFile = process.argv[2];
  if (!jobFile) {
    process.exitCode = 1;
    return;
  }
  try {
    const job = await loadJob(jobFile);
    job.status = "error";
    job.error = error instanceof Error ? error.message : String(error);
    await saveJob(job);
  } catch {
    // The parent will report an unreadable job file.
  }
  process.exitCode = 1;
});
