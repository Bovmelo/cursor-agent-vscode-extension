import assert from "node:assert/strict";
import test from "node:test";

import {
  HOST_TO_WEBVIEW_MESSAGE_TYPES,
  WEBVIEW_TO_HOST_MESSAGE_TYPES,
  isWebviewToHostMessage,
  parseHostToWebviewMessage,
  parseWebviewMessage,
} from "../out/webviewMessages.js";

test("shared webview message discriminants remain unique", () => {
  assert.equal(new Set(WEBVIEW_TO_HOST_MESSAGE_TYPES).size, WEBVIEW_TO_HOST_MESSAGE_TYPES.length);
  assert.equal(new Set(HOST_TO_WEBVIEW_MESSAGE_TYPES).size, HOST_TO_WEBVIEW_MESSAGE_TYPES.length);
});

test("webview message parser validates and normalizes payloads", () => {
  assert.equal(isWebviewToHostMessage({ type: "ready" }), true);
  assert.equal(isWebviewToHostMessage({ type: "send", prompt: "hello" }), true);
  assert.equal(isWebviewToHostMessage({ type: "send", text: "hello" }), false);
  assert.equal(isWebviewToHostMessage({ type: "not-a-message" }), false);
  assert.equal(isWebviewToHostMessage({}), false);
  assert.equal(isWebviewToHostMessage(null), false);

  assert.deepEqual(
    parseWebviewMessage({
      type: "send",
      prompt: "hello",
      files: ["image.png"],
      skills: ["review"],
      includeProjectMemory: false,
    }),
    {
      type: "send",
      prompt: "hello",
      attachContext: false,
      files: ["image.png"],
      modelId: undefined,
      modelParams: undefined,
      profile: undefined,
      skills: ["review"],
      commandId: undefined,
      includeProjectMemory: false,
    },
  );
  assert.equal(
    parseWebviewMessage({ type: "resolveAttachments", requestId: 1, references: [] }),
    undefined,
  );
  assert.deepEqual(parseWebviewMessage({ type: "runRecoveryAction", action: "retry" }), {
    type: "runRecoveryAction",
    action: "retry",
  });
  assert.deepEqual(parseWebviewMessage({ type: "runRecoveryAction", action: "diagnostics" }), {
    type: "runRecoveryAction",
    action: "diagnostics",
  });
  assert.deepEqual(parseWebviewMessage({ type: "runRecoveryAction", action: "runCenter" }), {
    type: "runRecoveryAction",
    action: "runCenter",
  });
  assert.deepEqual(parseWebviewMessage({ type: "runRecoveryAction", action: "logs" }), {
    type: "runRecoveryAction",
    action: "logs",
  });
  assert.equal(parseWebviewMessage({ type: "runRecoveryAction", action: "unknown" }), undefined);
  assert.equal(parseWebviewMessage({ type: "runRecoveryAction" }), undefined);
});

test("host message parser validates payloads before transport", () => {
  assert.deepEqual(parseHostToWebviewMessage({ type: "authState", configured: true }), {
    type: "authState",
    configured: true,
  });
  assert.equal(parseHostToWebviewMessage({ type: "authState" }), undefined);
  assert.equal(parseHostToWebviewMessage({ type: "chunk", text: 42 }), undefined);
  assert.equal(parseHostToWebviewMessage({ type: "not-a-message" }), undefined);
  assert.deepEqual(parseHostToWebviewMessage({ type: "error", text: "boom" }), {
    type: "error",
    text: "boom",
  });
  assert.deepEqual(
    parseHostToWebviewMessage({
      type: "error",
      text: "boom",
      recoveryActions: ["retry", "diagnostics", "runCenter", "logs"],
    }),
    {
      type: "error",
      text: "boom",
      recoveryActions: ["retry", "diagnostics", "runCenter", "logs"],
    },
  );
  assert.equal(
    parseHostToWebviewMessage({
      type: "error",
      text: "boom",
      recoveryActions: ["retry", "unknown"],
    }),
    undefined,
  );
  assert.deepEqual(
    parseHostToWebviewMessage({
      type: "executionProfileState",
      profileId: "balanced",
      label: "Balanced",
    }),
    {
      type: "executionProfileState",
      profileId: "balanced",
      label: "Balanced",
    },
  );
  assert.equal(
    parseHostToWebviewMessage({ type: "executionProfileState", profileId: "balanced" }),
    undefined,
  );
});
