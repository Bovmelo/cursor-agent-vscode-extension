import * as path from "node:path";
import * as vscode from "vscode";

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

export function resolveAbsoluteInWorkspace(
  filePath: string,
  preferred?: vscode.WorkspaceFolder,
): string | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    return undefined;
  }
  if (path.isAbsolute(filePath)) {
    return path.resolve(filePath);
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
      return path.resolve(folder.uri.fsPath, rest);
    }
  }

  for (const folder of ordered) {
    const absolute = path.resolve(folder.uri.fsPath, filePath);
    const rel = path.relative(folder.uri.fsPath, absolute);
    if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
      return absolute;
    }
  }
  return path.resolve(ordered[0].uri.fsPath, filePath);
}
