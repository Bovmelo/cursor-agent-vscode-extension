import * as path from "node:path";
import type {
  ChangeSessionSnapshot,
  VerificationRunSnapshot,
  VerificationStage,
  VerificationStep,
} from "./aiNative.js";
import type { AuditEntry } from "./auditLog.js";
import { redactDiagnosticText } from "./diagnosticsBundle.js";

const MAX_FAILURE_OUTPUT = 4_000;

export type FailureObservationStatus = "passed" | "failed" | "skipped";

export interface FailureRunObservation {
  sessionId: string;
  goal: string;
  at: number;
  runIndex: number;
  status: FailureObservationStatus;
  failedStep?: VerificationStep;
  failureSignature?: string;
}

export interface FailureFileCandidate {
  root: string;
  relative: string;
  sessionIds: string[];
  changedInTarget: boolean;
}

export interface FailureRecurrence {
  signature: string;
  count: number;
  firstAt: number;
  lastAt: number;
  sessionIds: string[];
}

export interface FailureTimeMachineReport {
  targetSessionId: string;
  targetGoal: string;
  targetStartedAt: number;
  targetFinishedAt?: number;
  targetPhase: ChangeSessionSnapshot["phase"];
  targetFiles: string[];
  targetFileDecisions: Record<string, "pending" | "kept" | "restored">;
  checkpointAvailable: boolean;
  repair?: ChangeSessionSnapshot["repair"];
  targetFailure: FailureRunObservation;
  firstRecordedFailure: FailureRunObservation;
  lastRecordedPass?: FailureRunObservation;
  boundaryConfidence: "high" | "medium" | "low";
  boundaryReason: "no-recorded-pass" | "immediate" | "skipped-between" | "other-runs-between";
  candidateFiles: FailureFileCandidate[];
  recurrence: FailureRecurrence;
  timeline: FailureRunObservation[];
  auditEntries: AuditEntry[];
  failureOutput: string;
}

export interface FailureTimeMachineInput {
  sessions: readonly ChangeSessionSnapshot[];
  auditEntries: readonly AuditEntry[];
  targetSessionId?: string;
  pathPlatform?: "win32" | "posix";
}

interface InternalRun extends FailureRunObservation {
  session: ChangeSessionSnapshot;
}

function verificationStage(step: VerificationStep): VerificationStage {
  if (step.stage) {
    return step.stage;
  }
  const command = step.command.toLowerCase();
  if (/\b(e2e|playwright|cypress)\b/u.test(command)) return "e2e";
  if (/\b(test|jest|vitest|mocha|pytest)\b/u.test(command)) return "test";
  if (/\b(lint|eslint|oxlint|ruff)\b/u.test(command)) return "lint";
  if (/\b(build|compile|tsc)\b/u.test(command)) return "build";
  return "other";
}

function firstMeaningfulLine(output: string): string {
  return output.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? "<no output>";
}

function normalizedFailureLine(output: string): string {
  return redactDiagnosticText(firstMeaningfulLine(output))
    .replace(/[A-Za-z]:[\\/][^\s:),]+/gu, "<path>")
    .replace(/(?:\/[A-Za-z0-9._-]+){2,}/gu, "<path>")
    .replace(/\b(?:0x)?[0-9a-f]{8,}\b/giu, "<id>")
    .replace(/\b\d+(?:\.\d+)?\b/gu, "#")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase()
    .slice(0, 320);
}

export function failureSignature(step: VerificationStep): string {
  const command = step.command.replace(/\s+/gu, " ").trim().toLowerCase();
  return `${verificationStage(step)}|${command}|${normalizedFailureLine(step.output)}`;
}

function verificationRuns(session: ChangeSessionSnapshot): VerificationRunSnapshot[] {
  if (Array.isArray(session.verificationHistory) && session.verificationHistory.length > 0) {
    return session.verificationHistory
      .map((run) => ({
        ...run,
        steps: run.steps.map((step) => ({ ...step })),
      }))
      .sort((left, right) => left.at - right.at);
  }
  return session.verification
    ? [{
        ...session.verification,
        at: session.finishedAt ?? session.startedAt,
        steps: session.verification.steps.map((step) => ({ ...step })),
      }]
    : [];
}

