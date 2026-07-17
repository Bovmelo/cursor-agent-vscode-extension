import assert from "node:assert/strict";
import test from "node:test";
import {
  appendAuditEntry,
  formatAuditLogMarkdown,
} from "../out/auditLog.js";
import {
  attachSubtasks,
  buildOrchestratorDetail,
  buildSynthesisPrompt,
  createOrchestratorExperiment,
  extractSubagentName,
  markSubtaskConversation,
  markSubtaskStatus,
  orchestratorSummaries,
  parseOrchestratorSubtasks,
} from "../out/orchestrator.js";
import {
  parseSupervisorReviewVerdict,
  scanTodoAiComments,
} from "../out/todoScanner.js";
import {
  budgetSnapshot,
  estimatedMonthlyCostSnapshot,
  emptyUsage,
  monthlyBudgetSnapshot,
  recordUsage,
} from "../out/usageStats.js";
import {
  isIntegrationEnabled,
  toggleIntegration,
} from "../out/integrationToggles.js";
import {
  dependencyReadiness,
  selectRunnableSupervisorTasks,
} from "../out/supervisorScheduling.js";
import { parseGitHubSupervisorSignals } from "../out/githubTriggers.js";
import { parseExecutionPlanSteps } from "../out/executionPlan.js";
import { ApplyQueue, FileOwnershipCoordinator } from "../out/parallelOwnership.js";
import {
  inlineCompletionAcceptanceRate,
  sanitizeInlineCompletion,
  shouldRequestInlineCompletion,
} from "../out/inlineCompletion.js";

test("scanTodoAiComments finds TODO(ai) markers", () => {
  const matches = scanTodoAiComments([
    "// TODO(ai): wire the pipeline",
    "const x = 1;",
    "# TODO(ai): fix docs",
    "/* TODO(ai): refactor */",
  ].join("\n"));
  assert.equal(matches.length, 3);
  assert.equal(matches[0].line, 1);
  assert.match(matches[0].text, /pipeline/);
});

test("parseSupervisorReviewVerdict reads approve and reject blocks", () => {
  const approved = parseSupervisorReviewVerdict([
    "Looks fine.",
    "<SUPERVISOR_REVIEW_VERDICT>",
    '{"verdict":"approve","reasons":["small focused change"]}',
    "</SUPERVISOR_REVIEW_VERDICT>",
  ].join("\n"));
  assert.equal(approved?.verdict, "approve");
  assert.equal(approved?.reasons[0], "small focused change");

  const rejected = parseSupervisorReviewVerdict(
    '<SUPERVISOR_REVIEW_VERDICT>{"verdict":"reject","reasons":["touches secrets"]}</SUPERVISOR_REVIEW_VERDICT>',
  );
  assert.equal(rejected?.verdict, "reject");
});

test("orchestrator parses subtasks and advances through synthesis", () => {
  const parsed = parseOrchestratorSubtasks([
    "<ORCHESTRATOR_SUBTASKS>",
    '[{"title":"A","prompt":"do A"},{"title":"B","prompt":"do B"}]',
    "</ORCHESTRATOR_SUBTASKS>",
  ].join("\n"));
  assert.equal(parsed.length, 2);

  let experiment = createOrchestratorExperiment("build feature");
  experiment = attachSubtasks(experiment, parsed);
  assert.equal(experiment.status, "running");
  assert.equal(experiment.subtasks.length, 2);

  experiment = markSubtaskConversation(experiment, experiment.subtasks[0].id, "c1");
  experiment = markSubtaskConversation(experiment, experiment.subtasks[1].id, "c2");
  experiment = markSubtaskStatus(experiment, "c1", "completed");
  assert.equal(experiment.status, "running");
  experiment = markSubtaskStatus(experiment, "c2", "completed");
  assert.equal(experiment.status, "synthesizing");
  assert.match(buildSynthesisPrompt(experiment), /Integrate the parallel subtask/);

  const summaries = orchestratorSummaries([experiment]);
  assert.equal(summaries[0].subtaskCount, 2);
  assert.equal(summaries[0].completedCount, 2);
  assert.equal(summaries[0].status, "synthesizing");

  const detail = buildOrchestratorDetail(experiment, new Set(["c1"]));
  assert.equal(detail.subtasks[0].running, true);
  assert.equal(detail.subtasks[1].running, false);
  assert.equal(detail.subtasks[0].activity, undefined);

  const withActivity = buildOrchestratorDetail(
    experiment,
    new Set(["c1"]),
    new Map([["c1", { text: "Reading file: src/a.ts", path: "src/a.ts" }]]),
  );
  assert.equal(withActivity.subtasks[0].activity?.path, "src/a.ts");
  assert.match(withActivity.subtasks[0].activity?.text ?? "", /Reading file/);
  assert.equal(withActivity.subtasks[1].activity, undefined);

  assert.equal(extractSubagentName({ subagent_type: "researcher" }), "researcher");
  assert.equal(extractSubagentName({ name: "implementer" }), "implementer");
  assert.equal(extractSubagentName({}), undefined);
});

