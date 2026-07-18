/**
 * Minimal environment for config-driven child processes.
 * Avoids forwarding unrelated secrets from the extension host.
 */
export function minimalShellEnv(): NodeJS.ProcessEnv {
  const allow = [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "ComSpec",
    "COMSPEC",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TERM",
    "COLORTERM",
    "NODE_ENV",
    "npm_config_cache",
    "npm_config_prefix",
    "NVM_DIR",
    "FNM_DIR",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allow) {
    const value = process.env[key];
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return env;
}

/** Minimal process environment plus the variables that `gh` uses for auth and host selection. */
export function githubCliEnv(): NodeJS.ProcessEnv {
  const env = minimalShellEnv();
  for (const key of [
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "GH_HOST",
    "GH_CONFIG_DIR",
    "XDG_CONFIG_HOME",
  ]) {
    const value = process.env[key];
    if (typeof value === "string") {
      env[key] = value;
    }
  }
  return env;
}
