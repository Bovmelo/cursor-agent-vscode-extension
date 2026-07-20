import * as vscode from "vscode";
import {
  type AgentBackend,
  type AgentBackendLocalOptions,
  type AgentBackendMcpServerConfig,
  type AgentBackendModelSelection,
  type AgentBackendSettingSource,
  backendSupports,
  CursorSdkBackend,
} from "./agentBackend.js";
import type { Conversation } from "./chatTypes.js";
import type { CursorAgent } from "./chatRuntime.js";
import type { SafetyApprovalMode } from "./safety.js";

export interface AgentFactoryOptions {
  supportsLocalSandbox: boolean;
  isJapanese: boolean;
  selectedApprovalMode: () => SafetyApprovalMode;
  selectedModel: () => AgentBackendModelSelection;
  saveConversations: () => Promise<void>;
  notifySandboxUnavailable: () => void;
}

export interface CreateAgentRequest {
  apiKey: string;
  roots: string[];
  workspaceName: string;
  conversation: Conversation;
  settingSources?: AgentBackendSettingSource[];
  mcpServers?: Record<string, AgentBackendMcpServerConfig>;
  /** Revalidates the trust/integration snapshot synchronously before each SDK connection. */
  assertIntegrationBoundary: () => void;
}

/** Encapsulates Cursor SDK agent creation, resume, and sandbox fallback policy. */
export class AgentFactory {
  private sandboxFallbackApproved = false;

  public constructor(
    private readonly options: AgentFactoryOptions,
    private readonly backend: AgentBackend = new CursorSdkBackend(),
  ) {}

  public async createOrResume(request: CreateAgentRequest): Promise<CursorAgent> {
    const {
      apiKey,
      roots,
      workspaceName,
      conversation,
      settingSources = ["all"],
      mcpServers,
      assertIntegrationBoundary,
    } = request;
    const cwd = roots.length === 1 ? roots[0] : roots;
    const approvalMode = this.options.selectedApprovalMode();
    const sandboxSupported = backendSupports(this.backend, "sandbox");
    const local: AgentBackendLocalOptions = {
      cwd,
      autoReview: approvalMode !== "full-access",
      // Be explicit even though current SDKs default this on for headless
      // embedders. Transport retries are especially important for the Windows
      // native runtime, where an interrupted pipe can surface as ECANCELED.
      enableAgentRetries: backendSupports(this.backend, "agentRetries") ? true : undefined,
      sandbox: sandboxSupported ? {
        enabled: this.options.supportsLocalSandbox && approvalMode !== "full-access",
      } : undefined,
      settingSources: backendSupports(this.backend, "settingSources")
        ? settingSources
        : undefined,
    };
    if (approvalMode !== "full-access"
      && (!this.options.supportsLocalSandbox || !sandboxSupported)) {
      this.options.notifySandboxUnavailable();
    }

    const subagents = backendSupports(this.backend, "subagents")
      ? this.backend.builtInSubagents()
      : undefined;
    const negotiatedMcpServers = backendSupports(this.backend, "mcpServers")
      ? mcpServers
      : undefined;
    const connect = async (localOptions: AgentBackendLocalOptions): Promise<CursorAgent> => {
      if (conversation.agentId && backendSupports(this.backend, "resume")) {
        try {
          assertIntegrationBoundary();
          return await this.backend.resume(conversation.agentId, {
            apiKey,
            local: localOptions,
            subagents,
            mcpServers: negotiatedMcpServers,
          });
        } catch (error) {
          if (this.backend.classifyResumeError(error) === "other") {
            throw error;
          }
          conversation.agentId = undefined;
        }
      }
      if (conversation.agentId) {
        conversation.agentId = undefined;
      }

      assertIntegrationBoundary();
      const agent = await this.backend.create({
        apiKey,
        model: this.options.selectedModel(),
        local: localOptions,
        subagents,
        mcpServers: negotiatedMcpServers,
        name: `VS Code: ${workspaceName}`,
      });
      conversation.agentId = agent.agentId;
      await this.options.saveConversations();
      return agent;
    };

    try {
      return await connect(local);
    } catch (error) {
      if (!local.sandbox?.enabled || !this.isSandboxUnavailableError(error)) {
        throw error;
      }
      if (!this.sandboxFallbackApproved && !await this.confirmUnsandboxedRun()) {
        throw new Error(this.localize(
          "Run cancelled because local sandboxing is unavailable.",
          "ローカルサンドボックスを利用できないため、実行をキャンセルしました。",
        ));
      }
      this.sandboxFallbackApproved = true;
      this.options.notifySandboxUnavailable();
      return connect({ ...local, sandbox: { enabled: false } });
    }
  }

  private async confirmUnsandboxedRun(): Promise<boolean> {
    const continueLabel = this.localize("Run without sandbox", "サンドボックスなしで実行");
    const answer = await vscode.window.showWarningMessage(
      this.localize(
        "This environment does not support Cursor's local sandbox. Continuing disables filesystem and network isolation, but Auto-review remains enabled.",
        "この環境はCursorのローカルサンドボックスに対応していません。続行するとファイルとネットワークの隔離はなくなりますが、自動レビューは維持されます。",
      ),
      { modal: true },
      continueLabel,
    );
    return answer === continueLabel;
  }

  private isSandboxUnavailableError(error: unknown): boolean {
    return this.backend.isSandboxUnavailableError(error);
  }

  private localize(english: string, japanese: string): string {
    return this.options.isJapanese ? japanese : english;
  }
}
