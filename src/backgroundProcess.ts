import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  isAuthenticatedWorkerInstance,
  type BackgroundWorkerHeartbeat,
} from "./backgroundWorkerProtocol.js";

const execFile = promisify(execFileCallback);
const MAX_PROCESS_INSPECTION_OUTPUT = 1024 * 1024;

export interface BackgroundProcessIdentity {
  pid: number;
  /** An OS-provided process creation marker that remains stable for the process lifetime. */
  startId: string;
  commandLine?: string;
  argv?: readonly string[];
  executablePath?: string;
}

export type BackgroundProcessInspection =
  | { state: "running"; identity: BackgroundProcessIdentity }
  | { state: "missing" }
  | { state: "unavailable"; error: string };

export interface BackgroundWorkerProcessExpectation {
  pid: number;
  token: string;
  startedAt: number | undefined;
  processStartId: string | undefined;
  workerFile: string;
  jobFile: string;
  executableFile?: string;
}

export interface ManagedBackgroundChild {
  pid?: number;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type BackgroundWorkerHardStopResult =
  | "signalled"
  | "already-exited"
  | "identity-mismatch"
  | "inspection-unavailable"
  | "signal-failed";

export interface BackgroundWorkerHardStopDependencies {
  managedChild?: ManagedBackgroundChild;
  inspectProcess?: (pid: number) => Promise<BackgroundProcessInspection>;
  signalProcess?: (pid: number) => void;
}

function validPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function missingProcessError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ESRCH" || code === "ENOENT";
}

function normalizeCommandValue(value: string, caseInsensitive: boolean): string {
  const normalized = value.replaceAll("\\", "/");
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

function commandLineIdentifiesWorker(
  identity: BackgroundProcessIdentity,
  expected: BackgroundWorkerProcessExpectation,
): boolean {
  const caseInsensitive = process.platform === "win32";
  const required = [expected.workerFile, expected.jobFile, expected.token]
    .map((value) => normalizeCommandValue(value, caseInsensitive));
  if (identity.argv) {
    const actual = identity.argv.map((value) => normalizeCommandValue(value, caseInsensitive));
    return required.every((value) => actual.includes(value));
  }
  if (identity.commandLine) {
    const commandLine = normalizeCommandValue(identity.commandLine, caseInsensitive);
    return required.every((value) => commandLine.includes(value));
  }
  // Windows exposes an exact process creation time and executable path to
  // standard users even when WMI command-line access is restricted.
  return Boolean(
    identity.executablePath
      && expected.executableFile
      && normalizeCommandValue(identity.executablePath, true)
        === normalizeCommandValue(expected.executableFile, true),
  );
}

/**
 * Require every persisted and live identity component to agree before a PID is
 * eligible for signalling. This deliberately fails closed for legacy jobs.
 */
export function isSameBackgroundWorkerProcess(
  expected: BackgroundWorkerProcessExpectation,
  heartbeat: BackgroundWorkerHeartbeat | undefined,
  identity: BackgroundProcessIdentity,
): boolean {
  return Boolean(
    heartbeat
      && identity.pid === expected.pid
      && expected.processStartId
      && identity.startId === expected.processStartId
      && heartbeat.processStartId === expected.processStartId
      && isAuthenticatedWorkerInstance(
        expected.token,
        expected.pid,
        expected.startedAt,
        heartbeat,
      )
      && commandLineIdentifiesWorker(identity, expected),
  );
}

async function inspectLinuxProcess(pid: number): Promise<BackgroundProcessInspection> {
  try {
    const [stat, commandLineBuffer] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile(`/proc/${pid}/cmdline`),
    ]);
    // `comm` is parenthesized and may itself contain spaces or `)`, so fields
    // after it must be located from the final closing parenthesis.
    const commandEnd = stat.lastIndexOf(")");
    const fields = commandEnd >= 0 ? stat.slice(commandEnd + 1).trim().split(/\s+/u) : [];
    // The sliced fields begin at proc(5) field 3; starttime is field 22.
    const startTicks = fields[19];
    if (!startTicks || !/^\d+$/u.test(startTicks)) {
      return { state: "unavailable", error: "Linux process start time was unreadable." };
    }
    const argv = commandLineBuffer.toString("utf8").split("\0").filter(Boolean);
    return {
      state: "running",
      identity: {
        pid,
        startId: `linux:${startTicks}`,
        commandLine: argv.join(" "),
        argv,
      },
    };
  } catch (error) {
    if (missingProcessError(error)) {
      return { state: "missing" };
    }
    return { state: "unavailable", error: errorMessage(error) };
  }
}

