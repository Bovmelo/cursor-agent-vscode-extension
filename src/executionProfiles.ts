export type ExecutionProfileId = "safe" | "balanced" | "automation";

export type ExecutionProfileSettingValue = boolean | number | string;

export interface ExecutionProfileDefinition {
  id: ExecutionProfileId;
  label: string;
  description: string;
  approvalMode: "safe-worktree" | "auto-review" | "full-access";
  requiresTrustedWorkspace: boolean;
  settings: Readonly<Record<string, ExecutionProfileSettingValue>>;
}

const DEFINITIONS: Readonly<Record<ExecutionProfileId, ExecutionProfileDefinition>> = {
  safe: {
    id: "safe",
    label: "Safe",
    description: "Review changes explicitly and keep autonomous execution disabled.",
    approvalMode: "safe-worktree",
    requiresTrustedWorkspace: false,
    settings: {
      enableAiNativeFeatures: true,
      enableAiSupervisor: true,
      supervisorMode: "observe",
      supervisorAutoApplySafeChanges: false,
      autoRepair: false,
      pipelineAutoKeep: false,
      maxParallelChatAgents: 2,
      maxBackgroundJobs: 1,
    },
  },
  balanced: {
    id: "balanced",
    label: "Balanced",
    description: "Use isolated worktrees, automatic verification, and manual apply decisions.",
    approvalMode: "auto-review",
    requiresTrustedWorkspace: true,
    settings: {
      enableAiNativeFeatures: true,
      enableAiSupervisor: true,
      supervisorMode: "observe",
      supervisorAutoApplySafeChanges: false,
      autoVerify: true,
      autoRepair: false,
      pipelineAutoKeep: false,
      maxParallelChatAgents: 3,
      maxBackgroundJobs: 2,
    },
  },
  automation: {
    id: "automation",
    label: "Automation",
    description: "Run trusted isolated tasks autonomously with bounded repair and review gates.",
    approvalMode: "auto-review",
    requiresTrustedWorkspace: true,
    settings: {
      enableAiNativeFeatures: true,
      enableAiSupervisor: true,
      supervisorMode: "autonomous",
      supervisorReviewGate: true,
      supervisorAutoApplySafeChanges: true,
      autoVerify: true,
      autoRepair: true,
      maxAutoRepairAttempts: 1,
      pipelineAutoKeep: true,
      maxParallelChatAgents: 4,
      maxBackgroundJobs: 4,
    },
  },
};

export function executionProfiles(): readonly ExecutionProfileDefinition[] {
  return [DEFINITIONS.safe, DEFINITIONS.balanced, DEFINITIONS.automation];
}

export function executionProfile(id: unknown): ExecutionProfileDefinition | undefined {
  return id === "safe" || id === "balanced" || id === "automation"
    ? DEFINITIONS[id]
    : undefined;
}

export function localizeExecutionProfile(
  definition: ExecutionProfileDefinition,
  japanese: boolean,
): Pick<ExecutionProfileDefinition, "label" | "description"> {
  if (!japanese) {
    return { label: definition.label, description: definition.description };
  }
  const localized: Record<ExecutionProfileId, [string, string]> = {
    safe: ["安全重視", "変更を明示確認し、自律実行を無効にします。"],
    balanced: ["バランス", "隔離worktreeと自動検証を使い、適用は手動で判断します。"],
    automation: ["自動化重視", "信頼済み環境で修復・レビュー上限付きの自律タスクを実行します。"],
  };
  return { label: localized[definition.id][0], description: localized[definition.id][1] };
}
