import type { McpServerConfig, SettingSource } from "@cursor/sdk";

const NON_PROJECT_SETTING_SOURCES: readonly SettingSource[] = [
  "user",
  "team",
  "mdm",
  "plugins",
];

export interface AgentIntegrationPolicyInput {
  isWorkspaceTrusted: boolean;
  hasWorkspace: boolean;
  hasDisabledWorkspaceIntegrations: boolean;
  workspaceMcpServers?: Record<string, McpServerConfig>;
}

export interface AgentIntegrationPolicy {
  settingSources: SettingSource[];
  mcpServers?: Record<string, McpServerConfig>;
}

export interface AgentSendBoundaryState {
  isWorkspaceTrusted: boolean;
  rootsKey?: string;
  agentId?: string;
}

export type PromptCommandSource = "project" | "user";

export function shouldUseWorkspacePromptIntegrations(
  isWorkspaceTrusted: boolean,
): boolean {
  return isWorkspaceTrusted;
}

export function workspaceTrustSnapshotMatches(
  expectedTrust: boolean,
  currentTrust: boolean,
): boolean {
  return expectedTrust === currentTrust;
}

export function agentSendBoundaryMatches(
  expected: AgentSendBoundaryState,
  current: AgentSendBoundaryState,
): boolean {
  return expected.rootsKey !== undefined
    && expected.agentId !== undefined
    && workspaceTrustSnapshotMatches(
      expected.isWorkspaceTrusted,
      current.isWorkspaceTrusted,
    )
    && expected.rootsKey === current.rootsKey
    && expected.agentId === current.agentId;
}

/** Skill requests currently carry names without source metadata, so fail closed when untrusted. */
export function filterRequestedSkillsForWorkspaceTrust(
  isWorkspaceTrusted: boolean,
  requestedSkills: readonly string[],
): string[] {
  return isWorkspaceTrusted ? [...requestedSkills] : [];
}

export function isPromptCommandAllowedForWorkspaceTrust(
  isWorkspaceTrusted: boolean,
  source: PromptCommandSource,
): boolean {
  return source === "user" || isWorkspaceTrusted;
}

export function projectSettingSourcesForWorkspaceTrust(
  isWorkspaceTrusted: boolean,
  includeProjectSettings: boolean,
): SettingSource[] {
  return isWorkspaceTrusted && includeProjectSettings ? ["project"] : [];
}

/**
 * Resolves the SDK-facing integration options without consulting VS Code state.
 * Untrusted workspaces must never load project settings or inject workspace MCP.
 */
export function resolveAgentIntegrationPolicy(
  input: AgentIntegrationPolicyInput,
): AgentIntegrationPolicy {
  if (!input.isWorkspaceTrusted) {
    return { settingSources: [...NON_PROJECT_SETTING_SOURCES] };
  }

  if (!input.hasWorkspace || !input.hasDisabledWorkspaceIntegrations) {
    return { settingSources: ["all"] };
  }

  return {
    settingSources: [...NON_PROJECT_SETTING_SOURCES],
    ...(input.workspaceMcpServers === undefined
      ? {}
      : { mcpServers: input.workspaceMcpServers }),
  };
}

export function workspaceTrustIntegrationKey(isWorkspaceTrusted: boolean): string {
  return isWorkspaceTrusted ? "trusted" : "untrusted";
}

/** Prevents an agent created with trusted project integrations from crossing the trust boundary. */
export function resumableAgentIdForWorkspaceTrust(
  isWorkspaceTrusted: boolean,
  agentId: string | undefined,
): string | undefined {
  return isWorkspaceTrusted ? agentId : undefined;
}
