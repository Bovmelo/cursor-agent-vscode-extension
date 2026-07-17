import { exec as execCallback } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";

const execAsync = promisify(execCallback);

export type HookPhase = "preEdit" | "postEdit";

export async function runConfiguredHooks(
  phase: HookPhase,
  root: string,
  output: vscode.OutputChannel,
): Promise<void> {
  const key = phase === "preEdit" ? "preEditCommands" : "postEditCommands";
  const commands = vscode.workspace
    .getConfiguration("cursorSubscription")
    .get<string[]>(key, []);
  if (!Array.isArray(commands) || commands.length === 0) {
    return;
  }
  for (const command of commands) {
    const trimmed = command.trim();
    if (!trimmed) {
      continue;
    }
    output.appendLine(
      `[${new Date().toISOString()}] Running ${phase} hook: ${trimmed}`,
    );
    try {
      const { stdout, stderr } = await execAsync(trimmed, {
        cwd: root,
        windowsHide: true,
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
