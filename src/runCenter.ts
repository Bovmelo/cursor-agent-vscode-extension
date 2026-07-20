import * as vscode from "vscode";
import {
  cloneRunCenterState,
  runCenterEntries,
  runCenterProgressDescription,
  runCenterSectionIcon,
  runCenterSectionLabel,
  runCenterSections,
  type RunCenterChange,
  type RunCenterEntryNode,
  type RunCenterPlanStatus,
  type RunCenterState,
  type RunCenterTreeNode,
  type RunCenterVerificationStatus,
} from "./runCenterModel.js";

export {
  RUN_CENTER_SECTION_ORDER,
  cloneRunCenterState,
  runCenterEntries,
  runCenterProgressDescription,
  runCenterSectionIcon,
  runCenterSectionLabel,
  runCenterSections,
  type RunCenterChange,
  type RunCenterChangeNode,
  type RunCenterChangeStatus,
  type RunCenterEntryNode,
  type RunCenterError,
  type RunCenterErrorNode,
  type RunCenterPlanItem,
  type RunCenterPlanNode,
  type RunCenterPlanStatus,
  type RunCenterProgress,
  type RunCenterProgressNode,
  type RunCenterProgressStatus,
  type RunCenterRecoveryAction,
  type RunCenterRecoveryNode,
  type RunCenterSectionId,
  type RunCenterSectionNode,
  type RunCenterState,
  type RunCenterTreeNode,
  type RunCenterVerification,
  type RunCenterVerificationNode,
  type RunCenterVerificationStatus,
} from "./runCenterModel.js";

const EMPTY_RUN_CENTER_STATE: RunCenterState = {};

/**
 * Mutable adapter around immutable Run Center snapshots. A host can push a full
 * snapshot or patch it without coupling the run producer to VS Code tree items.
 */
