/**
 * Pure chat send/queue helpers: ordering, interrupt prioritization, and
 * parallel-slot capacity. Kept free of VS Code / SDK I/O so ChatRuntime and
 * Supervisor runners stay independent.
 */

export type QueueKind = "queued" | "interrupt";

export interface QueueMessageItem {
  id: string;
  conversationId: string;
  kind: QueueKind;
}

export function enqueueChatMessage<T extends QueueMessageItem>(
  queue: readonly T[],
  item: T,
): T[] {
  if (item.kind === "interrupt") {
    return [item, ...queue];
  }
  return [...queue, item];
}

export function removeQueuedMessages(
  queue: readonly QueueMessageItem[],
  predicate: (item: QueueMessageItem) => boolean,
): QueueMessageItem[] {
  return queue.filter((item) => !predicate(item));
}

export function takeNextQueuedMessage<T extends QueueMessageItem>(
  queue: readonly T[],
  conversationId: string,
): { next?: T; remaining: T[] } {
  const index = queue.findIndex((item) => item.conversationId === conversationId);
  if (index < 0) {
    return { remaining: [...queue] };
  }
  const remaining = [...queue];
  const [next] = remaining.splice(index, 1);
  return { next, remaining };
}

/**
 * Put a message back after a drain attempt failed to start a run.
 * Preserves per-conversation order; interrupts stay ahead of other work.
 */
export function requeueUnstartedMessage<T extends QueueMessageItem>(
  queue: readonly T[],
  item: T,
): T[] {
  if (item.kind === "interrupt") {
    return [item, ...queue];
  }
  const insertAt = queue.findIndex((candidate) => candidate.conversationId === item.conversationId);
  if (insertAt < 0) {
    return [...queue, item];
  }
  return [...queue.slice(0, insertAt), item, ...queue.slice(insertAt)];
}

/**
 * Requeue several unstarted messages while preserving their relative order.
 * Forward requeueUnstartedMessage would reverse same-conversation batches.
 */
export function requeueUnstartedMessages<T extends QueueMessageItem>(
  queue: readonly T[],
  items: readonly T[],
): T[] {
  let result = [...queue];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    result = requeueUnstartedMessage(result, items[index]!);
  }
  return result;
}

export type ConversationRunState = "idle" | "running" | "queued" | "cancelling";

export function conversationRunState(input: {
  busy: boolean;
  pendingCancel: boolean;
  queueCount: number;
}): ConversationRunState {
  if (input.busy && input.pendingCancel) {
    return "cancelling";
  }
  if (input.busy) {
    return "running";
  }
  if (input.queueCount > 0) {
    return "queued";
  }
  return "idle";
}

/**
 * When an interrupt is enqueued for a busy conversation, cancel the active run
 * but keep other conversations' queues intact.
 */
export function shouldCancelOnInterrupt(busy: boolean, kind: QueueKind): boolean {
  return kind === "interrupt" && busy;
}

export function normalizeMaxParallelAgents(maxParallel: number): number {
  return Math.max(1, maxParallel);
}

export function canStartAnotherParallelAgent(
  activeRuns: number,
  maxParallel: number,
): boolean {
  return activeRuns < normalizeMaxParallelAgents(maxParallel);
}

export function availableParallelSlots(
  activeRuns: number,
  maxParallel: number,
): number {
  return Math.max(0, normalizeMaxParallelAgents(maxParallel) - activeRuns);
}

/**
 * Queued prompts eligible to launch as additional parallel agents (never
 * interrupts; scoped to the active conversation when one is selected).
 */
export function selectParallelLaunchCandidates<T extends QueueMessageItem>(
  queue: readonly T[],
  ids: readonly string[],
  activeConversationId?: string | null,
): T[] {
  const wanted = new Set(ids.filter((id) => id.length > 0));
  if (wanted.size === 0) {
    return [];
  }
  return queue.filter(
    (item) =>
      wanted.has(item.id)
      && item.kind !== "interrupt"
      && (!activeConversationId || item.conversationId === activeConversationId),
  );
}

export function takeParallelLaunchBatch<T>(
  items: readonly T[],
  availableSlots: number,
): { launchable: T[]; skippedForLimit: number } {
  const available = Math.max(0, availableSlots);
  const launchable = items.slice(0, available);
  return {
    launchable,
    skippedForLimit: items.length - launchable.length,
  };
}

export function queuedConversationIds(
  queue: readonly QueueMessageItem[],
): string[] {
  return [...new Set(queue.map((item) => item.conversationId))];
}
