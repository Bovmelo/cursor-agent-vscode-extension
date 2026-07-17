import { randomUUID } from "node:crypto";

export interface BestOfNExperiment {
  id: string;
  prompt: string;
  createdAt: number;
  conversationIds: string[];
  winnerId?: string;
  appliedWinnerId?: string;
  pullRequestCreated?: boolean;
}

export interface BestOfNCandidateSummary {
  id: string;
  title: string;
  running: boolean;
  totalTokens: number;
  lastAssistant?: string;
  isWinner: boolean;
}

export function createBestOfNExperiment(
  prompt: string,
  conversationIds: string[],
): BestOfNExperiment {
  return {
    id: randomUUID(),
    prompt,
    createdAt: Date.now(),
    conversationIds: [...conversationIds],
  };
}

export function pickWinner(
  experiment: BestOfNExperiment,
  conversationId: string,
): BestOfNExperiment {
  if (!experiment.conversationIds.includes(conversationId)) {
    return experiment;
  }
  return {
    ...experiment,
    winnerId: conversationId,
  };
}

export function experimentCandidates(
  experiment: BestOfNExperiment,
  conversations: ReadonlyArray<{
    id: string;
    title: string;
    tokenUsage?: { totalTokens?: number };
    transcript: ReadonlyArray<{ role: string; text: string }>;
  }>,
  runningIds: ReadonlySet<string>,
): BestOfNCandidateSummary[] {
  return experiment.conversationIds.flatMap((id) => {
    const conversation = conversations.find((item) => item.id === id);
    if (!conversation) {
      return [];
    }
    const lastAssistant = [...conversation.transcript]
      .reverse()
      .find((entry) => entry.role === "assistant")
      ?.text;
    return [{
      id,
      title: conversation.title,
      running: runningIds.has(id),
      totalTokens: conversation.tokenUsage?.totalTokens ?? 0,
      lastAssistant: lastAssistant?.slice(0, 1200),
      isWinner: experiment.winnerId === id,
    }];
  });
}
