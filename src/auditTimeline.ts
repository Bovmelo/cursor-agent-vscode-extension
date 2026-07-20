import * as path from "node:path";
import * as vscode from "vscode";
import { AUDIT_LOG_KEY, type AuditEntry } from "./auditLog.js";

interface AuditEntryNode {
  kind: "entry" | "detail" | "file";
  entry: AuditEntry;
  label: string;
  description?: string;
  file?: string;
}

interface AuditHealthNode {
  kind: "health";
  label: string;
  description: string;
}

type AuditNode = AuditEntryNode | AuditHealthNode;

export class AuditTimelineController implements vscode.TreeDataProvider<AuditNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<AuditNode | undefined>();
  private sharedEntries: AuditEntry[] = [];
  private sharedLogError: string | undefined;
  public readonly onDidChangeTreeData = this.changed.event;

  public constructor(
    private readonly state: vscode.Memento,
    private readonly japanese: boolean,
  ) {
    this.refresh();
  }

  public refresh(): void {
    void this.loadSharedEntries()
      .catch(() => {})
      .then(() => this.changed.fire(undefined));
  }

  public dispose(): void {
    this.changed.dispose();
  }

  public setSharedLogError(error: string | undefined): void {
    this.sharedLogError = error;
    this.changed.fire(undefined);
  }

  public getTreeItem(node: AuditNode): vscode.TreeItem {
    if (node.kind === "health") {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
      item.description = node.description;
      item.tooltip = this.japanese
        ? `共有監査ログへの書き込みに失敗しました。Agentログを開いて詳細を確認してください。\n\n${node.description}`
        : `Writing the shared audit log failed. Open Agent logs for details.\n\n${node.description}`;
      item.contextValue = "cursorAudit.health.error";
      item.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("list.warningForeground"));
      item.command = {
        command: "cursorSubscription.openOutput",
        title: this.japanese ? "Agentログを開く" : "Open Agent logs",
      };
      return item;
    }
    const item = new vscode.TreeItem(
      node.label,
      node.kind === "entry" && (node.entry.details || node.entry.files?.length)
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.description = node.description;
    item.tooltip = this.tooltip(node.entry);
    item.contextValue = `cursorAudit.${node.kind}`;
    item.iconPath = new vscode.ThemeIcon(
      node.kind === "entry" ? "history" : node.kind === "file" ? "file" : "info",
    );
    if (node.file) {
      item.command = {
        command: "cursorSubscription.openAuditFile",
        title: this.japanese ? "ファイルを開く" : "Open file",
        arguments: [node.entry, node.file],
      };
    }
    return item;
  }

  public getChildren(node?: AuditNode): AuditNode[] {
    if (!node) {
      const entries = new Map<string, AuditEntry>();
      for (const entry of [
        ...this.state.get<AuditEntry[]>(AUDIT_LOG_KEY, []),
        ...this.sharedEntries,
      ]) {
        entries.set(entry.id, entry);
      }
      const nodes: AuditNode[] = [...entries.values()]
        .sort((left, right) => right.at - left.at)
        .map((entry) => ({
        kind: "entry",
        entry,
        label: entry.summary,
        description: `${entry.action} · ${new Date(entry.at).toLocaleString()}`,
        }));
      if (this.sharedLogError) {
        nodes.unshift({
          kind: "health",
          label: this.japanese ? "共有ログの書き込みに失敗" : "Shared log write failed",
          description: this.sharedLogError.slice(0, 160),
        });
      }
      return nodes;
    }
    if (node.kind !== "entry") {
      return [];
    }
    const children: AuditNode[] = [];
    if (node.entry.details) {
      children.push({
        kind: "detail",
        entry: node.entry,
        label: node.entry.details.split(/\r?\n/u)[0].slice(0, 160),
      });
    }
    for (const file of node.entry.files ?? []) {
      children.push({
        kind: "file",
        entry: node.entry,
        file,
        label: path.basename(file),
        description: file,
      });
    }
    return children;
  }

  private tooltip(entry: AuditEntry): vscode.MarkdownString {
    const value = new vscode.MarkdownString(undefined, true);
    value.appendMarkdown(`**${entry.summary}**\n\n`);
    value.appendMarkdown(`\`${entry.action}\` · ${new Date(entry.at).toLocaleString()}\n\n`);
    if (entry.details) {
      value.appendText(entry.details);
    }
    return value;
  }

  private async loadSharedEntries(): Promise<void> {
    const entries: AuditEntry[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const configuration = vscode.workspace.getConfiguration("cursorSubscription", folder.uri);
      if (!configuration.get<boolean>("auditSharedLogEnabled", false)) {
        continue;
      }
      const configuredPath = configuration.get<string>(
        "auditSharedLogPath",
        ".cursor/ai-audit-log.jsonl",
      );
      if (!configuredPath || path.isAbsolute(configuredPath)) {
        continue;
      }
      const target = path.resolve(folder.uri.fsPath, configuredPath);
      const relative = path.relative(folder.uri.fsPath, target);
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        continue;
      }
      try {
        const raw = new TextDecoder().decode(
          await vscode.workspace.fs.readFile(vscode.Uri.file(target)),
        );
        for (const line of raw.split(/\r?\n/u).filter(Boolean).slice(-1_000)) {
          const entry = JSON.parse(line) as Partial<AuditEntry>;
          if (
            typeof entry.id === "string"
            && typeof entry.at === "number"
            && typeof entry.action === "string"
            && typeof entry.summary === "string"
          ) {
            entries.push(entry as AuditEntry);
          }
        }
      } catch {
        // The shared log is optional and may not exist yet.
      }
    }
    this.sharedEntries = entries;
  }
}
