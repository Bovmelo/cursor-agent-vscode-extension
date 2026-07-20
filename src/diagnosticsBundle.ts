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
}

const SECRET_ASSIGNMENT = /\b(api[_-]?key|authorization|cookie|credential|gh[_-]?token|password|secret|token)\b\s*[:=]\s*([^\s,;]+)/giu;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/giu;
const URL_CREDENTIALS = /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu;

export function redactDiagnosticText(value: string): string {
  return value
    .replace(BEARER_TOKEN, "Bearer <redacted>")
    .replace(SECRET_ASSIGNMENT, (_match, key: string) => `${key}=<redacted>`)
    .replace(URL_CREDENTIALS, "$1<redacted>@");
}

export function sanitizeDiagnosticsBundle(bundle: DiagnosticsBundle): DiagnosticsBundle {
  const clean = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : redactDiagnosticText(value);
  return {
    ...bundle,
    selectedModel: clean(bundle.selectedModel),
    checks: bundle.checks.map((check) => ({
      ...check,
      label: redactDiagnosticText(check.label),
      detail: clean(check.detail),
    })),
    recentRuns: bundle.recentRuns?.map((run) => ({
      ...run,
      title: redactDiagnosticText(run.title),
      detail: clean(run.detail),
      runId: clean(run.runId),
    })),
    recentAudit: bundle.recentAudit?.map((entry) => ({
      ...entry,
      summary: redactDiagnosticText(entry.summary),
      taskId: clean(entry.taskId),
      sessionId: clean(entry.sessionId),
    })),
  };
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
    `Selected model: ${bundle.selectedModel ?? "unknown"}`,
    "",
    "## Checks",
    "",
  ];
  for (const check of bundle.checks) {
    lines.push(`- **${check.status.toUpperCase()}** ${check.label}${check.detail ? ` — ${check.detail}` : ""}`);
  }
  if (bundle.recentRuns?.length) {
    lines.push("", "## Recent runs", "");
    for (const run of bundle.recentRuns) {
      lines.push(`- ${run.state}: ${run.title}${run.runId ? ` (run ${run.runId})` : ""}${run.detail ? ` — ${run.detail}` : ""}`);
    }
  }
  if (bundle.recentAudit?.length) {
    lines.push("", "## Recent audit entries", "");
    for (const entry of bundle.recentAudit) {
      lines.push(`- ${entry.at} · ${entry.action} · ${entry.summary}`);
    }
  }
  lines.push("", "API keys and common credential forms are redacted. Review the file before sharing it.", "");
  return lines.join("\n");
}
