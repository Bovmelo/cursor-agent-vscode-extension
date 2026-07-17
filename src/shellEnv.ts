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
