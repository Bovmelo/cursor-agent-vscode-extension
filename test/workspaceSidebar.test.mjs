import assert from "node:assert/strict";
import { createRequire, register } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  SIDEBAR_GROUP_ORDER,
  sidebarGroupAccessibilityLabel,
  sidebarGroupContextValue,
  sidebarGroupEmptyCommand,
  sidebarGroupDescription,
  sidebarGroupEmptyLabel,
  sidebarGroupLabel,
  sidebarGroupTooltip,
  unwrapWorkspaceNode,
  isWorkspaceChildNode,
} = require("../out/workspaceSidebarUtils.js");

register(new URL("./runCenter-vscode-loader.mjs", import.meta.url), import.meta.url);
const [{ WorkspaceSidebarController }, { TreeItem }] = await Promise.all([
  import("../out/workspaceSidebar.js"),
  import("./runCenter-vscode-mock.mjs"),
]);

function childProvider(children = []) {
  return {
    getChildren: () => children,
    getTreeItem: (node) => new TreeItem(node.label),
  };
}

function existingProviders() {
  return {
    sessions: childProvider(),
    inbox: childProvider(),
    integrations: childProvider(),
    background: childProvider(),
    audit: childProvider(),
  };
}

test("sidebar group context values are stable for menus", () => {
  assert.equal(sidebarGroupContextValue("runCenter"), "cursorSidebar.group.runCenter");
  assert.equal(sidebarGroupContextValue("sessions"), "cursorSidebar.group.sessions");
  assert.equal(sidebarGroupContextValue("inbox"), "cursorSidebar.group.inbox");
  assert.equal(sidebarGroupContextValue("integrations"), "cursorSidebar.group.integrations");
  assert.equal(sidebarGroupContextValue("background"), "cursorSidebar.group.background");
  assert.equal(sidebarGroupContextValue("audit"), "cursorSidebar.group.audit");
});

test("sidebar group labels stay short in the consolidated tree", () => {
  assert.equal(sidebarGroupLabel("runCenter", false), "Run Center");
  assert.equal(sidebarGroupLabel("sessions", false), "Sessions");
  assert.equal(sidebarGroupLabel("inbox", false), "Inbox");
  assert.equal(sidebarGroupLabel("integrations", true), "Rules / Skills / MCP");
});

test("empty sidebar groups offer a concrete next action", () => {
  assert.equal(sidebarGroupEmptyCommand("runCenter"), "cursorSubscription.chooseWorkflow");
  assert.equal(sidebarGroupEmptyCommand("background"), "cursorSubscription.startBackgroundJob");
  assert.equal(sidebarGroupEmptyCommand("integrations"), "cursorSubscription.refreshIntegrations");
});

test("Run Center is available as the first optional sidebar group", () => {
  assert.equal(SIDEBAR_GROUP_ORDER[0], "runCenter");
  assert.deepEqual(SIDEBAR_GROUP_ORDER.slice(1), [
    "sessions",
    "inbox",
    "integrations",
    "background",
    "audit",
  ]);
});

test("group metadata exposes counts, tooltips, and actionable empty labels", () => {
  assert.equal(sidebarGroupDescription(3), "3");
  assert.equal(sidebarGroupDescription(-1), "0");
  assert.equal(sidebarGroupTooltip("sessions", 1, false), "Sessions: 1 item");
  assert.equal(sidebarGroupTooltip("sessions", 2, false), "Sessions: 2 items");
  assert.equal(sidebarGroupEmptyLabel("background", false), "Next: start a background job");
  assert.equal(
    sidebarGroupAccessibilityLabel("runCenter", 0, false),
    "Run Center: 0 items. Next: start a run from Chat or Inbox",
  );
});

test("legacy providers remain valid and Run Center is optional at runtime", () => {
  const legacySidebar = new WorkspaceSidebarController(false, existingProviders());
  assert.deepEqual(
    legacySidebar.getChildren().map((node) => node.groupId),
    ["sessions", "inbox", "integrations", "background", "audit"],
  );

  const sidebar = new WorkspaceSidebarController(false, {
    ...existingProviders(),
    runCenter: childProvider(),
  });
  const [runCenterGroup] = sidebar.getChildren();
  assert.equal(runCenterGroup.groupId, "runCenter");
  const groupItem = sidebar.getTreeItem(runCenterGroup);
  assert.equal(groupItem.description, "0");
  assert.equal(
    groupItem.accessibilityInformation.label,
    "Run Center: 0 items. Next: start a run from Chat or Inbox",
  );
  const [placeholder] = sidebar.getChildren(runCenterGroup);
  assert.equal(placeholder.kind, "placeholder");
  assert.equal(sidebar.getTreeItem(placeholder).label, "Next: start a run from Chat or Inbox");

  legacySidebar.dispose();
  sidebar.dispose();
});

test("unwrapWorkspaceNode returns the inner child for wrapped tree elements", () => {
  const inner = { taskId: "abc", kind: "task" };
  const wrapped = { kind: "child", groupId: "inbox", node: inner };
  assert.equal(isWorkspaceChildNode(wrapped), true);
  assert.equal(unwrapWorkspaceNode(wrapped), inner);
  assert.equal(unwrapWorkspaceNode(inner), inner);
  assert.equal(unwrapWorkspaceNode("plain-id"), "plain-id");
  assert.equal(unwrapWorkspaceNode(undefined), undefined);
});
