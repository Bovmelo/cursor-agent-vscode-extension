import { Agent } from "@cursor/sdk";
import type { IsolatedWorktreeSession } from "./isolatedWorktree.js";
import type { LiveChatRun } from "./chatTypes.js";
import type { FileOwnershipLease } from "./parallelOwnership.js";

export type CursorAgent = Awaited<ReturnType<typeof Agent.create>>;
export type CursorRun = Awaited<ReturnType<CursorAgent["send"]>>;

/** Mutable resources for one conversation's currently active SDK run. */
export class ChatRuntime {
  public agent?: CursorAgent;
  public run?: CursorRun;
  public rootsKey?: string;
  public busy = false;
  public pendingCancel = false;
  public preparationAbort?: AbortController;
  public forceNextRun = false;
  public cancellation?: Promise<void>;
  public mutating = false;
  public overlappedMutation = false;
  public changeSessionId?: string;
  public live?: LiveChatRun;
  public isolatedWorktree?: IsolatedWorktreeSession;
  public isolationKind?: "parallel" | "windows-safe";
  public ownershipLease?: FileOwnershipLease;
}
