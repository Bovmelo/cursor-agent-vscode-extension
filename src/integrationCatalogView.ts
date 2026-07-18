import * as vscode from "vscode";
import {
  loadIntegrationCatalog,
  previewIntegrationText,
  toggleIntegration,
  type IntegrationItem,
  type IntegrationToggleState,
  INTEGRATION_TOGGLE_KEY,
} from "./integrationCatalog.js";

export interface CatalogNode {
  kind: "group" | "item";
  group?: string;
  item?: IntegrationItem;
}

export class IntegrationCatalogController
implements vscode.TreeDataProvider<CatalogNode>, vscode.Disposable {
  private readonly changedEmitter = new vscode.EventEmitter<CatalogNode | undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  private items: IntegrationItem[] = [];

  public readonly onDidChangeTreeData = this.changedEmitter.event;

  public constructor(
    private readonly state: vscode.Memento,
    private readonly japanese: boolean,
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => void this.refresh()),
    );
    void this.refresh();
  }

  public dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.changedEmitter.dispose();
  }

  public getTreeItem(element: CatalogNode): vscode.TreeItem {
    if (element.kind === "group") {
      const item = new vscode.TreeItem(
        element.group ?? "",
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.contextValue = "cursorIntegration.group";
      return item;
    }
    const integration = element.item!;
    const treeItem = new vscode.TreeItem(
      integration.label,
      vscode.TreeItemCollapsibleState.None,
    );
    treeItem.description = [
      integration.enabled
        ? undefined
        : (this.japanese ? "無効" : "disabled"),
      integration.folder,
      integration.description,
    ].filter(Boolean).join(" · ");
    treeItem.tooltip = integration.description;
    treeItem.contextValue = integration.enabled
      ? "cursorIntegration.item.enabled"
      : "cursorIntegration.item.disabled";
    treeItem.iconPath = new vscode.ThemeIcon(
      integration.kind === "skill"
        ? "sparkle"
        : integration.kind === "mcp"
          ? "server"
          : integration.kind === "command"
            ? "symbol-keyword"
            : "book",
    );
    if (integration.uri) {
      treeItem.command = {
        command: "cursorSubscription.previewIntegration",
        title: "Preview",
        arguments: [integration.id],
      };
    }
    return treeItem;
  }

  public getChildren(element?: CatalogNode): CatalogNode[] {
    if (!element) {
      const groups = [...new Set(this.items.map((item) => item.kind))];
      return groups.map((group) => ({ kind: "group" as const, group: this.groupLabel(group) }));
    }
    if (element.kind === "group") {
      const kind = this.kindFromLabel(element.group ?? "");
      return this.items
        .filter((item) => item.kind === kind)
        .map((item) => ({ kind: "item" as const, item }));
    }
    return [];
  }

  public async refresh(): Promise<void> {
    const toggles = this.state.get<IntegrationToggleState>(INTEGRATION_TOGGLE_KEY);
    this.items = await loadIntegrationCatalog(
      vscode.workspace.workspaceFolders ?? [],
      toggles,
    );
    this.changedEmitter.fire(undefined);
  }

  public async preview(target: string | CatalogNode | undefined): Promise<void> {
    const id = typeof target === "string" ? target : target?.item?.id;
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item?.uri) {
      return;
    }
    const text = await previewIntegrationText(vscode.Uri.parse(item.uri));
    const document = await vscode.workspace.openTextDocument({
      content: text || (this.japanese ? "(空)" : "(empty)"),
      language: item.kind === "mcp" ? "json" : "markdown",
    });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  public async toggle(target: string | CatalogNode | undefined, enabled: boolean): Promise<void> {
    const id = typeof target === "string" ? target : target?.item?.id;
    if (!id) {
      return;
    }
    const item = this.items.find((candidate) => candidate.id === id);
    const current = this.state.get<IntegrationToggleState>(INTEGRATION_TOGGLE_KEY);
    await this.state.update(
      INTEGRATION_TOGGLE_KEY,
      toggleIntegration(current, id, enabled, item?.legacyIds),
    );
    await this.refresh();
  }

  public async open(target: string | CatalogNode | undefined): Promise<void> {
    const id = typeof target === "string" ? target : target?.item?.id;
    const item = this.items.find((candidate) => candidate.id === id);
    if (!item?.uri) {
      return;
    }
    await vscode.window.showTextDocument(vscode.Uri.parse(item.uri), { preview: true });
  }

  public disabledIds(): string[] {
    return this.state.get<IntegrationToggleState>(INTEGRATION_TOGGLE_KEY)?.disabledIds ?? [];
  }

  private groupLabel(kind: IntegrationItem["kind"]): string {
    const labels: Record<IntegrationItem["kind"], [string, string]> = {
      rules: ["Rules", "Rules"],
      memory: ["Project memory", "プロジェクト記憶"],
      skill: ["Skills", "Skills"],
      mcp: ["MCP", "MCP"],
      command: ["Commands", "コマンド"],
    };
    return this.japanese ? labels[kind][1] : labels[kind][0];
  }

  private kindFromLabel(label: string): IntegrationItem["kind"] {
    for (const kind of ["rules", "memory", "skill", "mcp", "command"] as const) {
      if (this.groupLabel(kind) === label) {
        return kind;
      }
    }
    return "rules";
  }
}
