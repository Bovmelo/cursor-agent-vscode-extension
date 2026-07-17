export type AuditAction =
  | "supervisor.apply"
  | "supervisor.discard"
  | "supervisor.applyAll"
  | "supervisor.discardAll"
  | "session.keep"
  | "session.restore"
  | "session.keepAll"
  | "session.restoreAll"
  | "session.revert"
  | "pipeline.pr"
  | "plan.start"
  | "plan.step"
  | "plan.complete"
  | "compare.apply"
  | "compare.pr"
  | "background.apply"
  | "background.cancel"
  | "background.discard";

export interface AuditEntry {
  id: string;
  at: number;
  action: AuditAction;
  summary: string;
  details?: string;
  files?: string[];
  taskId?: string;
  sessionId?: string;
}

export const AUDIT_LOG_KEY = "cursorSubscription.auditLog";
export const MAX_AUDIT_ENTRIES = 200;

export function appendAuditEntry(
  entries: ReadonlyArray<AuditEntry> | undefined,
  entry: Omit<AuditEntry, "id" | "at"> & { id?: string; at?: number },
  maximum = MAX_AUDIT_ENTRIES,
): AuditEntry[] {
  const next: AuditEntry = {
    id: entry.id ?? cryptoRandomId(),
    at: entry.at ?? Date.now(),
    action: entry.action,
    summary: entry.summary,
    details: entry.details,
    files: entry.files?.slice(0, 50),
    taskId: entry.taskId,
    sessionId: entry.sessionId,
  };
  return [next, ...(entries ?? [])].slice(0, maximum);
}

export function formatAuditLogMarkdown(entries: ReadonlyArray<AuditEntry>): string {
  const lines = [
    "# AI Audit Log",
    "",
    `Exported: ${new Date().toISOString()}`,
    "",
  ];
  if (entries.length === 0) {
    lines.push("_No audit entries._");
    return lines.join("\n");
  }
  for (const entry of entries) {
    lines.push(`## ${new Date(entry.at).toISOString()} — ${entry.action}`);
    lines.push("");
    lines.push(entry.summary);
    if (entry.details) {
      lines.push("");
      lines.push(entry.details);
    }
    if (entry.files?.length) {
      lines.push("");
      lines.push("Files:");
      for (const file of entry.files) {
        lines.push(`- \`${file}\``);
      }
    }
    if (entry.taskId || entry.sessionId) {
      lines.push("");
      if (entry.taskId) {
        lines.push(`Task: \`${entry.taskId}\``);
      }
      if (entry.sessionId) {
        lines.push(`Session: \`${entry.sessionId}\``);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

function cryptoRandomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
