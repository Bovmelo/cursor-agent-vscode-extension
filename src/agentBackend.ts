import {
  Agent,
  AgentNotFoundError,
  type AgentDefinition,
  type LocalAgentOptions,
} from "@cursor/sdk";
import type { CursorAgent } from "./chatRuntime.js";

/** Optional backend features that callers must negotiate before using. */
export type AgentBackendCapability =
  | "sandbox"
  | "resume"
  | "subagents"
  | "mcpServers"
  | "settingSources"
  | "agentRetries";

export type AgentBackendCapabilitySupport = "supported" | "unsupported";

export type AgentBackendCapabilities = Readonly<
  Record<AgentBackendCapability, AgentBackendCapabilitySupport>
>;

export interface AgentBackendModelSelection {
  id: string;
  params?: Array<{ id: string; value: string }>;
}

export type AgentBackendSettingSource =
  | "project"
  | "user"
  | "team"
  | "mdm"
  | "plugins"
  | "all";

export type AgentBackendMcpServerConfig = {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
} | {
  type?: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
  auth?: {
    CLIENT_ID: string;
    CLIENT_SECRET?: string;
    scopes?: string[];
  };
};

export interface AgentBackendSubagentDefinition {
  description: string;
  prompt: string;
  model?: AgentBackendModelSelection | "inherit";
  mcpServers?: Array<string | Record<string, AgentBackendMcpServerConfig>>;
}

export interface AgentBackendLocalOptions {
  cwd: string | string[];
  autoReview: boolean;
  enableAgentRetries?: boolean;
  sandbox?: { enabled: boolean };
  settingSources?: AgentBackendSettingSource[];
}

interface AgentBackendConnectionOptions {
  apiKey: string;
  local: AgentBackendLocalOptions;
  subagents?: Readonly<Record<string, AgentBackendSubagentDefinition>>;
  mcpServers?: Record<string, AgentBackendMcpServerConfig>;
}

export interface AgentBackendCreateOptions extends AgentBackendConnectionOptions {
  model: AgentBackendModelSelection;
  name: string;
}

export type AgentBackendResumeOptions = AgentBackendConnectionOptions;

/**
 * Provider-neutral reasons that make a persisted agent ID safe to discard.
 * Every unrecognised failure must remain "other" so callers preserve the
 * existing conversation when authentication, transport, or service errors
 * occur.
 */
export type AgentBackendResumeErrorKind =
  | "session-not-found"
  | "invalid-agent-id"
  | "other";

/**
 * Stable extension-facing boundary around an agent provider.
 *
 * Capability checks are deliberately separate from method availability: every
 * backend has one predictable shape, while callers can negotiate optional
 * behavior before constructing requests.
 */
export interface AgentBackend {
  readonly capabilities: AgentBackendCapabilities;
  create(options: AgentBackendCreateOptions): Promise<CursorAgent>;
  resume(agentId: string, options: AgentBackendResumeOptions): Promise<CursorAgent>;
  builtInSubagents(): Readonly<Record<string, AgentBackendSubagentDefinition>>;
  classifyResumeError(error: unknown): AgentBackendResumeErrorKind;
  isSandboxUnavailableError(error: unknown): boolean;
}

export function backendSupports(
  backend: AgentBackend,
  capability: AgentBackendCapability,
): boolean {
  return backend.capabilities[capability] === "supported";
}

const CURSOR_SDK_CAPABILITIES: AgentBackendCapabilities = Object.freeze({
  sandbox: "supported",
  resume: "supported",
  subagents: "supported",
  mcpServers: "supported",
  settingSources: "supported",
  agentRetries: "supported",
});

const CURSOR_BUILT_IN_SUBAGENTS: Readonly<
  Record<string, AgentBackendSubagentDefinition>
