import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  agentSendBoundaryMatches,
  filterRequestedSkillsForWorkspaceTrust,
  isPromptCommandAllowedForWorkspaceTrust,
  projectSettingSourcesForWorkspaceTrust,
  resumableAgentIdForWorkspaceTrust,
  resolveAgentIntegrationPolicy,
  shouldUseWorkspacePromptIntegrations,
  workspaceTrustSnapshotMatches,
  workspaceTrustIntegrationKey,
} from "../out/integrationPolicy.js";

const NON_PROJECT_SOURCES = ["user", "team", "mdm", "plugins"];
const extensionSource = await readFile(
  new URL("../src/extension.ts", import.meta.url),
  "utf8",
);
const supervisorSource = await readFile(
  new URL("../src/supervisor.ts", import.meta.url),
  "utf8",
);
const supervisorRunnerSource = await readFile(
  new URL("../src/supervisorRunner.ts", import.meta.url),
  "utf8",
);
const agentFactorySource = await readFile(
  new URL("../src/agentFactory.ts", import.meta.url),
  "utf8",
);
const hooksSource = await readFile(
  new URL("../src/hooks.ts", import.meta.url),
  "utf8",
);
const aiNativeSource = await readFile(
  new URL("../src/aiNative.ts", import.meta.url),
  "utf8",
);

