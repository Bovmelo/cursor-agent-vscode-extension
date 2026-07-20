export interface SetupChecklistStepState {
  readonly complete: boolean;
  readonly hasWorkspace?: boolean;
  readonly gitReady?: boolean;
  readonly mode?: string;
  readonly available?: boolean;
  readonly optional?: boolean;
}

export interface SetupChecklistState {
  readonly visible: boolean;
  readonly dismissed: boolean;
  readonly sandboxSupported: boolean;
  readonly approvalMode: string;
  readonly steps: {
    readonly apiKey: SetupChecklistStepState;
    readonly workspaceTrust: SetupChecklistStepState;
    readonly gitWorkspace: SetupChecklistStepState;
    readonly permissions: SetupChecklistStepState;
    readonly gh: SetupChecklistStepState;
  };
}

export interface SetupChecklistStateInput {
  readonly dismissed: boolean;
  readonly apiKeyConfigured: boolean;
  readonly workspaceTrusted: boolean;
  readonly hasWorkspace: boolean;
  readonly gitReady: boolean;
  readonly permissionsConfirmed: boolean;
  readonly approvalMode: string;
  readonly ghSkipped: boolean;
  readonly ghAvailable: boolean;
  readonly sandboxSupported: boolean;
}

/** Build the setup checklist payload from already-probed host facts. */
export function buildSetupChecklistState(input: SetupChecklistStateInput): SetupChecklistState {
  const ghDone = input.ghAvailable || input.ghSkipped;
  return {
    // Keep the reconnect path visible until the only universally required
    // step is complete. Git, trust, permissions, and gh remain contextual.
    visible: !input.dismissed || !input.apiKeyConfigured,
    dismissed: input.dismissed,
    sandboxSupported: input.sandboxSupported,
    approvalMode: input.approvalMode,
    steps: {
      apiKey: { complete: input.apiKeyConfigured },
      workspaceTrust: { complete: input.workspaceTrusted },
      gitWorkspace: {
        complete: input.hasWorkspace && input.gitReady,
        hasWorkspace: input.hasWorkspace,
        gitReady: input.gitReady,
      },
      permissions: { complete: input.permissionsConfirmed, mode: input.approvalMode },
      gh: { complete: ghDone, available: input.ghAvailable, optional: true },
    },
  };
}
