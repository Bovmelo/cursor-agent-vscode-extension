import assert from "node:assert/strict";
import test from "node:test";
import {
  formatDiagnosticsMarkdown,
  redactDiagnosticText,
  sanitizeDiagnosticsBundle,
} from "../out/diagnosticsBundle.js";

const bundle = {
  generatedAt: "2026-07-20T00:00:00.000Z",
  extensionVersion: "0.2.0",
  vscodeVersion: "1.101.0",
  platform: "win32",
  architecture: "x64",
  language: "ja",
  workspaceTrusted: true,
  workspaceCount: 1,
  approvalMode: "auto-review",
  checks: [{ label: "Git", status: "ok", detail: "api_key=do-not-share" }],
};

test("diagnostic redaction removes common credential forms", () => {
  assert.equal(redactDiagnosticText("Authorization: Bearer abcdefghijklmnop"), "Authorization=<redacted> <redacted>");
  assert.equal(redactDiagnosticText("https://user:pass@example.com"), "https://<redacted>@example.com");
});

test("diagnostic bundles are sanitized before Markdown export", () => {
  const sanitized = sanitizeDiagnosticsBundle(bundle);
  assert.equal(sanitized.checks[0].detail, "api_key=<redacted>");
  const markdown = formatDiagnosticsMarkdown(bundle);
  assert.match(markdown, /Cursor Agent Diagnostics/u);
  assert.doesNotMatch(markdown, /do-not-share/u);
});