test("audit log appends and formats markdown", () => {
  const entries = appendAuditEntry(undefined, {
    action: "supervisor.apply",
    summary: "Applied src/a.ts",
    files: ["src/a.ts"],
    taskId: "t1",
  });
  assert.equal(entries.length, 1);
  const markdown = formatAuditLogMarkdown(entries);
  assert.match(markdown, /AI Audit Log/);
  assert.match(markdown, /supervisor\.apply/);
  assert.match(markdown, /src\/a\.ts/);
});

test("budgetSnapshot warns and exceeds thresholds", () => {
  assert.equal(budgetSnapshot(undefined, 0), undefined);
  let ledger = recordUsage(undefined, "chat", {
    ...emptyUsage(),
    totalTokens: 80,
    inputTokens: 80,
  });
  const warning = budgetSnapshot(ledger, 100);
  assert.equal(warning?.status, "warning");
  ledger = recordUsage(ledger, "supervisor", {
    ...emptyUsage(),
    totalTokens: 30,
    inputTokens: 30,
  });
  const exceeded = budgetSnapshot(ledger, 100);
  assert.equal(exceeded?.status, "exceeded");
});

test("integration toggles disable and re-enable ids", () => {
  const disabled = toggleIntegration(undefined, "skill:demo:review", false);
  assert.equal(isIntegrationEnabled(disabled, "skill:demo:review"), false);
  const enabled = toggleIntegration(disabled, "skill:demo:review", true);
  assert.equal(isIntegrationEnabled(enabled, "skill:demo:review"), true);
});

test("Supervisor scheduler honors dependencies, priority, cycles, and file ownership", () => {
  const tasks = [
    { id: "done", createdAt: 1, status: "completed", priority: "normal" },
    { id: "low", createdAt: 2, status: "queued", priority: "low", file: "src/shared.ts" },
    {
      id: "high",
      createdAt: 3,
      status: "queued",
      priority: "high",
      dependencyIds: ["done"],
      file: "src/shared.ts",
    },
    { id: "other", createdAt: 4, status: "queued", priority: "normal", file: "src/other.ts" },
  ];
  assert.equal(dependencyReadiness(tasks[2], tasks).ready, true);
  assert.deepEqual(
    selectRunnableSupervisorTasks(tasks, 3).map((task) => task.id),
    ["high", "other"],
  );
  const cycle = [
    { id: "a", createdAt: 1, status: "queued", dependencyIds: ["b"] },
    { id: "b", createdAt: 2, status: "queued", dependencyIds: ["a"] },
  ];
  assert.equal(dependencyReadiness(cycle[0], cycle).ready, false);
  assert.deepEqual(selectRunnableSupervisorTasks(cycle, 2), []);
});

