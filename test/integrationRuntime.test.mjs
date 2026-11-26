import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";
import {
  integrationToggleId,
  isWorkspaceIntegrationEnabled,
  toggleIntegration,
} from "../out/integrationToggles.js";
import {
  workspaceIntegrationSelection,
  resolveAgentIntegrationPolicy,
} from "../out/integrationPolicy.js";
import { assertAuxiliaryIntegrationsAllowed } from "../out/auxiliaryIntegrationPolicy.js";

register(new URL("./gitWorkflow.vscode-loader.mjs", import.meta.url), import.meta.url);
const { filterEnabledProjectCommands } = await import("../out/projectCommands.js");

const first = { uri: "file:///work/client-a/app", name: "app", fsPath: "/work/client-a/app" };
const second = { uri: "file:///work/client-b/app", name: "app", fsPath: "/work/client-b/app" };
const mcpPath = (folder) => `${folder.fsPath}/.cursor/mcp.json`;
const selection = (folder, disabledIds) => workspaceIntegrationSelection({
  disabledIds: new Set(disabledIds),
  folderUri: folder.uri,
  folderName: folder.name,
  mcpPath: mcpPath(folder),
});

test("disabling a catalog MCP item suppresses SDK project loading and MCP injection", () => {
  const id = integrationToggleId("mcp", first.uri, mcpPath(first));
  const state = toggleIntegration(undefined, id, false);
  const scoped = selection(first, state.disabledIds);
  assert.equal(scoped.mcpEnabled, false);
  assert.deepEqual(scoped.disabledIds, [id]);
  const policy = resolveAgentIntegrationPolicy({
    isWorkspaceTrusted: true,
    hasWorkspace: true,
    hasDisabledWorkspaceIntegrations: scoped.disabledIds.length > 0,
    workspaceMcpServers: scoped.mcpEnabled ? { executable: { command: "do-not-launch" } } : undefined,
  });
  assert.equal(policy.settingSources.includes("all"), false);
  assert.equal(policy.settingSources.includes("project"), false);
  assert.equal(Object.hasOwn(policy, "mcpServers"), false);
});

test("same-named folders keep independent MCP toggles and agent reuse identities", () => {
  const id = integrationToggleId("mcp", first.uri, mcpPath(first));
  const firstEnabled = selection(first, []);
  const firstDisabled = selection(first, [id]);
  const secondEnabled = selection(second, [id]);
  assert.equal(firstDisabled.mcpEnabled, false);
  assert.equal(secondEnabled.mcpEnabled, true);
  assert.deepEqual(secondEnabled.disabledIds, []);
  assert.notEqual(firstEnabled.key, firstDisabled.key);
  assert.notEqual(firstEnabled.key, secondEnabled.key);
});

test("runtime rules, memory and skills honor catalog IDs and legacy aliases", () => {
  for (const [kind, suffix, relative] of [
    ["rules", ".cursor/rules.md", ".cursor/rules.md"],
    ["memory", ".cursor/project-memory.md", ".cursor/project-memory.md"],
    ["skill", "review", ".cursor/skills/review/SKILL.md"],
  ]) {
    const absolutePath = `${first.fsPath}/${relative}`;
    const id = integrationToggleId(kind, first.uri, absolutePath);
    for (const disabled of [[id], [`${kind}:app:${suffix}`]]) {
      assert.equal(isWorkspaceIntegrationEnabled(new Set(disabled), kind, first.uri, absolutePath, first.name, suffix), false);
    }
    assert.equal(isWorkspaceIntegrationEnabled(new Set([id]), kind, second.uri, `${second.fsPath}/${relative}`, second.name, suffix), true);
  }
});

test("project command filtering honors stable paths without disabling same-named siblings", () => {
  const command = (folder) => ({
    id: "deploy", source: "project", workspaceFolderName: folder.name,
    integrationId: integrationToggleId("command", folder.uri, `${folder.fsPath}/.cursor/commands/deploy.md`),
  });
  const a = command(first);
  const b = command(second);
  assert.deepEqual(filterEnabledProjectCommands([a, b], new Set([a.integrationId])), [b]);
  assert.deepEqual(filterEnabledProjectCommands([a, b], new Set(["command:app:deploy"])), []);
});

test("auxiliary agents fail closed only for disabled integrations in their target scope", () => {
  const id = integrationToggleId("mcp", first.uri, mcpPath(first));
  const disabled = new Set([id]);
  assert.throws(() => assertAuxiliaryIntegrationsAllowed(disabled, [first, second], first.fsPath), /main chat/u);
  assert.doesNotThrow(() => assertAuxiliaryIntegrationsAllowed(disabled, [first, second], second.fsPath));
  assert.throws(() => assertAuxiliaryIntegrationsAllowed(disabled, [], "/unknown"), /main chat/u);
  assert.doesNotThrow(() => assertAuxiliaryIntegrationsAllowed(new Set(), [first, second], first.fsPath));
});