function observations(session: ChangeSessionSnapshot): InternalRun[] {
  return verificationRuns(session).map((run, runIndex) => {
    const failedStep = run.steps.find((step) => !step.success);
    const status: FailureObservationStatus = run.skipped
      ? "skipped"
      : run.success
        ? "passed"
        : "failed";
    return {
      session,
      sessionId: session.id,
      goal: session.goal,
      at: run.at,
      runIndex,
      status,
      failedStep,
      failureSignature: failedStep ? failureSignature(failedStep) : undefined,
    };
  });
}

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/\/+$/u, "");
}

function usesWindowsPathSemantics(
  value: string,
  pathPlatform: "win32" | "posix",
): boolean {
  return /^[A-Za-z]:[\\/]/u.test(value)
    || value.startsWith("\\\\")
    || (pathPlatform === "win32" && value.startsWith("//"));
}

function pathIdentity(value: string, windowsSemantics: boolean): string {
  const normalized = normalizedPath(value);
  return windowsSemantics ? normalized.toLowerCase() : normalized;
}

function relativeSessionFile(
  root: string,
  file: string,
  pathPlatform: "win32" | "posix",
): string {
  const normalizedRoot = normalizedPath(root);
  const normalizedFile = normalizedPath(file);
  const windowsSemantics = usesWindowsPathSemantics(root, pathPlatform);
  if (
    pathIdentity(normalizedFile, windowsSemantics)
      .startsWith(`${pathIdentity(normalizedRoot, windowsSemantics)}/`)
  ) {
    return normalizedFile.slice(normalizedRoot.length + 1);
  }
  const pathApi = windowsSemantics ? path.win32 : path.posix;
  const relative = pathApi.relative(root, file).replaceAll("\\", "/");
  return relative && !relative.startsWith("../") && !pathApi.isAbsolute(relative)
    ? relative
    : pathApi.basename(normalizedFile);
}

function sameRoot(
  left: string,
  right: string,
  pathPlatform: "win32" | "posix",
): boolean {
  const windowsSemantics = usesWindowsPathSemantics(left, pathPlatform)
    && usesWindowsPathSemantics(right, pathPlatform);
  return pathIdentity(left, windowsSemantics) === pathIdentity(right, windowsSemantics);
}

function boundaryConfidence(
  timeline: readonly InternalRun[],
  firstFailureIndex: number,
  lastPassIndex: number,
): Pick<FailureTimeMachineReport, "boundaryConfidence" | "boundaryReason"> {
  if (lastPassIndex < 0) {
    return {
      boundaryConfidence: "low",
      boundaryReason: "no-recorded-pass",
    };
  }
  const between = timeline.slice(lastPassIndex + 1, firstFailureIndex);
  if (between.length === 0) {
    return {
      boundaryConfidence: "high",
      boundaryReason: "immediate",
    };
  }
  if (between.every((run) => run.status === "skipped")) {
    return {
      boundaryConfidence: "medium",
      boundaryReason: "skipped-between",
    };
  }
  return {
    boundaryConfidence: "medium",
    boundaryReason: "other-runs-between",
  };
}

function clippedFailureOutput(step: VerificationStep | undefined): string {
  const output = redactDiagnosticText(step?.output.trim() ?? "");
  if (output.length <= MAX_FAILURE_OUTPUT) {
    return output;
  }
  return `${output.slice(0, MAX_FAILURE_OUTPUT)}\n… output truncated …`;
}

