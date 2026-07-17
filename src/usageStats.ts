export interface StoredTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
}

export type UsageSource = "chat" | "supervisor";

export interface DailyUsageBucket {
  chat: StoredTokenUsage;
  supervisor: StoredTokenUsage;
}

export interface UsageLedger {
  days: Record<string, DailyUsageBucket>;
}

export interface UsageSummary {
  today: {
    chat: number;
    supervisor: number;
    total: number;
  };
  last7Days: {
    chat: number;
    supervisor: number;
    total: number;
  };
  thisMonth: {
    chat: number;
    supervisor: number;
    total: number;
  };
  conversations: number;
  conversationTotal: number;
}

export const USAGE_LEDGER_KEY = "cursorSubscription.usageLedger";

export function emptyUsage(): StoredTokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
  };
}

export function addTokenUsage(
  current: StoredTokenUsage | undefined,
  usage: StoredTokenUsage,
): StoredTokenUsage {
  const reasoningTokens = (current?.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0);
  return {
    inputTokens: (current?.inputTokens ?? 0) + usage.inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + usage.outputTokens,
    cacheReadTokens: (current?.cacheReadTokens ?? 0) + usage.cacheReadTokens,
    cacheWriteTokens: (current?.cacheWriteTokens ?? 0) + usage.cacheWriteTokens,
    totalTokens: (current?.totalTokens ?? 0) + usage.totalTokens,
    reasoningTokens: reasoningTokens > 0 ? reasoningTokens : undefined,
  };
}

export function dayKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function recordUsage(
  ledger: UsageLedger | undefined,
  source: UsageSource,
  usage: StoredTokenUsage,
  at = new Date(),
): UsageLedger {
  const next: UsageLedger = {
    days: { ...(ledger?.days ?? {}) },
  };
  const key = dayKey(at);
  const bucket = next.days[key] ?? {
    chat: emptyUsage(),
    supervisor: emptyUsage(),
  };
  next.days[key] = {
    ...bucket,
    [source]: addTokenUsage(bucket[source], usage),
  };
  pruneOldDays(next, 120);
  return next;
}

export function pruneOldDays(ledger: UsageLedger, keepDays: number): void {
  const cutoff = new Date();
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - keepDays);
  const cutoffKey = dayKey(cutoff);
  for (const key of Object.keys(ledger.days)) {
    if (key < cutoffKey) {
      delete ledger.days[key];
    }
  }
}

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  }
  return String(Math.max(0, Math.round(value)));
}

export type BudgetStatus = "ok" | "warning" | "exceeded";

export interface BudgetSnapshot {
  budget: number;
  used: number;
  remaining: number;
  ratio: number;
  status: BudgetStatus;
}

export function budgetSnapshot(
  ledger: UsageLedger | undefined,
  dailyTokenBudget: number,
): BudgetSnapshot | undefined {
  const budget = Math.max(0, Math.floor(dailyTokenBudget));
  if (budget <= 0) {
    return undefined;
  }
  const used = summarizeUsage([], ledger).today.total;
  const remaining = Math.max(0, budget - used);
  const ratio = used / budget;
  const status: BudgetStatus = ratio >= 1 ? "exceeded" : ratio >= 0.8 ? "warning" : "ok";
  return { budget, used, remaining, ratio, status };
}

export function monthKey(date = new Date()): string {
  return dayKey(date).slice(0, 7);
}

export function monthlyBudgetSnapshot(
  ledger: UsageLedger | undefined,
  monthlyTokenBudget: number,
  at = new Date(),
): BudgetSnapshot | undefined {
  const budget = Math.max(0, Math.floor(monthlyTokenBudget));
  if (budget <= 0) {
    return undefined;
  }
  const prefix = `${monthKey(at)}-`;
  let used = 0;
  for (const [key, bucket] of Object.entries(ledger?.days ?? {})) {
    if (key.startsWith(prefix)) {
      used += bucket.chat.totalTokens + bucket.supervisor.totalTokens;
    }
  }
  const remaining = Math.max(0, budget - used);
  const ratio = used / budget;
  const status: BudgetStatus = ratio >= 1 ? "exceeded" : ratio >= 0.8 ? "warning" : "ok";
  return { budget, used, remaining, ratio, status };
}

export interface EstimatedCostSnapshot extends BudgetSnapshot {
  /** Approximation based on the user-configured blended USD/token rate. */
  estimatedUsd: number;
  limitUsd: number;
  usdPerMillionTokens: number;
}

export function estimatedMonthlyCostSnapshot(
  ledger: UsageLedger | undefined,
  limitUsd: number,
  usdPerMillionTokens: number,
  at = new Date(),
): EstimatedCostSnapshot | undefined {
  if (limitUsd <= 0 || usdPerMillionTokens <= 0) {
    return undefined;
  }
  const tokenSnapshot = monthlyBudgetSnapshot(ledger, Number.MAX_SAFE_INTEGER, at)!;
  const estimatedUsd = tokenSnapshot.used / 1_000_000 * usdPerMillionTokens;
  const ratio = estimatedUsd / limitUsd;
  return {
    budget: limitUsd,
    used: estimatedUsd,
    remaining: Math.max(0, limitUsd - estimatedUsd),
    ratio,
    status: ratio >= 1 ? "exceeded" : ratio >= 0.8 ? "warning" : "ok",
    estimatedUsd,
    limitUsd,
    usdPerMillionTokens,
  };
}

export function summarizeUsage(
  conversations: ReadonlyArray<{ tokenUsage?: StoredTokenUsage }>,
  ledger: UsageLedger | undefined,
): UsageSummary {
  const todayKey = dayKey();
  const todayBucket = ledger?.days[todayKey];
  const todayChat = todayBucket?.chat.totalTokens ?? 0;
  const todaySupervisor = todayBucket?.supervisor.totalTokens ?? 0;

  let weekChat = 0;
  let weekSupervisor = 0;
  let monthChat = 0;
  let monthSupervisor = 0;
  const weekStart = new Date();
  weekStart.setHours(0, 0, 0, 0);
  weekStart.setDate(weekStart.getDate() - 6);
  const weekStartKey = dayKey(weekStart);
  for (const [key, bucket] of Object.entries(ledger?.days ?? {})) {
    if (key.startsWith(`${monthKey()}-`)) {
      monthChat += bucket.chat.totalTokens;
      monthSupervisor += bucket.supervisor.totalTokens;
    }
    if (key < weekStartKey) {
      continue;
    }
    weekChat += bucket.chat.totalTokens;
    weekSupervisor += bucket.supervisor.totalTokens;
  }

  let conversationTotal = 0;
  for (const conversation of conversations) {
    conversationTotal += conversation.tokenUsage?.totalTokens ?? 0;
  }

  return {
    today: {
      chat: todayChat,
      supervisor: todaySupervisor,
      total: todayChat + todaySupervisor,
    },
    last7Days: {
      chat: weekChat,
      supervisor: weekSupervisor,
      total: weekChat + weekSupervisor,
    },
    thisMonth: {
      chat: monthChat,
      supervisor: monthSupervisor,
      total: monthChat + monthSupervisor,
    },
    conversations: conversations.length,
    conversationTotal,
  };
}