export class RunCenterTreeDataProvider
implements vscode.TreeDataProvider<RunCenterTreeNode>, vscode.Disposable {
  private readonly changedEmitter = new vscode.EventEmitter<RunCenterTreeNode | undefined>();
  private state: RunCenterState;

  public readonly onDidChangeTreeData = this.changedEmitter.event;

  public constructor(
    private readonly japanese = false,
    initialState: RunCenterState = EMPTY_RUN_CENTER_STATE,
  ) {
    this.state = cloneRunCenterState(initialState);
  }

  public dispose(): void {
    this.changedEmitter.dispose();
  }

  public get snapshot(): RunCenterState {
    return cloneRunCenterState(this.state);
  }

  public pushState(state: RunCenterState): void {
    this.state = cloneRunCenterState(state);
    this.changedEmitter.fire(undefined);
  }

  public setState(state: RunCenterState): void {
    this.pushState(state);
  }

  public updateState(patch: Partial<RunCenterState>): void {
    this.pushState({ ...this.state, ...patch });
  }

  public clear(): void {
    this.pushState(EMPTY_RUN_CENTER_STATE);
  }

  public getChildren(element?: RunCenterTreeNode): RunCenterTreeNode[] {
    if (!element) {
      return runCenterSections(this.state);
    }
    return element.kind === "section"
      ? runCenterEntries(this.state, element.sectionId)
      : [];
  }

  public getTreeItem(element: RunCenterTreeNode): vscode.TreeItem {
    if (element.kind === "section") {
      const count = runCenterEntries(this.state, element.sectionId).length;
      const label = runCenterSectionLabel(element.sectionId, this.japanese);
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
      item.description = String(count);
      item.contextValue = `cursorRunCenter.section.${element.sectionId}`;
      item.iconPath = new vscode.ThemeIcon(runCenterSectionIcon(element.sectionId));
      item.tooltip = `${label}: ${count}`;
      item.accessibilityInformation = {
        label: `${label}: ${count}`,
        role: "treeitem",
      };
      item.id = `cursorRunCenter.section.${element.sectionId}`;
      return item;
    }
    return this.entryTreeItem(element);
  }

  private entryTreeItem(element: RunCenterEntryNode): vscode.TreeItem {
    switch (element.kind) {
      case "plan":
        return this.leafItem(
          element.item.label,
          this.planStatusLabel(element.item.status),
          this.planStatusIcon(element.item.status),
          element.item.detail,
          "plan",
          element.item.id,
        );
      case "progress":
        return this.leafItem(
          element.progress.message,
          runCenterProgressDescription(element.progress),
          element.progress.status === "completed" ? "pass" : "sync~spin",
          element.progress.detail,
          "progress",
          "current",
        );
      case "change":
        return this.leafItem(
          element.change.path,
          this.changeDescription(element.change),
          "diff",
          element.change.previousPath
            ? `${element.change.previousPath} → ${element.change.path}`
            : undefined,
          "change",
          element.change.path,
        );
      case "verification":
        return this.leafItem(
          element.verification.label,
          this.verificationStatusLabel(element.verification.status),
          this.verificationStatusIcon(element.verification.status),
          element.verification.detail,
          "verification",
          element.verification.id,
        );
      case "error":
        return this.leafItem(
          element.error.message,
          element.error.code,
          "error",
          element.error.detail,
          "error",
          element.error.code ?? element.error.message,
        );
      case "recovery": {
        const item = this.leafItem(
          element.action.label,
          element.action.description,
          "debug-restart",
          element.action.description,
          "recovery",
          element.action.id,
        );
        item.command = {
          command: element.action.command,
          title: element.action.label,
          arguments: element.action.arguments ? [...element.action.arguments] : undefined,
        };
        return item;
      }
    }
  }

  private leafItem(
    label: string,
    description: string | undefined,
    icon: string,
    detail: string | undefined,
    context: RunCenterEntryNode["kind"],
    id: string,
  ): vscode.TreeItem {
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.description = description;
    item.contextValue = `cursorRunCenter.${context}`;
    item.iconPath = new vscode.ThemeIcon(icon);
    item.tooltip = detail ?? description ?? label;
    item.accessibilityInformation = {
      label: description ? `${label}: ${description}` : label,
      role: "treeitem",
    };
    item.id = `cursorRunCenter.${context}.${id}`;
    return item;
  }

  private planStatusLabel(status: RunCenterPlanStatus): string {
    const labels: Record<RunCenterPlanStatus, [string, string]> = {
      pending: ["Pending", "待機中"],
      running: ["Running", "実行中"],
      completed: ["Completed", "完了"],
      blocked: ["Blocked", "ブロック中"],
      skipped: ["Skipped", "スキップ"],
    };
    return this.japanese ? labels[status][1] : labels[status][0];
  }

  private planStatusIcon(status: RunCenterPlanStatus): string {
    const icons: Record<RunCenterPlanStatus, string> = {
      pending: "circle-outline",
      running: "sync~spin",
      completed: "pass",
      blocked: "error",
      skipped: "debug-step-over",
    };
    return icons[status];
  }

  private verificationStatusLabel(status: RunCenterVerificationStatus): string {
    const labels: Record<RunCenterVerificationStatus, [string, string]> = {
      pending: ["Pending", "待機中"],
      running: ["Running", "実行中"],
      passed: ["Passed", "成功"],
      failed: ["Failed", "失敗"],
      skipped: ["Skipped", "スキップ"],
    };
    return this.japanese ? labels[status][1] : labels[status][0];
  }

  private verificationStatusIcon(status: RunCenterVerificationStatus): string {
    const icons: Record<RunCenterVerificationStatus, string> = {
      pending: "circle-outline",
      running: "sync~spin",
      passed: "pass",
      failed: "error",
      skipped: "debug-step-over",
    };
    return icons[status];
  }

  private changeDescription(change: RunCenterChange): string {
    const totals: string[] = [];
    if (change.additions !== undefined) {
      totals.push(`+${Math.max(0, Math.trunc(change.additions))}`);
    }
    if (change.deletions !== undefined) {
      totals.push(`-${Math.max(0, Math.trunc(change.deletions))}`);
    }
    return totals.length > 0 ? `${change.status} ${totals.join(" ")}` : change.status;
  }
}

export { RunCenterTreeDataProvider as RunCenterProvider };