test("extension wires trust guards into prompt, send, and integration UI boundaries", () => {
  const sendSource = extensionSource.slice(
    extensionSource.indexOf("private async send("),
    extensionSource.indexOf("private projectGuidanceInstruction("),
  );
  const guidanceSource = extensionSource.slice(
    extensionSource.indexOf("private projectGuidanceInstruction("),
    extensionSource.indexOf("private composePrompt("),
  );
  const integrationIndexSource = extensionSource.slice(
    extensionSource.indexOf("private async publishUserPromptIntegrations("),
    extensionSource.indexOf("private async openSkillsFolder("),
  );
  const conflictResolutionSource = extensionSource.slice(
    extensionSource.indexOf("private async offerAiConflictResolution("),
    extensionSource.indexOf("private handleToolEvent("),
  );

  assert.match(extensionSource, /onDidGrantWorkspaceTrust/u);
  assert.match(guidanceSource, /shouldUseWorkspacePromptIntegrations/u);
  assert.match(sendSource, /isPromptCommandAllowedForWorkspaceTrust/u);
  assert.match(sendSource, /ensureAgentForCurrentTrust/u);
  assert.match(sendSource, /workspaceTrustSnapshotMatches/u);
  assert.match(sendSource, /preparedRootsKey !== currentRootsKey\(\)/u);
  assert.match(integrationIndexSource, /publishUserPromptIntegrations/u);
  assert.match(integrationIndexSource, /skills: \[\][\s\S]*mcpServers: \[\]/u);
  assert.match(conflictResolutionSource, /agentSendBoundaryMatches/u);
  assert.match(conflictResolutionSource, /this\.integrationStateKey\(input\.conversation\)/u);
  assert.match(conflictResolutionSource, /isPromptCommandAllowedForWorkspaceTrust/u);
  assert.match(conflictResolutionSource, /input\.runtime\.agent!\.send\(prompt/u);
});

test("Supervisor rechecks workspace trust at preparation, agent creation, and send boundaries", () => {
  const runTaskSource = supervisorSource.slice(
    supervisorSource.indexOf("public async runTask("),
    supervisorSource.indexOf("public async openChange("),
  );
  const executeSource = supervisorRunnerSource.slice(
    supervisorRunnerSource.indexOf("public async execute("),
    supervisorRunnerSource.indexOf("private async createAgent("),
  );
  const createSource = supervisorRunnerSource.slice(
    supervisorRunnerSource.indexOf("private async createAgent("),
    supervisorRunnerSource.indexOf("private workspaceTrustError("),
  );

  assert.match(runTaskSource, /prepareWorktree\(task\)[\s\S]*?!vscode\.workspace\.isTrusted[\s\S]*?this\.executor\(/u);
  assert.match(executeSource, /active\.agent = await[\s\S]*?assertWorkspaceTrusted\(\)[\s\S]*?active\.agent!\.send\(/u);
  assert.match(createSource, /assertWorkspaceTrusted\(\);\s*return Agent\.create\(/u);
  assert.match(createSource, /settingSources: \["all"\]/u);
});

test("SDK reconnects and sequential hooks revalidate their trust boundary", () => {
  const factoryConnectSource = agentFactorySource.slice(
    agentFactorySource.indexOf("const connect = async"),
    agentFactorySource.indexOf("try {\n      return await connect(local);"),
  );
  const hookLoopSource = hooksSource.slice(
    hooksSource.indexOf("for (const command of commands)"),
    hooksSource.lastIndexOf("  }\n}"),
  );
  const verificationSource = aiNativeSource.slice(
    aiNativeSource.indexOf("export async function runVerification("),
    aiNativeSource.indexOf("export function verificationStage("),
  );

  assert.match(factoryConnectSource, /assertIntegrationBoundary\(\);\s*return await Agent\.resume/u);
  assert.match(factoryConnectSource, /assertIntegrationBoundary\(\);\s*const agent = await Agent\.create/u);
  assert.match(hookLoopSource, /!vscode\.workspace\.isTrusted[\s\S]*?runConfiguredCommand\(/u);
  assert.match(verificationSource, /for \(const command[\s\S]*?!vscode\.workspace\.isTrusted[\s\S]*?runConfiguredCommand\(/u);
});

test("untrusted prompt composition excludes workspace guidance and skill requests", () => {
  const requestedSkills = ["review", "deploy"];

  assert.equal(shouldUseWorkspacePromptIntegrations(false), false);
  assert.deepEqual(filterRequestedSkillsForWorkspaceTrust(false, requestedSkills), []);
  assert.equal(shouldUseWorkspacePromptIntegrations(true), true);
  assert.deepEqual(
    filterRequestedSkillsForWorkspaceTrust(true, requestedSkills),
    requestedSkills,
  );
});

test("workspace trust snapshots fail closed in either transition direction", () => {
  assert.equal(workspaceTrustSnapshotMatches(false, false), true);
  assert.equal(workspaceTrustSnapshotMatches(true, true), true);
  assert.equal(workspaceTrustSnapshotMatches(true, false), false);
  assert.equal(workspaceTrustSnapshotMatches(false, true), false);
});

test("agent send boundaries require matching trust, roots, and agent identity", () => {
  const expected = {
    isWorkspaceTrusted: false,
    rootsKey: "root\nintegrations:untrusted:",
    agentId: "agent-1",
  };

  assert.equal(agentSendBoundaryMatches(expected, { ...expected }), true);
  assert.equal(agentSendBoundaryMatches(expected, {
    ...expected,
    isWorkspaceTrusted: true,
  }), false);
  assert.equal(agentSendBoundaryMatches(expected, {
    ...expected,
    rootsKey: "root\nintegrations:trusted:",
  }), false);
  assert.equal(agentSendBoundaryMatches(expected, {
    ...expected,
    agentId: "agent-2",
  }), false);
  assert.equal(agentSendBoundaryMatches({ ...expected, agentId: undefined }, expected), false);
});

test("untrusted workspaces reject project commands but retain user commands", () => {
  assert.equal(isPromptCommandAllowedForWorkspaceTrust(false, "project"), false);
  assert.equal(isPromptCommandAllowedForWorkspaceTrust(false, "user"), true);
  assert.equal(isPromptCommandAllowedForWorkspaceTrust(true, "project"), true);
  assert.equal(isPromptCommandAllowedForWorkspaceTrust(true, "user"), true);
});

test("one-shot SDK calls cannot load project settings from untrusted workspaces", () => {
  assert.deepEqual(projectSettingSourcesForWorkspaceTrust(false, true), []);
  assert.deepEqual(projectSettingSourcesForWorkspaceTrust(false, false), []);
  assert.deepEqual(projectSettingSourcesForWorkspaceTrust(true, true), ["project"]);
  assert.deepEqual(projectSettingSourcesForWorkspaceTrust(true, false), []);
});

test("untrusted workspaces exclude project settings and workspace MCP", () => {
  const workspaceMcpServers = {
    untrustedServer: { command: "untrusted-command" },
  };

  for (const hasDisabledWorkspaceIntegrations of [false, true]) {
    const policy = resolveAgentIntegrationPolicy({
      isWorkspaceTrusted: false,
      hasWorkspace: true,
      hasDisabledWorkspaceIntegrations,
      workspaceMcpServers,
    });

    assert.deepEqual(policy.settingSources, NON_PROJECT_SOURCES);
    assert.equal(policy.settingSources.includes("all"), false);
    assert.equal(policy.settingSources.includes("project"), false);
    assert.equal(Object.hasOwn(policy, "mcpServers"), false);
  }
});

test("trusted workspaces preserve automatic project integration loading", () => {
  assert.deepEqual(
    resolveAgentIntegrationPolicy({
      isWorkspaceTrusted: true,
      hasWorkspace: true,
      hasDisabledWorkspaceIntegrations: false,
    }),
    { settingSources: ["all"] },
  );

  assert.deepEqual(
    resolveAgentIntegrationPolicy({
      isWorkspaceTrusted: true,
      hasWorkspace: false,
      hasDisabledWorkspaceIntegrations: false,
    }),
    { settingSources: ["all"] },
  );
});

test("trusted workspaces preserve selective toggles and enabled MCP", () => {
  const workspaceMcpServers = {
    trustedServer: { command: "trusted-command" },
  };

  assert.deepEqual(
    resolveAgentIntegrationPolicy({
      isWorkspaceTrusted: true,
      hasWorkspace: true,
      hasDisabledWorkspaceIntegrations: true,
      workspaceMcpServers,
    }),
    {
      settingSources: NON_PROJECT_SOURCES,
      mcpServers: workspaceMcpServers,
    },
  );

  assert.deepEqual(
    resolveAgentIntegrationPolicy({
      isWorkspaceTrusted: true,
      hasWorkspace: true,
      hasDisabledWorkspaceIntegrations: true,
    }),
    { settingSources: NON_PROJECT_SOURCES },
  );
});

test("workspace trust participates in agent integration reuse identity", () => {
  assert.equal(workspaceTrustIntegrationKey(true), "trusted");
  assert.equal(workspaceTrustIntegrationKey(false), "untrusted");
  assert.notEqual(workspaceTrustIntegrationKey(true), workspaceTrustIntegrationKey(false));
});

test("untrusted workspaces cannot resume an agent created with project integrations", () => {
  assert.equal(resumableAgentIdForWorkspaceTrust(false, "trusted-agent"), undefined);
  assert.equal(resumableAgentIdForWorkspaceTrust(true, "trusted-agent"), "trusted-agent");
  assert.equal(resumableAgentIdForWorkspaceTrust(false, undefined), undefined);
});
