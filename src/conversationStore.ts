import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type * as vscode from "vscode";
import type { Conversation } from "./chatTypes.js";

const TITLE_MAX_LENGTH = 40;

export const CONVERSATION_STORE_SCHEMA_VERSION = 1;
export const DEFAULT_MAX_CONVERSATIONS = 100;
export const DEFAULT_MAX_CONVERSATION_BYTES = 4 * 1024 * 1024;
export const DEFAULT_SAVE_DEBOUNCE_MS = 25;

export interface ConversationStoreOptions {
  maxConversations?: number;
  maxSerializedBytes?: number;
  saveDebounceMs?: number;
}

export interface PersistedConversationState {
  schemaVersion: typeof CONVERSATION_STORE_SCHEMA_VERSION;
  conversations: Conversation[];
}

interface SaveWaiter {
  resolve: () => void;
  reject: (reason: unknown) => void;
}

export function makeConversationTitle(prompt: string): string {
  const firstLine = prompt.split("\n", 1)[0].trim();
  return firstLine.length > TITLE_MAX_LENGTH
    ? `${firstLine.slice(0, TITLE_MAX_LENGTH)}…`
    : firstLine;
}

/** Owns conversation selection, collection mutation, and workspace persistence. */
export class ConversationStore {
  private readonly conversations: Conversation[];
  private selectedId: string | undefined;
  private readonly maxConversations: number;
  private readonly maxSerializedBytes: number;
  private readonly saveDebounceMs: number;
  private pendingSnapshot: PersistedConversationState | undefined;
  private pendingWaiters: SaveWaiter[] = [];
  private saveTimer: NodeJS.Timeout | undefined;
  private writeChain: Promise<void> = Promise.resolve();
  private lastWrite: Promise<void> = Promise.resolve();

  public constructor(
    private readonly workspaceState: vscode.Memento,
    private readonly storageKey: string,
    options: ConversationStoreOptions = {},
  ) {
    this.maxConversations = normalizeLimit(
      options.maxConversations,
      DEFAULT_MAX_CONVERSATIONS,
      0,
    );
    this.maxSerializedBytes = normalizeLimit(
      options.maxSerializedBytes,
      DEFAULT_MAX_CONVERSATION_BYTES,
      64,
    );
    this.saveDebounceMs = normalizeLimit(
      options.saveDebounceMs,
      DEFAULT_SAVE_DEBOUNCE_MS,
      0,
    );
    this.conversations = decodePersistedConversations(workspaceState.get<unknown>(storageKey));
    this.pruneToLimits();
  }

  public get items(): Conversation[] {
    return this.conversations;
  }

  public get activeId(): string | undefined {
    return this.selectedId;
  }

  public set activeId(value: string | undefined) {
    this.selectedId = value;
  }

  public active(): Conversation | undefined {
    return this.find(this.selectedId);
  }

  public find(id: string | undefined): Conversation | undefined {
    return id ? this.conversations.find((conversation) => conversation.id === id) : undefined;
  }

  public create(prompt: string, workspaceFolderUri?: string): Conversation {
    const now = Date.now();
    const conversation: Conversation = {
      id: randomUUID(),
      title: makeConversationTitle(prompt),
      createdAt: now,
      updatedAt: now,
      workspaceFolderUri,
      transcript: [],
    };
    this.conversations.unshift(conversation);
    this.selectedId = conversation.id;
    return conversation;
  }

  public add(conversation: Conversation): void {
    this.conversations.unshift(conversation);
  }

  public remove(id: string): Conversation | undefined {
    const index = this.conversations.findIndex((conversation) => conversation.id === id);
    if (index < 0) {
      return undefined;
    }
    const [removed] = this.conversations.splice(index, 1);
    if (this.selectedId === id) {
      this.selectedId = undefined;
    }
    return removed;
  }

