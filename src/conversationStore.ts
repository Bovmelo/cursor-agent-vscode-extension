import { randomUUID } from "node:crypto";
import type * as vscode from "vscode";
import type { Conversation } from "./chatTypes.js";

const TITLE_MAX_LENGTH = 40;

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

  public constructor(
    private readonly workspaceState: vscode.Memento,
    private readonly storageKey: string,
  ) {
    this.conversations = workspaceState.get<Conversation[]>(storageKey, []);
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

  public save(): Thenable<void> {
    return this.workspaceState.update(this.storageKey, this.conversations);
  }
}
