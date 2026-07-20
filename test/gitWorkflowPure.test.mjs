import assert from "node:assert/strict";
import test from "node:test";
import {
  extractPullRequestUrl,
  isUnsafeGitRefName,
  sanitizePullRequestTitle,
} from "../out/gitWorkflowPure.js";

test("extractPullRequestUrl returns the first http(s) line from gh stdout", () => {
  assert.equal(
    extractPullRequestUrl([
      "Warning: 1 uncommitted change",
      "https://github.com/example/repo/pull/42",
      "https://github.com/example/repo/pull/43",
    ].join("\n")),
    "https://github.com/example/repo/pull/42",
  );
  assert.equal(
    extractPullRequestUrl("http://example.test/pull/7\r\n"),
    "http://example.test/pull/7",
  );
});

test("extractPullRequestUrl returns undefined when no URL line is present", () => {
  assert.equal(extractPullRequestUrl("Created pull request\nsee GitHub UI"), undefined);
  assert.equal(extractPullRequestUrl(""), undefined);
  assert.equal(extractPullRequestUrl("not-a-url://example"), undefined);
});

test("sanitizePullRequestTitle collapses newlines and bounds length", () => {
  assert.equal(sanitizePullRequestTitle("fix\r\nthe\nbug"), "fix the bug");
  const long = `title-${"x".repeat(200)}`;
  assert.equal(sanitizePullRequestTitle(long).length, 120);
  assert.equal(sanitizePullRequestTitle(long), long.slice(0, 120));
});

test("isUnsafeGitRefName rejects refs unsafe for git CLI args", () => {
  assert.equal(isUnsafeGitRefName("-main"), true);
  assert.equal(isUnsafeGitRefName("--output"), true);
  assert.equal(isUnsafeGitRefName(""), true);
  assert.equal(isUnsafeGitRefName("   "), true);
  assert.equal(isUnsafeGitRefName("foo..bar"), true);
  assert.equal(isUnsafeGitRefName("foo@{bar"), true);
  assert.equal(isUnsafeGitRefName("foo bar"), true);
  assert.equal(isUnsafeGitRefName("foo~1"), true);
  assert.equal(isUnsafeGitRefName("foo^1"), true);
  assert.equal(isUnsafeGitRefName("foo:bar"), true);
  assert.equal(isUnsafeGitRefName("foo?bar"), true);
  assert.equal(isUnsafeGitRefName("foo*bar"), true);
  assert.equal(isUnsafeGitRefName("foo[bar"), true);
  assert.equal(isUnsafeGitRefName("foo\\bar"), true);
  assert.equal(isUnsafeGitRefName("foo\nbar"), true);
  assert.equal(isUnsafeGitRefName("foo\x7fbar"), true);
  assert.equal(isUnsafeGitRefName("main"), false);
  assert.equal(isUnsafeGitRefName("cursor/fix-123"), false);
  assert.equal(isUnsafeGitRefName("feature/foo-bar"), false);
});
