const assert = require("node:assert/strict");
const vscode = require("vscode");

const EXTENSION_ID = "ark4ez.cursor-subscription-for-vscode";
const CHAT_VIEW_ID = "cursorSubscription.chatView";
const WORKSPACE_TREE_VIEW_ID = "cursorSubscription.workspaceTree";
const WEBVIEW_STATE_COMMAND = "cursorSubscription.__e2e.webviewState";
const SETUP_CHECKLIST_STATE_COMMAND = "cursorSubscription.__e2e.setupChecklistState";
const RUN_CENTER_SNAPSHOT_COMMAND = "cursorSubscription.__e2e.runCenterSnapshot";
const EXPORT_DIAGNOSTICS_DRY_RUN_COMMAND = "cursorSubscription.__e2e.exportDiagnosticsDryRun";
const RETRY_LAST_RUN_PROBE_COMMAND = "cursorSubscription.__e2e.retryLastRunProbe";
const SET_API_KEY_COMMAND = "cursorSubscription.setApiKey";
const START_BACKGROUND_JOB_COMMAND = "cursorSubscription.startBackgroundJob";
const CREATE_PULL_REQUEST_COMMAND = "cursorSubscription.createPullRequest";
const RUN_TASK_PIPELINE_COMMAND = "cursorSubscription.runTaskPipeline";
const SCAN_SUPERVISOR_GITHUB_COMMAND = "cursorSubscription.scanSupervisorGitHub";
const SUITE = process.env.CURSOR_EXTENSION_E2E_SUITE || "smoke";

