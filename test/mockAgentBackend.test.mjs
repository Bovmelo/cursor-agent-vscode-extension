import assert from "node:assert/strict";
import test from "node:test";
import { backendSupports } from "../out/agentBackend.js";
import { MockAgentBackend } from "./mockAgentBackend.mjs";

test("MockAgentBackend records calls and returns default agents", async () => {
  const backend = new MockAgentBackend();
  const created = await backend.create({
    apiKey: "secret",
    model: { id: "composer" },
    name: "workspace",
    local: { cwd: "C:/workspace", autoReview: true },
  });
  const resumed = await backend.resume("existing", {
    apiKey: "secret",
    local: { cwd: "C:/workspace", autoReview: true },
  });

  assert.equal(created.agentId, "mock-agent-1");
  assert.equal(resumed.agentId, "existing");
  assert.equal(backend.calls[0][0], "create");
  assert.equal(backend.calls[0][1].apiKey, "secret");
  assert.equal(backend.calls[1][0], "resume");
  assert.equal(backend.calls[1][1], "existing");
  assert.equal(backendSupports(backend, "resume"), true);
  assert.deepEqual(Object.keys(backend.builtInSubagents()), [
    "researcher",
    "implementer",
    "reviewer",
  ]);
  assert.equal(backend.calls.some((call) => call[0] === "builtInSubagents"), true);
});

test("MockAgentBackend honors handler and classification overrides", async () => {
  const backend = new MockAgentBackend({
    capabilities: {
      sandbox: "unsupported",
      resume: "supported",
      subagents: "unsupported",
      mcpServers: "unsupported",
      settingSources: "unsupported",
      agentRetries: "unsupported",
    },
    createHandler: async () => ({ agentId: "custom-created" }),
    resumeHandler: async (agentId) => ({ agentId: `resumed-${agentId}` }),
    classifyResumeError: (error) =>
      error && typeof error === "object" && error.code === "agent_not_found"
        ? "session-not-found"
        : "other",
    isSandboxUnavailableError: () => true,
  });

  assert.equal(backendSupports(backend, "sandbox"), false);
  assert.equal((await backend.create({})).agentId, "custom-created");
  assert.equal((await backend.resume("abc", {})).agentId, "resumed-abc");
  assert.equal(backend.classifyResumeError({ code: "agent_not_found" }), "session-not-found");
  assert.equal(backend.classifyResumeError({ code: "other" }), "other");
  assert.equal(backend.isSandboxUnavailableError(new Error("unrelated")), true);
});

test("MockAgentBackend can throw configured resume errors", async () => {
  const resumeError = { code: "invalid_agent_id" };
  const backend = new MockAgentBackend({
    resumeError,
    classifyResumeError: (error) => (error === resumeError ? "invalid-agent-id" : "other"),
    sandboxUnavailable: true,
  });

  await assert.rejects(backend.resume("gone", {}), (error) => error === resumeError);
  assert.equal(backend.classifyResumeError(resumeError), "invalid-agent-id");
  assert.equal(backend.isSandboxUnavailableError(new Error("quiet")), true);
  assert.equal(
    new MockAgentBackend().isSandboxUnavailableError(
      new Error("Local SDK sandboxing was requested"),
    ),
    true,
  );
});
