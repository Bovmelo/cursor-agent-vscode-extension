import { randomUUID } from "node:crypto";

export interface BestOfNExperiment {
  id: string;
  prompt: string;
  createdAt: number;
  conversationIds: string[];
  winnerId?: string;
  appliedWinnerId?: string;
  pullRequestCreated?: boolean;
  /** True when the winner was chosen automatically (heuristic or AI judge). */
  autoSelected?: boolean;
  autoSelectReasons?: string[];
}

export interface BestOfNCandidateSummary {
  id: string;
  title: string;
  running: boolean;
  totalTokens: number;
  lastAssistant?: string;
  isWinner: boolean;
}

export interface BestOfNCandidateEvidence {
  conversationId: string;
  title: string;
  completed: boolean;
  failed: boolean;
  hasArtifact: boolean;
  changedFileCount: number;
  changedFiles?: readonly string[];
  verificationSuccess?: boolean;
  verificationSkipped?: boolean;
  totalTokens: number;
  lastAssistant?: string;
}

export interface BestOfNCandidateScore extends BestOfNCandidateEvidence {
  score: number;
  reasons: string[];
}

export interface BestOfNSelection {
  winnerId: string;
  reasons: string[];
  tied: boolean;
  method: "heuristic" | "judge";
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
  options?: { autoSelected?: boolean; reasons?: readonly string[] },
): BestOfNExperiment {
  if (!experiment.conversationIds.includes(conversationId)) {
    return experiment;
  }
  return {
    ...experiment,
    winnerId: conversationId,
    autoSelected: options?.autoSelected === true ? true : experiment.autoSelected,
    autoSelectReasons: options?.reasons && options.reasons.length > 0
      ? [...options.reasons].slice(0, 12)
      : experiment.autoSelectReasons,
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

export function scoreBestOfNCandidate(
  evidence: BestOfNCandidateEvidence,
): BestOfNCandidateScore {
  const reasons: string[] = [];
  let score = 0;

  if (evidence.failed) {
    score -= 1_000;
    reasons.push("run failed");
  } else if (evidence.completed) {
    score += 100;
    reasons.push("run completed");
  }

  if (evidence.hasArtifact) {
    score += 50;
    reasons.push(`${evidence.changedFileCount} changed file(s)`);
  } else if (evidence.completed && !evidence.failed) {
    score -= 40;
    reasons.push("no isolated change artifact");
  }

  if (evidence.verificationSuccess === true) {
    score += 200;
    reasons.push("verification passed");
  } else if (evidence.verificationSuccess === false) {
    score -= 150;
    reasons.push("verification failed");
  } else if (evidence.verificationSkipped) {
    reasons.push("verification skipped");
  }

  if (evidence.hasArtifact) {
    score += Math.max(0, 20 - evidence.changedFileCount);
  }

  // Prefer cheaper completed candidates when quality signals match.
  score -= Math.min(30, Math.floor(evidence.totalTokens / 50_000));

  return {
    ...evidence,
    score,
    reasons,
  };
}

export function selectBestOfNWinner(
  evidence: ReadonlyArray<BestOfNCandidateEvidence>,
): BestOfNSelection | undefined {
  const scored = evidence
    .map((item) => scoreBestOfNCandidate(item))
    .sort((left, right) => right.score - left.score || left.conversationId.localeCompare(right.conversationId));
  const eligible = scored.filter(
    (item) => item.completed && !item.failed && item.hasArtifact,
  );
  if (eligible.length === 0) {
    return undefined;
  }
  const best = eligible[0];
  const tied = eligible.length > 1 && eligible[1].score === best.score;
  return {
    winnerId: best.conversationId,
    reasons: best.reasons,
    tied,
    method: "heuristic",
  };
}

/**
 * After an await (e.g. AI judge), refuse to write a winner if the experiment
 * already has one or auto-select / auto-judge was turned off mid-flight.
 */
export function shouldAbortBestOfNAutoSelect(
  experiment: BestOfNExperiment | undefined,
  options: {
    autoSelectEnabled: boolean;
    /** When true, also abort if auto-judge is disabled. */
    requireAutoJudge?: boolean;
    autoJudgeEnabled?: boolean;
  },
): boolean {
  if (!experiment) {
    return true;
  }
  if (experiment.winnerId || experiment.appliedWinnerId) {
    return true;
  }
  if (!options.autoSelectEnabled) {
    return true;
  }
  if (options.requireAutoJudge && options.autoJudgeEnabled !== true) {
    return true;
  }
  return false;
}

export function buildBestOfNJudgePrompt(
  prompt: string,
  candidates: ReadonlyArray<BestOfNCandidateEvidence>,
): string {
  const blocks = candidates.map((candidate, index) => {
    const lines = [
      `${index + 1}. id=${candidate.conversationId}`,
      `   title: ${candidate.title}`,
      `   status: ${candidate.failed ? "failed" : candidate.completed ? "completed" : "incomplete"}`,
      `   changedFiles: ${candidate.changedFileCount}`,
    ];
    if (candidate.changedFiles && candidate.changedFiles.length > 0) {
      lines.push(`   files: ${candidate.changedFiles.slice(0, 30).join(", ")}`);
    }
    if (candidate.verificationSuccess === true) {
      lines.push("   verification: passed");
    } else if (candidate.verificationSuccess === false) {
      lines.push("   verification: failed");
    } else if (candidate.verificationSkipped) {
      lines.push("   verification: skipped");
    }
    if (candidate.lastAssistant?.trim()) {
      const summary = candidate.lastAssistant.trim().slice(0, 1_500);
      lines.push("   summary:");
      for (const line of summary.split("\n")) {
        lines.push(`   ${line}`);
      }
    }
    return lines.join("\n");
  });
  return [
    "Pick the single best candidate for the original request.",
    "Prefer correctness and verification success over verbosity.",
    "Prefer the smallest coherent change set when quality is equal.",
    "Original request:",
    prompt,
    "",
    "Candidates:",
    ...blocks,
    "",
    "Return only this exact structure:",
    "<BEST_OF_N_WINNER>",
    '{"winnerId":"<conversation-id>","reasons":["short reason"]}',
    "</BEST_OF_N_WINNER>",
  ].join("\n");
}

export function parseBestOfNWinnerVerdict(
  text: string,
  allowedIds: ReadonlyArray<string>,
): { winnerId: string; reasons: string[] } | undefined {
  const block = /<BEST_OF_N_WINNER>\s*([\s\S]*?)\s*<\/BEST_OF_N_WINNER>/i
    .exec(text)
    ?.at(1)
    ?.trim();
  if (!block) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(block) as {
      winnerId?: unknown;
      reasons?: unknown;
    };
    const winnerId = typeof parsed.winnerId === "string" ? parsed.winnerId.trim() : "";
    if (!winnerId || !allowedIds.includes(winnerId)) {
      return undefined;
    }
    const reasons = Array.isArray(parsed.reasons)
      ? parsed.reasons
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
        .slice(0, 10)
      : [];
    return { winnerId, reasons };
  } catch {
    return undefined;
  }
}
