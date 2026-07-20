import {
  executionProfile,
  executionProfiles,
  localizeExecutionProfile,
  type ExecutionProfileDefinition,
  type ExecutionProfileId,
  type ExecutionProfileSettingValue,
} from "./executionProfiles.js";
import { localizeWorkflowRecipe, workflowRecipes, type WorkflowRecipe } from "./workflowRecipes.js";

export type WorkflowConfigurationTarget = "workspace" | "global";
export type WorkflowApprovalMode = "safe-worktree" | "auto-review" | "full-access";

export interface WorkflowQuickPickItem {
  readonly label: string;
  readonly description: string;
  readonly recipe: WorkflowRecipe;
}

export interface ExecutionProfileQuickPickItem {
  readonly label: string;
  readonly description: string;
  readonly profile: ExecutionProfileDefinition;
}

export interface WorkflowQuickPickOptions {
  readonly title: string;
  readonly placeHolder: string;
}

export interface WorkflowWarningOptions {
  readonly modal?: boolean;
}

export interface WorkflowControllerDependencies {
  readonly japanese: boolean;
  readonly supportsLocalSandbox: boolean;
  readonly isWorkspaceTrusted: () => boolean;
  readonly hasWorkspaceFolders: () => boolean;
  readonly currentExecutionProfile: () => ExecutionProfileId | undefined;
  readonly pickWorkflow: (
    items: readonly WorkflowQuickPickItem[],
    options: WorkflowQuickPickOptions,
  ) => Promise<WorkflowQuickPickItem | undefined>;
  readonly pickExecutionProfile: (
    items: readonly ExecutionProfileQuickPickItem[],
    options: WorkflowQuickPickOptions,
  ) => Promise<ExecutionProfileQuickPickItem | undefined>;
  readonly showWarningMessage: (
    message: string,
    options: WorkflowWarningOptions,
    actions: readonly string[],
  ) => Promise<string | undefined>;
  readonly showInformationMessage: (message: string) => unknown;
  readonly executeCommand: (command: string, ...args: readonly unknown[]) => Promise<unknown>;
  readonly updateConfiguration: (
    key: string,
    value: ExecutionProfileSettingValue,
    target: WorkflowConfigurationTarget,
  ) => Promise<void>;
  readonly updateSelectedExecutionProfile: (id: ExecutionProfileId) => Promise<void>;
  readonly updateApprovalMode: (mode: WorkflowApprovalMode) => Promise<void>;
  readonly markPermissionsConfirmed: () => Promise<void>;
  readonly cancelAllChats: () => Promise<void>;
  readonly disposeAgent: () => Promise<void>;
  readonly approvalModeSelected: (mode: WorkflowApprovalMode) => unknown;
  readonly refreshNotificationAndSoundSettings: () => unknown;
  readonly publishSetupChecklistState: () => Promise<void>;
}

export type WorkflowSelectionResult = "cancelled" | "trust-required" | "executed";
export type ExecutionProfileSelectionResult = "cancelled" | "trust-required" | "applied";

/** Coordinates workflow and execution-profile selection without importing VS Code. */
export class WorkflowController {
  public constructor(private readonly dependencies: WorkflowControllerDependencies) {}

  public async chooseWorkflow(): Promise<WorkflowSelectionResult> {
    const selected = await this.dependencies.pickWorkflow(
      workflowRecipes().map((recipe) => {
        const localized = localizeWorkflowRecipe(recipe, this.dependencies.japanese);
        return {
          label: localized.label,
          description: localized.description,
          recipe,
        };
      }),
      {
        title: this.localize("What do you want to do?", "何をしますか？"),
        placeHolder: this.localize(
          "Ask, change, delegate, or review",
          "質問・変更・委譲・確認から選択",
        ),
      },
    );
    if (!selected) {
      return "cancelled";
    }
    if (selected.recipe.trustRequired && !this.dependencies.isWorkspaceTrusted()) {
      const trustLabel = this.localize("Manage Workspace Trust", "ワークスペースの信頼を管理");
      const answer = await this.dependencies.showWarningMessage(
        this.localize(
          `${selected.label} requires a trusted workspace.`,
          `${selected.label}には信頼済みワークスペースが必要です。`,
        ),
        {},
        [trustLabel],
      );
      if (answer === trustLabel) {
        await this.dependencies.executeCommand("workbench.trust.manage");
      }
      return "trust-required";
    }
    await this.dependencies.executeCommand(selected.recipe.command);
    return "executed";
  }

  public async chooseExecutionProfile(): Promise<ExecutionProfileSelectionResult> {
    const currentId = this.dependencies.currentExecutionProfile();
    const selected = await this.dependencies.pickExecutionProfile(
      executionProfiles().map((profile) => {
        const localized = localizeExecutionProfile(profile, this.dependencies.japanese);
        return {
          label: `${profile.id === currentId ? "$(check) " : ""}${localized.label}`,
          description: localized.description,
          profile,
        };
      }),
      {
        title: this.localize("Choose an execution profile", "実行プロファイルを選択"),
        placeHolder: this.localize(
          "Profiles configure the existing safety and automation controls.",
          "既存の安全性・自動化設定をまとめて変更します。",
        ),
      },
    );
    if (!selected) {
      return "cancelled";
    }
    const profile = executionProfile(selected.profile.id);
    if (!profile) {
      return "cancelled";
    }
    if (profile.requiresTrustedWorkspace && !this.dependencies.isWorkspaceTrusted()) {
      await this.dependencies.showWarningMessage(
        this.localize(
          "This profile requires a trusted workspace. Trust the workspace, then select it again.",
          "このプロファイルには信頼済みワークスペースが必要です。信頼後に再選択してください。",
        ),
        {},
        [],
      );
      return "trust-required";
    }
    if (profile.id === "automation") {
      const applyLabel = this.localize("Enable bounded automation", "上限付き自動化を有効化");
      const answer = await this.dependencies.showWarningMessage(
        this.localize(
          "Automation enables autonomous Supervisor runs, bounded repair, and safe-change auto-apply in isolated worktrees.",
          "自動化重視では、隔離worktree上の自律Supervisor、上限付き修復、安全な変更の自動適用を有効にします。",
        ),
        { modal: true },
        [applyLabel],
      );
      if (answer !== applyLabel) {
        return "cancelled";
      }
    }

    const target = this.dependencies.hasWorkspaceFolders() ? "workspace" : "global";
    await Promise.all(
      Object.entries(profile.settings).map(([key, value]) =>
        this.dependencies.updateConfiguration(key, value, target),
      ),
    );
    const approvalMode: WorkflowApprovalMode =
      profile.approvalMode === "safe-worktree" && this.dependencies.supportsLocalSandbox
        ? "auto-review"
        : profile.approvalMode;
    await Promise.all([
      this.dependencies.updateSelectedExecutionProfile(profile.id),
      this.dependencies.updateApprovalMode(approvalMode),
      this.dependencies.markPermissionsConfirmed(),
    ]);
    await this.dependencies.cancelAllChats();
    await this.dependencies.disposeAgent();
    await this.dependencies.approvalModeSelected(approvalMode);
    await this.dependencies.refreshNotificationAndSoundSettings();
    await this.dependencies.publishSetupChecklistState();

    const label = selected.label.replace(/^\$\(check\)\s*/u, "");
    await this.dependencies.showInformationMessage(
      this.localize(
        `Execution profile applied: ${label}`,
        `実行プロファイルを適用しました: ${label}`,
      ),
    );
    return "applied";
  }

  private localize(english: string, japanese: string): string {
    return this.dependencies.japanese ? japanese : english;
  }
}
