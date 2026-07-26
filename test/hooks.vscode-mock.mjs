const configuration = {
  preEditCommands: [],
  postEditCommands: [],
};

export class Uri {
  constructor(fsPath) {
    this.fsPath = fsPath;
  }

  static file(fsPath) {
    return new Uri(fsPath);
  }
}

export const workspace = {
  isTrusted: true,
  getConfiguration() {
    return {
      get(key, defaultValue) {
        return Object.prototype.hasOwnProperty.call(configuration, key)
          ? configuration[key]
          : defaultValue;
      },
    };
  },
};

export function resetHooksVscodeMock(options = {}) {
  workspace.isTrusted = options.isTrusted ?? true;
  configuration.preEditCommands = options.preEditCommands ?? [];
  configuration.postEditCommands = options.postEditCommands ?? [];
}
