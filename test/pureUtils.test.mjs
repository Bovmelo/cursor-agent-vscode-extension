import assert from "node:assert/strict";
import test from "node:test";
import { branchStartsAtBase, expandCommandBody, slugifyBranchTitle } from "../out/pureUtils.js";

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