export function analyzeFailureTimeMachine(
  input: FailureTimeMachineInput,
): FailureTimeMachineReport | undefined {
  const sessions = [...input.sessions];
  const pathPlatform = input.pathPlatform ?? (process.platform === "win32" ? "win32" : "posix");
  const requested = input.targetSessionId
    ? sessions.find((session) => session.id === input.targetSessionId)
    : undefined;
  const targetSession = input.targetSessionId
    ? requested
    : sessions.find((session) => observations(session).some((run) => run.status === "failed"));
  if (!targetSession) {
    return undefined;
  }
  const targetFailure = observations(targetSession).filter((run) => run.status === "failed").at(-1);
  if (!targetFailure) {
    return undefined;
  }

  const rootSessions = sessions
    .filter((session) => sameRoot(session.root, targetSession.root, pathPlatform))
    .sort((left, right) => left.startedAt - right.startedAt);
  const allRuns = rootSessions
    .flatMap(observations)
    .sort((left, right) => left.at - right.at || left.runIndex - right.runIndex);
  const targetIndex = allRuns.findIndex((run) =>
    run.sessionId === targetFailure.sessionId
    && run.at === targetFailure.at
    && run.runIndex === targetFailure.runIndex
  );
  if (targetIndex < 0) {
    return undefined;
  }
  const timeline = allRuns.slice(0, targetIndex + 1);
  let lastPassIndex = -1;
  for (let index = 0; index < timeline.length; index += 1) {
    if (timeline[index].status === "passed") {
      lastPassIndex = index;
    }
  }
  const firstFailureIndex = timeline.findIndex(
    (run, index) => index > lastPassIndex && run.status === "failed",
  );
  const firstFailure = timeline[firstFailureIndex >= 0 ? firstFailureIndex : targetIndex];
  const lastPass = lastPassIndex >= 0 ? timeline[lastPassIndex] : undefined;
  const confidence = boundaryConfidence(
    timeline,
    firstFailureIndex >= 0 ? firstFailureIndex : targetIndex,
    lastPassIndex,
  );

  const windowStart = lastPass?.at ?? Number.NEGATIVE_INFINITY;
  const candidateSessions = rootSessions.filter((session) =>
    session.startedAt <= targetFailure.at
    && (session.id === targetSession.id || session.startedAt >= windowStart)
  );
  const candidates = new Map<string, FailureFileCandidate>();
  for (const session of candidateSessions) {
    for (const file of session.files) {
      const relative = relativeSessionFile(session.root, file, pathPlatform);
      const windowsSemantics = usesWindowsPathSemantics(session.root, pathPlatform);
      const key = `${pathIdentity(session.root, windowsSemantics)}\0${pathIdentity(relative, windowsSemantics)}`;
      const existing = candidates.get(key) ?? {
        root: session.root,
        relative,
        sessionIds: [],
        changedInTarget: false,
      };
      if (!existing.sessionIds.includes(session.id)) {
        existing.sessionIds.push(session.id);
      }
      existing.changedInTarget ||= session.id === targetSession.id;
      candidates.set(key, existing);
    }
  }

  const sameFailures = allRuns.filter((run) =>
    run.status === "failed" && run.failureSignature === targetFailure.failureSignature
  );
  const recurrence: FailureRecurrence = {
    signature: targetFailure.failureSignature ?? "unknown",
    count: sameFailures.length,
    firstAt: sameFailures[0]?.at ?? targetFailure.at,
    lastAt: sameFailures.at(-1)?.at ?? targetFailure.at,
    sessionIds: [...new Set(sameFailures.map((run) => run.sessionId))],
  };
  const relevantSessionIds = new Set(candidateSessions.map((session) => session.id));
  const auditEntries = input.auditEntries
    .filter((entry) => Boolean(entry.sessionId && relevantSessionIds.has(entry.sessionId)))
    .map((entry) => ({
      ...entry,
      summary: redactDiagnosticText(entry.summary),
      details: entry.details ? redactDiagnosticText(entry.details) : undefined,
      files: entry.files?.map((file) => redactDiagnosticText(file)),
    }))
    .sort((left, right) => left.at - right.at);
  const targetFileDecisions = Object.fromEntries(
    Object.entries(targetSession.fileDecisions ?? {}).map(([file, decision]) => [
      relativeSessionFile(targetSession.root, file, pathPlatform),
      decision,
    ]),
  );

  return {
    targetSessionId: targetSession.id,
    targetGoal: targetSession.goal,
    targetStartedAt: targetSession.startedAt,
    targetFinishedAt: targetSession.finishedAt,
    targetPhase: targetSession.phase,
    targetFiles: targetSession.files.map((file) =>
      relativeSessionFile(targetSession.root, file, pathPlatform)
    ),
    targetFileDecisions,
    checkpointAvailable: targetSession.checkpointReady ?? targetSession.baselineClean,
    repair: targetSession.repair ? { ...targetSession.repair } : undefined,
    targetFailure,
    firstRecordedFailure: firstFailure,
    lastRecordedPass: lastPass,
    ...confidence,
    candidateFiles: [...candidates.values()].sort((left, right) =>
      Number(right.changedInTarget) - Number(left.changedInTarget)
      || left.relative.localeCompare(right.relative)
    ),
    recurrence,
    timeline,
    auditEntries,
    failureOutput: clippedFailureOutput(targetFailure.failedStep),
  };
}

function escapeMarkdown(value: unknown): string {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_[\]{}|#])/gu, "\\$1");
}

function iso(value: number | undefined, unknown: string): string {
  if (value === undefined || !Number.isFinite(value)) return unknown;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? unknown : date.toISOString();
}

