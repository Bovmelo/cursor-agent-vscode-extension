import * as vscode from "vscode";
import {
  DEFAULT_SENSITIVE_GLOBS,
  matcherFromGlobs,
} from "./sensitivePathMatch.js";

export {
  DEFAULT_SENSITIVE_GLOBS,
  createSecretContentMatcher,
  globRegex,
} from "./sensitivePathMatch.js";

export function excludedApplyGlobs(uri?: vscode.Uri): string[] {
  const configured = vscode.workspace
    .getConfiguration("cursorSubscription", uri)
    .get<string[]>("supervisorExcludedGlobs", DEFAULT_SENSITIVE_GLOBS);
  if (!Array.isArray(configured) || configured.length === 0) {
    return [...DEFAULT_SENSITIVE_GLOBS];
  }
  return configured.filter((pattern) => typeof pattern === "string" && pattern.trim().length > 0);
}

export function createExcludedPathMatcher(uri?: vscode.Uri): (relative: string) => boolean {
  return matcherFromGlobs(excludedApplyGlobs(uri));
}
