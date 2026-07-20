import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [extensionSource, clientSource, controllerSource] = await Promise.all([
  readFile(new URL("../src/extension.ts", import.meta.url), "utf8"),
  readFile(new URL("../media/webview.js", import.meta.url), "utf8"),
  readFile(new URL("../src/webviewController.ts", import.meta.url), "utf8"),
]);

test("task summaries and parallel tasks receive completed synthesis links", () => {
  assert.match(extensionSource, /availableOrchestratorFinalResultLinks\(\)/u);
  assert.match(
    extensionSource,
    /orchestratorFinalResultLinks\(this\.orchestratorExperiments\)/u,
  );
  assert.match(
    extensionSource,
    /orchestratorFinalResultConversationId: finalResultLinks\.get\(conversation\.id\)/u,
  );
  assert.match(
    extensionSource,
    /buildOrchestratorDetail\([\s\S]*?new Set\(this\.conversations\.map\(\(conversation\) => conversation\.id\)\)/u,
  );
});

test("orchestrator tasks open the synthesis conversation through the existing link contract", () => {
  assert.match(
    clientSource,
    /experiment\.status === "completed"[\s\S]*?experiment\.synthesis\?\.conversationId/u,
  );
  assert.match(
    clientSource,
    /createOrchestratorFlowSubtask\(subtask, finalResultConversationId\)/u,
  );
  assert.match(
    clientSource,
    /conv\.orchestratorFinalResultConversationId[\s\S]*?createOpenConversationButton/u,
  );
  assert.match(
    clientSource,
    /vscode\.postMessage\(\{ type: "openConversation", id: conversationId \}\)/u,
  );
  assert.match(controllerSource, /orchestratorOpenFinalResult: "最終結果を開く"/u);
  assert.match(controllerSource, /orchestratorOpenFinalResult: "Open final result"/u);
});
