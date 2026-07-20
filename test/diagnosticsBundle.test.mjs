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
  executionProfile: "balanced",
  profileMatch: "custom",
  checks: [{ label: "Git", status: "ok", detail: "api_key=do-not-share" }],
  configurationSnapshot: [
    { label: "supervisorMode", status: "ok", detail: "observe" },
    { label: "shared log", status: "warning", detail: "token=abc12345" },
  ],
  recentBackgroundJobs: [
    {
      id: "job-1",
      title: "Background with password=hunter2",
      status: "error",
      updatedAt: "2026-07-20T00:00:00.000Z",
      error: "Authorization: Bearer abcdefghijklmnop",
    },
  ],
  runCenter: {
    runId: "run-1",
    title: "Run with secret=value",
    progress: {
      message: "Working",
      status: "running",
      detail: "https://user:pass@example.com",
    },
    error: "cookie=session",
  },
  recentSupervisorTasks: [
    {
      id: "task-1",
      title: "Supervisor",
      status: "failed",
      source: "manual",
      updatedAt: "2026-07-20T00:00:00.000Z",
      error: "gh_token=leak",
      blockedReasons: ["api_key=blocked"],
    },
  ],
  auditSharedLogError: "failed to write password=shared-secret",
};

test("diagnostic redaction removes common credential forms", () => {
  assert.equal(redactDiagnosticText("Authorization: Bearer abcdefghijklmnop"), "Authorization: Bearer <redacted>");
  assert.equal(redactDiagnosticText("https://user:pass@example.com"), "https://<redacted>@example.com");
});

test("diagnostic redaction removes Cursor API key export forms", () => {
  assert.equal(
    redactDiagnosticText("CURSOR_API_KEY = cursor-secret-value"),
    "CURSOR_API_KEY = <redacted>",
  );
  assert.equal(
    redactDiagnosticText("request failed for key_0123456789abcdef."),
    "request failed for <redacted>.",
  );
  assert.equal(redactDiagnosticText("apiKey cursor-secret-value"), "apiKey <redacted>");
  assert.equal(redactDiagnosticText("APIKEY\tABCDEF0123456789"), "APIKEY\t<redacted>");
  assert.equal(
    redactDiagnosticText("cursorApiKey cursor-secret-value"),
    "cursorApiKey <redacted>",
  );
  assert.equal(
    redactDiagnosticText("CURSOR_API_KEY ABCDEF0123456789"),
    "CURSOR_API_KEY <redacted>",
  );
  assert.equal(
    redactDiagnosticText("cursor-api-key 'key_0123456789abcdef'"),
    "cursor-api-key <redacted>",
  );
});

test("diagnostic redaction avoids ordinary API key labels and short identifiers", () => {
  assert.equal(
    redactDiagnosticText(
      "API key is configured; apiKey missing; cursorApiKey unset; CURSOR_API_KEY required; key_name is a field",
    ),
    "API key is configured; apiKey missing; cursorApiKey unset; CURSOR_API_KEY required; key_name is a field",
  );
});

test("diagnostic bundles are sanitized before Markdown export", () => {
  const sanitized = sanitizeDiagnosticsBundle(bundle);
  assert.equal(sanitized.checks[0].detail, "api_key=<redacted>");
  assert.equal(sanitized.configurationSnapshot?.[1].detail, "token=<redacted>");
  assert.equal(sanitized.recentBackgroundJobs?.[0].title, "Background with password=<redacted>");
  assert.equal(sanitized.runCenter?.title, "Run with secret=<redacted>");
  assert.equal(sanitized.recentSupervisorTasks?.[0].error, "gh_token=<redacted>");
  assert.equal(sanitized.auditSharedLogError, "failed to write password=<redacted>");

  const markdown = formatDiagnosticsMarkdown(bundle);
  assert.match(markdown, /Cursor Agent Diagnostics/u);
  assert.match(markdown, /## Recent background jobs/u);
  assert.match(markdown, /## Run Center/u);
  assert.match(markdown, /## Recent supervisor tasks/u);
  assert.match(markdown, /## Configuration snapshot/u);
  assert.match(markdown, /Profile match: custom/u);
  assert.doesNotMatch(markdown, /do-not-share|hunter2|abcdefghijklmnop|shared-secret|user:pass/u);
  assert.doesNotMatch(JSON.stringify(sanitized), /prompt/iu);
});