test("GitHub trigger parser selects failed checks and actionable review feedback", () => {
  const signals = parseGitHubSupervisorSignals(JSON.stringify({
    number: 42,
    title: "Improve pipeline",
    statusCheckRollup: [
      { name: "unit", conclusion: "FAILURE", completedAt: "2026-07-17" },
      { name: "lint", conclusion: "SUCCESS" },
    ],
    comments: [
      { id: "c1", body: "/cursor please add the missing test", author: { login: "alice" } },
      { id: "c2", body: "looks good", author: { login: "bob" } },
    ],
    reviews: [
      { id: "r1", state: "CHANGES_REQUESTED", body: "Handle the edge case", author: { login: "carol" } },
    ],
  }));
  assert.deepEqual(signals.map((signal) => signal.source), ["ci", "pr-comment", "pr-comment"]);
  assert.match(signals[0].title, /unit/);
  assert.match(signals[1].detail, /missing test/);
});

test("Plan artifacts parse executable checkpoint steps", () => {
  const steps = parseExecutionPlanSteps([
    "Implementation plan:",
    "<CURSOR_EXECUTION_PLAN>",
    '[{"title":"Schema","prompt":"Add the schema"},{"title":"UI","prompt":"Build the UI"}]',
    "</CURSOR_EXECUTION_PLAN>",
  ].join("\n"));
  assert.deepEqual(steps, [
    { title: "Schema", prompt: "Add the schema" },
    { title: "UI", prompt: "Build the UI" },
  ]);
});

test("monthly token and estimated cost budgets aggregate the current month", () => {
  const at = new Date(2026, 6, 17);
  let ledger = recordUsage(undefined, "chat", {
    ...emptyUsage(),
    inputTokens: 800_000,
    totalTokens: 800_000,
  }, at);
  ledger = recordUsage(ledger, "supervisor", {
    ...emptyUsage(),
    inputTokens: 200_000,
    totalTokens: 200_000,
  }, at);
  assert.equal(monthlyBudgetSnapshot(ledger, 1_000_000, at)?.status, "exceeded");
  const cost = estimatedMonthlyCostSnapshot(ledger, 5, 6, at);
  assert.equal(cost?.estimatedUsd, 6);
  assert.equal(cost?.status, "exceeded");
});

test("parallel ownership is atomic and wakes a waiting apply", async () => {
  const ownership = new FileOwnershipCoordinator();
  const first = ownership.tryAcquire("first", ["src/a.ts", "src/b.ts"]);
  assert.ok(first.lease);
  const conflict = ownership.tryAcquire("second", ["src/b.ts", "src/c.ts"]);
  assert.equal(conflict.lease, undefined);
  assert.equal(conflict.conflicts[0].owner, "first");
  assert.equal(ownership.conflicts("first", ["src/a.ts"]).length, 0);

  let acquired = false;
  const waiting = ownership.acquire("second", ["src/b.ts", "src/c.ts"]).then((lease) => {
    acquired = true;
    lease.release();
  });
  await Promise.resolve();
  assert.equal(acquired, false);
  first.lease.release();
  await waiting;
  assert.equal(acquired, true);
});

test("apply queue preserves FIFO order and continues after failure", async () => {
  const queue = new ApplyQueue();
  const order = [];
  const first = queue.run(async () => {
    order.push("first");
    throw new Error("expected");
  });
  const second = queue.run(async () => {
    order.push("second");
    return 2;
  });
  await assert.rejects(first, /expected/);
  assert.equal(await second, 2);
  assert.deepEqual(order, ["first", "second"]);
});

test("inline completion helpers gate, sanitize, and report acceptance", () => {
  assert.equal(shouldRequestInlineCompletion("const value =", "", 3), true);
  assert.equal(shouldRequestInlineCompletion("  ", "", 3), false);
  const completion = sanitizeInlineCompletion(
    "```ts\nconst answer = 42;\nconsole.log(answer);\n```",
    "",
    "",
    { maxCharacters: 200, maxLines: 1 },
  );
  assert.equal(completion, "const answer = 42;");
  assert.equal(inlineCompletionAcceptanceRate({ suggested: 8, accepted: 2 }), 0.25);
  assert.equal(inlineCompletionAcceptanceRate({ suggested: 0, accepted: 0 }), 0);
});
