export const ACTIVE_POLL_MIN_DELAY_MS = 2_000;
export const ACTIVE_POLL_MAX_DELAY_MS = 8_000;
export const IDLE_POLL_MIN_DELAY_MS = 5_000;
export const IDLE_POLL_MAX_DELAY_MS = 60_000;
export const INACTIVE_WINDOW_MULTIPLIER = 2;

export interface BackgroundJobPollState {
  /** Active work, cancellation grace, or another recovery action is pending. */
  requiresSupervision: boolean;
  /** VS Code reports recent window activity (stronger than focus alone). */
  windowActive: boolean;
  /** Number of consecutive polls that observed no durable state change. */
  unchangedPolls: number;
}

/** Pure scheduling policy for one-shot polling. */
export function nextBackgroundJobPollDelay(state: Readonly<BackgroundJobPollState>): number {
  const minimum = state.requiresSupervision ? ACTIVE_POLL_MIN_DELAY_MS : IDLE_POLL_MIN_DELAY_MS;
  const maximum = state.requiresSupervision ? ACTIVE_POLL_MAX_DELAY_MS : IDLE_POLL_MAX_DELAY_MS;
  const visibilityMultiplier = state.windowActive ? 1 : INACTIVE_WINDOW_MULTIPLIER;
  const exponent = Math.min(Math.max(0, Math.floor(state.unchangedPolls)), 8);
  return Math.min(maximum * visibilityMultiplier, minimum * visibilityMultiplier * 2 ** exponent);
}
