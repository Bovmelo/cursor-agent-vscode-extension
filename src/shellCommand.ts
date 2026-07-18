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

export interface ExecFileInvocation extends ParsedCommand {
  windowsVerbatimArguments?: boolean;
}

export interface RunExecutableCommandOptions {
  cwd: string;
  timeout?: number;
  maxBuffer: number;
  env?: NodeJS.ProcessEnv;
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

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META, "^$1");
}

/**
 * Quote one arbitrary argv token for `cmd.exe /d /s /c`.
 *
 * This follows the quoting strategy used by mature spawn wrappers and keeps
 * PR titles/bodies as data rather than cmd.exe syntax while preserving Windows
 * argv escaping for any executable launched by the shim.
 */
export function quoteForCmd(argument: string): string {
  let escaped = argument
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\*)$/, "$1$1");
  escaped = `"${escaped}"`.replace(CMD_META, "^$1");
  return escaped;
}

/**
 * Node 20+ rejects direct spawn of `.cmd`/`.bat` on Windows (`spawn EINVAL`)
 * unless a shell is used. Route those through `cmd.exe /d /s /c` instead of
 * `shell: true`, so argv stays explicit after parseCommandLine validation.
 */
function windowsCmdExe(): string {
  if (process.env.ComSpec) {
    return process.env.ComSpec;
  }
  if (process.env.SystemRoot) {
    return path.join(process.env.SystemRoot, "System32", "cmd.exe");
  }
  return "cmd.exe";
}

export function toExecFileInvocation(
  parsed: ParsedCommand,
  platform: NodeJS.Platform = process.platform,
): ExecFileInvocation {
  if (platform !== "win32") {
    return parsed;
  }
  const base = path.basename(parsed.file);
  const isBatch = /\.(cmd|bat)$/i.test(parsed.file);
  const isKnownShim = /^(npm|npx|pnpm|yarn|corepack|gh)(\.cmd)?$/i.test(base);
  if (!isBatch && !isKnownShim) {
    return parsed;
  }
  if (/\r|\n/.test(parsed.file) || parsed.args.some((argument) => /\r|\n/.test(argument))) {
    throw new Error("Windows batch commands do not support line breaks in arguments.");
  }
  const commandLine = `"${[
    escapeCmdCommand(parsed.file),
    ...parsed.args.map((argument) => quoteForCmd(argument)),
  ].join(" ")}"`;
  return {
    file: windowsCmdExe(),
    args: ["/d", "/s", "/v:off", "/c", commandLine],
    windowsVerbatimArguments: true,
  };
}

/** Run a program while supporting `.cmd` shims on Windows without `shell: true`. */
export async function runExecutableCommand(
  file: string,
  args: string[],
  options: RunExecutableCommandOptions,
): Promise<{ stdout: string; stderr: string }> {
  const invocation = toExecFileInvocation({ file, args });
  return execFileAsync(invocation.file, invocation.args, {
    cwd: options.cwd,
    windowsHide: true,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
    env: options.env ?? minimalShellEnv(),
    encoding: "utf8",
  });
}

export async function runConfiguredCommand(
  command: string,
  options: {
    cwd: string;
    timeout: number;
    maxBuffer: number;
  },
): Promise<{ stdout: string; stderr: string }> {
  const parsed = parseCommandLine(command);
  return runExecutableCommand(parsed.file, parsed.args, {
    cwd: options.cwd,
    timeout: options.timeout,
    maxBuffer: options.maxBuffer,
  });
}
