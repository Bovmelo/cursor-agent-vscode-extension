import * as vscode from "vscode";
import {
  SIDEBAR_GROUP_ORDER,
  sidebarGroupAccessibilityLabel,
  sidebarGroupContextValue,
  sidebarGroupDescription,
  sidebarGroupEmptyCommand,
  sidebarGroupEmptyLabel,
  sidebarGroupIcon,
  sidebarGroupLabel,
  sidebarGroupTooltip,
  type ExistingSidebarGroupId,
  type SidebarGroupId,
  type WorkspaceGroupNode,
  type WorkspacePlaceholderNode,
  type WorkspaceTreeNode,
  WORKSPACE_TREE_VIEW_ID,
} from "./workspaceSidebarUtils.js";

export {
  unwrapWorkspaceNode,
  WORKSPACE_TREE_VIEW_ID,
  type ExistingSidebarGroupId,
  type SidebarGroupId,
  type WorkspaceChildNode,
  type WorkspaceGroupNode,
  type WorkspacePlaceholderNode,
  type WorkspaceTreeNode,
} from "./workspaceSidebarUtils.js";

export type WorkspaceSidebarChildProvider = vscode.TreeDataProvider<unknown>;

export type WorkspaceSidebarProviders = Record<
  ExistingSidebarGroupId,
  WorkspaceSidebarChildProvider
> & {
  runCenter?: WorkspaceSidebarChildProvider;
};

export class WorkspaceSidebarController
implements vscode.TreeDataProvider<WorkspaceTreeNode>, vscode.Disposable {
  private readonly changedEmitter = new vscode.EventEmitter<WorkspaceTreeNode | undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly groupNodes: WorkspaceGroupNode[];
  private treeView: vscode.TreeView<WorkspaceTreeNode> | undefined;

  public readonly onDidChangeTreeData = this.changedEmitter.event;

  public constructor(
    private readonly japanese: boolean,
    private readonly providers: WorkspaceSidebarProviders,
  ) {
    this.groupNodes = SIDEBAR_GROUP_ORDER
      .filter((groupId) => this.providerFor(groupId) !== undefined)
      .map((groupId) => ({
        kind: "group" as const,
        groupId,
      }));
    for (const provider of Object.values(this.providers)) {
      if (provider.onDidChangeTreeData) {
        this.disposables.push(
          provider.onDidChangeTreeData(() => this.changedEmitter.fire(undefined)),
        );
      }
    }
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.changedEmitter.dispose();
  }

  public attachTreeView(treeView: vscode.TreeView<WorkspaceTreeNode>): void {
    this.treeView = treeView;
  }

  public groupNode(groupId: SidebarGroupId): WorkspaceGroupNode {
    return this.groupNodes.find((node) => node.groupId === groupId) ?? { kind: "group", groupId };
  }

  public async focusGroup(groupId: SidebarGroupId): Promise<void> {
    await vscode.commands.executeCommand(`${WORKSPACE_TREE_VIEW_ID}.focus`);
    if (!this.treeView) {
      return;
    }
    await this.treeView.reveal(this.groupNode(groupId), {
      expand: true,
      focus: true,
      select: true,
    });
  }

  public getTreeItem(element: WorkspaceTreeNode): vscode.TreeItem {
    if (element.kind === "group") {
      const count = this.rootChildren(element.groupId).length;
      const item = new vscode.TreeItem(
        sidebarGroupLabel(element.groupId, this.japanese),
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.description = sidebarGroupDescription(count);
      item.tooltip = sidebarGroupTooltip(element.groupId, count, this.japanese);
      item.accessibilityInformation = {
        label: sidebarGroupAccessibilityLabel(element.groupId, count, this.japanese),
        role: "treeitem",
      };
      item.id = sidebarGroupContextValue(element.groupId);
      item.contextValue = sidebarGroupContextValue(element.groupId);
      item.iconPath = new vscode.ThemeIcon(sidebarGroupIcon(element.groupId));
      return item;
    }
    if (element.kind === "placeholder") {
      const label = sidebarGroupEmptyLabel(element.groupId, this.japanese);
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
      item.contextValue = `${sidebarGroupContextValue(element.groupId)}.empty`;
      item.iconPath = new vscode.ThemeIcon("lightbulb");
      item.tooltip = label;
      item.accessibilityInformation = {
        label,
        role: "treeitem",
      };
      item.id = `${sidebarGroupContextValue(element.groupId)}.empty`;
      item.command = {
        command: sidebarGroupEmptyCommand(element.groupId),
        title: label,
      };
      return item;
    }
    const provider = this.providerFor(element.groupId);
    const item = provider?.getTreeItem(element.node);
    if (item instanceof vscode.TreeItem) {
      return item;
    }
    throw new Error("Workspace sidebar child providers must return TreeItem synchronously");
  }

  public getChildren(element?: WorkspaceTreeNode): WorkspaceTreeNode[] {
    if (!element) {
      return this.groupNodes;
    }
    if (element.kind === "group") {
      const children = this.rootChildren(element.groupId);
      return children.length > 0
        ? this.wrapChildren(element.groupId, children)
        : [this.placeholderNode(element.groupId)];
    }
    if (element.kind === "placeholder") {
      return [];
    }
    const provider = this.providerFor(element.groupId);
    return this.wrapChildren(
      element.groupId,
      provider?.getChildren?.(element.node),
    );
  }

  private providerFor(groupId: SidebarGroupId): WorkspaceSidebarChildProvider | undefined {
    return this.providers[groupId];
  }

  private rootChildren(groupId: SidebarGroupId): unknown[] {
    const children = this.providerFor(groupId)?.getChildren?.();
    return Array.isArray(children) ? children : [];
  }

  private placeholderNode(groupId: SidebarGroupId): WorkspacePlaceholderNode {
    return { kind: "placeholder", groupId };
  }

  private wrapChildren(groupId: SidebarGroupId, children: unknown): WorkspaceTreeNode[] {
    // Child providers in this extension return arrays synchronously.
    if (!Array.isArray(children)) {
      return [];
    }
    return children.map((node) => ({
      kind: "child" as const,
      groupId,
      node,
    }));
  }
}
