import {
  Agent,
  type AgentDefinition,
  type LocalAgentOptions,
  type ModelParameterValue,
  type ModelSelection,
  type RunResult,
} from "@cursor/sdk";
import * as vscode from "vscode";
import { detectBlockedProxyEnvironment } from "./networkEnvironment.js";
import type { SupervisorExecutionResult, SupervisorTask } from "./supervisor.js";

const API_KEY_SECRET = "cursorSubscription.apiKey";
const MODEL_KEY = "cursorSubscription.model";
const MODEL_PARAMS_KEY = "cursorSubscription.modelParams";
const APPROVAL_MODE_KEY = "cursorSubscription.approvalMode";
const DEFAULT_MODEL = "auto";
const SUPPORTS_LOCAL_SANDBOX = process.platform !== "win32";

type CursorAgent = Awaited<ReturnType<typeof Agent.create>>;
type CursorRun = Awaited<ReturnType<CursorAgent["send"]>>;

interface ActiveSupervisorRun {
  agent?: CursorAgent;
  run?: CursorRun;
  cancelRequested: boolean;
  interrupt?: (error: Error) => void;
}

class SupervisorCancelledError extends Error {}
class SupervisorDeadlineError extends Error {}

export class SupervisorAgentRunner implements vscode.Disposable {
  private readonly activeRuns = new Map<string, ActiveSupervisorRun>();

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {}

  public isBusy(): boolean {
    return this.activeRuns.size > 0;
  }

  public isAtCapacity(): boolean {
    const maximum = Math.max(
      1,
      vscode.workspace.getConfiguration("cursorSubscription")
        .get<number>("supervisorMaxParallelTasks", 2),
    );
    return this.activeRuns.size >= maximum;
  }

  public async cancel(taskId?: string): Promise<void> {
    const runs = taskId
      ? [[taskId, this.activeRuns.get(taskId)] as const]
      : [...this.activeRuns.entries()];
    await Promise.all(runs.map(async ([, active]) => {
      if (!active) {
        return;
      }
      active.cancelRequested = true;
      if (active.run?.supports("cancel")) {
        void active.run.cancel().catch(() => {});
      }
      active.interrupt?.(new SupervisorCancelledError("The Supervisor run was cancelled."));
    }));
  }

  public activeTaskIds(): string[] {
    return [...this.activeRuns.keys()];
  }

  public dispose(): void {
    const active = [...this.activeRuns.values()];
    void this.cancel()
      .catch(() => {})
      .then(() => Promise.all(active.map((entry) => this.disposeAgent(entry.agent))))
      .catch(() => {});
  }

  private maximumParallelTasks(): number {
    return Math.max(
      1,
      vscode.workspace.getConfiguration("cursorSubscription")
        .get<number>("supervisorMaxParallelTasks", 2),
    );
  }

  private reserve(taskId: string): ActiveSupervisorRun | undefined {
    if (this.activeRuns.has(taskId) || this.activeRuns.size >= this.maximumParallelTasks()) {
      return undefined;
    }
    const active: ActiveSupervisorRun = { cancelRequested: false };
    this.activeRuns.set(taskId, active);
    return active;
  }

