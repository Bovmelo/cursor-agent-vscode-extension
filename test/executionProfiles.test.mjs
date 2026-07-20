import assert from "node:assert/strict";
import test from "node:test";
import {
  currentExecutionProfileLabel,
  executionProfile,
  executionProfiles,
  localizeExecutionProfile,
  matchExecutionProfile,
} from "../out/executionProfiles.js";

test("execution profiles expose safe, balanced, and automation presets", () => {
  assert.deepEqual(executionProfiles().map((profile) => profile.id), ["safe", "balanced", "automation"]);
  assert.equal(executionProfile("safe")?.approvalMode, "safe-worktree");
  assert.equal(executionProfile("balanced")?.settings.autoVerify, true);
  assert.equal(executionProfile("automation")?.settings.supervisorMode, "autonomous");
  assert.equal(executionProfile("unknown"), undefined);
});

test("automation is trust-bound and profiles have Japanese labels", () => {
  const profile = executionProfile("automation");
  assert.ok(profile?.requiresTrustedWorkspace);
  assert.equal(localizeExecutionProfile(profile, true).label, "自動化重視");
});

test("matchExecutionProfile remaps safe approval when sandbox is available", () => {
  const safe = executionProfile("safe");
  assert.ok(safe);
  assert.equal(
    matchExecutionProfile({
      settings: { ...safe.settings },
      approvalMode: "auto-review",
      supportsLocalSandbox: true,
    }),
    "safe",
  );
  assert.equal(
    matchExecutionProfile({
      settings: { ...safe.settings },
      approvalMode: "safe-worktree",
      supportsLocalSandbox: false,
    }),
    "safe",
  );
});

test("matchExecutionProfile returns balanced, automation, or custom", () => {
  const balanced = executionProfile("balanced");
  const automation = executionProfile("automation");
  assert.ok(balanced);
  assert.ok(automation);

  assert.equal(
    matchExecutionProfile({
      settings: { ...balanced.settings },
      approvalMode: "auto-review",
      supportsLocalSandbox: true,
    }),
    "balanced",
  );
  assert.equal(
    matchExecutionProfile({
      settings: { ...automation.settings },
      approvalMode: "auto-review",
      supportsLocalSandbox: true,
    }),
    "automation",
  );
  assert.equal(
    matchExecutionProfile({
      settings: { ...balanced.settings, supervisorMode: "autonomous" },
      approvalMode: "auto-review",
      supportsLocalSandbox: true,
    }),
    "custom",
  );
});

test("currentExecutionProfileLabel localizes presets and custom", () => {
  assert.equal(currentExecutionProfileLabel("safe", false), "Safe");
  assert.equal(currentExecutionProfileLabel("balanced", true), "バランス");
  assert.equal(currentExecutionProfileLabel("custom", false), "Custom");
  assert.equal(currentExecutionProfileLabel(undefined, true), "カスタム");
});
