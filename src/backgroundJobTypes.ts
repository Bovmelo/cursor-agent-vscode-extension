import * as path from "node:path";
import type { ModelSelection, TokenUsage } from "@cursor/sdk";
import type { IsolatedWorktreeSession } from "./isolatedWorktree.js";

export type BackgroundJobStatus =
  | "starting"
  | "running"
  | "completed"
  | "applying"
  | "applied"
  | "cancelled"
  | "discarded"
  | "error";

export interface BackgroundJob {
  id: string;
  title: string;
  prompt: string;
  workspaceRoot: string;
  storageRoot: string;
  jobFile: string;
  session: IsolatedWorktreeSession;
  status: BackgroundJobStatus;
  createdAt: number;
  updatedAt: number;
  pid?: number;
  workerToken?: string;
  /** Worker-selected wall-clock start time, used with its authenticated heartbeat. */
  workerStartedAt?: number;
  /** OS process creation marker. Missing legacy values are never used for PID-based hard stops. */
  workerProcessStartId?: string;
  maxMinutes?: number;
  assistantText?: string;
  error?: string;
  usage?: TokenUsage;
  notified?: boolean;
}

export interface BackgroundWorkerInput {
  apiKey: string;
  model: ModelSelection;
  approvalMode: string;
  maxMinutes: number;
  /** Captured synchronously by the trusted host immediately before spawn. */
  workspaceTrustedAtLaunch: boolean;
}

const BACKGROUND_JOB_STATUSES: ReadonlySet<BackgroundJobStatus> = new Set([
  "starting",
  "running",
  "completed",
  "applying",
  "applied",
  "cancelled",
  "discarded",
  "error",
]);

/** Validate the durable repository boundary before recovery touches a record. */
export function isBackgroundJob(value: unknown): value is BackgroundJob {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<BackgroundJob>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    typeof candidate.title === "string" &&
    typeof candidate.prompt === "string" &&
    typeof candidate.workspaceRoot === "string" &&
    typeof candidate.storageRoot === "string" &&
    typeof candidate.jobFile === "string" &&
    isBackgroundJobSession(candidate.session, candidate.id, candidate.workspaceRoot) &&
    BACKGROUND_JOB_STATUSES.has(candidate.status as BackgroundJobStatus) &&
    Number.isFinite(candidate.createdAt) &&
    Number.isFinite(candidate.updatedAt) &&
    (candidate.pid === undefined || (Number.isSafeInteger(candidate.pid) && candidate.pid > 0)) &&
    (candidate.workerToken === undefined || typeof candidate.workerToken === "string") &&
    (candidate.workerStartedAt === undefined || Number.isFinite(candidate.workerStartedAt)) &&
    (candidate.workerProcessStartId === undefined ||
      typeof candidate.workerProcessStartId === "string") &&
    (candidate.maxMinutes === undefined ||
      (Number.isFinite(candidate.maxMinutes) && candidate.maxMinutes > 0))
  );
}

function isBackgroundJobSession(
  value: unknown,
  expectedId: string,
  expectedRoot: string,
): value is IsolatedWorktreeSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const session = value as Partial<IsolatedWorktreeSession>;
  if (
    session.id !== expectedId ||
    typeof session.root !== "string" ||
    !path.isAbsolute(session.root) ||
    !samePath(session.root, expectedRoot) ||
    typeof session.worktreePath !== "string" ||
    !path.isAbsolute(session.worktreePath) ||
    samePath(session.worktreePath, session.root) ||
    typeof session.baselineCommit !== "string" ||
    !/^[0-9a-f]{40,64}$/iu.test(session.baselineCommit) ||
    session.baselinesFolder !== "background-baselines" ||
    !Array.isArray(session.initialChangedFiles) ||
    !session.initialChangedFiles.every(isSafeRelativePath) ||
    !session.baselineFiles ||
    typeof session.baselineFiles !== "object" ||
    Array.isArray(session.baselineFiles)
  ) {
    return false;
  }
  return Object.entries(session.baselineFiles).every(([relative, file]) => {
    if (!isSafeRelativePath(relative) || !file || typeof file !== "object") {
      return false;
    }
    if (!file.existed) {
      return file.hash === undefined && file.backupName === undefined;
    }
    return (
      typeof file.hash === "string" &&
      /^[0-9a-f]{64}$/iu.test(file.hash) &&
      typeof file.backupName === "string" &&
      /^[0-9a-f]{64}$/iu.test(file.backupName)
    );
  });
}

function isSafeRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.split(/[\\/]/u).some((segment) => !segment || segment === "." || segment === "..")
  );
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const normalized = path.resolve(value);
    return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
  };
  return normalize(left) === normalize(right);
}
