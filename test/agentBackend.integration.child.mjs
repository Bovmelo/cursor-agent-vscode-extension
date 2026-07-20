import assert from "node:assert/strict";
import { AgentFactory } from "../out/agentFactory.js";

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
  const calls = [];
  let builtInsRequested = 0;
  const backend = {
    capabilities: supportedCapabilities,
    create: async (options) => {
      calls.push(["create", options]);
      return { agentId: "created-agent" };
    },
    resume: async (agentId, options) => {
      calls.push(["resume", agentId, options]);
      return { agentId };
    },
    builtInSubagents: () => {
      builtInsRequested += 1;
      return { researcher: { description: "read", prompt: "inspect" } };
    },
    classifyResumeError: () => "other",
    isSandboxUnavailableError: () => false,
  };
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
  assert.equal(builtInsRequested, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "resume");
  assert.deepEqual(calls[0][2].local, {
    cwd: "C:/workspace",
    autoReview: true,
    enableAgentRetries: true,
    sandbox: { enabled: true },
    settingSources: ["user"],
  });
  assert.deepEqual(calls[0][2].subagents, {
    researcher: { description: "read", prompt: "inspect" },
  });
  assert.deepEqual(calls[0][2].mcpServers, {
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
  const backend = {
    capabilities: unsupportedCapabilities,
    create: async (options) => {
      createOptions = options;
      return { agentId: "replacement-agent" };
    },
    resume: async () => {
      throw new Error("resume must not be called");
    },
    builtInSubagents: () => {
      throw new Error("subagents must not be requested");
    },
    classifyResumeError: () => "other",
    isSandboxUnavailableError: () => false,
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
  const calls = [];
  let saves = 0;
  const backend = {
    capabilities: supportedCapabilities,
    create: async () => {
      calls.push("create");
      return { agentId: "replacement-agent" };
    },
    resume: async () => {
      calls.push("resume");
      throw recoverable.error;
    },
    builtInSubagents: () => ({}),
    classifyResumeError: (error) => (error === recoverable.error ? recoverable.kind : "other"),
    isSandboxUnavailableError: () => false,
  };
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
  assert.deepEqual(calls, ["resume", "create"], recoverable.label);
  assert.equal(saves, 1, recoverable.label);
}

for (const fatal of [
  Object.assign(new Error("service unavailable"), { status: 503, isRetryable: true }),
  Object.assign(new Error("invalid API key"), { status: 401, code: "unauthenticated" }),
]) {
  let creates = 0;
  let saves = 0;
  const backend = {
    capabilities: supportedCapabilities,
    create: async () => {
      creates += 1;
      return { agentId: "must-not-be-created" };
    },
    resume: async () => {
      throw fatal;
    },
    builtInSubagents: () => ({}),
    classifyResumeError: () => "other",
    isSandboxUnavailableError: () => false,
  };
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
  assert.equal(creates, 0);
  assert.equal(saves, 0);
}
