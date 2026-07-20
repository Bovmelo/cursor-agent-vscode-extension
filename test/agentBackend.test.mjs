import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { backendSupports, CursorSdkBackend } from "../out/agentBackend.js";
import { AgentNotFoundError } from "@cursor/sdk";

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
