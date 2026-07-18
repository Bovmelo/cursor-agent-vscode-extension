const DEFAULT_HOTKEY_HANDOFF_MS = 2_000;

/**
 * Tracks a dictation-hotkey handoff without treating ordinary prompt blur as
 * restoration intent. This keeps editor/sidebar focus changes untouched.
 */
export class PromptFocusHandoff {
  private dictationHotkeyAt = Number.NEGATIVE_INFINITY;
  private lastHostWindowLostAt = Number.NEGATIVE_INFINITY;
  private restoreOnWindowFocus = false;

  public constructor(
    private readonly hotkeyHandoffMs = DEFAULT_HOTKEY_HANDOFF_MS,
  ) {}

  public dictationHotkeyStarted(
    occurredAt: number,
    hostWindowFocused: boolean,
    viewVisible: boolean,
  ): void {
    this.dictationHotkeyAt = occurredAt;
    // The native window-loss event may reach the host before this renderer
    // message. Arm the same one-shot restoration in either order.
    if (!hostWindowFocused && viewVisible) {
      this.restoreOnWindowFocus = Math.abs(
        occurredAt - this.lastHostWindowLostAt,
      ) <= this.hotkeyHandoffMs;
    }
  }

  /** Returns true once when the prompt should be restored on native focus gain. */
  public hostWindowFocusChanged(
    focused: boolean,
    viewVisible: boolean,
    now = Date.now(),
  ): boolean {
    if (!focused) {
      this.lastHostWindowLostAt = now;
      this.restoreOnWindowFocus = viewVisible && this.hotkeyIsRecent(now);
      return false;
    }

    const shouldRestore = viewVisible && this.restoreOnWindowFocus;
    this.restoreOnWindowFocus = false;
    this.dictationHotkeyAt = Number.NEGATIVE_INFINITY;
    this.lastHostWindowLostAt = Number.NEGATIVE_INFINITY;
    return shouldRestore;
  }

  public reset(): void {
    this.dictationHotkeyAt = Number.NEGATIVE_INFINITY;
    this.lastHostWindowLostAt = Number.NEGATIVE_INFINITY;
    this.restoreOnWindowFocus = false;
  }

  private hotkeyIsRecent(now: number): boolean {
    return now >= this.dictationHotkeyAt
      && now - this.dictationHotkeyAt <= this.hotkeyHandoffMs;
  }
}
