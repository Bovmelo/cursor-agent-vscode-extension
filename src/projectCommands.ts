import { homedir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { expandCommandBody } from "./pureUtils.js";

export interface ProjectCommand {
  id: string;
  label: string;
  description: string;
  body: string;
  source: "project" | "user";
}

const MAX_COMMANDS = 100;
const MAX_COMMAND_BYTES = 32 * 1024;

function commandIdFromFileName(fileName: string): string | undefined {
  if (!fileName.toLowerCase().endsWith(".md")) {
    return undefined;
  }
  const id = fileName.slice(0, -3).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(id)) {
    return undefined;
  }
  return id;
}

function firstMeaningfulLine(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^#+\s*/, "");
    if (trimmed) {
      return trimmed.slice(0, 120);
    }
  }
  return "";
}

async function readCommandFile(
  uri: vscode.Uri,
  source: "project" | "user",
): Promise<ProjectCommand | undefined> {
  const id = commandIdFromFileName(path.basename(uri.fsPath));
  if (!id) {
    return undefined;
  }
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_COMMAND_BYTES) {
      return undefined;
    }
    const body = Buffer.from(bytes).toString("utf8").trim();
    if (!body) {
      return undefined;
    }
    const description = firstMeaningfulLine(body) || id;
    return {
      id,
      label: `/${id}`,
      description,
      body,
      source,
    };
  } catch {
    return undefined;
  }
}

async function loadCommandsFromDirectory(
  directory: vscode.Uri,
  source: "project" | "user",
): Promise<ProjectCommand[]> {
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(directory);
  } catch {
    return [];
  }
  const commands: ProjectCommand[] = [];
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.File) {
      continue;
    }
    const command = await readCommandFile(
      vscode.Uri.joinPath(directory, name),
      source,
    );
    if (command) {
      commands.push(command);
    }
    if (commands.length >= MAX_COMMANDS) {
      break;
    }
  }
  return commands;
}

export async function loadProjectCommands(
  workspaces?: vscode.WorkspaceFolder | readonly vscode.WorkspaceFolder[],
): Promise<ProjectCommand[]> {
  const byId = new Map<string, ProjectCommand>();
  const folders = workspaces === undefined
    ? vscode.workspace.workspaceFolders ?? []
    : Array.isArray(workspaces)
      ? workspaces
      : [workspaces];

  for (const workspace of folders) {
    for (const command of await loadCommandsFromDirectory(
      vscode.Uri.joinPath(workspace.uri, ".cursor", "commands"),
      "project",
    )) {
      if (!byId.has(command.id)) {
        byId.set(command.id, command);
      }
    }
  }

  const userRoot = vscode.Uri.file(path.join(homedir(), ".cursor", "commands"));
  for (const command of await loadCommandsFromDirectory(userRoot, "user")) {
    if (!byId.has(command.id)) {
      byId.set(command.id, command);
    }
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function expandProjectCommand(
  command: ProjectCommand,
  trailingText: string,
): string {
  return expandCommandBody(command.body, trailingText);
}
