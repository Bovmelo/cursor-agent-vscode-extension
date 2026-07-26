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
  assert.equal(
    redactDiagnosticText("Authorization: Basic dXNlcjpwYXNz"),
    "Authorization: Basic <redacted>",
  );
  assert.equal(
    redactDiagnosticText("Proxy-Authorization: Basic cHJveHk6c2VjcmV0"),
    "Proxy-Authorization: Basic <redacted>",
  );
  assert.equal(
    redactDiagnosticText("Authorization: Digest username=user, realm=private, nonce=secret"),
    "Authorization: Digest <redacted>",
  );
  assert.equal(
    redactDiagnosticText("Authorization: Basic dXNlcjpwYXNz\nStatus: 401"),
    "Authorization: Basic <redacted>\nStatus: 401",
  );
  assert.equal(redactDiagnosticText("https://user:pass@example.com"), "https://<redacted>@example.com");
});

test("diagnostic redaction preserves unrelated JSON fields around authorization credentials", () => {
  assert.equal(
    redactDiagnosticText(
      '{"status":401,"Authorization":"Basic dXNlcjpwYXNz","retry":false}',
    ),
    '{"status":401,"Authorization":"Basic <redacted>","retry":false}',
  );
  assert.equal(
    redactDiagnosticText(
      '{"Proxy-Authorization": "Digest username=user, realm=private, nonce=secret", "host":"proxy.example"}',
    ),
    '{"Proxy-Authorization": "Digest <redacted>", "host":"proxy.example"}',
  );
  assert.equal(
    redactDiagnosticText('{"authorization":"Bearer abcdefghijklmnop","requestId":"req-1"}'),
    '{"authorization":"Bearer <redacted>","requestId":"req-1"}',
  );
  assert.equal(
    redactDiagnosticText(
      `{'Proxy-Authorization':'Basic cHJveHk6c2VjcmV0','status':'failed'}`,
    ),
    `{'Proxy-Authorization':'Basic <redacted>','status':'failed'}`,
  );
});

test("diagnostic redaction removes folded authorization credentials", () => {
  assert.equal(
    redactDiagnosticText("Authorization: Basic\r\n dXNlcjpwYXNz"),
    "Authorization: Basic <redacted>",
  );
  assert.equal(
    redactDiagnosticText("Proxy-Authorization:\r\n\tBearer abcdefghijklmnop"),
    "Proxy-Authorization: Bearer <redacted>",
  );
  assert.equal(
    redactDiagnosticText(
      "Authorization: Digest username=user,\r\n realm=private,\r\n nonce=secret\r\nStatus: 401",
    ),
    "Authorization: Digest <redacted>\r\nStatus: 401",
  );
});

test("diagnostic redaction preserves unrelated inline diagnostic fields", () => {
  assert.equal(
    redactDiagnosticText("Authorization=secret status=401 requestId=req-1"),
    "Authorization=<redacted> status=401 requestId=req-1",
  );
  assert.equal(
    redactDiagnosticText(
      "{Proxy-Authorization: Basic cHJveHk6c2VjcmV0, status: 407, requestId: req-2}",
    ),
    "{Proxy-Authorization: Basic <redacted>, status: 407, requestId: req-2}",
  );
  assert.equal(
    redactDiagnosticText(
      "[response] Authorization=Digest username=user, realm=private, nonce=secret status=401 requestId=req-3",
    ),
    "[response] Authorization=Digest <redacted> status=401 requestId=req-3",
  );
});

test("diagnostic redaction removes complete inline SigV4 credentials", () => {
  assert.equal(
    redactDiagnosticText(
      "Authorization=AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20260726/ap-northeast-1/service/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=0123456789abcdef status=403 requestId=req-aws-1",
    ),
    "Authorization=AWS4-HMAC-SHA256 <redacted> status=403 requestId=req-aws-1",
  );
  assert.equal(
    redactDiagnosticText(
      "[proxy] Proxy-Authorization=AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20260726/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=abcdef0123456789, status=407, requestId=req-aws-2",
    ),
    "[proxy] Proxy-Authorization=AWS4-HMAC-SHA256 <redacted>, status=407, requestId=req-aws-2",
  );
  assert.equal(
    redactDiagnosticText(
      '{"authorization":"AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20260726/us-west-2/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=fedcba9876543210","status":401,"requestId":"req-aws-3"}',
    ),
    '{"authorization":"AWS4-HMAC-SHA256 <redacted>","status":401,"requestId":"req-aws-3"}',
  );
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
      "API key is configured; apiKey missing; cursorApiKey unset; CURSOR_API_KEY required; authorization is required; key_name is a field",
    ),
    "API key is configured; apiKey missing; cursorApiKey unset; CURSOR_API_KEY required; authorization is required; key_name is a field",
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
