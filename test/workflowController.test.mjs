import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowController } from "../out/workflowController.js";

function createHarness(overrides = {}) {
  const calls = {
    commands: [],
    warnings: [],
    information: [],
    settings: [],
    selectedProfiles: [],
    approvalModes: [],
    permissionsConfirmed: 0,
    hooks: [],
  };
  const dependencies = {
    japanese: false,
    supportsLocalSandbox: false,
    isWorkspaceTrusted: () => true,
    hasWorkspaceFolders: () => true,
    currentExecutionProfile: () => undefined,
    pickWorkflow: async () => undefined,
    pickExecutionProfile: async () => undefined,
    showWarningMessage: async (message, options, actions) => {
      calls.warnings.push({ message, options, actions });
      return undefined;
    },
    showInformationMessage: async (message) => {
      calls.information.push(message);
    },
    executeCommand: async (command, ...args) => {
      calls.commands.push({ command, args });
    },
    updateConfiguration: async (key, value, target) => {
      calls.settings.push({ key, value, target });
    },
    updateSelectedExecutionProfile: async (id) => {
      calls.selectedProfiles.push(id);
    },
    updateApprovalMode: async (mode) => {
      calls.approvalModes.push(mode);
    },
    markPermissionsConfirmed: async () => {
      calls.permissionsConfirmed += 1;
    },
    cancelAllChats: async () => calls.hooks.push("cancel"),
    disposeAgent: async () => calls.hooks.push("dispose"),
    approvalModeSelected: async () => calls.hooks.push("approval"),
    refreshNotificationAndSoundSettings: async () => calls.hooks.push("notifications"),
    publishSetupChecklistState: async () => calls.hooks.push("checklist"),
    ...overrides,
  };
  return { controller: new WorkflowController(dependencies), calls };
}

test("workflow selection executes the chosen recipe command", async () => {
  const { controller, calls } = createHarness({
    pickWorkflow: async (items) => items.find((item) => item.recipe.id === "ask"),
  });

  assert.equal(await controller.chooseWorkflow(), "executed");
  assert.deepEqual(calls.commands, [{ command: "cursorSubscription.openChat", args: [] }]);
});

test("workflow trust gate offers workspace trust without running the recipe", async () => {
  let trustAction;
  const { controller, calls } = createHarness({
    isWorkspaceTrusted: () => false,
    pickWorkflow: async (items) => items.find((item) => item.recipe.id === "delegate"),
    showWarningMessage: async (message, options, actions) => {
      calls.warnings.push({ message, options, actions });
      trustAction = actions[0];
      return actions[0];
    },
  });

  assert.equal(await controller.chooseWorkflow(), "trust-required");
  assert.equal(trustAction, "Manage Workspace Trust");
  assert.deepEqual(calls.commands, [{ command: "workbench.trust.manage", args: [] }]);
});

test("execution profile applies settings, persisted state, and lifecycle hooks", async () => {
  const { controller, calls } = createHarness({
    supportsLocalSandbox: true,
    currentExecutionProfile: () => "safe",
    pickExecutionProfile: async (items) => items.find((item) => item.profile.id === "safe"),
  });

  assert.equal(await controller.chooseExecutionProfile(), "applied");
  assert.ok(calls.settings.some((entry) => entry.key === "supervisorMode"));
  assert.ok(calls.settings.every((entry) => entry.target === "workspace"));
  assert.deepEqual(calls.selectedProfiles, ["safe"]);
  assert.deepEqual(calls.approvalModes, ["auto-review"]);
  assert.equal(calls.permissionsConfirmed, 1);
  assert.deepEqual(calls.hooks, ["cancel", "dispose", "approval", "notifications", "checklist"]);
  assert.equal(calls.information[0], "Execution profile applied: Safe");
});

test("trusted automation requires explicit modal confirmation", async () => {
  const { controller, calls } = createHarness({
    pickExecutionProfile: async (items) => items.find((item) => item.profile.id === "automation"),
  });

  assert.equal(await controller.chooseExecutionProfile(), "cancelled");
  assert.equal(calls.warnings[0].options.modal, true);
  assert.deepEqual(calls.settings, []);
  assert.deepEqual(calls.hooks, []);
});

test("trust-bound profiles do not mutate configuration in untrusted workspaces", async () => {
  const { controller, calls } = createHarness({
    isWorkspaceTrusted: () => false,
    pickExecutionProfile: async (items) => items.find((item) => item.profile.id === "balanced"),
  });

  assert.equal(await controller.chooseExecutionProfile(), "trust-required");
  assert.deepEqual(calls.settings, []);
  assert.match(calls.warnings[0].message, /requires a trusted workspace/u);
});
