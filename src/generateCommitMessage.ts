import {
  Agent,
  CursorAgentError,
  type ModelParameterValue,
  type ModelSelection,
} from "@cursor/sdk";
import * as vscode from "vscode";
import { collectCommitContext, getGitApi, resolveRepository } from "./gitApi.js";
import { detectBlockedProxyEnvironment } from "./networkEnvironment.js";

const API_KEY_SECRET = "cursorSubscription.apiKey";
const MODEL_KEY = "cursorSubscription.model";
const MODEL_PARAMS_KEY = "cursorSubscription.modelParams";
const DEFAULT_MODEL = "auto";
const IS_JAPANESE = vscode.env.language.toLowerCase().startsWith("ja");

function localize(english: string, japanese: string): string {
  return IS_JAPANESE ? japanese : english;
}

function selectedModelSelection(context: vscode.ExtensionContext): ModelSelection {
  const id = context.globalState.get<string>(MODEL_KEY, DEFAULT_MODEL);
  const allParams = context.globalState.get<Record<string, ModelParameterValue[]>>(
    MODEL_PARAMS_KEY,
    {},
  );
  const params = allParams[id];
  return { id, params: params?.length ? params : undefined };
}

function buildPrompt(diff: string, recentMessages: string[], usedStaged: boolean): string {
  const scope = usedStaged
    ? "staged changes (index)"
    : "unstaged working tree changes";
  const recent =
    recentMessages.length > 0
      ? recentMessages.map((message) => `- ${message}`).join("\n")
      : "(no recent commits)";

  return [
    "Generate a git commit message for the following repository changes.",
    "",
    "Rules:",
    "- Reply with ONLY the commit message text. No quotes, no markdown fences, no commentary.",
    "- Focus on why the change was made, not a file-by-file list of what changed.",
    "- Keep the subject line concise (about 72 characters or less when practical).",
    "- Use 1–2 short sentences total. Add a blank line and a brief body only if needed.",
    "- Match the style and language of the recent commit messages below (including conventional commits if that is the repo style).",
    "- Do not edit files, run tools, or stage/commit anything. The diff is already provided.",
    "",
    `Change scope: ${scope}`,
    "",
    "Recent commit messages:",
    recent,
    "",
    "Diff:",
    "```",
    diff,
    "```",
  ].join("\n");
}

function cleanCommitMessage(raw: string): string {
  let text = raw.trim();
  if (!text) {
    return "";
  }

  const fenced = text.match(/^```(?:\w+)?\r?\n([\s\S]*?)\r?\n```$/);
  if (fenced) {
    text = fenced[1].trim();
  }

  const prefixes = [
    /^here(?:'s| is) (?:a |the )?commit message[:\s-]*/i,
    /^commit message[:\s-]*/i,
  ];
  for (const prefix of prefixes) {
    text = text.replace(prefix, "").trim();
  }

  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }

  return text;
}

export async function generateCommitMessage(
  context: vscode.ExtensionContext,
  rootUri: vscode.Uri | undefined,
  promptForApiKey: () => Promise<void>,
  output: vscode.OutputChannel,
  startRunningSound: () => vscode.Disposable,
  playCompletionSound: () => void,
): Promise<void> {
  let apiKey = await context.secrets.get(API_KEY_SECRET);
  if (!apiKey) {
    await promptForApiKey();
    apiKey = await context.secrets.get(API_KEY_SECRET);
    if (!apiKey) {
      return;
    }
  }

  const git = await getGitApi();
  if (!git) {
    void vscode.window.showErrorMessage(
      localize("Git extension is unavailable.", "Git拡張機能を利用できません。"),
    );
    return;
  }

  const repository = resolveRepository(git, rootUri);
  if (!repository) {
    void vscode.window.showInformationMessage(
      localize("No Git repository is open.", "開いているGitリポジトリがありません。"),
    );
    return;
  }

  const commitContext = await collectCommitContext(repository);
  if (!commitContext) {
    void vscode.window.showInformationMessage(
      localize(
        "No changes to commit. Stage or modify files first.",
        "コミットする変更がありません。先にファイルをステージするか編集してください。",
      ),
    );
    return;
  }

  const prompt = buildPrompt(
    commitContext.diff,
    commitContext.recentMessages,
    commitContext.usedStaged,
  );

  try {
    const blockedProxy = detectBlockedProxyEnvironment();
    if (blockedProxy) {
      const message = localize(
        `Cursor network access is blocked because ${blockedProxy.variable} points to ${blockedProxy.address}. Fully quit VS Code and reopen it outside the restricted or sandboxed launcher.`,
        `${blockedProxy.variable} が ${blockedProxy.address} を参照しているため、Cursorへのネットワーク接続が遮断されています。VS Codeをすべて終了し、制限環境やサンドボックス経由ではなく通常の方法で起動し直してください。`,
      );
      output.appendLine(
        `[${new Date().toISOString()}] Commit message generation blocked: ${blockedProxy.variable}=${blockedProxy.address}`,
      );
      throw new Error(message);
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: localize("Generating commit message…", "コミットメッセージを生成中…"),
        cancellable: false,
      },
      async () => {
        const runningSound = startRunningSound();
        let completed = false;
        try {
          const result = await Agent.prompt(prompt, {
            apiKey,
            model: selectedModelSelection(context),
            name: "VS Code: Generate Commit Message",
            mode: "plan",
            local: {
              cwd: repository.rootUri.fsPath,
              // Inline config only; avoid loading ambient project settings for this one-shot.
              settingSources: [],
            },
          });

          if (result.status === "error") {
            throw new Error(
              result.error?.message ??
                localize("Commit message generation failed.", "コミットメッセージの生成に失敗しました。"),
            );
          }

          if (result.status === "cancelled") {
            return;
          }

          const message = cleanCommitMessage(result.result ?? "");
          if (!message) {
            throw new Error(
              localize(
                "The model returned an empty commit message.",
                "モデルが空のコミットメッセージを返しました。",
              ),
            );
          }

          repository.inputBox.value = message;
          completed = true;
        } finally {
          runningSound.dispose();
          if (completed) {
            playCompletionSound();
          }
        }
      },
    );
  } catch (error) {
    output.appendLine(
      `[${new Date().toISOString()}] Commit message generation error: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    if (error instanceof CursorAgentError) {
      void vscode.window.showErrorMessage(
        localize(
          `Could not start commit message generation: ${error.message}`,
          `コミットメッセージ生成を開始できませんでした: ${error.message}`,
        ),
      );
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(
      localize(
        `Commit message generation failed: ${message}`,
        `コミットメッセージの生成に失敗しました: ${message}`,
      ),
    );
  }
}

export function resolveRootUri(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) {
    return arg;
  }

  if (
    arg &&
    typeof arg === "object" &&
    "rootUri" in arg &&
    (arg as { rootUri: unknown }).rootUri instanceof vscode.Uri
  ) {
    return (arg as { rootUri: vscode.Uri }).rootUri;
  }

  return undefined;
}
