/**
 * Minimal vscode mock for gitWorkflow integration tests.
 * Mutate `workspace.isTrusted` / `configuration` between cases.
 */

const configuration = {
  cursorSubscription: {
    defaultBaseBranch: "main",
  },
};

export const workspace = {
  isTrusted: true,
  getConfiguration(section) {
    const sectionValues = configuration[section] ?? {};
    return {
      get(key, defaultValue) {
        return Object.prototype.hasOwnProperty.call(sectionValues, key)
          ? sectionValues[key]
          : defaultValue;
      },
    };
  },
};

/** Reset mutable mock state between tests. */
export function resetGitWorkflowVscodeMock(options = {}) {
  workspace.isTrusted = options.isTrusted ?? true;
  configuration.cursorSubscription = {
    defaultBaseBranch: options.defaultBaseBranch ?? "main",
  };
}
