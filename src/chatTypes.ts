import type { ModelSelection, TokenUsage } from "@cursor/sdk";

export type RunProfile = "agent" | "plan" | "multitask";

export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  error?: boolean;
  files?: string[];
  attachments?: Array<string | TranscriptAttachment>;
  progress?: ToolProgressEntry[];
  progressState?: "completed" | "stopped" | "error";
}

export interface TranscriptAttachment {
  path: string;
  label: string;
}

export interface ToolProgressEntry {
  id: string;
  text: string;
  status: "running" | "completed" | "error" | "stopped";
}

export interface WorkspaceFileItem {
  path: string;
  label: string;
  description: string;
}

export interface DroppedFileUpload {
  name: string;
  data: Uint8Array;
}

export interface AttachedFileReference {
  displayPath: string;
  agentPath: string;
  external: boolean;
}

export interface EditorContextSnapshot {
  filePath: string;
  languageId: string;
  startLine?: number;
  endLine?: number;
  selectedText?: string;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  agentId?: string;
  /** Persisted workspace folder URI for multi-root chat cwd. */
  workspaceFolderUri?: string;
  attachmentRoot?: string;
  pinned?: boolean;
  experimentGroupId?: string;
  orchestratorExperimentId?: string;
  orchestratorRole?: "plan" | "subtask" | "synthesis";
  tokenUsage?: TokenUsage;
  transcript: TranscriptEntry[];
}

export interface QueuedMessage {
  id: string;
  conversationId: string;
  prompt: string;
  attachContext: boolean;
  files: string[];
  profile: RunProfile;
  skills: string[];
  model: ModelSelection;
  kind: "queued" | "interrupt";
  editorContext?: EditorContextSnapshot;
  internalRepair?: boolean;
  commandId?: string;
  includeProjectMemory?: boolean;
}

export interface LiveChatRun {
  userEntry: TranscriptEntry;
  assistantText: string;
  editedFiles: Set<string>;
  progressSteps: Map<string, ToolProgressEntry>;
  progressState: "completed" | "stopped" | "error";
}
