import assert from "node:assert/strict";
import test from "node:test";
import { pullRequestRecoveryMessage } from "../out/gitWorkflowRecovery.js";

test("PR recovery message preserves branch and distinguishes a confirmed push", () => {
  const message = pullRequestRecoveryMessage({
    branch: "cursor/20260718-fix-123abc",
    commit: "abcdef123456",
    originalBranch: "main",
    failureStage: "create-pull-request",
    pushStatus: "confirmed",
  });
  assert.match(message, /cursor\/20260718-fix-123abc/);
  assert.match(message, /abcdef123456/);
  assert.match(message, /pushed to origin/);
  assert.match(message, /gh pr create/);
});

test("PR recovery does not claim an unconfirmed push succeeded", () => {
  const message = pullRequestRecoveryMessage({
    branch: "cursor/20260718-fix-123abc",
    commit: "abcdef123456",
    originalBranch: "main",
    failureStage: "push",
    pushStatus: "unconfirmed",
  });
  assert.match(message, /Check whether the push reached the remote/);
  assert.doesNotMatch(message, /was pushed to origin/);
});
