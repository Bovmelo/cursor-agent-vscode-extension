import childProcess, { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode, runTests } from "@vscode/test-electron";

const VSCODE_VERSION = "1.101.2";
const DEFAULT_TIMEOUT_MS = 240_000;
const CHILD_MARKER = "CURSOR_EXTENSION_E2E_CHILD";
const EXECUTABLE_ENV = "CURSOR_EXTENSION_E2E_EXECUTABLE";
const PROFILE_ENV = "CURSOR_EXTENSION_E2E_PROFILE";
const SUITE_ENV = "CURSOR_EXTENSION_E2E_SUITE";
const WORKSPACE_ENV = "CURSOR_EXTENSION_E2E_WORKSPACE";
const KEEP_WORKSPACE_TRUST_ENV = "CURSOR_EXTENSION_E2E_KEEP_WORKSPACE_TRUST";

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

function stripDisableWorkspaceTrustArgs(args) {
  return args.filter((arg) => {
    const value = typeof arg === "string" ? arg.replaceAll(/^"|"$/gu, "") : arg;
    return value !== "--disable-workspace-trust";
  });
}

/**
 * @vscode/test-electron always injects --disable-workspace-trust. Patch spawn only while
 * the untrusted suite is launching so Restricted Mode stays enabled under runTests.
 * Returns a restore function; always call it after runTests (success or failure).
 *
 * Limitation: this only strips the CLI flag. It cannot reproduce every VS Code Restricted
 * Mode nuance (e.g. UI banners, extension host edge cases). The suite asserts
 * vscode.workspace.isTrusted === false plus this extension's automation gates instead.
 */
function installWorkspaceTrustSpawnPatch() {
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function patchedSpawn(command, args, options) {
    // Only rewrite args when the untrusted suite explicitly opts in via env.
    if (Array.isArray(args) && process.env[KEEP_WORKSPACE_TRUST_ENV] === "1") {
      return originalSpawn.call(this, command, stripDisableWorkspaceTrustArgs(args), options);
    }
    return originalSpawn.call(this, command, args, options);
  };
  return () => {
    childProcess.spawn = originalSpawn;
  };
}

