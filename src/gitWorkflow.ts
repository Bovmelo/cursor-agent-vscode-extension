import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { branchStartsAtBase, slugifyBranchTitle } from "./pureUtils.js";
import { githubCliEnv } from "./shellEnv.js";
import { runExecutableCommand } from "./shellCommand.js";
import {
  pullRequestRecoveryMessage,
  type PullRequestRecovery,
} from "./gitWorkflowRecovery.js";

async function run(
  cwd: string,
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return runExecutableCommand(command, args, {
    cwd,
    maxBuffer: 4 * 1024 * 1024,
    env: command === "gh" ? githubCliEnv() : undefined,
  });
}

export { slugifyBranchTitle };
export {
  pullRequestRecoveryActionLabel,
  pullRequestRecoveryActions,
  pullRequestRecoveryMessage,
  type PullRequestFailureStage,
  type PullRequestRecovery,
  type PullRequestRecoveryAction,
} from "./gitWorkflowRecovery.js";

/** A recoverable post-commit failure; callers can show the retained branch details. */
export class PullRequestCreationError extends Error {
  public readonly recovery: PullRequestRecovery;
  public readonly originalError: unknown;

  public constructor(
    recovery: PullRequestRecovery,
    cause: unknown,
    japanese = false,
  ) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`${causeMessage}\n\n${pullRequestRecoveryMessage(recovery, japanese)}`);
    this.name = "PullRequestCreationError";
    this.recovery = recovery;
    this.originalError = cause;
  }
}

