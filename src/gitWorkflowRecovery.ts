export type PullRequestFailureStage = "push" | "create-pull-request";

/**
 * State intentionally retained after a branch commit succeeded but PR creation
 * did not. `pushStatus` is only a confirmed outcome: a failed push can be
 * ambiguous, so callers must not infer that the remote branch is absent.
 */
export interface PullRequestRecovery {
  branch: string;
  commit: string;
  originalBranch: string;
  failureStage: PullRequestFailureStage;
  pushStatus: "not-attempted" | "unconfirmed" | "confirmed";
}

export type PullRequestRecoveryAction = "checkout" | "retry";

export function pullRequestRecoveryActions(
  _recovery: PullRequestRecovery,
): PullRequestRecoveryAction[] {
  return ["checkout", "retry"];
}

export function pullRequestRecoveryActionLabel(
  action: PullRequestRecoveryAction,
  japanese = false,
): string {
  if (action === "checkout") {
    return japanese
      ? "保持したブランチをチェックアウト"
      : "Checkout preserved branch";
  }
  return japanese ? "PR作成を再試行" : "Retry PR create";
}

export function pullRequestRecoveryMessage(
  recovery: PullRequestRecovery,
  japanese = false,
): string {
  const remoteGuidance = recovery.pushStatus === "confirmed"
    ? japanese
      ? "ブランチは origin に push 済みです。GitHub で PR を作成するか、`gh pr create` を再実行してください。"
      : "The branch was pushed to origin. Create the PR in GitHub or retry `gh pr create`."
    : japanese
      ? "push の結果を確認してから、`git push -u origin HEAD` と `gh pr create` を再実行してください。"
      : "Check whether the push reached the remote, then retry `git push -u origin HEAD` and `gh pr create`.";
  return japanese
    ? `PR の作成に失敗しましたが、コミットは保持されています。ブランチ: ${recovery.branch}、コミット: ${recovery.commit}。${remoteGuidance}`
    : `Pull-request creation failed, but the commit was preserved on ${recovery.branch} (${recovery.commit}). ${remoteGuidance}`;
}
