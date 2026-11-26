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

/** Catalog item IDs (excluding the toggled item) that share each legacy ID. */
export type IntegrationToggleSiblings =
  | ReadonlyMap<string, readonly string[]>
  | Readonly<Record<string, readonly string[]>>;

function siblingsFor(
  legacyId: string,
  siblingsSharingLegacy: IntegrationToggleSiblings,
): readonly string[] {
  if (siblingsSharingLegacy instanceof Map) {
    return siblingsSharingLegacy.get(legacyId) ?? [];
  }
  return (siblingsSharingLegacy as Readonly<Record<string, readonly string[]>>)[legacyId] ?? [];
}

/**
 * Builds a legacyId → sibling stable-id map from the current catalog.
 * Only legacy IDs belonging to `item` are included; `item.id` is excluded.
 */
export function siblingsSharingLegacyIds(
  items: readonly { id: string; legacyIds?: readonly string[] }[],
  item: { id: string; legacyIds?: readonly string[] } | undefined,
): Record<string, string[]> {
  const legacyIds = item?.legacyIds ?? [];
  const result: Record<string, string[]> = {};
  for (const legacyId of legacyIds) {
    result[legacyId] = items
      .filter((candidate) => (
        candidate.id !== item!.id
        && candidate.legacyIds?.includes(legacyId)
      ))
      .map((candidate) => candidate.id);
  }
  return result;
}

export function isIntegrationEnabled(
  state: IntegrationToggleState | undefined,
  id: string,
  legacyIds: readonly string[] = [],
): boolean {
  const disabled = state?.disabledIds ?? [];
  return !disabled.includes(id) && !legacyIds.some((legacyId) => disabled.includes(legacyId));
}

/** Match current URI-scoped IDs and older persisted folder-name IDs. */
export function disabledIntegrationIdsForWorkspace(
  disabledIds: Iterable<string>,
  folderUri: string,
  folderName: string,
): string[] {
  const uriScope = encodeURIComponent(folderUri);
  return [...disabledIds].filter((id) => {
    const scope = id.split(":")[1];
    return scope === uriScope || scope === folderName;
  }).sort();
}

export function isWorkspaceIntegrationEnabled(
  disabledIds: ReadonlySet<string>,
  kind: string,
  folderUri: string,
  absolutePath: string,
  folderName: string,
  legacySuffix: string,
): boolean {
  return !disabledIds.has(integrationToggleId(kind, folderUri, absolutePath))
    && !disabledIds.has(legacyIntegrationToggleId(kind, folderName, legacySuffix));
}

export function toggleIntegration(
  state: IntegrationToggleState | undefined,
  id: string,
  enabled: boolean,
  legacyIds: readonly string[] = [],
  siblingsSharingLegacy: IntegrationToggleSiblings = {},
): IntegrationToggleState {
  const disabled = new Set(state?.disabledIds ?? []);
  if (enabled) {
    disabled.delete(id);
    for (const legacyId of legacyIds) {
      const siblings = siblingsFor(legacyId, siblingsSharingLegacy);
      if (siblings.length === 0) {
        disabled.delete(legacyId);
      } else {
        // Migrate siblings onto stable disabled IDs before dropping the shared
        // legacy entry; otherwise clearing legacy would re-enable them.
        for (const siblingId of siblings) {
          disabled.add(siblingId);
        }
        disabled.delete(legacyId);
      }
    }
  } else {
    disabled.add(id);
    // Prefer the stable ID. Drop a legacy entry only when no catalog sibling
    // still shares it; otherwise keep the shared legacy so siblings remain
    // disabled without an accidental enable.
    for (const legacyId of legacyIds) {
      const siblings = siblingsFor(legacyId, siblingsSharingLegacy);
      if (siblings.length === 0) {
        disabled.delete(legacyId);
      }
    }
  }
  return { disabledIds: [...disabled].sort() };
}