function assertNoSecretsInJson(value, path = "$") {
  if (typeof value === "string") {
    assert.doesNotMatch(
      value,
      /\b(sk-[A-Za-z0-9]{10,}|cursor_api_key|ghp_[A-Za-z0-9]{20,})\b/iu,
      `${path} must not contain secret-looking material`,
    );
    assert.doesNotMatch(
      value,
      /\b(api[_-]?key|authorization|password|secret|token)\b\s*[:=]\s*[^\s,<"]{8,}/iu,
      `${path} must not contain credential assignments`,
    );
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretsInJson(entry, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      assertNoSecretsInJson(entry, `${path}.${key}`);
    }
  }
}

async function completesWithin(operation, description, milliseconds = 20_000) {
  let timeout;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${description} timed out after ${milliseconds} ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function check(description, operation) {
  process.stdout.write(`E2E[${SUITE}]: ${description} ... `);
  await operation();
  process.stdout.write("ok\n");
}

async function waitForWebviewReady(milliseconds = 20_000) {
  const deadline = Date.now() + milliseconds;
  let state;
  do {
    state = await vscode.commands.executeCommand(WEBVIEW_STATE_COMMAND);
    if (state?.attached === true && state?.ready === true) {
      return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  } while (Date.now() < deadline);

  assert.fail(
    `WebviewView did not attach and send its ready message: ${JSON.stringify(state)}`,
  );
}

async function activateExtension() {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} was not loaded into the Extension Host`);
  await completesWithin(extension.activate(), "activating the extension", 30_000);
  assert.equal(extension.isActive, true);
  return extension;
}

async function runSmokeSuite() {
  const extension = await activateExtension();

  await check("register commands and contributed views", async () => {
    const commands = new Set(await vscode.commands.getCommands(true));
    for (const command of [
      "cursorSubscription.openChat",
      "cursorSubscription.focusWorkspaceSessions",
      "cursorSubscription.showSetupChecklist",
      "cursorSubscription.openRunCenter",
      "cursorSubscription.exportDiagnostics",
      "cursorSubscription.retryLastRun",
      "cursorSubscription.chooseWorkflow",
      "cursorSubscription.chooseExecutionProfile",
      SET_API_KEY_COMMAND,
      WEBVIEW_STATE_COMMAND,
      SETUP_CHECKLIST_STATE_COMMAND,
      RUN_CENTER_SNAPSHOT_COMMAND,
      EXPORT_DIAGNOSTICS_DRY_RUN_COMMAND,
      RETRY_LAST_RUN_PROBE_COMMAND,
      `${CHAT_VIEW_ID}.focus`,
      `${WORKSPACE_TREE_VIEW_ID}.focus`,
    ]) {
      assert.ok(commands.has(command), `${command} was not registered`);
    }

    const contributedViews = extension.packageJSON.contributes?.views?.cursorSubscription ?? [];
    assert.deepEqual(
      contributedViews.map((view) => view.id),
      [CHAT_VIEW_ID, WORKSPACE_TREE_VIEW_ID],
    );
  });

  await check("missing API key surfaces setApiKey command gate", async () => {
    // Fresh --user-data-dir profiles have empty SecretStorage. Do not read, write,
    // or prompt for a real Cursor API key, and do not call @cursor/sdk.
    // The launcher scrubs live credentials from the suite child env before spawn.
    assert.equal(
      process.env.CURSOR_API_KEY,
      undefined,
      "E2E must not run with CURSOR_API_KEY set",
    );
    assert.equal(
      process.env.CURSOR_SECRET_KEY,
      undefined,
      "E2E must not run with CURSOR_SECRET_KEY set",
    );
    assert.equal(
      process.env.GH_TOKEN,
      undefined,
      "E2E must not run with GH_TOKEN set",
    );
    assert.equal(
      process.env.GITHUB_TOKEN,
      undefined,
      "E2E must not run with GITHUB_TOKEN set",
    );

    const contributedCommands = extension.packageJSON.contributes?.commands ?? [];
    assert.ok(
      contributedCommands.some((entry) => entry.command === SET_API_KEY_COMMAND),
      `${SET_API_KEY_COMMAND} must remain a contributed Command Palette gate`,
    );

    const commands = new Set(await vscode.commands.getCommands(true));
    assert.ok(
      commands.has(SET_API_KEY_COMMAND),
      `${SET_API_KEY_COMMAND} must be registered when no API key is configured`,
    );
    assert.ok(
      commands.has("cursorSubscription.clearApiKey"),
      "clearApiKey must stay registered alongside the setApiKey gate",
    );
  });

  await check("resolve chat WebviewView provider without credentials", async () => {
    await completesWithin(
      vscode.commands.executeCommand("cursorSubscription.openChat"),
      "opening the contributed chat WebviewView",
    );

    const state = await waitForWebviewReady();
    assert.deepEqual(state, { attached: true, ready: true });

    // This command only posts local UI state into the attached WebviewView. It
    // intentionally stops before any Cursor request, so no API key is needed.
    await completesWithin(
      vscode.commands.executeCommand("cursorSubscription.newChat"),
      "posting to the resolved chat WebviewView",
    );

    await completesWithin(
      vscode.commands.executeCommand(`${WORKSPACE_TREE_VIEW_ID}.focus`),
      "focusing the registered workspace tree view",
    );
  });

  await check("showSetupChecklist and openRunCenter complete without throw", async () => {
    await completesWithin(
      vscode.commands.executeCommand("cursorSubscription.showSetupChecklist"),
      "showing the setup checklist",
    );
    await completesWithin(
      vscode.commands.executeCommand("cursorSubscription.openRunCenter"),
      "opening Run Center",
    );
  });

  await check("E2E hooks expose checklist, Run Center, diagnostics, and retry probe", async () => {
    const checklist = await completesWithin(
      vscode.commands.executeCommand(SETUP_CHECKLIST_STATE_COMMAND),
      "reading setup checklist state",
    );
    assert.equal(typeof checklist, "object");
    assert.equal(checklist.visible, true);
    assert.equal(checklist.steps?.apiKey?.complete, false);

    const runCenter = await completesWithin(
      vscode.commands.executeCommand(RUN_CENTER_SNAPSHOT_COMMAND),
      "reading Run Center snapshot",
    );
    assert.equal(typeof runCenter, "object");
    assert.ok(runCenter !== null);

    const bundle = await completesWithin(
      vscode.commands.executeCommand(EXPORT_DIAGNOSTICS_DRY_RUN_COMMAND),
      "collecting diagnostics dry-run bundle",
    );
    assert.ok(Array.isArray(bundle.checks), "diagnostics bundle must include checks");
    const apiKeyCheck = bundle.checks.find((check) => check.label === "Cursor API key");
    assert.equal(apiKeyCheck?.status, "error");
    assertNoSecretsInJson(bundle);

    const retryProbe = await completesWithin(
      vscode.commands.executeCommand(RETRY_LAST_RUN_PROBE_COMMAND),
      "probing retryLastRun without send",
    );
    assert.equal(typeof retryProbe, "object");
    assert.equal(typeof retryProbe.wouldCallSend, "boolean");
    // Fresh profile has no transcript seed; probe must stay structured and non-sending.
    if (retryProbe.wouldCallSend !== true) {
      assert.equal(retryProbe.wouldCallSend, false);
    }
  });
}

async function runUntrustedSuite() {
  const extension = await activateExtension();

  await check("workspace remains untrusted under Workspace Trust", async () => {
    assert.equal(
      vscode.workspace.isTrusted,
      false,
      "Untrusted suite must launch without --disable-workspace-trust and keep Restricted Mode",
    );
    assert.ok(
      (vscode.workspace.workspaceFolders?.length ?? 0) >= 1,
      "Untrusted suite requires an opened workspace folder",
    );
  });

  await check("restricted automation settings are filtered in Restricted Mode", async () => {
    const restricted =
      extension.packageJSON.capabilities?.untrustedWorkspaces?.restrictedConfigurations ?? [];
    for (const setting of [
      "cursorSubscription.autoRepair",
      "cursorSubscription.autoVerify",
      "cursorSubscription.supervisorMode",
      "cursorSubscription.supervisorAutoApplySafeChanges",
    ]) {
      assert.ok(
        restricted.includes(setting),
        `${setting} must remain in capabilities.untrustedWorkspaces.restrictedConfigurations`,
      );
    }

    const folder = vscode.workspace.workspaceFolders?.[0];
    assert.ok(folder, "Untrusted suite requires an opened workspace folder");
    const settingsUri = vscode.Uri.joinPath(folder.uri, ".vscode", "settings.json");
    const settingsRaw = Buffer.from(await vscode.workspace.fs.readFile(settingsUri)).toString("utf8");
    const settings = JSON.parse(settingsRaw);
    assert.equal(settings["cursorSubscription.autoRepair"], true);
    assert.equal(settings["cursorSubscription.supervisorMode"], "autonomous");
    assert.equal(settings["cursorSubscription.autoVerify"], false);
    assert.equal(settings["cursorSubscription.supervisorAutoApplySafeChanges"], true);

    // VS Code must not expose those restricted workspace values to this extension
    // while the folder remains untrusted (package defaults: autoRepair=false,
    // supervisorMode=observe, autoVerify=true, supervisorAutoApplySafeChanges=false).
    const configuration = vscode.workspace.getConfiguration("cursorSubscription");
    assert.equal(vscode.workspace.isTrusted, false);
    assert.equal(
      configuration.inspect("autoRepair")?.workspaceValue,
      undefined,
      "Restricted Mode must hide workspace autoRepair from this extension",
    );
    assert.equal(
      configuration.inspect("supervisorMode")?.workspaceValue,
      undefined,
      "Restricted Mode must hide workspace supervisorMode from this extension",
    );
    assert.equal(
      configuration.inspect("autoVerify")?.workspaceValue,
      undefined,
      "Restricted Mode must hide workspace autoVerify from this extension",
    );
    assert.equal(
      configuration.inspect("supervisorAutoApplySafeChanges")?.workspaceValue,
      undefined,
      "Restricted Mode must hide workspace supervisorAutoApplySafeChanges from this extension",
    );
    assert.equal(configuration.get("autoRepair"), false);
    assert.notEqual(configuration.get("supervisorMode"), "autonomous");
    // Fixture wrote autoVerify=false / supervisorAutoApplySafeChanges=true; get() must
    // fall back to package defaults once Restricted Mode scrubs the workspace values.
    assert.equal(
      configuration.get("autoVerify"),
      true,
      "Restricted Mode must scrub workspace autoVerify=false back to the default true",
    );
    assert.equal(
      configuration.get("supervisorAutoApplySafeChanges"),
      false,
      "Restricted Mode must scrub workspace supervisorAutoApplySafeChanges=true back to the default false",
    );
  });

  async function assertTrustedWorkspaceGate(commandId) {
    const commands = new Set(await vscode.commands.getCommands(true));
    assert.ok(
      commands.has(commandId),
      `${commandId} must remain registered in Restricted Mode`,
    );

    const result = await completesWithin(
      vscode.commands.executeCommand(commandId),
      `invoking ${commandId} in an untrusted workspace`,
      10_000,
    );
    assert.equal(
      result,
      "workspace-trust-required",
      `${commandId} must stop at the command-boundary trust gate`,
    );
  }

  await check("untrusted workspace blocks background-agent command path", async () => {
    // Trust is checked before API key / prompts (BackgroundJobsController.create).
    await assertTrustedWorkspaceGate(START_BACKGROUND_JOB_COMMAND);
  });

  await check("untrusted workspace blocks create-pull-request command path", async () => {
    await assertTrustedWorkspaceGate(CREATE_PULL_REQUEST_COMMAND);
  });

  await check("untrusted workspace blocks task-pipeline command path", async () => {
    await assertTrustedWorkspaceGate(RUN_TASK_PIPELINE_COMMAND);
  });

  await check("untrusted workspace blocks supervisor GitHub scan command path", async () => {
    await assertTrustedWorkspaceGate(SCAN_SUPERVISOR_GITHUB_COMMAND);
  });
}

async function run() {
  if (SUITE === "untrusted") {
    await runUntrustedSuite();
    return;
  }

  if (SUITE !== "smoke") {
    throw new Error(
      `Unknown CURSOR_EXTENSION_E2E_SUITE "${SUITE}". Expected "smoke" or "untrusted".`,
    );
  }

  await runSmokeSuite();
}

module.exports = { run };
