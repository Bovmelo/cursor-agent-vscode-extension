import { createHash } from "node:crypto";
import { githubCliEnv } from "./shellEnv.js";
import { runExecutableCommand } from "./shellCommand.js";

export interface GitHubSupervisorSignal {
  source: "ci" | "pr-comment";
  title: string;
  detail: string;
  fingerprint: string;
  priority: "high" | "normal";
}

interface GitHubAuthor {
  login?: string;
}

interface GitHubComment {
  id?: string;
  body?: string;
  url?: string;
  author?: GitHubAuthor;
}

interface GitHubReview extends GitHubComment {
  state?: string;
  submittedAt?: string;
}

interface GitHubCheck {
  name?: string;
  workflowName?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  completedAt?: string;
}

interface GitHubPrSnapshot {
  number?: number;
  title?: string;
  url?: string;
  comments?: GitHubComment[];
  reviews?: GitHubReview[];
  statusCheckRollup?: GitHubCheck[];
}

const FAILED_CHECK_STATES = new Set([
  "ACTION_REQUIRED",
  "CANCELLED",
  "ERROR",
  "FAILURE",
  "STARTUP_FAILURE",
  "TIMED_OUT",
]);

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function actionableComment(body: string): boolean {
  return /(?:^|\s)(?:\/cursor\b|\[cursor\]|TODO\(ai\)\s*:)/i.test(body);
}

function compact(value: string, maximum = 2_000): string {
  const normalized = value.replace(/\r\n/g, "\n").trim();
  return normalized.length > maximum ? `${normalized.slice(0, maximum)}\n…` : normalized;
}

export function parseGitHubSupervisorSignals(raw: string): GitHubSupervisorSignal[] {
  const snapshot = JSON.parse(raw) as GitHubPrSnapshot;
  const pr = snapshot.number ? `PR #${snapshot.number}` : "current PR";
  const signals: GitHubSupervisorSignal[] = [];

  for (const check of snapshot.statusCheckRollup ?? []) {
    const state = String(check.conclusion ?? check.state ?? "").toUpperCase();
    if (!FAILED_CHECK_STATES.has(state)) {
      continue;
    }
    const name = check.name || check.workflowName || "GitHub check";
    const detail = [
      `${pr}: ${snapshot.title ?? ""}`.trim(),
      `Check: ${name}`,
      `State: ${state}`,
      check.detailsUrl,
      "Inspect the failing CI logs, fix the smallest coherent cause, and keep related checks green.",
    ].filter(Boolean).join("\n");
    signals.push({
      source: "ci",
      title: `Fix failed CI: ${name}`,
      detail,
      fingerprint: fingerprint(`ci:${snapshot.number}:${name}:${state}:${check.completedAt ?? ""}`),
      priority: "high",
    });
  }

  for (const comment of snapshot.comments ?? []) {
    const body = comment.body?.trim() ?? "";
    if (!body || !actionableComment(body)) {
      continue;
    }
    signals.push({
      source: "pr-comment",
      title: `Address PR comment from @${comment.author?.login ?? "reviewer"}`,
      detail: compact([`${pr}: ${snapshot.title ?? ""}`.trim(), body, comment.url].filter(Boolean).join("\n\n")),
      fingerprint: fingerprint(`comment:${snapshot.number}:${comment.id ?? comment.url ?? body}`),
      priority: "normal",
    });
  }

  for (const review of snapshot.reviews ?? []) {
    const body = review.body?.trim() ?? "";
    const changesRequested = String(review.state ?? "").toUpperCase() === "CHANGES_REQUESTED";
    if (!changesRequested && (!body || !actionableComment(body))) {
      continue;
    }
    signals.push({
      source: "pr-comment",
      title: `Address requested changes from @${review.author?.login ?? "reviewer"}`,
      detail: compact([
        `${pr}: ${snapshot.title ?? ""}`.trim(),
        `Review state: ${review.state ?? "COMMENTED"}`,
        body,
        review.url,
      ].filter(Boolean).join("\n\n")),
      fingerprint: fingerprint(
        `review:${snapshot.number}:${review.id ?? review.url ?? review.submittedAt ?? body}`,
      ),
      priority: changesRequested ? "high" : "normal",
    });
  }
  return signals;
}

export async function scanCurrentGitHubPullRequest(root: string): Promise<GitHubSupervisorSignal[]> {
  const { stdout } = await runExecutableCommand(
    "gh",
    [
      "pr",
      "view",
      "--json",
      "number,title,url,comments,reviews,statusCheckRollup",
    ],
    {
      cwd: root,
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      env: githubCliEnv(),
    },
  );
  const snapshot = JSON.parse(stdout) as GitHubPrSnapshot;
  if (snapshot.number) {
    try {
      const { stdout: inlineRaw } = await runExecutableCommand(
        "gh",
        ["api", `repos/{owner}/{repo}/pulls/${snapshot.number}/comments`],
        {
          cwd: root,
          timeout: 30_000,
          maxBuffer: 8 * 1024 * 1024,
          env: githubCliEnv(),
        },
      );
      const inlineComments = JSON.parse(inlineRaw) as Array<{
        id?: number | string;
        body?: string;
        html_url?: string;
        path?: string;
        line?: number;
        user?: { login?: string };
      }>;
      snapshot.comments = [
        ...(snapshot.comments ?? []),
        ...inlineComments.map((comment) => ({
          id: String(comment.id ?? comment.html_url ?? ""),
          body: [
            "[cursor] Inline review comment",
            comment.path
              ? `${comment.path}${comment.line ? `:${comment.line}` : ""}`
              : undefined,
            comment.body,
          ].filter(Boolean).join("\n"),
          url: comment.html_url,
          author: comment.user,
        })),
      ];
    } catch {
      // The review-comments API can be unavailable for forks or limited tokens;
      // PR-level checks, comments, and review bodies are still useful signals.
    }
  }
  return parseGitHubSupervisorSignals(JSON.stringify(snapshot));
}
