/** Paths removed from isolated worktrees so agents cannot read secret bytes. */
export const DEFAULT_SECRET_CONTENT_GLOBS = [
  "**/.env*",
  "**/*secret*",
  "**/*credential*",
  "**/*.pem",
  "**/*.key",
  "**/.netrc",
  "**/_netrc",
  "**/.npmrc",
  "**/.pypirc",
  "**/.gem/credentials",
  "**/.yarnrc",
  "**/.yarnrc.yml",
  "**/.docker/config.json",
  "**/.config/gh/hosts.yml",
  "**/.kube/config",
];

/** Secret-bearing paths plus generated files agents should not modify. */
export const DEFAULT_SENSITIVE_GLOBS = [
  ...DEFAULT_SECRET_CONTENT_GLOBS,
  "**/package-lock.json",
  "**/pnpm-lock.yaml",
  "**/yarn.lock",
];

export function globRegex(pattern: string): RegExp {
  let source = pattern.trim().replaceAll("\\", "/");
  const optionalPrefix = source.startsWith("**/");
  if (optionalPrefix) {
    source = source.slice(3);
  }
  let result = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "*" && source[index + 1] === "*") {
      result += ".*";
      index += 1;
    } else if (character === "*") {
      result += "[^/]*";
    } else if (character === "?") {
      result += "[^/]";
    } else {
      result += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`^${optionalPrefix ? "(?:.*/)?" : ""}${result}$`, "i");
}

export function matcherFromGlobs(globs: readonly string[]): (relative: string) => boolean {
  const patterns = globs.map(globRegex);
  return (relative: string) => {
    const normalized = relative.replaceAll("\\", "/");
    return patterns.some((pattern) => pattern.test(normalized));
  };
}

/**
 * Matcher for secret-bearing content that must not remain readable inside
 * isolated worktrees. Lockfiles stay available for install/tooling.
 */
export function createSecretContentMatcher(): (relative: string) => boolean {
  return matcherFromGlobs(DEFAULT_SECRET_CONTENT_GLOBS);
}
