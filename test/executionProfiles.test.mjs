import assert from "node:assert/strict";
import test from "node:test";
import {
  executionProfile,
  executionProfiles,
  localizeExecutionProfile,
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
