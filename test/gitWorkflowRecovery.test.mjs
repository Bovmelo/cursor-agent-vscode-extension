import assert from "node:assert/strict";
import test from "node:test";
import {
  pullRequestRecoveryActionLabel,
  pullRequestRecoveryActions,
  pullRequestRecoveryMessage,
} from "../out/gitWorkflowRecovery.js";

const sampleRecovery = {
  branch: "cursor/20260718-fix-123abc",
  commit: "abcdef123456",
  originalBranch: "main",
  failureStage: "create-pull-request",
  pushStatus: "confirmed",
};

test("PR recovery actions always offer checkout and retry", () => {
  assert.deepEqual(pullRequestRecoveryActions(sampleRecovery), [
    "checkout",
    "retry",
  ]);
});

test("PR recovery action labels stay paired in English and Japanese", () => {
  assert.equal(
    pullRequestRecoveryActionLabel("checkout", false),
    "Checkout preserved branch",
  );
  assert.equal(
    pullRequestRecoveryActionLabel("checkout", true),
    "保持したブランチをチェックアウト",
  );
  assert.equal(
    pullRequestRecoveryActionLabel("retry", false),
    "Retry PR create",
  );
  assert.equal(
    pullRequestRecoveryActionLabel("retry", true),
    "PR作成を再試行",
  );
});

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
