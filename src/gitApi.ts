import * as vscode from "vscode";

interface GitInputBox {
  value: string;
}

interface GitCommit {
  message: string;
}

interface GitRepositoryState {
  indexChanges: readonly unknown[];
  workingTreeChanges: readonly unknown[];
}

interface GitRepositoryUIState {
  selected: boolean;
}

export interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly inputBox: GitInputBox;
  readonly state: GitRepositoryState;
  readonly ui: GitRepositoryUIState;
  diff(cached?: boolean): Promise<string>;
  log(options?: { maxEntries?: number }): Promise<GitCommit[]>;
}

interface GitAPI {
  readonly repositories: GitRepository[];
  getRepository(uri: vscode.Uri): GitRepository | null;
}

interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitAPI;
}

const MAX_DIFF_CHARS = 100_000;

export async function getGitApi(): Promise<GitAPI | undefined> {
  const extension = vscode.extensions.getExtension<GitExtension>("vscode.git");
  if (!extension) {
    return undefined;
  }

  const gitExtension = extension.isActive ? extension.exports : await extension.activate();
  if (!gitExtension.enabled) {
    return undefined;
  }

  return gitExtension.getAPI(1);
}

export function resolveRepository(
  api: GitAPI,
  rootUri?: vscode.Uri,
): GitRepository | undefined {
  if (rootUri) {
    const byUri = api.getRepository(rootUri);
    if (byUri) {
      return byUri;
    }
  }

  return api.repositories.find((repo) => repo.ui.selected) ?? api.repositories[0];
}

export interface CommitContext {
  repository: GitRepository;
  diff: string;
  recentMessages: string[];
  usedStaged: boolean;
}

export async function collectCommitContext(
  repository: GitRepository,
): Promise<CommitContext | undefined> {
  const hasStaged = repository.state.indexChanges.length > 0;
  const hasWorking = repository.state.workingTreeChanges.length > 0;

  if (!hasStaged && !hasWorking) {
    return undefined;
  }

  let usedStaged = hasStaged;
  let diff = "";
  try {
    diff = (await repository.diff(hasStaged)).trim();
    if (!diff && hasWorking && hasStaged) {
      usedStaged = false;
      diff = (await repository.diff(false)).trim();
    } else if (!diff && !hasStaged && hasWorking) {
      usedStaged = false;
      diff = (await repository.diff(false)).trim();
    }
  } catch {
    return undefined;
  }

  if (!diff) {
    return undefined;
  }

  if (diff.length > MAX_DIFF_CHARS) {
    diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n\n[diff truncated]`;
  }

  let recentMessages: string[] = [];
  try {
    const commits = await repository.log({ maxEntries: 8 });
    recentMessages = commits
      .map((commit) => commit.message.trim().split(/\r?\n/, 1)[0] ?? "")
      .filter(Boolean);
  } catch {
    recentMessages = [];
  }

  return { repository, diff, recentMessages, usedStaged };
}
