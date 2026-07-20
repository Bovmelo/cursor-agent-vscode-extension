import assert from "node:assert/strict";
import { AgentFactory } from "../out/agentFactory.js";
import { MockAgentBackend } from "./mockAgentBackend.mjs";

const supportedCapabilities = {
  sandbox: "supported",
  resume: "supported",
  subagents: "supported",
  mcpServers: "supported",
  settingSources: "supported",
  agentRetries: "supported",
};

function factoryOptions(overrides = {}) {
  return {
    supportsLocalSandbox: true,
    isJapanese: false,
    selectedApprovalMode: () => "auto-review",
    selectedModel: () => ({ id: "test-model" }),
    saveConversations: async () => {},
    notifySandboxUnavailable: () => {},
    ...overrides,
  };
}

{
  const backend = new MockAgentBackend({
    capabilities: supportedCapabilities,
    createHandler: async () => {
      throw new Error("create must not be called");
    },
    resumeHandler: async (agentId) => ({ agentId }),
    builtInSubagents: {
      researcher: { description: "read", prompt: "inspect" },
    },
  });
  let boundaries = 0;
  let saves = 0;
  const conversation = { agentId: "existing-agent" };
  const factory = new AgentFactory(
    factoryOptions({
      saveConversations: async () => {
        saves += 1;
      },
    }),
    backend,
  );

  const agent = await factory.createOrResume({
    apiKey: "secret",
    roots: ["C:/workspace"],
    workspaceName: "workspace",
    conversation,
    settingSources: ["user"],
    mcpServers: { docs: { url: "https://example.test/mcp" } },
    assertIntegrationBoundary: () => {
      boundaries += 1;
    },
  });

  assert.equal(agent.agentId, "existing-agent");
  assert.equal(boundaries, 1);
  assert.equal(saves, 0);
  const resumeCall = backend.calls.find((call) => call[0] === "resume");
  assert.ok(resumeCall);
  assert.deepEqual(resumeCall[2].local, {
    cwd: "C:/workspace",
    autoReview: true,
    enableAgentRetries: true,
    sandbox: { enabled: true },
    settingSources: ["user"],
  });
  assert.deepEqual(resumeCall[2].subagents, {
    researcher: { description: "read", prompt: "inspect" },
  });
  assert.deepEqual(resumeCall[2].mcpServers, {
    docs: { url: "https://example.test/mcp" },
  });
}

{
  const unsupportedCapabilities = Object.fromEntries(
    Object.keys(supportedCapabilities).map((capability) => [capability, "unsupported"]),
  );
  let createOptions;
  let notified = 0;
  let boundaries = 0;
  let saves = 0;
  const backend = new MockAgentBackend({
    capabilities: unsupportedCapabilities,
    createHandler: async (options) => {
      createOptions = options;
      return { agentId: "replacement-agent" };
    },
    resumeHandler: async () => {
      throw new Error("resume must not be called");
    },
  });
  backend.builtInSubagents = () => {
    throw new Error("subagents must not be requested");
  };
  const conversation = { agentId: "old-agent" };
  const factory = new AgentFactory(
    factoryOptions({
      saveConversations: async () => {
        saves += 1;
      },
      notifySandboxUnavailable: () => {
        notified += 1;
      },
    }),
    backend,
  );

  await factory.createOrResume({
    apiKey: "secret",
    roots: ["C:/one", "C:/two"],
    workspaceName: "multi-root",
    conversation,
    settingSources: ["all"],
    mcpServers: { docs: { url: "https://example.test/mcp" } },
    assertIntegrationBoundary: () => {
      boundaries += 1;
    },
  });

  assert.equal(conversation.agentId, "replacement-agent");
  assert.equal(boundaries, 1);
  assert.equal(saves, 1);
  assert.equal(notified, 1);
  assert.deepEqual(createOptions.local, {
    cwd: ["C:/one", "C:/two"],
    autoReview: true,
    enableAgentRetries: undefined,
    sandbox: undefined,
    settingSources: undefined,
  });
  assert.equal(createOptions.subagents, undefined);
  assert.equal(createOptions.mcpServers, undefined);
}

for (const recoverable of [
  { label: "missing session", error: { code: "agent_not_found" }, kind: "session-not-found" },
  { label: "invalid agent ID", error: { code: "invalid_agent_id" }, kind: "invalid-agent-id" },
]) {
  const backend = new MockAgentBackend({
    capabilities: supportedCapabilities,
    createHandler: async () => ({ agentId: "replacement-agent" }),
    resumeError: recoverable.error,
    classifyResumeError: (error) => (error === recoverable.error ? recoverable.kind : "other"),
  });
  let saves = 0;
  const conversation = { agentId: "persisted-agent" };
  const factory = new AgentFactory(
    factoryOptions({
      saveConversations: async () => {
        saves += 1;
      },
    }),
    backend,
  );

  const agent = await factory.createOrResume({
    apiKey: "secret",
    roots: ["C:/workspace"],
    workspaceName: recoverable.label,
    conversation,
    assertIntegrationBoundary: () => {},
  });

  assert.equal(agent.agentId, "replacement-agent", recoverable.label);
  assert.equal(conversation.agentId, "replacement-agent", recoverable.label);
  assert.deepEqual(
    backend.calls.filter((call) => call[0] === "resume" || call[0] === "create").map((call) => call[0]),
    ["resume", "create"],
    recoverable.label,
  );
  assert.equal(saves, 1, recoverable.label);
}

for (const fatal of [
  Object.assign(new Error("service unavailable"), { status: 503, isRetryable: true }),
  Object.assign(new Error("invalid API key"), { status: 401, code: "unauthenticated" }),
]) {
  const backend = new MockAgentBackend({
    capabilities: supportedCapabilities,
    createHandler: async () => ({ agentId: "must-not-be-created" }),
    resumeError: fatal,
    classifyResumeError: () => "other",
  });
  let saves = 0;
  const conversation = { agentId: "persisted-agent" };
  const factory = new AgentFactory(
    factoryOptions({
      saveConversations: async () => {
        saves += 1;
      },
    }),
    backend,
  );

  await assert.rejects(
    factory.createOrResume({
      apiKey: "secret",
      roots: ["C:/workspace"],
      workspaceName: "preserve-session",
      conversation,
      assertIntegrationBoundary: () => {},
    }),
    (error) => error === fatal,
  );

  assert.equal(conversation.agentId, "persisted-agent");
  assert.equal(backend.calls.some((call) => call[0] === "create"), false);
  assert.equal(saves, 0);
}
