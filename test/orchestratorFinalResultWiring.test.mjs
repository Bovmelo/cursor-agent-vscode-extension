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

test("resumed orchestrator planners retain the plan execution profile", () => {
  assert.match(
    extensionSource,
    /launch\.kind === "plan" \? "plan" : "agent"/u,
  );
});

test("recreated planner conversations persist their prior-response baseline", () => {
  assert.match(
    extensionSource,
    /planResponseBaseline: Math\.max\(0, \(experiment\.planAttempts \?\? 1\) - 1\)/u,
  );
});

test("resumed terminal planners are finalized instead of re-launched", () => {
  assert.match(
    extensionSource,
    /planResponseOutcome: \(conversationId, expectedResponseCount\)[\s\S]*?classifyOrchestratorPlanResponse\(/u,
  );
  assert.match(
    extensionSource,
    /for \(const terminal of pending\.terminalPlans\)[\s\S]*?terminal\.progressState,[\s\S]*?terminal\.assistantText/u,
  );
});

test("terminal transcript state is persisted even without tool progress", () => {
  assert.match(
    extensionSource,
    /progress: storedProgress\.length > 0 \? storedProgress : undefined,[\s\S]*?progressState,/u,
  );
  assert.doesNotMatch(
    extensionSource,
    /progressState: storedProgress\.length > 0 \? progressState : undefined/u,
  );
});