export async function createBranchCommitAndPullRequest(options: {
  root: string;
  title: string;
  body?: string;
  baseBranch?: string;
  files?: string[];
  japanese?: boolean;
}): Promise<{ branch: string; url?: string }> {
  const { root, title, japanese = false } = options;
  if (!vscode.workspace.isTrusted) {
    throw new Error(
      japanese
        ? "プルリクエストを作成するには、信頼済みワークスペースが必要です。"
        : "Creating a pull request requires a trusted workspace.",
    );
  }
  const baseBranch = options.baseBranch?.trim()
    || vscode.workspace.getConfiguration("cursorSubscription").get<string>("defaultBaseBranch", "main")
    || "main";
  if (baseBranch.startsWith("-")) {
    throw new Error("The pull-request base branch is invalid.");
  }
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const branch = `cursor/${stamp}-${slugifyBranchTitle(title)}-${randomUUID().slice(0, 6)}`;

  const originalBranch = (await run(root, "git", ["rev-parse", "--abbrev-ref", "HEAD"]))
    .stdout.trim();
  if (!originalBranch || originalBranch === "HEAD") {
    throw new Error(
      japanese
        ? "PRを作成する前に、名前付きのGitブランチへ切り替えてください。"
        : "Switch to a named Git branch before creating a pull request.",
    );
  }
  const originalHead = (await run(root, "git", ["rev-parse", "HEAD"])).stdout.trim();
  const baseHead = (await run(root, "git", [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${baseBranch}^{commit}`,
  ])).stdout.trim();
  if (!branchStartsAtBase(originalHead, baseHead)) {
    throw new Error(
      japanese
        ? `現在のHEADは基点ブランチ ${baseBranch} と一致しません。基点ブランチへ切り替えて更新してから再実行してください。`
        : `The current HEAD does not match base branch ${baseBranch}. Switch to and update the base branch, then try again.`,
    );
  }

  const statusArgs = ["status", "--porcelain", "--untracked-files=all"];
  if (options.files?.length) {
    statusArgs.push("--", ...options.files);
  }
  const pending = await run(root, "git", statusArgs);
  if (!pending.stdout.trim()) {
    throw new Error(
      japanese ? "コミットする変更がありません。" : "There are no changes to commit.",
    );
  }
  if (options.files?.length) {
    const alreadyStaged = await run(root, "git", ["diff", "--cached", "--name-only"]);
    if (alreadyStaged.stdout.trim()) {
      throw new Error(
        japanese
          ? "対象外の変更を誤って含めないよう、既にステージ済みの変更を解除してから再実行してください。"
          : "Unstage existing changes before creating the pull request so unrelated files cannot be included.",
      );
    }
  }
  const originalIndexTree = (await run(root, "git", ["write-tree"])).stdout.trim();
  let commitCreated = false;
  let commit = "";
  let pushStatus: PullRequestRecovery["pushStatus"] = "not-attempted";
  let failureStage: PullRequestRecovery["failureStage"] = "push";

  try {
    await run(root, "git", ["checkout", "-b", branch, baseBranch]);
    if (options.files && options.files.length > 0) {
      await run(root, "git", ["add", "--", ...options.files]);
    } else {
      await run(root, "git", ["add", "-A"]);
    }
    const staged = await run(root, "git", ["diff", "--cached", "--name-only"]);
    if (!staged.stdout.trim()) {
      throw new Error(
        japanese ? "コミットする変更がありません。" : "There are no changes to commit.",
      );
    }
    await run(root, "git", ["commit", "-m", title.slice(0, 72)]);
    commitCreated = true;
    commit = (await run(root, "git", ["rev-parse", "HEAD"])).stdout.trim();
    pushStatus = "unconfirmed";
    await run(root, "git", ["push", "-u", "origin", "HEAD"]);
    pushStatus = "confirmed";

    failureStage = "create-pull-request";
    const bodyFile = path.join(tmpdir(), `cursor-pr-body-${randomUUID()}.md`);
    await writeFile(bodyFile, options.body?.trim() || title, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    let pr: { stdout: string; stderr: string };
    try {
      pr = await run(root, "gh", [
        "pr",
        "create",
        "--title",
        title.replace(/[\r\n]+/g, " ").slice(0, 120),
        "--body-file",
        bodyFile,
        "--base",
        baseBranch,
        "--head",
        branch,
      ]);
    } finally {
      await rm(bodyFile, { force: true }).catch(() => undefined);
    }
    const url = pr.stdout.trim().split(/\r?\n/).find((line) => /^https?:\/\//.test(line));
    return { branch, url };
  } catch (error) {
    const currentHead = await run(root, "git", ["rev-parse", "HEAD"])
      .then((result) => result.stdout.trim(), () => "");
    if (!commitCreated && currentHead === originalHead) {
      await run(root, "git", ["read-tree", originalIndexTree]).catch(() => undefined);
      await run(root, "git", ["checkout", originalBranch]).catch(() => undefined);
      await run(root, "git", ["branch", "-D", branch]).catch(() => undefined);
    }
    const preservedCommit = commit || currentHead;
    if (commitCreated && preservedCommit) {
      throw new PullRequestCreationError({
        branch,
        commit: preservedCommit,
        originalBranch,
        failureStage,
        pushStatus,
      }, error, japanese);
    }
    throw error;
  }
}

/** Check out the branch that still holds the preserved post-commit work. */
export async function checkoutPreservedPullRequestBranch(
  root: string,
  recovery: PullRequestRecovery,
  japanese = false,
): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    throw new Error(
      japanese
        ? "保持したブランチをチェックアウトするには、信頼済みワークスペースが必要です。"
        : "Checking out the preserved branch requires a trusted workspace.",
    );
  }
  if (recovery.branch.startsWith("-")) {
    throw new Error(
      japanese ? "保持ブランチ名が無効です。" : "The preserved branch name is invalid.",
    );
  }
  await run(root, "git", [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${recovery.commit}^{commit}`,
  ]);
  await run(root, "git", ["checkout", recovery.branch]);
  const head = (await run(root, "git", ["rev-parse", "HEAD"])).stdout.trim();
  if (head !== recovery.commit) {
    throw new Error(
      japanese
        ? `ブランチ ${recovery.branch} の HEAD (${head}) が保持コミット ${recovery.commit} と一致しません。`
        : `Branch ${recovery.branch} HEAD (${head}) does not match preserved commit ${recovery.commit}.`,
    );
  }
}

/**
 * Retry push (when needed) and `gh pr create` for a branch that already has a
 * preserved commit. Never rewrites or discards that commit.
 */
export async function retryPullRequestCreation(options: {
  root: string;
  title: string;
  body?: string;
  recovery: PullRequestRecovery;
  japanese?: boolean;
}): Promise<{ branch: string; url?: string }> {
  const { root, title, recovery, japanese = false } = options;
  if (!vscode.workspace.isTrusted) {
    throw new Error(
      japanese
        ? "プルリクエストを作成するには、信頼済みワークスペースが必要です。"
        : "Creating a pull request requires a trusted workspace.",
    );
  }
  const baseBranch = vscode.workspace.getConfiguration("cursorSubscription")
    .get<string>("defaultBaseBranch", "main")
    || "main";
  if (baseBranch.startsWith("-")) {
    throw new Error("The pull-request base branch is invalid.");
  }

  let pushStatus = recovery.pushStatus;
  let failureStage: PullRequestRecovery["failureStage"] = "push";

  try {
    await checkoutPreservedPullRequestBranch(root, recovery, japanese);

    if (pushStatus !== "confirmed") {
      pushStatus = "unconfirmed";
      await run(root, "git", ["push", "-u", "origin", "HEAD"]);
      pushStatus = "confirmed";
    }

    failureStage = "create-pull-request";
    const bodyFile = path.join(tmpdir(), `cursor-pr-body-${randomUUID()}.md`);
    await writeFile(bodyFile, options.body?.trim() || title, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    let pr: { stdout: string; stderr: string };
    try {
      pr = await run(root, "gh", [
        "pr",
        "create",
        "--title",
        title.replace(/[\r\n]+/g, " ").slice(0, 120),
        "--body-file",
        bodyFile,
        "--base",
        baseBranch,
        "--head",
        recovery.branch,
      ]);
    } finally {
      await rm(bodyFile, { force: true }).catch(() => undefined);
    }
    const url = pr.stdout.trim().split(/\r?\n/).find((line) => /^https?:\/\//.test(line));
    return { branch: recovery.branch, url };
  } catch (error) {
    if (error instanceof PullRequestCreationError) {
      throw error;
    }
    throw new PullRequestCreationError({
      ...recovery,
      failureStage,
      pushStatus,
    }, error, japanese);
  }
}
