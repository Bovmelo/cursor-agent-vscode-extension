import assert from "node:assert/strict";
import test from "node:test";
import { expandCommandBody, slugifyBranchTitle } from "../out/pureUtils.js";

test("slugifyBranchTitle creates safe branch suffixes", () => {
  assert.equal(slugifyBranchTitle("Fix Auth Flow!!"), "fix-auth-flow");
  assert.equal(slugifyBranchTitle("@@@"), "change");
  assert.ok(slugifyBranchTitle("a".repeat(100)).length <= 48);
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
