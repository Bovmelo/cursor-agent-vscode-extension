const assert = require("node:assert/strict");
const vscode = require("vscode");

const EXTENSION_ID = "ark4ez.cursor-subscription-for-vscode";
const CHAT_VIEW_ID = "cursorSubscription.chatView";
const WORKSPACE_TREE_VIEW_ID = "cursorSubscription.workspaceTree";
const WEBVIEW_STATE_COMMAND = "cursorSubscription.__e2e.webviewState";

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
  process.stdout.write(`E2E: ${description} ... `);
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

async function run() {
  const extension = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(extension, `${EXTENSION_ID} was not loaded into the Extension Host`);

  await check("activate extension", async () => {
    await completesWithin(extension.activate(), "activating the extension", 30_000);
    assert.equal(extension.isActive, true);
  });

  await check("register commands and contributed views", async () => {
    const commands = new Set(await vscode.commands.getCommands(true));
    for (const command of [
      "cursorSubscription.openChat",
      "cursorSubscription.focusWorkspaceSessions",
      WEBVIEW_STATE_COMMAND,
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
}

module.exports = { run };
