export interface IntegrationToggleState {
  disabledIds: string[];
}

export const INTEGRATION_TOGGLE_KEY = "cursorSubscription.integrationToggles";

export function isIntegrationEnabled(
  state: IntegrationToggleState | undefined,
  id: string,
): boolean {
  return !(state?.disabledIds ?? []).includes(id);
}

export function toggleIntegration(
  state: IntegrationToggleState | undefined,
  id: string,
  enabled: boolean,
): IntegrationToggleState {
  const disabled = new Set(state?.disabledIds ?? []);
  if (enabled) {
    disabled.delete(id);
  } else {
    disabled.add(id);
  }
  return { disabledIds: [...disabled].sort() };
}
