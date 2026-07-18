import * as vscode from "vscode";
import { runConfiguredCommand } from "./shellCommand.js";

const MAX_HOOK_COMMANDS = 20;
const MAX_HOOK_COMMAND_LENGTH = 4_000;
const MAX_HOOK_TOTAL_MS = 10 * 60_000;

export type HookPhase = "preEdit" | "postEdit";

export async function runConfiguredHooks(
  phase: HookPhase,
  root: string,
  output: vscode.OutputChannel,
): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    output.appendLine(
      `[${new Date().toISOString()}] Skipping ${phase} hooks in an untrusted workspace.`,
    );
    return;
  }
  const key = phase === "preEdit" ? "preEditCommands" : "postEditCommands";
  const commands = vscode.workspace
    .getConfiguration("cursorSubscription", vscode.Uri.file(root))
    .get<string[]>(key, []);
  if (!Array.isArray(commands) || commands.length === 0) {
    return;
  }
  const startedAt = Date.now();
  let ran = 0;
  for (const command of commands) {
    if (typeof command !== "string") {
      continue;
    }
    const trimmed = command.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.length > MAX_HOOK_COMMAND_LENGTH) {
      throw new Error(`${phase} hook rejected: command exceeds ${MAX_HOOK_COMMAND_LENGTH} characters`);
    }
    if (ran >= MAX_HOOK_COMMANDS) {
      throw new Error(`${phase} hook rejected: more than ${MAX_HOOK_COMMANDS} commands`);
    }
    if (Date.now() - startedAt > MAX_HOOK_TOTAL_MS) {
      throw new Error(`${phase} hook rejected: total time budget exceeded`);
    }
    if (!vscode.workspace.isTrusted) {
      output.appendLine(
        `[${new Date().toISOString()}] Stopping remaining ${phase} hooks because the workspace is no longer trusted.`,
      );
      return;
    }
    ran += 1;
    output.appendLine(
      `[${new Date().toISOString()}] Running ${phase} hook: ${trimmed}`,
    );
    try {
      const { stdout, stderr } = await runConfiguredCommand(trimmed, {
        cwd: root,
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      if (stdout.trim()) {
        output.appendLine(stdout.trimEnd());
      }
      if (stderr.trim()) {
        output.appendLine(stderr.trimEnd());
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(
        `[${new Date().toISOString()}] ${phase} hook failed: ${message}`,
      );
      throw new Error(`${phase} hook failed: ${trimmed}\n${message}`);
    }
  }
}
