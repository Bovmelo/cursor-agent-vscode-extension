import {
  Agent,
  type AgentDefinition,
  type LocalAgentOptions,
  type McpServerConfig,
  type ModelSelection,
  type SettingSource,
} from "@cursor/sdk";
import * as vscode from "vscode";
import type { Conversation } from "./chatTypes.js";
import type { CursorAgent } from "./chatRuntime.js";
import type { SafetyApprovalMode } from "./safety.js";

export interface AgentFactoryOptions {
  supportsLocalSandbox: boolean;
  isJapanese: boolean;
  selectedApprovalMode: () => SafetyApprovalMode;
  selectedModel: () => ModelSelection;
  saveConversations: () => Promise<void>;
  notifySandboxUnavailable: () => void;
}

export interface CreateAgentRequest {
  apiKey: string;
  roots: string[];
  workspaceName: string;
  conversation: Conversation;
  settingSources?: SettingSource[];
  mcpServers?: Record<string, McpServerConfig>;
}

/** Encapsulates Cursor SDK agent creation, resume, and sandbox fallback policy. */
export class AgentFactory {
  private sandboxFallbackApproved = false;

  public constructor(private readonly options: AgentFactoryOptions) {}

  public async createOrResume(request: CreateAgentRequest): Promise<CursorAgent> {
    const {
      apiKey,
      roots,
      workspaceName,
      conversation,
      settingSources = ["all"],
      mcpServers,
    } = request;
    const cwd = roots.length === 1 ? roots[0] : roots;
    const approvalMode = this.options.selectedApprovalMode();
    const local: LocalAgentOptions = {
      cwd,
      autoReview: approvalMode !== "full-access",
      sandboxOptions: {
        enabled: this.options.supportsLocalSandbox && approvalMode !== "full-access",
      },
      settingSources,
    };
    if (approvalMode !== "full-access" && !this.options.supportsLocalSandbox) {
      this.options.notifySandboxUnavailable();
    }

    const agents = this.builtInSubagents();
    const connect = async (localOptions: LocalAgentOptions): Promise<CursorAgent> => {
      if (conversation.agentId) {
        try {
          return await Agent.resume(conversation.agentId, {
            apiKey,
            local: localOptions,
            agents,
            mcpServers,
          });
        } catch (error) {
          if (this.isSandboxUnavailableError(error)) {
            throw error;
          }
          conversation.agentId = undefined;
        }
      }

      const agent = await Agent.create({
        apiKey,
        model: this.options.selectedModel(),
        local: localOptions,
        agents,
        mcpServers,
        name: `VS Code: ${workspaceName}`,
      });
      conversation.agentId = agent.agentId;
      await this.options.saveConversations();
      return agent;
    };

    try {
      return await connect(local);
    } catch (error) {
      if (!local.sandboxOptions?.enabled || !this.isSandboxUnavailableError(error)) {
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
      return connect({ ...local, sandboxOptions: { enabled: false } });
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
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("sandboxing is not supported in this environment")
      || message.includes("Local SDK sandboxing was requested");
  }

  private builtInSubagents(): Record<string, AgentDefinition> {
    return {
      researcher: {
        description: "Read-only specialist for gathering codebase evidence and comparing approaches.",
        prompt: "Investigate the assigned question. Read relevant files, gather concise evidence, and report findings. Do not edit files.",
        model: "inherit",
      },
      implementer: {
        description: "Implementation specialist for a clearly scoped independent code change.",
        prompt: "Implement only the assigned scope, preserve unrelated work, and run focused validation. Report changed files and results.",
        model: "inherit",
      },
      reviewer: {
        description: "Review specialist for correctness, regressions, security, and missing validation.",
        prompt: "Review the assigned work with evidence. Do not edit files unless explicitly instructed. Report actionable issues by priority.",
        model: "inherit",
      },
    };
  }

  private localize(english: string, japanese: string): string {
    return this.options.isJapanese ? japanese : english;
  }
}
