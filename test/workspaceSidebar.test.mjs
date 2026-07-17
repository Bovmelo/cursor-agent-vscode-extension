import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  sidebarGroupContextValue,
  sidebarGroupLabel,
  unwrapWorkspaceNode,
  isWorkspaceChildNode,
} = require("../out/workspaceSidebarUtils.js");

test("sidebar group context values are stable for menus", () => {
  assert.equal(sidebarGroupContextValue("sessions"), "cursorSidebar.group.sessions");
  assert.equal(sidebarGroupContextValue("inbox"), "cursorSidebar.group.inbox");
  assert.equal(sidebarGroupContextValue("integrations"), "cursorSidebar.group.integrations");
  assert.equal(sidebarGroupContextValue("background"), "cursorSidebar.group.background");
  assert.equal(sidebarGroupContextValue("audit"), "cursorSidebar.group.audit");
});

test("sidebar group labels stay short in the consolidated tree", () => {
  assert.equal(sidebarGroupLabel("sessions", false), "Sessions");
  assert.equal(sidebarGroupLabel("inbox", false), "Inbox");
  assert.equal(sidebarGroupLabel("integrations", true), "Rules / Skills / MCP");
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
