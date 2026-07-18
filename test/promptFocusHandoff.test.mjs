import assert from "node:assert/strict";
import test from "node:test";

import { PromptFocusHandoff } from "../out/promptFocusHandoff.js";

test("restores once after a Typeless hotkey starts a native focus handoff", () => {
  const handoff = new PromptFocusHandoff();
  handoff.dictationHotkeyStarted(0, true, true);

  assert.equal(handoff.hostWindowFocusChanged(false, true, 10), false);
  assert.equal(handoff.hostWindowFocusChanged(true, true, 10_000), true);
  assert.equal(handoff.hostWindowFocusChanged(true, true, 10_010), false);
});

test("does not restore after ordinary prompt, editor, or Explorer focus changes", () => {
  const handoff = new PromptFocusHandoff();

  assert.equal(handoff.hostWindowFocusChanged(false, true, 10), false);
  assert.equal(handoff.hostWindowFocusChanged(true, true, 20), false);
});

test("hotkey message may arrive just after native window focus loss", () => {
  const handoff = new PromptFocusHandoff();
  handoff.hostWindowFocusChanged(false, true, 10);
  handoff.dictationHotkeyStarted(9, false, true);

  assert.equal(handoff.hostWindowFocusChanged(true, true, 10_000), true);
});

test("stale delayed hotkey cannot arm an unrelated native focus return", () => {
  const handoff = new PromptFocusHandoff();
  handoff.hostWindowFocusChanged(false, true, 5_000);
  handoff.dictationHotkeyStarted(0, false, true);

  assert.equal(handoff.hostWindowFocusChanged(true, true, 6_000), false);
});

test("hotkey alone never forces focus without a native window round trip", () => {
  const handoff = new PromptFocusHandoff();
  handoff.dictationHotkeyStarted(100, true, true);

  assert.equal(handoff.hostWindowFocusChanged(true, true, 200), false);
});

test("ignores stale hotkeys, hidden views, and resets", () => {
  const stale = new PromptFocusHandoff(250);
  stale.dictationHotkeyStarted(0, true, true);
  stale.hostWindowFocusChanged(false, true, 500);
  assert.equal(stale.hostWindowFocusChanged(true, true, 510), false);

  const hidden = new PromptFocusHandoff();
  hidden.dictationHotkeyStarted(0, true, false);
  hidden.hostWindowFocusChanged(false, false, 10);
  assert.equal(hidden.hostWindowFocusChanged(true, true, 20), false);

  const reset = new PromptFocusHandoff();
  reset.dictationHotkeyStarted(0, true, true);
  reset.hostWindowFocusChanged(false, true, 10);
  reset.reset();
  assert.equal(reset.hostWindowFocusChanged(true, true, 20), false);
});
