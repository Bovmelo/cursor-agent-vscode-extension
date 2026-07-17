import { readFile } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  isIntegrationEnabled,
  type IntegrationToggleState,
} from "./integrationToggles.js";

export type IntegrationKind = "rules" | "memory" | "skill" | "mcp" | "command";

export interface IntegrationItem {
  id: string;
  kind: IntegrationKind;
  label: string;
  description?: string;
  uri?: string;
  enabled: boolean;
  folder?: string;
}

export {
  INTEGRATION_TOGGLE_KEY,
  isIntegrationEnabled,
  toggleIntegration,
  type IntegrationToggleState,
} from "./integrationToggles.js";

export async function loadIntegrationCatalog(
  folders: readonly vscode.WorkspaceFolder[],
  state: IntegrationToggleState | undefined,
): Promise<IntegrationItem[]> {
  const items: IntegrationItem[] = [];
  for (const folder of folders) {
    const root = folder.uri;
    const folderName = folder.name;
    for (const [kind, relative] of [
      ["rules", ".cursor/rules.md"],
      ["memory", ".cursor/project-memory.md"],
    ] as const) {
      const uri = vscode.Uri.joinPath(root, ...relative.split("/"));
      if (await exists(uri)) {
        const id = `${kind}:${folderName}:${relative}`;
        items.push({
          id,
          kind,
          label: path.basename(relative),
          description: relative,
          uri: uri.toString(),
          enabled: isIntegrationEnabled(state, id),
          folder: folderName,
        });
      }
    }

    try {
      const skillFiles = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, ".cursor/skills/**/SKILL.md"),
        null,
        100,
      );
      for (const skillUri of skillFiles) {
        const relative = vscode.workspace.asRelativePath(skillUri, false);
        const name = path.basename(path.dirname(skillUri.fsPath));
        const id = `skill:${folderName}:${name}`;
        items.push({
          id,
          kind: "skill",
          label: name,
          description: relative,
          uri: skillUri.toString(),
          enabled: isIntegrationEnabled(state, id),
          folder: folderName,
        });
      }
    } catch {
      // Missing skills folders are fine.
    }

    const mcpUri = vscode.Uri.joinPath(root, ".cursor", "mcp.json");
    if (await exists(mcpUri)) {
      const id = `mcp:${folderName}:mcp.json`;
      items.push({
        id,
        kind: "mcp",
        label: "mcp.json",
        description: ".cursor/mcp.json",
        uri: mcpUri.toString(),
        enabled: isIntegrationEnabled(state, id),
        folder: folderName,
      });
    }

    try {
      const commandFiles = await vscode.workspace.findFiles(
        new vscode.RelativePattern(folder, ".cursor/commands/*.md"),
        null,
        100,
      );
      for (const commandUri of commandFiles) {
        const name = path.basename(commandUri.fsPath, ".md");
        const relative = vscode.workspace.asRelativePath(commandUri, false);
        const id = `command:${folderName}:${name}`;
        items.push({
          id,
          kind: "command",
          label: `/${name}`,
          description: relative,
          uri: commandUri.toString(),
          enabled: isIntegrationEnabled(state, id),
          folder: folderName,
        });
      }
    } catch {
      // Missing commands folders are fine.
    }
  }
  return items.sort((a, b) => a.kind.localeCompare(b.kind) || a.label.localeCompare(b.label));
}

export async function previewIntegrationText(uri: vscode.Uri, maximum = 8_000): Promise<string> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString("utf8");
    return text.length > maximum ? `${text.slice(0, maximum)}\n…` : text;
  } catch {
    try {
      return await readFile(uri.fsPath, "utf8");
    } catch {
      return "";
    }
  }
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
