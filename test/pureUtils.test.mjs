import assert from "node:assert/strict";
import test from "node:test";
import {
  branchStartsAtBase,
  expandCommandBody,
  isLocalRuntimeWriteCancelled,
  slugifyBranchTitle,
} from "../out/pureUtils.js";

test("slugifyBranchTitle creates safe branch suffixes", () => {
  assert.equal(slugifyBranchTitle("Fix Auth Flow!!"), "fix-auth-flow");
  assert.equal(slugifyBranchTitle("@@@"), "change");
  assert.ok(slugifyBranchTitle("a".repeat(100)).length <= 48);
});

test("branchStartsAtBase requires the current commit to equal the PR base", () => {
  assert.equal(branchStartsAtBase("abc123\n", "abc123"), true);
  assert.equal(branchStartsAtBase("feature-head", "main-head"), false);
});

test("expandCommandBody appends trailing user text", () => {
  assert.equal(
    expandCommandBody("Review carefully.", ""),
    "Review carefully.",
  );
  assert.equal(
    expandCommandBody("Review carefully.", "focus on auth"),
    "Review carefully.\n\nfocus on auth",
  );
});

test("isLocalRuntimeWriteCancelled only matches the native IPC cancellation", () => {
  assert.equal(isLocalRuntimeWriteCancelled(undefined, "write ECANCELED"), true);
  assert.equal(isLocalRuntimeWriteCancelled("ECANCELED", "operation failed"), true);
  assert.equal(isLocalRuntimeWriteCancelled(undefined, "cancelled by user"), false);
  assert.equal(isLocalRuntimeWriteCancelled("ERR_CANCELED", "request cancelled"), false);
  assert.equal(isLocalRuntimeWriteCancelled(undefined, "write EPIPE"), false);
});