  /**
   * Queues a detached snapshot for persistence. Rapid calls are coalesced and all
   * callers settle only after the newest coalesced snapshot has been written.
   */
  public save(): Promise<void> {
    let snapshot: PersistedConversationState;
    try {
      this.pruneToLimits();
      snapshot = clonePersistedState({
        schemaVersion: CONVERSATION_STORE_SCHEMA_VERSION,
        conversations: this.conversations,
      });
    } catch (error) {
      return Promise.reject(error);
    }

    this.pendingSnapshot = snapshot;
    const completion = new Promise<void>((resolve, reject) => {
      this.pendingWaiters.push({ resolve, reject });
    });
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.startPendingWrite(), this.saveDebounceMs);
    return completion;
  }

  /** Immediately starts any debounced save and waits for all serialized writes. */
  public async flush(): Promise<void> {
    if (this.pendingSnapshot) this.startPendingWrite();
    const observedWrite = this.lastWrite;
    await observedWrite;
    if (this.pendingSnapshot || this.lastWrite !== observedWrite) await this.flush();
  }

  private startPendingWrite(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
    }
    const snapshot = this.pendingSnapshot;
    if (!snapshot) return;
    const waiters = this.pendingWaiters;
    this.pendingSnapshot = undefined;
    this.pendingWaiters = [];

    const update = (): Promise<void> =>
      Promise.resolve(this.workspaceState.update(this.storageKey, snapshot));
    const write = this.writeChain.then(update, update);
    this.lastWrite = write;
    this.writeChain = write.then(
      () => undefined,
      () => undefined,
    );
    void write.then(
      () => waiters.forEach(({ resolve }) => resolve()),
      (error) => waiters.forEach(({ reject }) => reject(error)),
    );
  }

  private pruneToLimits(): void {
    while (this.conversations.length > this.maxConversations) {
      this.removeAt(this.findOldestIndex(false));
    }

    let serializedBytes = this.serializedBytes();
    while (serializedBytes > this.maxSerializedBytes) {
      const transcriptIndex = this.findOldestIndex(true);
      if (transcriptIndex >= 0) {
        this.conversations[transcriptIndex].transcript.shift();
      } else if (this.conversations.length > 0) {
        this.removeAt(this.findOldestIndex(false));
      } else {
        break;
      }
      serializedBytes = this.serializedBytes();
    }
  }

  /** Prefer pruning old, unpinned, inactive conversations before protected ones. */
  private findOldestIndex(requireTranscript: boolean): number {
    const candidates = this.conversations
      .map((conversation, index) => ({ conversation, index }))
      .filter(({ conversation }) => !requireTranscript || conversation.transcript.length > 0);
    if (candidates.length === 0) return -1;

    const rank = ({ conversation }: (typeof candidates)[number]): readonly [number, number, number] => [
      conversation.id === this.selectedId ? 1 : 0,
      conversation.pinned === true ? 1 : 0,
      Number.isFinite(conversation.updatedAt) ? conversation.updatedAt : 0,
    ];
    candidates.sort((left, right) => {
      const leftRank = rank(left);
      const rightRank = rank(right);
      return leftRank[0] - rightRank[0]
        || leftRank[1] - rightRank[1]
        || leftRank[2] - rightRank[2]
        || right.index - left.index;
    });
    return candidates[0].index;
  }

  private removeAt(index: number): void {
    if (index < 0) return;
    const [removed] = this.conversations.splice(index, 1);
    if (removed?.id === this.selectedId) this.selectedId = undefined;
  }

  private serializedBytes(): number {
    return Buffer.byteLength(JSON.stringify({
      schemaVersion: CONVERSATION_STORE_SCHEMA_VERSION,
      conversations: this.conversations,
    }), "utf8");
  }
}

function normalizeLimit(value: number | undefined, fallback: number, minimum: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(minimum, Math.floor(value))
    : fallback;
}

function decodePersistedConversations(value: unknown): Conversation[] {
  const source = Array.isArray(value)
    ? value
    : isRecord(value)
      && value.schemaVersion === CONVERSATION_STORE_SCHEMA_VERSION
      && Array.isArray(value.conversations)
        ? value.conversations
        : [];
  const conversations: Conversation[] = [];
  const seenIds = new Set<string>();
  for (const item of source) {
    const conversation = decodeConversation(item);
    if (!conversation || seenIds.has(conversation.id)) continue;
    seenIds.add(conversation.id);
    conversations.push(conversation);
  }
  return conversations;
}

function decodeConversation(value: unknown): Conversation | undefined {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || value.id.length === 0
    || typeof value.title !== "string"
    || typeof value.createdAt !== "number"
    || !Number.isFinite(value.createdAt)
    || typeof value.updatedAt !== "number"
    || !Number.isFinite(value.updatedAt)
    || !Array.isArray(value.transcript)) {
    return undefined;
  }
  try {
    const cloned = JSON.parse(JSON.stringify(value)) as Conversation;
    cloned.transcript = cloned.transcript.filter((entry) =>
      isRecord(entry)
      && (entry.role === "user" || entry.role === "assistant")
      && typeof entry.text === "string"
    );
    return cloned;
  } catch {
    return undefined;
  }
}

function clonePersistedState(value: PersistedConversationState): PersistedConversationState {
  return JSON.parse(JSON.stringify(value)) as PersistedConversationState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