function duration(value: number | undefined): string {
  return `${Math.max(0, value ?? 0) / 1_000}s`;
}

function codeFence(value: string): string {
  const longestBacktickRun = Math.max(
    0,
    ...(value.match(/`+/gu) ?? []).map((run) => run.length),
  );
  return "`".repeat(Math.max(3, longestBacktickRun + 1));
}

export function formatFailureTimeMachineMarkdown(
  report: FailureTimeMachineReport,
  japanese: boolean,
): string {
  const text = japanese
    ? {
        title: "失敗のタイムマシン",
        caveat: "これは保存済みの観測事実から作る限定的な履歴です。完全な実行トレースでも、root causeの断定でもありません。",
        summary: "概要",
        goal: "目標",
        started: "開始",
        finished: "終了",
        phase: "現在の状態",
        checkpoint: "チェックポイント",
        available: "利用可能",
        unavailable: "利用不可",
        observed: "観測事実",
        lastPass: "最後に記録された成功",
        firstFailure: "最初に記録された失敗",
        none: "記録なし",
        session: "セッション",
        command: "コマンド",
        stage: "段階",
        duration: "所要時間",
        inference: "推定（root causeではありません）",
        confidence: "境界の確度",
        candidateFiles: "記録された境界に関連する候補ファイル",
        candidateNote: "セッションにはファイル単位の変更時刻が保存されないため、因果関係や正確な変更順序の証拠ではありません。確認対象を絞るための候補です。",
        target: "対象セッションで変更",
        recurrence: "再発",
        occurrences: "記録回数",
        timeline: "検証タイムライン",
        when: "時刻",
        result: "結果",
        failureOutput: "対象失敗の出力（機密情報を伏せ字・切り詰め済み）",
        noOutput: "保存済み出力なし",
        recovery: "復旧コンテキスト",
        repair: "自動修復",
        decisions: "ファイル判断",
        audit: "関連する監査操作",
        safeNext: "安全な次の手順",
        nextSteps: [
          "最新の失敗セッションなら、Sessionsから検証を再実行する。",
          "候補ファイルの保存済みdiffをSessionsから確認する。",
          "復元・破棄は既存の確認付きSessions操作から行う。",
        ],
      }
    : {
        title: "Failure Time Machine",
        caveat: "This is a bounded history reconstructed from saved observations. It is not a complete execution trace or a root-cause determination.",
        summary: "Summary",
        goal: "Goal",
        started: "Started",
        finished: "Finished",
        phase: "Current phase",
        checkpoint: "Checkpoint",
        available: "available",
        unavailable: "unavailable",
        observed: "Observed facts",
        lastPass: "Last recorded pass",
        firstFailure: "First recorded failure",
        none: "None recorded",
        session: "Session",
        command: "Command",
        stage: "Stage",
        duration: "Duration",
        inference: "Inference (not root cause)",
        confidence: "Boundary confidence",
        candidateFiles: "Candidate files associated with the recorded boundary",
        candidateNote: "Sessions do not save per-file edit times, so this is not evidence of causation or exact edit order. Use the list only to focus review.",
        target: "changed in target session",
        recurrence: "Recurrence",
        occurrences: "Recorded occurrences",
        timeline: "Verification timeline",
        when: "When",
        result: "Result",
        failureOutput: "Target failure output (redacted and bounded)",
        noOutput: "No saved output",
        recovery: "Recovery context",
        repair: "Auto-repair",
        decisions: "File decisions",
        audit: "Related audit actions",
        safeNext: "Safe next steps",
        nextSteps: [
          "For the latest failed session, re-run verification from Sessions.",
          "Inspect saved candidate-file diffs from Sessions.",
          "Use the existing confirmation-gated Sessions actions for restore or discard.",
        ],
      };
  const boundaryExplanation: Record<FailureTimeMachineReport["boundaryReason"], string> = japanese
    ? {
        "no-recorded-pass": "同じワークスペースに、それ以前の成功検証記録がありません。",
        immediate: "記録上、最初の失敗は成功検証の直後です。",
        "skipped-between": "成功と失敗の間にある検証記録は、スキップされたものだけです。",
        "other-runs-between": "成功と失敗の間に、ほかの検証記録があります。",
      }
    : {
        "no-recorded-pass": "No earlier recorded passing verification exists for this workspace.",
        immediate: "The first recorded failure immediately follows a recorded passing verification.",
        "skipped-between": "Only skipped verification runs appear between the recorded pass and failure.",
        "other-runs-between": "Other recorded verification runs appear between the pass and failure.",
      };
  const runDescription = (run: FailureRunObservation | undefined): string => {
    if (!run) return text.none;
    const failed = run.failedStep;
    return [
      `${escapeMarkdown(run.goal)} (${iso(run.at, text.none)})`,
      failed ? `\`${escapeMarkdown(failed.command)}\`` : undefined,
    ].filter(Boolean).join(" — ");
  };
  const lines = [
    `# ${text.title}`,
    "",
    `> ${text.caveat}`,
    "",
    `## ${text.summary}`,
    "",
    `- **${text.goal}:** ${escapeMarkdown(report.targetGoal)}`,
    `- **${text.started}:** ${iso(report.targetStartedAt, text.none)}`,
    `- **${text.finished}:** ${iso(report.targetFinishedAt, text.none)}`,
    `- **${text.phase}:** \`${report.targetPhase}\``,
    `- **${text.checkpoint}:** ${report.checkpointAvailable ? text.available : text.unavailable}`,
    "",
    `## ${text.observed}`,
    "",
    `- **${text.lastPass}:** ${runDescription(report.lastRecordedPass)}`,
    `- **${text.firstFailure}:** ${runDescription(report.firstRecordedFailure)}`,
  ];
  const failed = report.targetFailure.failedStep;
  if (failed) {
    lines.push(
      `- **${text.command}:** \`${escapeMarkdown(failed.command)}\``,
      `- **${text.stage}:** \`${verificationStage(failed)}\``,
      `- **${text.duration}:** ${duration(failed.durationMs)}`,
    );
  }
  lines.push(
    "",
    `## ${text.inference}`,
    "",
    `- **${text.confidence}:** \`${report.boundaryConfidence}\` — ${escapeMarkdown(boundaryExplanation[report.boundaryReason])}`,
    `- **${text.recurrence}:** ${text.occurrences} ${report.recurrence.count}; ${iso(report.recurrence.firstAt, text.none)} → ${iso(report.recurrence.lastAt, text.none)}`,
    "",
    `### ${text.candidateFiles}`,
    "",
    `> ${text.candidateNote}`,
    "",
  );
  if (report.candidateFiles.length === 0) {
    lines.push(`- _${text.none}_`);
  } else {
    for (const file of report.candidateFiles) {
      lines.push(`- \`${escapeMarkdown(file.relative)}\`${file.changedInTarget ? ` — ${text.target}` : ""}`);
    }
  }
  lines.push(
    "",
    `## ${text.timeline}`,
    "",
    `| ${text.when} | ${text.session} | ${text.result} | ${text.command} |`,
    "| --- | --- | --- | --- |",
  );
  for (const run of report.timeline) {
    lines.push(`| ${iso(run.at, text.none)} | ${escapeMarkdown(run.goal)} | ${run.status} | ${run.failedStep ? `\`${escapeMarkdown(run.failedStep.command)}\`` : "—"} |`);
  }
  lines.push("", `## ${text.failureOutput}`, "");
  if (report.failureOutput) {
    const fence = codeFence(report.failureOutput);
    lines.push(`${fence}text`, report.failureOutput, fence);
  } else {
    lines.push(`_${text.noOutput}_`);
  }
  lines.push("", `## ${text.recovery}`, "");
  if (report.repair) {
    lines.push(`- **${text.repair}:** ${report.repair.attempts}/${report.repair.maxAttempts} — \`${report.repair.status}\``);
  } else {
    lines.push(`- **${text.repair}:** ${text.none}`);
  }
  const decisions = Object.entries(report.targetFileDecisions);
  if (decisions.length === 0) {
    lines.push(`- **${text.decisions}:** ${text.none}`);
  } else {
    lines.push(`- **${text.decisions}:**`);
    for (const [file, decision] of decisions) {
      lines.push(`  - \`${escapeMarkdown(file)}\` — ${decision}`);
    }
  }
  lines.push("", `### ${text.audit}`, "");
  if (report.auditEntries.length === 0) {
    lines.push(`- _${text.none}_`);
  } else {
    for (const entry of report.auditEntries) {
      lines.push(`- ${iso(entry.at, text.none)} — \`${entry.action}\` — ${escapeMarkdown(entry.summary)}`);
    }
  }
  lines.push("", `## ${text.safeNext}`, "");
  for (const step of text.nextSteps) {
    lines.push(`- ${step}`);
  }
  lines.push("");
  return lines.join("\n");
}
