import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { backendSupports, CursorSdkBackend } from "../out/agentBackend.js";
import { Agent, AgentNotFoundError } from "@cursor/sdk";

const execFileAsync = promisify(execFile);

test("Cursor SDK backend advertises the optional features used by AgentFactory", () => {
  const backend = new CursorSdkBackend();

  for (const capability of [
    "sandbox",
    "resume",
    "subagents",
    "mcpServers",
    "settingSources",
    "agentRetries",
  ]) {
    assert.equal(backendSupports(backend, capability), true, capability);
  }
});

test("Cursor SDK backend owns immutable built-in subagent definitions", () => {
  const backend = new CursorSdkBackend();
  const definitions = backend.builtInSubagents();

  assert.deepEqual(Object.keys(definitions), ["researcher", "implementer", "reviewer"]);
  assert.equal(definitions.researcher.model, "inherit");
  assert.equal(Object.isFrozen(definitions), true);
  assert.equal(Object.isFrozen(definitions.researcher), true);
});

test("SDK connections retain every workspace root and the local safety options", async (t) => {
  const requests = [];
  const fakeAgent = { agentId: "local-test-agent" };
  t.mock.method(Agent, "create", async (options) => {
    requests.push(options);
    return fakeAgent;
  });
  t.mock.method(Agent, "resume", async (agentId, options) => {
    assert.equal(agentId, fakeAgent.agentId);
    requests.push(options);
    return fakeAgent;
  });
  const roots = ["/workspace/main", "/workspace/secondary", "/workspace/third"];
  const local = {
    cwd: roots,
    autoReview: true,
    enableAgentRetries: true,
    sandbox: { enabled: true },
    settingSources: ["project"],
  };
  const backend = new CursorSdkBackend();

  assert.equal(await backend.create({
    apiKey: "test-key-not-a-credential",
    model: { id: "auto" },
    name: "workspace mapping regression",
    local,
  }), fakeAgent);
  assert.equal(await backend.resume(fakeAgent.agentId, {
    apiKey: "test-key-not-a-credential",
    local,
  }), fakeAgent);

  for (const request of requests) {
    assert.deepEqual(request.local, {
      cwd: "/workspace/main",
      dirs: ["/workspace/secondary", "/workspace/third"],
      autoReview: true,
      enableAgentRetries: true,
      sandboxOptions: { enabled: true },
      settingSources: ["project"],
    });
  }
  assert.deepEqual(roots, ["/workspace/main", "/workspace/secondary", "/workspace/third"]);
});

test("SDK connections use a scalar cwd for single-root workspaces and reject no roots", async (t) => {
  const requests = [];
  t.mock.method(Agent, "create", async (options) => {
    requests.push(options);
    return { agentId: "local-test-agent" };
  });
  const backend = new CursorSdkBackend();
  const options = {
    apiKey: "test-key-not-a-credential",
    model: { id: "auto" },
    name: "single workspace",
  };

  for (const cwd of ["/workspace/main", ["/workspace/main"]]) {
    await backend.create({ ...options, local: { cwd, autoReview: true } });
  }
  for (const request of requests) {
    assert.equal(request.local.cwd, "/workspace/main");
    assert.equal(Object.hasOwn(request.local, "dirs"), false);
  }
  await assert.rejects(
    backend.create({ ...options, local: { cwd: [], autoReview: true } }),
    /At least one working directory is required/u,
  );
  assert.equal(requests.length, 2);
});

test("Cursor SDK backend narrowly classifies recoverable resume failures", () => {
  const backend = new CursorSdkBackend();

  assert.equal(backend.classifyResumeError(new AgentNotFoundError("missing")), "session-not-found");
  assert.equal(backend.classifyResumeError({ code: "agent_not_found" }), "session-not-found");
  assert.equal(backend.classifyResumeError({ code: "invalid_agent_id" }), "invalid-agent-id");
  assert.equal(
    backend.classifyResumeError(new Error("Agent ID must be in the format 'bc-<uuid>'")),
    "invalid-agent-id",
  );

  for (const error of [
    { status: 404, code: "not_found" },
    { status: 401, code: "unauthenticated" },
    { status: 503, isRetryable: true },
    new Error("Agent abc not found"),
  ]) {
    assert.equal(backend.classifyResumeError(error), "other");
  }
});

test("AgentFactory keeps its existing constructor and accepts an injected backend", async () => {
  const source = await readFile(new URL("../src/agentFactory.ts", import.meta.url), "utf8");

  assert.match(source, /private readonly backend: AgentBackend = new CursorSdkBackend\(\)/u);
  assert.match(source, /backendSupports\(this\.backend, "resume"\)/u);
  assert.match(source, /this\.backend\.builtInSubagents\(\)/u);
  assert.match(source, /this\.backend\.classifyResumeError\(error\)/u);
  assert.match(source, /this\.backend\.isSandboxUnavailableError\(error\)/u);
});

test("AgentFactory negotiates backend capabilities through dependency injection", async () => {
  const loader = new URL("./vscode-runtime-loader.mjs", import.meta.url).href;
  const child = fileURLToPath(new URL("./agentBackend.integration.child.mjs", import.meta.url));

  try {
    await execFileAsync(process.execPath, ["--experimental-loader", loader, child], {
      windowsHide: true,
      timeout: 10_000,
    });
  } catch (error) {
    assert.fail(`agent-backend integration child failed: ${error.stderr ?? error.message}`);
  }
});
