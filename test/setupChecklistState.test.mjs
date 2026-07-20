import assert from "node:assert/strict";
import test from "node:test";
import { buildSetupChecklistState } from "../out/setupChecklistState.js";

test("buildSetupChecklistState stays visible until API key is configured", () => {
  const state = buildSetupChecklistState({
    dismissed: true,
    apiKeyConfigured: false,
    workspaceTrusted: true,
    hasWorkspace: true,
    gitReady: true,
    permissionsConfirmed: true,
    approvalMode: "auto-review",
    ghSkipped: false,
    ghAvailable: false,
    sandboxSupported: true,
  });

  assert.equal(state.visible, true);
  assert.equal(state.dismissed, true);
  assert.equal(state.steps.apiKey.complete, false);
  assert.equal(state.steps.gh.complete, false);
  assert.equal(state.steps.gh.optional, true);
});

test("buildSetupChecklistState marks contextual steps from probes", () => {
  const state = buildSetupChecklistState({
    dismissed: false,
    apiKeyConfigured: true,
    workspaceTrusted: false,
    hasWorkspace: true,
    gitReady: false,
    permissionsConfirmed: false,
    approvalMode: "safe-worktree",
    ghSkipped: true,
    ghAvailable: false,
    sandboxSupported: false,
  });

  assert.equal(state.visible, true);
  assert.equal(state.sandboxSupported, false);
  assert.equal(state.steps.workspaceTrust.complete, false);
  assert.equal(state.steps.gitWorkspace.complete, false);
  assert.equal(state.steps.gitWorkspace.hasWorkspace, true);
  assert.equal(state.steps.gitWorkspace.gitReady, false);
  assert.equal(state.steps.permissions.complete, false);
  assert.equal(state.steps.permissions.mode, "safe-worktree");
  assert.equal(state.steps.gh.complete, true);
  assert.equal(state.steps.gh.available, false);
});
