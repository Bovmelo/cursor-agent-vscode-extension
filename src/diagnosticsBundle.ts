import type {
  DiagnosticsBackgroundJobSummary,
  DiagnosticsRunCenterSummary,
  DiagnosticsSupervisorTaskSummary,
} from "./diagnosticsCollectors.js";

export interface DiagnosticCheck {
  label: string;
  status: "ok" | "warning" | "error" | "unknown";
  detail?: string;
}

export interface DiagnosticsBundle {
  generatedAt: string;
  extensionVersion: string;
  vscodeVersion: string;
  platform: string;
  architecture: string;
  language: string;
  workspaceTrusted: boolean;
  workspaceCount: number;
  approvalMode: string;
  executionProfile?: string;
  selectedModel?: string;
  checks: readonly DiagnosticCheck[];
  recentRuns?: readonly {
    title: string;
    state: string;
    detail?: string;
    runId?: string;
  }[];
  recentAudit?: readonly {
    at: string;
    action: string;
    summary: string;
    taskId?: string;
    sessionId?: string;
  }[];
  recentBackgroundJobs?: readonly DiagnosticsBackgroundJobSummary[];
  runCenter?: DiagnosticsRunCenterSummary;
  recentSupervisorTasks?: readonly DiagnosticsSupervisorTaskSummary[];
  auditSharedLogError?: string;
  profileMatch?: string;
  configurationSnapshot?: readonly DiagnosticCheck[];
}

const AUTHORIZATION_SCHEME = "Basic|Bearer|Digest|Negotiate|NTLM|Token|AWS4-HMAC-SHA256";
const AUTHORIZATION_KEY = "proxy-authorization|authorization";
const JSON_AUTHORIZATION_PROPERTY = new RegExp(
  `(["'])(${AUTHORIZATION_KEY})\\1(\\s*:\\s*)(["'])((?:${AUTHORIZATION_SCHEME})\\b[ \\t]*)?(?:\\\\.|(?!\\4)[^\\\\\\r\\n])*\\4`,
  "giu",
);
const AUTHORIZATION_HEADER = new RegExp(
  `^([ \\t]*)(${AUTHORIZATION_KEY})\\b([ \\t]*:[ \\t]*)([^\\r\\n]*(?:\\r?\\n[ \\t]+[^\\r\\n]*)*)`,
  "gimu",
);
const AUTHORIZATION_SCHEME_PREFIX = new RegExp(`^(${AUTHORIZATION_SCHEME})\\b`, "iu");
const INLINE_QUOTED_AUTHORIZATION = new RegExp(
  `(?<![A-Za-z0-9_-])(["']?)(${AUTHORIZATION_KEY})\\1([ \\t]*[:=][ \\t]*)(["'])((?:${AUTHORIZATION_SCHEME})\\b[ \\t]*)?(?:\\\\.|(?!\\4)[^\\\\\\r\\n])*\\4`,
  "giu",
);
const AWS4_PARAMETER_VALUE =
  String.raw`(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;}\]"']+)`;
const AWS4_SIGNED_HEADERS_VALUE =
  String.raw`(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,}\]"']+)`;
const INLINE_AWS4_AUTHORIZATION = new RegExp(
  `(?<![A-Za-z0-9_-])(["']?)(${AUTHORIZATION_KEY})\\1([ \\t]*[:=][ \\t]*)(AWS4-HMAC-SHA256)\\b[ \\t]+Credential\\b[ \\t]*=[ \\t]*${AWS4_PARAMETER_VALUE}[ \\t]*,[ \\t]*SignedHeaders\\b[ \\t]*=[ \\t]*${AWS4_SIGNED_HEADERS_VALUE}[ \\t]*,[ \\t]*Signature\\b[ \\t]*=[ \\t]*${AWS4_PARAMETER_VALUE}`,
  "giu",
);
const DIGEST_PARAMETER =
  String.raw`[A-Za-z][A-Za-z0-9_-]*[ \t]*=[ \t]*(?:"(?:\\.|[^"\\\r\n])*"|'(?:\\.|[^'\\\r\n])*'|[^\s,;}\]"']+)`;
