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

const SECRET_ASSIGNMENT = /\b(api[_-]?key|authorization|cookie|credential|gh[_-]?token|password|secret|token)\b\s*[:=]\s*([^\s,;]+)/giu;
const BEARER_TOKEN = /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/giu;
const URL_CREDENTIALS = /(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu;

export function redactDiagnosticText(value: string): string {
  return value
    .replace(BEARER_TOKEN, "Bearer <redacted>")
    .replace(SECRET_ASSIGNMENT, (_match, key: string) => `${key}=<redacted>`)
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
