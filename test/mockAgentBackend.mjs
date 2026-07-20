/**
 * Test-only AgentBackend double. Keep this out of src/ so production never
 * imports a mock implementation.
 */

const DEFAULT_CAPABILITIES = Object.freeze({
  sandbox: "supported",
  resume: "supported",
  subagents: "supported",
  mcpServers: "supported",
  settingSources: "supported",
  agentRetries: "supported",
});

const DEFAULT_SUBAGENTS = Object.freeze({
  researcher: Object.freeze({
    description: "mock researcher",
    prompt: "mock researcher prompt",
    model: "inherit",
  }),
  implementer: Object.freeze({
    description: "mock implementer",
    prompt: "mock implementer prompt",
    model: "inherit",
  }),
  reviewer: Object.freeze({
    description: "mock reviewer",
    prompt: "mock reviewer prompt",
    model: "inherit",
  }),
});

function clone(value) {
  return structuredClone(value);
}

export class MockAgentBackend {
  /**
   * @param {{
   *   capabilities?: Readonly<Record<string, "supported" | "unsupported">>,
   *   createHandler?: (options: unknown) => Promise<unknown> | unknown,
   *   resumeHandler?: (agentId: string, options: unknown) => Promise<unknown> | unknown,
   *   resumeError?: unknown,
   *   classifyResumeError?: (error: unknown) => "session-not-found" | "invalid-agent-id" | "other",
   *   isSandboxUnavailableError?: (error: unknown) => boolean,
   *   sandboxUnavailable?: boolean,
   *   builtInSubagents?: Readonly<Record<string, unknown>>,
   * }} [options]
   */
  constructor(options = {}) {
    this.capabilities = Object.freeze({ ...DEFAULT_CAPABILITIES, ...options.capabilities });
    this.calls = [];
    this.createHandler = options.createHandler;
    this.resumeHandler = options.resumeHandler;
    this.resumeError = options.resumeError;
    this.classifyResumeErrorImpl = options.classifyResumeError;
    this.isSandboxUnavailableErrorImpl = options.isSandboxUnavailableError;
    this.sandboxUnavailable = options.sandboxUnavailable ?? false;
    this.subagents = options.builtInSubagents ?? DEFAULT_SUBAGENTS;
    this.agentSeq = 0;
  }

  async create(options) {
    this.calls.push(["create", clone(options)]);
    if (this.createHandler) {
      return this.createHandler(options);
    }
    this.agentSeq += 1;
    return { agentId: `mock-agent-${this.agentSeq}` };
  }

  async resume(agentId, options) {
    this.calls.push(["resume", agentId, clone(options)]);
    if (this.resumeError !== undefined) {
      throw this.resumeError;
    }
    if (this.resumeHandler) {
      return this.resumeHandler(agentId, options);
    }
    return { agentId };
  }

  builtInSubagents() {
    this.calls.push(["builtInSubagents"]);
    return this.subagents;
  }

  classifyResumeError(error) {
    this.calls.push(["classifyResumeError", error]);
    if (this.classifyResumeErrorImpl) {
      return this.classifyResumeErrorImpl(error);
    }
    return "other";
  }

  isSandboxUnavailableError(error) {
    this.calls.push(["isSandboxUnavailableError", error]);
    if (this.isSandboxUnavailableErrorImpl) {
      return this.isSandboxUnavailableErrorImpl(error);
    }
    if (this.sandboxUnavailable) {
      return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("sandboxing is not supported in this environment")
      || message.includes("Local SDK sandboxing was requested");
  }
}
