import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";

const VSCODE_VERSION = "1.101.2";
const DEFAULT_TIMEOUT_MS = 120_000;
const CHILD_MARKER = "CURSOR_EXTENSION_E2E_CHILD";
const EXECUTABLE_ENV = "CURSOR_EXTENSION_E2E_EXECUTABLE";
const PROFILE_ENV = "CURSOR_EXTENSION_E2E_PROFILE";

const scriptPath = fileURLToPath(import.meta.url);
const extensionDevelopmentPath = path.resolve(path.dirname(scriptPath), "..");
const extensionTestsPath = path.join(extensionDevelopmentPath, "test", "e2e", "runner.cjs");

function configuredTimeout() {
  const value = Number(process.env.CURSOR_EXTENSION_E2E_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  if (!Number.isSafeInteger(value) || value < 10_000) {
    throw new Error("CURSOR_EXTENSION_E2E_TIMEOUT_MS must be an integer of at least 10000");
  }
  return value;
}

async function runInExtensionHost() {
  const vscodeExecutablePath = process.env[EXECUTABLE_ENV];
  const profileRoot = process.env[PROFILE_ENV];
  if (!vscodeExecutablePath || !profileRoot) {
    throw new Error("The Extension Host child is missing its executable or profile path");
  }

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath,
    extensionTestsPath,
    extensionTestsEnv: {
      CURSOR_SUBSCRIPTION_E2E: "1",
    },
    launchArgs: [
      "--disable-extensions",
      "--disable-workspace-trust",
      "--new-window",
      `--user-data-dir=${path.join(profileRoot, "user-data")}`,
      `--extensions-dir=${path.join(profileRoot, "extensions")}`,
    ],
  });
}

async function waitForExit(child, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal, timedOut: false }));
      }),
      new Promise((resolve) => {
        timeout = setTimeout(
          () => resolve({ code: null, signal: null, timedOut: true }),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function terminateProcessTree(child) {
  if (!child.pid) return;

  if (process.platform === "win32") {
    const taskkill = path.join(process.env.WINDIR ?? "C:\\Windows", "System32", "taskkill.exe");
    await new Promise((resolve) => {
      const killer = spawn(taskkill, ["/F", "/T", "/PID", String(child.pid)], {
        stdio: "inherit",
        windowsHide: true,
      });
      killer.once("error", resolve);
      killer.once("exit", resolve);
    });
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

async function main() {
  const timeoutMs = configuredTimeout();
  const vscodeExecutablePath = await downloadAndUnzipVSCode(VSCODE_VERSION);
  const profileRoot = await mkdtemp(path.join(tmpdir(), "cursor-extension-e2e-"));
  let child;

  try {
    child = spawn(process.execPath, [scriptPath], {
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        [CHILD_MARKER]: "1",
        [EXECUTABLE_ENV]: vscodeExecutablePath,
        [PROFILE_ENV]: profileRoot,
      },
      stdio: "inherit",
      windowsHide: true,
    });

    const result = await waitForExit(child, timeoutMs);
    if (result.timedOut) {
      await terminateProcessTree(child);
      throw new Error(`Extension Host tests timed out after ${timeoutMs} ms`);
    }
    if (result.code !== 0) {
      throw new Error(
        `Extension Host tests exited with ${result.code ?? `signal ${result.signal ?? "unknown"}`}`,
      );
    }
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) {
      await terminateProcessTree(child);
    }
    await rm(profileRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  }
}

if (process.env[CHILD_MARKER] === "1") {
  await runInExtensionHost();
} else {
  await main();
}