async function inspectWindowsProcess(pid: number): Promise<BackgroundProcessInspection> {
  const script = [
    `$target = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    "if ($null -eq $target) { [Console]::Out.Write('null') } else { [Console]::Out.Write(([pscustomobject]@{ ProcessId = $target.Id; StartTicks = $target.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(); ExecutablePath = $target.Path } | ConvertTo-Json -Compress)) }",
  ].join("; ");
  try {
    const { stdout } = await execFile("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ], {
      windowsHide: true,
      encoding: "utf8",
      maxBuffer: MAX_PROCESS_INSPECTION_OUTPUT,
    });
    const raw = stdout.trim();
    if (!raw || raw === "null") {
      return { state: "missing" };
    }
    const parsed = JSON.parse(raw) as {
      ProcessId?: number;
      StartTicks?: string;
      ExecutablePath?: string;
    };
    if (
      parsed.ProcessId !== pid
      || typeof parsed.StartTicks !== "string"
      || !/^\d+$/u.test(parsed.StartTicks)
      || typeof parsed.ExecutablePath !== "string"
      || !parsed.ExecutablePath
    ) {
      return { state: "unavailable", error: "Windows process identity was incomplete." };
    }
    return {
      state: "running",
      identity: {
        pid,
        startId: `win32:${parsed.StartTicks}`,
        executablePath: parsed.ExecutablePath,
      },
    };
  } catch (error) {
    return { state: "unavailable", error: errorMessage(error) };
  }
}

async function inspectPsProcess(pid: number): Promise<BackgroundProcessInspection> {
  try {
    const [{ stdout: startedAt }, { stdout: commandLine }] = await Promise.all([
      execFile("ps", ["-p", String(pid), "-o", "lstart="], {
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: MAX_PROCESS_INSPECTION_OUTPUT,
      }),
      execFile("ps", ["-ww", "-p", String(pid), "-o", "command="], {
        windowsHide: true,
        encoding: "utf8",
        maxBuffer: MAX_PROCESS_INSPECTION_OUTPUT,
      }),
    ]);
    if (!startedAt.trim() || !commandLine.trim()) {
      return { state: "missing" };
    }
    return {
      state: "running",
      identity: {
        pid,
        startId: `${process.platform}:${startedAt.trim()}`,
        commandLine: commandLine.trim(),
      },
    };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 1 || code === "1") {
      return { state: "missing" };
    }
    return { state: "unavailable", error: errorMessage(error) };
  }
}

/** Inspect a PID without signalling it, returning a stable OS process start marker. */
export async function inspectBackgroundProcess(pid: number): Promise<BackgroundProcessInspection> {
  if (!validPid(pid)) {
    return { state: "missing" };
  }
  if (process.platform === "linux") {
    return inspectLinuxProcess(pid);
  }
  if (process.platform === "win32") {
    return inspectWindowsProcess(pid);
  }
  if (["darwin", "freebsd", "openbsd", "aix", "sunos"].includes(process.platform)) {
    return inspectPsProcess(pid);
  }
  return {
    state: "unavailable",
    error: `Process identity inspection is unsupported on ${process.platform}.`,
  };
}

/**
 * Hard-stop a managed worker after the caller has observed its grace period.
 * A retained child handle is only the signalling transport; every live worker
 * still requires authenticated heartbeat and current OS identity agreement.
 */
export async function hardStopBackgroundWorkerProcess(
  expected: BackgroundWorkerProcessExpectation,
  heartbeat: BackgroundWorkerHeartbeat | undefined,
  dependencies: BackgroundWorkerHardStopDependencies = {},
): Promise<BackgroundWorkerHardStopResult> {
  const child = dependencies.managedChild;
  if (child) {
    if (child.pid !== expected.pid) {
      return "identity-mismatch";
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      return "already-exited";
    }
  }

  const inspectProcess = dependencies.inspectProcess ?? inspectBackgroundProcess;
  const inspection = await inspectProcess(expected.pid);
  if (inspection.state === "missing") {
    return "already-exited";
  }
  if (inspection.state === "unavailable") {
    return "inspection-unavailable";
  }
  if (!isSameBackgroundWorkerProcess(expected, heartbeat, inspection.identity)) {
    return "identity-mismatch";
  }
  try {
    if (child) {
      return child.kill("SIGKILL") ? "signalled" : "already-exited";
    }
    (dependencies.signalProcess ?? ((pid: number) => process.kill(pid, "SIGKILL")))(expected.pid);
    return "signalled";
  } catch (error) {
    return missingProcessError(error) ? "already-exited" : "signal-failed";
  }
}
