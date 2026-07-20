import type { Conversation, TranscriptEntry } from "./chatTypes.js";

export interface ConversationSummary {
  id: string;
  title: string;
  updatedAt: number;
  running: boolean;
  queued: boolean;
  pinned: boolean;
  totalTokens: number;
  experimentGroupId?: string;
  orchestratorFinalResultConversationId?: string;
}

export interface ConversationSummaryOptions {
  readonly isBusy: (conversationId: string) => boolean;
  readonly isQueued: (conversationId: string) => boolean;
  readonly orchestratorFinalResultLinks?: ReadonlyMap<string, string>;
}

/** Filter/sort conversations for the home list, with busy/queue flags from the host. */
export function conversationSummaries(
  conversations: readonly Conversation[],
  query = "",
  options: ConversationSummaryOptions,
): ConversationSummary[] {
  const normalized = query.trim().toLowerCase();
  return [...conversations]
    .filter((conversation) => {
      if (!normalized) {
        return true;
      }
      if (conversation.title.toLowerCase().includes(normalized)) {
        return true;
      }
      return conversation.transcript.some((entry) =>
        entry.text.toLowerCase().includes(normalized),
      );
    })
    .sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) {
        return a.pinned ? -1 : 1;
      }
      return b.updatedAt - a.updatedAt;
    })
    .map(({ id, title, updatedAt, pinned, tokenUsage, experimentGroupId }) => {
      const finalResultConversationId = options.orchestratorFinalResultLinks?.get(id);
      return {
        id,
        title,
        updatedAt,
        running: options.isBusy(id),
        queued: options.isQueued(id),
        pinned: pinned === true,
        totalTokens: tokenUsage?.totalTokens ?? 0,
        experimentGroupId,
        ...(finalResultConversationId
          ? { orchestratorFinalResultConversationId: finalResultConversationId }
          : {}),
      };
    });
}

/** Render a conversation transcript as Markdown for export. */
export function conversationToMarkdown(conversation: Conversation): string {
  const lines = [
    `# ${conversation.title}`,
    "",
    `- Created: ${new Date(conversation.createdAt).toISOString()}`,
    `- Updated: ${new Date(conversation.updatedAt).toISOString()}`,
    `- Tokens: ${conversation.tokenUsage?.totalTokens ?? 0}`,
    "",
  ];
  for (const entry of conversation.transcript) {
    lines.push(`## ${entry.role === "user" ? "User" : "Assistant"}`);
    lines.push("");
    lines.push(entry.text);
    lines.push("");
    if (entry.files?.length) {
      lines.push("Edited files:");
      for (const file of entry.files) {
        lines.push(`- ${file}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

export interface ConversationRetryTarget {
  readonly conversation: Conversation;
  readonly lastUserPrompt: TranscriptEntry;
}

function lastUserPromptIn(conversation: Conversation): TranscriptEntry | undefined {
  return [...conversation.transcript]
    .reverse()
    .find((entry) => entry.role === "user" && Boolean(entry.text.trim()));
}

/** Resolve the conversation + last user prompt that retryLastRun would send. */
export function findConversationForRetry(
  conversations: readonly Conversation[],
  activeId: string | undefined,
): ConversationRetryTarget | undefined {
  const preferred = activeId
    ? conversations.find((item) => item.id === activeId)
    : undefined;
  if (preferred) {
    const lastUserPrompt = lastUserPromptIn(preferred);
    if (lastUserPrompt) {
      return { conversation: preferred, lastUserPrompt };
    }
  }
  const conversation = [...conversations]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .find((item) => lastUserPromptIn(item));
  if (!conversation) {
    return undefined;
  }
  const lastUserPrompt = lastUserPromptIn(conversation);
  if (!lastUserPrompt) {
    return undefined;
  }
  return { conversation, lastUserPrompt };
}