const INLINE_DIGEST_AUTHORIZATION = new RegExp(
  `(?<![A-Za-z0-9_-])(["']?)(${AUTHORIZATION_KEY})\\1([ \\t]*[:=][ \\t]*)(Digest)\\b[ \\t]+${DIGEST_PARAMETER}(?:[ \\t]*,[ \\t]*${DIGEST_PARAMETER})*`,
  "giu",
);
const INLINE_AUTHORIZATION = new RegExp(
  `(?<![A-Za-z0-9_-])(["']?)(${AUTHORIZATION_KEY})\\1([ \\t]*[:=][ \\t]*)(?:(${AUTHORIZATION_SCHEME})\\b[ \\t]+)?[^\\s,;}\\]"']+`,
  "giu",
);
const SECRET_ASSIGNMENT = /\b(cursor[_-]?api[_-]?key|api[_-]?key|cookie|credential|gh[_-]?token|password|secret|token)\b(\s*[:=]\s*)(?!Bearer\b)([^\s,;]+)/giu;
const API_KEY_WHITESPACE = /\b(cursor[_-]?api[_-]?key|api[_-]?key)([ \t]+)(?!is\b|was\b|missing\b|unset\b|undefined\b|null\b|none\b|configured\b|present\b|absent\b|required\b)(?:(["'])([A-Za-z0-9][A-Za-z0-9._~+\/-]{6,}[A-Za-z0-9])\3|[A-Za-z0-9][A-Za-z0-9._~+\/-]{6,}[A-Za-z0-9])/giu;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/giu;
const CURSOR_KEY_TOKEN = /(?<![A-Za-z0-9_])(?:key_|crsr_)[A-Za-z0-9][A-Za-z0-9._-]{6,}[A-Za-z0-9](?![A-Za-z0-9_-]|\.[A-Za-z0-9])/giu;
const URL_CREDENTIALS = /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu;

export function redactDiagnosticText(value: string): string {
  return value
    .replace(
      JSON_AUTHORIZATION_PROPERTY,
      (
        _match,
        keyQuote: string,
        key: string,
        separator: string,
        valueQuote: string,
        scheme: string | undefined,
      ) =>
        `${keyQuote}${key}${keyQuote}${separator}${valueQuote}${scheme ?? ""}<redacted>${valueQuote}`,
    )
    .replace(
      AUTHORIZATION_HEADER,
      (
        _match,
        indentation: string,
        key: string,
        separator: string,
        rawValue: string,
      ) => {
        const unfoldedValue = rawValue.replace(/\r?\n[ \t]+/gu, " ").trim();
        const scheme = AUTHORIZATION_SCHEME_PREFIX.exec(unfoldedValue)?.[1];
        const foldedSeparator =
          rawValue.includes("\n") && !/[ \t]$/u.test(separator) ? " " : "";
        return `${indentation}${key}${separator}${foldedSeparator}${scheme ? `${scheme} ` : ""}<redacted>`;
      },
    )
    .replace(
      INLINE_QUOTED_AUTHORIZATION,
      (
        _match,
        keyQuote: string,
        key: string,
        separator: string,
        valueQuote: string,
        scheme: string | undefined,
      ) =>
        `${keyQuote}${key}${keyQuote}${separator}${valueQuote}${scheme ?? ""}<redacted>${valueQuote}`,
    )
    .replace(
      INLINE_AWS4_AUTHORIZATION,
      (_match, keyQuote: string, key: string, separator: string, scheme: string) =>
        `${keyQuote}${key}${keyQuote}${separator}${scheme} <redacted>`,
    )
    .replace(
      INLINE_DIGEST_AUTHORIZATION,
      (_match, keyQuote: string, key: string, separator: string, scheme: string) =>
        `${keyQuote}${key}${keyQuote}${separator}${scheme} <redacted>`,
    )
    .replace(
      INLINE_AUTHORIZATION,
      (
        _match,
        keyQuote: string,
        key: string,
        separator: string,
        scheme: string | undefined,
      ) =>
        `${keyQuote}${key}${keyQuote}${separator}${scheme ? `${scheme} ` : ""}<redacted>`,
    )
    .replace(BEARER_TOKEN, "Bearer <redacted>")
    .replace(SECRET_ASSIGNMENT, (_match, key: string, separator: string) => `${key}${separator}<redacted>`)
    .replace(API_KEY_WHITESPACE, (_match, key: string, separator: string) => `${key}${separator}<redacted>`)
    .replace(CURSOR_KEY_TOKEN, "<redacted>")
    .replace(URL_CREDENTIALS, "$1<redacted>@");
}

function cleanOptional(value: string | undefined): string | undefined {
  return value === undefined ? undefined : redactDiagnosticText(value);
}

function sanitizeCheck(check: DiagnosticCheck): DiagnosticCheck {
  return {
    ...check,
    label: redactDiagnosticText(check.label),
    detail: cleanOptional(check.detail),
  };
}

function sanitizeBackgroundJob(
  job: DiagnosticsBackgroundJobSummary,
): DiagnosticsBackgroundJobSummary {
  return {
    ...job,
    title: redactDiagnosticText(job.title),
    error: cleanOptional(job.error),
  };
}

function sanitizeRunCenter(state: DiagnosticsRunCenterSummary): DiagnosticsRunCenterSummary {
  return {
    ...state,
    runId: cleanOptional(state.runId),
    title: cleanOptional(state.title),
    progress: state.progress
      ? {
          ...state.progress,
          message: redactDiagnosticText(state.progress.message),
          detail: cleanOptional(state.progress.detail),
        }
      : undefined,
    planSteps: state.planSteps?.map((step) => ({
      ...step,
      label: redactDiagnosticText(step.label),
    })),
    verificationSummary: state.verificationSummary?.map((item) => ({
      ...item,
      label: redactDiagnosticText(item.label),
    })),
    error: cleanOptional(state.error),
  };
}

function sanitizeSupervisorTask(
  task: DiagnosticsSupervisorTaskSummary,
): DiagnosticsSupervisorTaskSummary {
  return {
    ...task,
    title: redactDiagnosticText(task.title),
    error: cleanOptional(task.error),
    blockedReasons: task.blockedReasons?.map((reason) => redactDiagnosticText(reason)),
  };
}

export function sanitizeDiagnosticsBundle(bundle: DiagnosticsBundle): DiagnosticsBundle {
  return {
    ...bundle,
    selectedModel: cleanOptional(bundle.selectedModel),
    executionProfile: cleanOptional(bundle.executionProfile),
    profileMatch: cleanOptional(bundle.profileMatch),
    auditSharedLogError: cleanOptional(bundle.auditSharedLogError),
    checks: bundle.checks.map(sanitizeCheck),
    configurationSnapshot: bundle.configurationSnapshot?.map(sanitizeCheck),
    recentRuns: bundle.recentRuns?.map((run) => ({
      ...run,
      title: redactDiagnosticText(run.title),
      detail: cleanOptional(run.detail),
      runId: cleanOptional(run.runId),
    })),
    recentAudit: bundle.recentAudit?.map((entry) => ({
      ...entry,
      summary: redactDiagnosticText(entry.summary),
      taskId: cleanOptional(entry.taskId),
      sessionId: cleanOptional(entry.sessionId),
    })),
    recentBackgroundJobs: bundle.recentBackgroundJobs?.map(sanitizeBackgroundJob),
    runCenter: bundle.runCenter ? sanitizeRunCenter(bundle.runCenter) : undefined,
    recentSupervisorTasks: bundle.recentSupervisorTasks?.map(sanitizeSupervisorTask),
  };
}

function appendCheckSection(
  lines: string[],
  heading: string,
  checks: readonly DiagnosticCheck[] | undefined,
): void {
  if (!checks?.length) {
    return;
  }
  lines.push("", `## ${heading}`, "");
  for (const check of checks) {
    lines.push(
      `- **${check.status.toUpperCase()}** ${check.label}${check.detail ? ` — ${check.detail}` : ""}`,
    );
  }
}

export function formatDiagnosticsMarkdown(raw: DiagnosticsBundle): string {
  const bundle = sanitizeDiagnosticsBundle(raw);
  const lines = [
    "# Cursor Agent Diagnostics",
    "",
    `Generated: ${bundle.generatedAt}`,
    `Extension: ${bundle.extensionVersion}`,
    `VS Code: ${bundle.vscodeVersion}`,
    `Runtime: ${bundle.platform} ${bundle.architecture}`,
    `Language: ${bundle.language}`,
    `Workspace trusted: ${bundle.workspaceTrusted ? "yes" : "no"}`,
    `Workspace folders: ${bundle.workspaceCount}`,
    `Approval mode: ${bundle.approvalMode}`,
    `Execution profile: ${bundle.executionProfile ?? "custom"}`,
    `Profile match: ${bundle.profileMatch ?? "unknown"}`,
    `Selected model: ${bundle.selectedModel ?? "unknown"}`,
    "",
    "## Checks",
    "",
  ];
  for (const check of bundle.checks) {
    lines.push(`- **${check.status.toUpperCase()}** ${check.label}${check.detail ? ` — ${check.detail}` : ""}`);
  }
  appendCheckSection(lines, "Configuration snapshot", bundle.configurationSnapshot);
  if (bundle.recentRuns?.length) {
    lines.push("", "## Recent runs", "");
    for (const run of bundle.recentRuns) {
      lines.push(`- ${run.state}: ${run.title}${run.runId ? ` (run ${run.runId})` : ""}${run.detail ? ` — ${run.detail}` : ""}`);
    }
  }
  if (bundle.recentBackgroundJobs?.length) {
    lines.push("", "## Recent background jobs", "");
    for (const job of bundle.recentBackgroundJobs) {
      lines.push(
        `- ${job.status}: ${job.title} (${job.id})${job.error ? ` — ${job.error}` : ""}`,
      );
    }
  }
  if (bundle.runCenter) {
    const run = bundle.runCenter;
    lines.push("", "## Run Center", "");
    lines.push(`- Title: ${run.title ?? "none"}`);
    if (run.runId) {
      lines.push(`- Run ID: ${run.runId}`);
    }
    if (run.progress) {
      lines.push(
        `- Progress: ${run.progress.status} — ${run.progress.message}${run.progress.detail ? ` (${run.progress.detail})` : ""}`,
      );
    }
    if (run.planSteps?.length) {
      lines.push(`- Plan steps: ${run.planSteps.map((step) => `${step.status}:${step.label}`).join(", ")}`);
    }
    if (run.changeCount !== undefined) {
      lines.push(`- Changes: ${run.changeCount}`);
    }
    if (run.verificationSummary?.length) {
      lines.push(
        `- Verification: ${run.verificationSummary.map((item) => `${item.status}:${item.label}`).join(", ")}`,
      );
    }
    if (run.error) {
      lines.push(`- Error: ${run.error}`);
    }
  }
  if (bundle.recentSupervisorTasks?.length) {
    lines.push("", "## Recent supervisor tasks", "");
    for (const task of bundle.recentSupervisorTasks) {
      lines.push(
        `- ${task.status}: ${task.title} (${task.source}${task.error ? ` — ${task.error}` : ""})`,
      );
    }
  }
  if (bundle.recentAudit?.length) {
    lines.push("", "## Recent audit entries", "");
    for (const entry of bundle.recentAudit) {
      lines.push(`- ${entry.at} · ${entry.action} · ${entry.summary}`);
    }
  }
  if (bundle.auditSharedLogError) {
    lines.push("", "## Shared audit log", "", `- Error: ${bundle.auditSharedLogError}`);
  }
  lines.push("", "API keys and common credential forms are redacted. Review the file before sharing it.", "");
  return lines.join("\n");
}
