import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { slugifyBranchTitle } from "./pureUtils.js";
import { minimalShellEnv } from "./shellEnv.js";

const execFileAsync = promisify(execFileCallback);

async function run(
  cwd: string,
  command: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
    env: minimalShellEnv(),
  });
}

export { slugifyBranchTitle };

export async function createBranchCommitAndPullRequest(options: {
  root: string;
  title: string;
  body?: string;
  baseBranch?: string;
  files?: string[];
  japanese?: boolean;
}): Promise<{ branch: string; url?: string }> {
  const { root, title, japanese = false } = options;
  const baseBranch = options.baseBranch?.trim()
    || vscode.workspace.getConfiguration("cursorSubscription").get<string>("defaultBaseBranch", "main")
    || "main";
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const branch = `cursor/${stamp}-${slugifyBranchTitle(title)}`;

  await run(root, "git", ["checkout", "-b", branch]);
  if (options.files && options.files.length > 0) {
    await run(root, "git", ["add", "--", ...options.files]);
  } else {
    await run(root, "git", ["add", "-A"]);
  }
  const status = await run(root, "git", ["status", "--porcelain"]);
  if (!status.stdout.trim()) {
    throw new Error(
      japanese
        ? "コミットする変更がありません。"
        : "There are no changes to commit.",
    );
  }
  await run(root, "git", ["commit", "-m", title.slice(0, 72)]);
  await run(root, "git", ["push", "-u", "origin", "HEAD"]);

  const prArgs = [
    "pr",
    "create",
    "--title",
    title.slice(0, 120),
    "--body",
    options.body?.trim() || title,
    "--base",
    baseBranch,
  ];
  const pr = await run(root, "gh", prArgs);
  const url = pr.stdout.trim().split(/\r?\n/).find((line) => /^https?:\/\//.test(line));
  return { branch, url };
}
