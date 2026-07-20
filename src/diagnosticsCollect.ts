import type { AuditEntry } from "./auditLog.js";
import type { Conversation } from "./chatTypes.js";
import type { DiagnosticCheck } from "./diagnosticsBundle.js";
import type { ExecutionProfileSettingValue } from "./executionProfiles.js";

export interface DiagnosticsRecentRun {
  readonly title: string;
  readonly state: string;
  readonly detail?: string;
  readonly runId?: string;
}

export interface DiagnosticsRecentAudit {
  readonly at: string;
  readonly action: string;
  readonly summary: string;
  readonly taskId?: string;
  readonly sessionId?: string;
}

/** Derive recent run summaries from conversation transcripts (no prompts/secrets). */
export function buildRecentRunsFromConversations(
  conversations: readonly Conversation[],
  limit = 20,
): DiagnosticsRecentRun[] {
  return [...conversations]
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, Math.max(0, limit))
    .flatMap((conversation) => {
      const result = [...conversation.transcript]
        .reverse()
        .find((entry) => entry.role === "assistant");
      if (!result) return [];
      const runId = /(?:^|\n)Run:\s*([^\s]+)/u.exec(result.text)?.[1];
      return [
        {
          title: conversation.title,
          state: result.progressState ?? (result.error ? "error" : "completed"),
          detail: result.error ? result.text.slice(0, 500) : undefined,
          runId,
        },
      ];
    });
}

/** Map audit ledger entries into a redaction-ready recent-audit snapshot. */
export function buildRecentAuditSnapshot(
  entries: readonly AuditEntry[],
  limit = 20,
): DiagnosticsRecentAudit[] {
  return entries.slice(0, Math.max(0, limit)).map((entry) => ({
    at: new Date(entry.at).toISOString(),
    action: entry.action,
    summary: entry.summary,
    taskId: entry.taskId,
    sessionId: entry.sessionId,
  }));
}

const CONFIGURATION_KEYS: readonly string[] = [
  "enableAiNativeFeatures",
  "enableAiSupervisor",
  "supervisorMode",
  "supervisorAutoApplySafeChanges",
  "autoVerify",
  "autoRepair",
  "maxAutoRepairAttempts",
  "pipelineAutoKeep",
  "maxParallelChatAgents",
  "maxBackgroundJobs",
  "notifyOnComplete",
];

/** Snapshot non-secret configuration keys for diagnostics (values only). */
export function buildConfigurationSnapshot(
  settings: Readonly<Record<string, ExecutionProfileSettingValue | undefined>>,
  extras?: readonly DiagnosticCheck[],
): DiagnosticCheck[] {
  const checks: DiagnosticCheck[] = CONFIGURATION_KEYS.map((key) => {
    const value = settings[key];
    return {
      label: key,
      status: value === undefined ? "unknown" : "ok",
      detail: value === undefined ? "unset" : String(value),
    };
  });
  if (extras?.length) {
    checks.push(...extras);
  }
  return checks;
}

export function configurationKeysForDiagnostics(): readonly string[] {
  return CONFIGURATION_KEYS;
}
