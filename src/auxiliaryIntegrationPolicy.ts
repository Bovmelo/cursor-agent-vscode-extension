import * as path from "node:path";
import { disabledIntegrationIdsForWorkspace } from "./integrationToggles.js";

export interface IntegrationWorkspaceScope {
  uri: string;
  name: string;
  fsPath: string;
}

function contains(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Auxiliary SDK routes cannot selectively load project settings. Fail closed. */
export function assertAuxiliaryIntegrationsAllowed(
  disabledIds: ReadonlySet<string>,
  folders: readonly IntegrationWorkspaceScope[],
  root: string,
): void {
  const targets = folders.filter((folder) => contains(folder.fsPath, root) || contains(root, folder.fsPath));
  const blocked = targets.length === 0
    ? disabledIds.size > 0
    : targets.some((folder) => disabledIntegrationIdsForWorkspace(disabledIds, folder.uri, folder.name).length > 0);
  if (blocked) {
    throw new Error("Background and Supervisor agents cannot honor selectively disabled project integrations. Use the main chat instead.");
  }
}
