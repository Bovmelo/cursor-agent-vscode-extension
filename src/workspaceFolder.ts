import * as path from "node:path";
import * as vscode from "vscode";
import { isPathInside, isPathInsideResolved } from "./safety.js";

export function resolveWorkspaceFolder(
  uri?: vscode.Uri,
): vscode.WorkspaceFolder | undefined {
  if (uri) {
    const matched = vscode.workspace.getWorkspaceFolder(uri);
    if (matched) {
      return matched;
    }
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active) {
    const fromEditor = vscode.workspace.getWorkspaceFolder(active);
    if (fromEditor) {
      return fromEditor;
    }
  }
  return vscode.workspace.workspaceFolders?.[0];
}

/** Resolve a persisted folder URI against the current multi-root workspace. */
export function workspaceFolderFromUri(
  uriString: string | undefined,
): vscode.WorkspaceFolder | undefined {
  if (!uriString) {
    return undefined;
  }
  const folders = vscode.workspace.workspaceFolders ?? [];
  try {
    const target = vscode.Uri.parse(uriString);
    return folders.find(
      (folder) =>
        folder.uri.toString() === target.toString()
        || folder.uri.fsPath === target.fsPath,
    );
  } catch {
    return undefined;
  }
}

export function defaultWorkspaceFolder(
  uri?: vscode.Uri,
): vscode.WorkspaceFolder | undefined {
  return resolveWorkspaceFolder(uri) ?? vscode.workspace.workspaceFolders?.[0];
}

export function configurationFor(
  section: string,
  uri?: vscode.Uri,
): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(
    section,
    resolveWorkspaceFolder(uri)?.uri,
  );
}

export function workspaceDisplayName(): string | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0].name;
  }
  const active = resolveWorkspaceFolder()?.name;
  return active ? `${active} (+${folders.length - 1})` : `${folders.length} folders`;
}

export async function pickWorkspaceFolder(
  placeHolder = "Select a workspace folder",
): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0];
  }
  const picked = await vscode.window.showQuickPick(
    folders.map((folder) => ({
      label: folder.name,
      description: folder.uri.fsPath,
      folder,
    })),
    { placeHolder },
  );
  return picked?.folder;
}

function isInsideAnyWorkspaceFolder(absolute: string): boolean {
  return (vscode.workspace.workspaceFolders ?? []).some((folder) =>
    isPathInside(folder.uri.fsPath, absolute)
  );
}

async function isInsideAnyWorkspaceFolderResolved(absolute: string): Promise<boolean> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (await isPathInsideResolved(folder.uri.fsPath, absolute)) {
      return true;
    }
  }
  return false;
}

export function resolveAbsoluteInWorkspace(
  filePath: string,
  preferred?: vscode.WorkspaceFolder,
): string | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    return undefined;
  }
  if (path.isAbsolute(filePath)) {
    const absolute = path.resolve(filePath);
    return isInsideAnyWorkspaceFolder(absolute) ? absolute : undefined;
  }
  const ordered = preferred
    ? [preferred, ...folders.filter((folder) => folder !== preferred)]
    : [...folders];

  // Multi-root relative paths may be prefixed with the folder name.
  const slash = filePath.replaceAll("\\", "/");
  const slashIndex = slash.indexOf("/");
  if (slashIndex > 0) {
    const folderName = slash.slice(0, slashIndex);
    const rest = slash.slice(slashIndex + 1);
    const folder = folders.find((candidate) => candidate.name === folderName);
    if (folder) {
      const absolute = path.resolve(folder.uri.fsPath, rest);
      return isPathInside(folder.uri.fsPath, absolute) ? absolute : undefined;
    }
  }

  for (const folder of ordered) {
    const absolute = path.resolve(folder.uri.fsPath, filePath);
    if (isPathInside(folder.uri.fsPath, absolute)) {
      return absolute;
    }
  }
  return undefined;
}

/** Lexical resolve plus symlink/realpath containment. */
export async function resolveAbsoluteInWorkspaceResolved(
  filePath: string,
  preferred?: vscode.WorkspaceFolder,
): Promise<string | undefined> {
  const absolute = resolveAbsoluteInWorkspace(filePath, preferred);
  if (!absolute) {
    return undefined;
  }
  return (await isInsideAnyWorkspaceFolderResolved(absolute)) ? absolute : undefined;
}
