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