  public async execute(
    task: SupervisorTask,
    worktreePath: string,
    prompt: string,
  ): Promise<SupervisorExecutionResult | undefined> {
    const apiKey = await this.context.secrets.get(API_KEY_SECRET);
    if (!apiKey) {
      return {
        status: "error",
        error: this.text(
          "Set the Cursor API key before running AI Supervisor.",
          "AI Supervisorを実行する前にCursor APIキーを設定してください。",
        ),
      };
    }
    const blockedProxy = detectBlockedProxyEnvironment();
    if (blockedProxy) {
      return {
        status: "error",
        error: this.text(
          `The local proxy setting ${blockedProxy.variable}=${blockedProxy.address} blocks Cursor SDK connections.`,
          `ローカルプロキシ設定 ${blockedProxy.variable}=${blockedProxy.address} がCursor SDK接続を妨げています。`,
        ),
      };
    }

    const active = this.reserve(task.id);
    if (!active) {
      return undefined;
    }

    let executionTimedOut = false;
    let executionTimer: ReturnType<typeof setTimeout> | undefined;
    let assistantText = "";
    let rejectInterrupt: ((error: Error) => void) | undefined;
    const interrupt = new Promise<never>((_, reject) => {
      rejectInterrupt = reject;
    });
    active.interrupt = (error) => rejectInterrupt?.(error);
    const maximumMinutes = vscode.workspace
      .getConfiguration("cursorSubscription")
      .get<number>("supervisorMaxRunMinutes", 15);
    executionTimer = setTimeout(() => {
      executionTimedOut = true;
      active.cancelRequested = true;
      this.output.appendLine(
        `[${new Date().toISOString()}] Cancelling Supervisor task ${task.id} after its time budget expired.`,
      );
      if (active.run?.supports("cancel")) {
        void active.run.cancel().catch(() => {});
      }
      active.interrupt?.(new SupervisorDeadlineError("Supervisor execution deadline expired."));
    }, Math.max(1, maximumMinutes) * 60 * 1000);
    const withinBudget = <T>(operation: PromiseLike<T>): Promise<T> =>
      Promise.race([Promise.resolve(operation), interrupt]);
    try {
      const agentPromise = this.createAgent(apiKey, worktreePath, task.title);
      void agentPromise.then((agent) => {
        if (active.cancelRequested && active.agent !== agent) {
          void this.disposeAgentBounded(agent);
        }
      }).catch(() => {});
      active.agent = await withinBudget(agentPromise);
      const run = await withinBudget(active.agent.send(prompt, {
        model: this.selectedModelSelection(),
        mode: "agent",
      }));
      active.run = run;
      if (active.cancelRequested && run.supports("cancel")) {
        void run.cancel().catch(() => {});
      }

      const eventStream = run.stream();
      const resultPromise = run.wait();
      const terminalSignal = resultPromise.then(async (result) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
        return { type: "result" as const, result };
      });
      let result: RunResult | undefined;
      while (!result) {
        const outcome = await Promise.race([
          eventStream.next().then(
            (next) => ({ type: "event" as const, next }),
            (error: unknown) => ({ type: "streamError" as const, error }),
          ),
          terminalSignal,
          interrupt,
        ]);
        if (outcome.type === "result") {
          result = outcome.result;
          void eventStream.return(undefined).catch(() => {});
          break;
        }
        if (outcome.type === "streamError") {
          throw outcome.error;
        }
        if (outcome.next.done) {
          break;
        }
        const event = outcome.next.value;
        if (event.type === "assistant") {
          for (const block of event.message.content) {
            if (block.type === "text" && block.text) {
              assistantText += block.text;
            }
          }
        } else if (event.type === "tool_call") {
          const tool = event as { name?: string; status?: string };
          if (tool.name) {
            this.output.appendLine(
              `[${new Date().toISOString()}] AI Supervisor ${tool.status ?? "running"}: ${tool.name}`,
            );
          }
        }
      }
      result ??= await withinBudget(resultPromise);
      if (executionTimedOut) {
        return {
          status: "error",
          error: this.text(
            "AI Supervisor stopped after reaching its execution-time budget.",
            "AI Supervisorは実行時間の上限に達したため停止しました。",
          ),
        };
      }
      if (result.status === "finished") {
        return {
          status: "finished",
          usage: result.usage,
          assistantText,
          ...this.completionMetadata(assistantText),
        };
      }
      if (result.status === "cancelled") {
        return { status: "cancelled", usage: result.usage };
      }
      return {
        status: "error",
        usage: result.usage,
        error: result.error?.message
          || assistantText
          || this.text("The Supervisor run failed.", "Supervisor実行に失敗しました。"),
      };
    } catch (error) {
      if (executionTimedOut || error instanceof SupervisorDeadlineError) {
        return {
          status: "error",
          error: this.text(
            "AI Supervisor stopped after reaching its execution-time budget.",
            "AI Supervisorは実行時間の上限に達したため停止しました。",
          ),
        };
      }
      if (error instanceof SupervisorCancelledError || active.cancelRequested) {
        return { status: "cancelled" };
      }
      const message = error instanceof Error ? error.message : String(error);
      this.output.appendLine(
        `[${new Date().toISOString()}] AI Supervisor runner error: ${message}`,
      );
      return { status: "error", error: message };
    } finally {
      if (executionTimer) {
        clearTimeout(executionTimer);
      }
      active.interrupt = undefined;
      active.run = undefined;
      await this.disposeAgentBounded(active.agent);
      active.agent = undefined;
      this.activeRuns.delete(task.id);
    }
  }

  private async createAgent(
    apiKey: string,
    worktreePath: string,
    title: string,
  ): Promise<CursorAgent> {
    const approvalMode = this.context.globalState.get<string>(
      APPROVAL_MODE_KEY,
      "auto-review",
    );
    const local: LocalAgentOptions = {
      cwd: worktreePath,
      autoReview: approvalMode !== "full-access",
      sandboxOptions: {
        enabled: SUPPORTS_LOCAL_SANDBOX && approvalMode !== "full-access",
      },
      settingSources: ["all"],
    };
    const connect = (options: LocalAgentOptions) => Agent.create({
      apiKey,
      model: this.selectedModelSelection(),
      local: options,
      agents: this.builtInSubagents(),
      name: `AI Supervisor: ${title}`,
    });
    try {
      return await connect(local);
    } catch (error) {
      if (!local.sandboxOptions?.enabled || !this.isSandboxUnavailableError(error)) {
        throw error;
      }
      const continueLabel = this.text("Run without sandbox", "サンドボックスなしで実行");
      const answer = await vscode.window.showWarningMessage(
        this.text(
          "Cursor's local sandbox is unavailable. Continue with Auto-review enabled?",
          "Cursorのローカルサンドボックスを利用できません。自動レビューを有効にしたまま続行しますか？",
        ),
        { modal: true },
        continueLabel,
      );
      if (answer !== continueLabel) {
        throw new Error(this.text(
          "Supervisor run cancelled because sandboxing is unavailable.",
          "サンドボックスを利用できないためSupervisor実行を中止しました。",
        ));
      }
      return connect({ ...local, sandboxOptions: { enabled: false } });
    }
  }

  private selectedModelSelection(): ModelSelection {
    const id = this.context.globalState.get<string>(MODEL_KEY, DEFAULT_MODEL);
    const params = this.context.globalState
      .get<Record<string, ModelParameterValue[]>>(MODEL_PARAMS_KEY, {})[id];
    return { id, params: params?.length ? params : undefined };
  }

  private builtInSubagents(): Record<string, AgentDefinition> {
    return {
      researcher: {
        description: "Read-only specialist for gathering codebase evidence and comparing approaches.",
        prompt: "Investigate the assigned question, gather concise evidence, and do not edit files.",
        model: "inherit",
      },
      implementer: {
        description: "Implementation specialist for a clearly scoped independent change.",
        prompt: "Implement only the assigned scope, preserve unrelated work, and run focused validation.",
        model: "inherit",
      },
      reviewer: {
        description: "Review specialist for correctness, regressions, security, and missing validation.",
        prompt: "Review the assigned work with evidence and report actionable issues by priority.",
        model: "inherit",
      },
    };
  }

  private completionMetadata(
    assistantText: string,
  ): Pick<SupervisorExecutionResult, "summary" | "changeReasons"> {
    const startTag = "<SUPERVISOR_CHANGE_REASONS>";
    const endTag = "</SUPERVISOR_CHANGE_REASONS>";
    const start = assistantText.lastIndexOf(startTag);
    const end = start >= 0 ? assistantText.indexOf(endTag, start + startTag.length) : -1;
    let summaryText = assistantText;
    const changeReasons: Record<string, string> = {};
    if (start >= 0 && end >= 0) {
      const json = assistantText.slice(start + startTag.length, end).trim();
      summaryText = `${assistantText.slice(0, start)}${assistantText.slice(end + endTag.length)}`;
      try {
        const parsed: unknown = JSON.parse(json);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          for (const [rawPath, rawReason] of Object.entries(parsed)) {
            if (typeof rawReason !== "string" || !rawReason.trim()) {
              continue;
            }
            const relative = rawPath.replaceAll("\\", "/").replace(/^\.\//, "").trim();
            if (!relative || relative.startsWith("../") || relative.startsWith("/")) {
              continue;
            }
            changeReasons[relative] = rawReason.replace(/\s+/g, " ").trim().slice(0, 500);
          }
        }
      } catch (error) {
        this.output.appendLine(
          `[${new Date().toISOString()}] AI Supervisor returned invalid change-reason JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    const summary = summaryText.trim().slice(0, 1_500);
    return {
      summary: summary || undefined,
      changeReasons: Object.keys(changeReasons).length > 0 ? changeReasons : undefined,
    };
  }

  private async disposeAgent(agent: CursorAgent | undefined): Promise<void> {
    if (agent) {
      await agent[Symbol.asyncDispose]();
    }
  }

  private async disposeAgentBounded(agent: CursorAgent | undefined): Promise<void> {
    if (!agent) {
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.disposeAgent(agent).catch(() => {}),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5_000);
      }),
    ]);
    if (timer) {
      clearTimeout(timer);
    }
  }

  private isSandboxUnavailableError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("sandboxing is not supported in this environment")
      || message.includes("Local SDK sandboxing was requested");
  }

  private text(english: string, japanese: string): string {
    return vscode.env.language.toLowerCase().startsWith("ja") ? japanese : english;
  }
}