> = Object.freeze({
  researcher: Object.freeze({
    description: "Read-only specialist for gathering codebase evidence and comparing approaches.",
    prompt: "Investigate the assigned question. Read relevant files, gather concise evidence, and report findings. Do not edit files.",
    model: "inherit",
  }),
  implementer: Object.freeze({
    description: "Implementation specialist for a clearly scoped independent code change.",
    prompt: "Implement only the assigned scope, preserve unrelated work, and run focused validation. Report changed files and results.",
    model: "inherit",
  }),
  reviewer: Object.freeze({
    description: "Review specialist for correctness, regressions, security, and missing validation.",
    prompt: "Review the assigned work with evidence. Do not edit files unless explicitly instructed. Report actionable issues by priority.",
    model: "inherit",
  }),
});

/** Adapter containing all Cursor SDK beta-specific request mapping. */
export class CursorSdkBackend implements AgentBackend {
  public readonly capabilities = CURSOR_SDK_CAPABILITIES;

  public async create(options: AgentBackendCreateOptions): Promise<CursorAgent> {
    return Agent.create({
      apiKey: options.apiKey,
      model: options.model,
      local: this.toSdkLocalOptions(options.local),
      agents: this.toSdkSubagents(options.subagents),
      mcpServers: options.mcpServers,
      name: options.name,
    });
  }

  public async resume(
    agentId: string,
    options: AgentBackendResumeOptions,
  ): Promise<CursorAgent> {
    return Agent.resume(agentId, {
      apiKey: options.apiKey,
      local: this.toSdkLocalOptions(options.local),
      agents: this.toSdkSubagents(options.subagents),
      mcpServers: options.mcpServers,
    });
  }

  public builtInSubagents(): Readonly<Record<string, AgentBackendSubagentDefinition>> {
    return CURSOR_BUILT_IN_SUBAGENTS;
  }

  public classifyResumeError(error: unknown): AgentBackendResumeErrorKind {
    if (error instanceof AgentNotFoundError) {
      return "session-not-found";
    }

    const record = this.errorRecord(error);
    const code = typeof record?.code === "string" ? record.code.toLowerCase() : undefined;
    if (code === "agent_not_found") {
      return "session-not-found";
    }
    if (code === "invalid_agent_id" || code === "invalid-agent-id") {
      return "invalid-agent-id";
    }

    // Cursor SDK 1.0.23 emits this exact ConfigurationError message when a
    // cloud-style agent ID has the wrong shape, without attaching a code.
    const message = error instanceof Error
      ? error.message
      : typeof record?.message === "string"
        ? record.message
        : undefined;
    if (message === "Agent ID must be in the format 'bc-<uuid>'") {
      return "invalid-agent-id";
    }

    return "other";
  }

  public isSandboxUnavailableError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("sandboxing is not supported in this environment")
      || message.includes("Local SDK sandboxing was requested");
  }

  private errorRecord(error: unknown): Record<string, unknown> | undefined {
    return typeof error === "object" && error !== null
      ? error as Record<string, unknown>
      : undefined;
  }

  private toSdkLocalOptions(options: AgentBackendLocalOptions): LocalAgentOptions {
    const roots = typeof options.cwd === "string" ? [options.cwd] : options.cwd;
    if (roots.length === 0) {
      throw new Error("At least one working directory is required.");
    }
    return {
      // SDK 1.5 separates the primary shell/store directory from the remaining
      // workspace roots. Passing an array as cwd no longer initializes a local
      // agent correctly, and dropping additional roots loses their rules.
      cwd: roots[0],
      ...(roots.length > 1 ? { dirs: roots.slice(1) } : {}),
      autoReview: options.autoReview,
      enableAgentRetries: options.enableAgentRetries,
      sandboxOptions: options.sandbox,
      settingSources: options.settingSources,
    };
  }

  private toSdkSubagents(
    subagents: Readonly<Record<string, AgentBackendSubagentDefinition>> | undefined,
  ): Record<string, AgentDefinition> | undefined {
    if (!subagents) {
      return undefined;
    }
    return Object.fromEntries(
      Object.entries(subagents).map(([name, definition]) => [name, { ...definition }]),
    );
  }
}
