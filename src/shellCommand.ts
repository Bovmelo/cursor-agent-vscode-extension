import { execFile as execFileCallback } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { minimalShellEnv } from "./shellEnv.js";

const execFileAsync = promisify(execFileCallback);

/** Characters / tokens that imply shell metacharacter interpretation. */
const SHELL_META = /[|;&$`<>(){}!\n\r]|\$\(|`/;

export interface ParsedCommand {
  file: string;
  args: string[];
}

/**
 * Quote-aware tokenization for configured commands.
 * Rejects shell operators so callers can use execFile without `shell: true`.
 */
export function parseCommandLine(command: string): ParsedCommand {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new Error("Command is empty.");
  }
  if (SHELL_META.test(trimmed)) {
    throw new Error(
      "Command contains shell metacharacters. Use a simple program and arguments, or a script file.",
    );
  }

  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index];
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }
  if (quote) {
    throw new Error("Command has an unmatched quote.");
  }
  if (current) {
    tokens.push(current);
  }
  if (tokens.length === 0) {
    throw new Error("Command is empty.");
  }

  const [file, ...args] = tokens;
  return { file: resolveWindowsExecutable(file), args };
}

function resolveWindowsExecutable(file: string): string {
  if (process.platform !== "win32") {
    return file;
  }
  if (path.isAbsolute(file) || /[\\/]/.test(file)) {
    return file;
  }
  if (/\.(exe|cmd|bat|com)$/i.test(file)) {
    return file;
  }
  const base = path.basename(file);
  if (/^(npm|npx|pnpm|yarn|corepack)$/i.test(base)) {
    return `${file}.cmd`;
  }
  return file;
}

/** Quote one argv token for `cmd.exe /d /s /c` without enabling a full shell. */
export function quoteForCmd(argument: string): string {
  if (argument.length === 0) {
    return '""';
  }
  if (!/[\s"]/.test(argument)) {
    return argument;
  }
  return `"${argument.replace(/"/g, '""')}"`;
}

/**
 * Node 20+ rejects direct spawn of `.cmd`/`.bat` on Windows (`spawn EINVAL`)
 * unless a shell is used. Route those through `cmd.exe /d /s /c` instead of
 * `shell: true`, so argv stays explicit after parseCommandLine validation.
 */
export function toExecFileInvocation(parsed: ParsedCommand): ParsedCommand {
  if (process.platform !== "win32" || !/\.(cmd|bat)$/i.test(parsed.file)) {
    return parsed;
  }
  const commandLine = [parsed.file, ...parsed.args].map(quoteForCmd).join(" ");
  return {
    file: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", commandLine],
  };
}

export async function runConfiguredCommand(
  command: string,
  options: {
    cwd: string;
    timeout: number;
    maxBuffer: number;
  },
): Promise<{ stdout: string; stderr: string }> {
  const invocation = toExecFileInvocation(parseCommandLine(command));
  return execFileAsync(invocation.file, invocation.args, {
    cwd: options.cwd,
    windowsHide: true,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    env: minimalShellEnv(),
    encoding: "utf8",
  });
}
