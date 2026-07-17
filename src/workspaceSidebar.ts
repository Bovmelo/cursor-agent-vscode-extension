import * as vscode from "vscode";
import {
  SIDEBAR_GROUP_ORDER,
  sidebarGroupContextValue,
  sidebarGroupIcon,
  sidebarGroupLabel,
  type SidebarGroupId,
  type WorkspaceGroupNode,
  type WorkspaceTreeNode,
  WORKSPACE_TREE_VIEW_ID,
} from "./workspaceSidebarUtils.js";

export {
  unwrapWorkspaceNode,
  WORKSPACE_TREE_VIEW_ID,
  type SidebarGroupId,
  type WorkspaceChildNode,
  type WorkspaceGroupNode,
  type WorkspaceTreeNode,
} from "./workspaceSidebarUtils.js";

type ChildProvider = vscode.TreeDataProvider<unknown>;

export class WorkspaceSidebarController
implements vscode.TreeDataProvider<WorkspaceTreeNode>, vscode.Disposable {
  private readonly changedEmitter = new vscode.EventEmitter<WorkspaceTreeNode | undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly groupNodes: WorkspaceGroupNode[] = SIDEBAR_GROUP_ORDER.map((groupId) => ({
    kind: "group" as const,
    groupId,
  }));
  private treeView: vscode.TreeView<WorkspaceTreeNode> | undefined;

  public readonly onDidChangeTreeData = this.changedEmitter.event;

  public constructor(
    private readonly japanese: boolean,
    private readonly providers: Record<SidebarGroupId, ChildProvider>,
  ) {
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
      const item = new vscode.TreeItem(
        sidebarGroupLabel(element.groupId, this.japanese),
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.contextValue = sidebarGroupContextValue(element.groupId);
      item.iconPath = new vscode.ThemeIcon(sidebarGroupIcon(element.groupId));
      return item;
    }
    const item = this.providers[element.groupId].getTreeItem(element.node);
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
      return this.wrapChildren(
        element.groupId,
        this.providers[element.groupId].getChildren?.(),
      );
    }
    return this.wrapChildren(
      element.groupId,
      this.providers[element.groupId].getChildren?.(element.node),
    );
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
