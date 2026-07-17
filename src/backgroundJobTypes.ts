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
}