async function prepareUntrustedWorkspace(root) {
  const workspaceRoot = path.join(root, "workspace");
  const vscodeDir = path.join(workspaceRoot, ".vscode");
  await mkdir(vscodeDir, { recursive: true });
  await writeFile(
    path.join(vscodeDir, "settings.json"),
    `${JSON.stringify(
      {
        "cursorSubscription.autoRepair": true,
        "cursorSubscription.supervisorMode": "autonomous",
        "cursorSubscription.autoVerify": false,
        "cursorSubscription.supervisorAutoApplySafeChanges": true,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    path.join(workspaceRoot, "README.md"),
    "# Extension Host untrusted-workspace fixture\n",
    "utf8",
  );
  return workspaceRoot;
}

async function prepareTrustAwareUserData(userDataDir) {
  const userDir = path.join(userDataDir, "User");
  await mkdir(userDir, { recursive: true });
  // Keep Workspace Trust enabled, but avoid modal prompts that block headless CI.
  //
  // CI-only activation workaround: vscode.git / vscode.git-base declare
  // untrustedWorkspaces.supported=false. Without extensions.supportUntrustedWorkspaces
  // overrides, the extensionDependency stays unavailable and this extension cannot
  // activate under Restricted Mode at all. Override only the built-in Git stack so
  // activation succeeds while isTrusted remains false for the opened folder and *this*
  // extension's automation gates still apply. This is not a faithful full Restricted
  // Mode simulation of Git's own unsupported-untrusted policy.
  await writeFile(
    path.join(userDir, "settings.json"),
    `${JSON.stringify(
      {
        "security.workspace.trust.enabled": true,
        "security.workspace.trust.startupPrompt": "never",
        "security.workspace.trust.banner": "never",
        "security.workspace.trust.emptyWindow": true,
        "extensions.supportUntrustedWorkspaces": {
          "vscode.git": {
            supported: true,
            version: "1.0.0",
          },
          "vscode.git-base": {
            supported: true,
            version: "1.0.0",
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function runInExtensionHost() {
  const vscodeExecutablePath = process.env[EXECUTABLE_ENV];
  const profileRoot = process.env[PROFILE_ENV];
  const suite = process.env[SUITE_ENV] || "smoke";
  const workspaceFolder = process.env[WORKSPACE_ENV];
  if (!vscodeExecutablePath || !profileRoot) {
    throw new Error("The Extension Host child is missing its executable or profile path");
  }

  const userDataDir = path.join(profileRoot, "user-data");
  const extensionsDir = path.join(profileRoot, "extensions");
  const extensionTestsEnv = {
    CURSOR_SUBSCRIPTION_E2E: "1",
    CURSOR_EXTENSION_E2E_SUITE: suite,
  };

  if (suite === "untrusted") {
    if (!workspaceFolder) {
      throw new Error("The untrusted suite requires CURSOR_EXTENSION_E2E_WORKSPACE");
    }
    await prepareTrustAwareUserData(userDataDir);
    process.env[KEEP_WORKSPACE_TRUST_ENV] = "1";
    const restoreSpawn = installWorkspaceTrustSpawnPatch();
    try {
      await runTests({
        vscodeExecutablePath,
        extensionDevelopmentPath,
        extensionTestsPath,
        extensionTestsEnv,
        launchArgs: [
          workspaceFolder,
          "--disable-extensions",
          "--new-window",
          `--user-data-dir=${userDataDir}`,
          `--extensions-dir=${extensionsDir}`,
        ],
      });
    } finally {
      restoreSpawn();
      delete process.env[KEEP_WORKSPACE_TRUST_ENV];
    }
    return;
  }

  if (suite !== "smoke") {
    throw new Error(`Unknown Extension Host suite "${suite}"`);
  }

  await runTests({
    vscodeExecutablePath,
    extensionDevelopmentPath,
    extensionTestsPath,
    extensionTestsEnv,
    launchArgs: [
      "--disable-extensions",
      "--disable-workspace-trust",
      "--new-window",
      `--user-data-dir=${userDataDir}`,
      `--extensions-dir=${extensionsDir}`,
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

async function runSuiteChild({
  suite,
  vscodeExecutablePath,
  timeoutMs,
  workspaceFolder,
}) {
  const profileRoot = await mkdtemp(path.join(tmpdir(), `cursor-extension-e2e-${suite}-`));
  let child;

  try {
    const env = {
      ...process.env,
      [CHILD_MARKER]: "1",
      [EXECUTABLE_ENV]: vscodeExecutablePath,
      [PROFILE_ENV]: profileRoot,
      [SUITE_ENV]: suite,
      ...(workspaceFolder ? { [WORKSPACE_ENV]: workspaceFolder } : {}),
    };
    // Never forward live credentials into Extension Host suites.
    // extensionTestsEnv (set in runInExtensionHost) may add intentional test flags;
    // do not strip those — only scrub host/CI secrets from this suite child env.
    for (const key of [
      "CURSOR_API_KEY",
      "CURSOR_SECRET_KEY",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
    ]) {
      delete env[key];
    }

    child = spawn(process.execPath, [scriptPath], {
      detached: process.platform !== "win32",
      env,
      stdio: "inherit",
      windowsHide: true,
    });

    const result = await waitForExit(child, timeoutMs);
    if (result.timedOut) {
      await terminateProcessTree(child);
      throw new Error(`Extension Host ${suite} suite timed out after ${timeoutMs} ms`);
    }
    if (result.code !== 0) {
      throw new Error(
        `Extension Host ${suite} suite exited with ${result.code ?? `signal ${result.signal ?? "unknown"}`}`,
      );
    }
  } finally {
    if (child?.exitCode === null && child?.signalCode === null) {
      await terminateProcessTree(child);
    }
    await rm(profileRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  }
}

async function main() {
  const timeoutMs = configuredTimeout();
  const vscodeExecutablePath = await downloadAndUnzipVSCode(VSCODE_VERSION);
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "cursor-extension-e2e-fixtures-"));

  try {
    const untrustedWorkspace = await prepareUntrustedWorkspace(fixtureRoot);
    // Smoke keeps --disable-workspace-trust (via @vscode/test-electron + launchArgs).
    await runSuiteChild({
      suite: "smoke",
      vscodeExecutablePath,
      timeoutMs,
    });
    // Untrusted suite uses a separate profile/launch without --disable-workspace-trust.
    await runSuiteChild({
      suite: "untrusted",
      vscodeExecutablePath,
      timeoutMs,
      workspaceFolder: untrustedWorkspace,
    });
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
  }
}

if (process.env[CHILD_MARKER] === "1") {
  await runInExtensionHost();
} else {
  await main();
}
