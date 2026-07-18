export interface IntegrationToggleState {
  disabledIds: string[];
}

export const INTEGRATION_TOGGLE_KEY = "cursorSubscription.integrationToggles";

/**
 * Produces a location-scoped ID for persisted integration toggles. Folder display
 * names are not unique in a multi-root workspace, so both the workspace-folder
 * URI and the discovered file's absolute fsPath are encoded into the ID.
 */
export function integrationToggleId(
  kind: string,
  folderUri: string,
  absolutePath: string,
): string {
  return `${kind}:${encodeURIComponent(folderUri)}:${encodeURIComponent(absolutePath)}`;
}

/** The pre-multi-root ID format, retained to honor existing disabled toggles. */
export function legacyIntegrationToggleId(
  kind: string,
  folderName: string,
  suffix: string,
): string {
  return `${kind}:${folderName}:${suffix}`;
}

export function isIntegrationEnabled(
  state: IntegrationToggleState | undefined,
  id: string,
  legacyIds: readonly string[] = [],
): boolean {
  const disabled = state?.disabledIds ?? [];
  return !disabled.includes(id) && !legacyIds.some((legacyId) => disabled.includes(legacyId));
}

export function toggleIntegration(
  state: IntegrationToggleState | undefined,
  id: string,
  enabled: boolean,
  legacyIds: readonly string[] = [],
): IntegrationToggleState {
  const disabled = new Set(state?.disabledIds ?? []);
  if (enabled) {
    disabled.delete(id);
    for (const legacyId of legacyIds) {
      disabled.delete(legacyId);
    }
  } else {
    disabled.add(id);
    // Replace legacy state with the stable ID once the user changes this item.
    for (const legacyId of legacyIds) {
      disabled.delete(legacyId);
    }
  }
  return { disabledIds: [...disabled].sort() };
}
