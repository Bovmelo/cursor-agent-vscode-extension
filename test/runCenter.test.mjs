import assert from "node:assert/strict";
import { createRequire, register } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  cloneRunCenterState,
  runCenterEntries,
  runCenterProgressDescription,
  runCenterSections,
} = require("../out/runCenterModel.js");

register(new URL("./runCenter-vscode-loader.mjs", import.meta.url), import.meta.url);
const { RunCenterTreeDataProvider } = await import("../out/runCenter.js");

function completeState() {
  return {
    runId: "run-1",
    plan: [{ id: "plan-1", label: "Inspect", status: "completed" }],
    progress: { message: "Implementing", status: "running", completed: 2, total: 4 },
    changes: [{
      path: "src/feature.ts",
      status: "modified",
      additions: 4,
      deletions: 1,
      open: {
        command: "cursorSubscription.openSessionFile",
        arguments: ["session-1", "C:\\repo\\src\\feature.ts"],
      },
    }],
    verification: [{ id: "test", label: "Unit tests", status: "passed" }],
    error: { message: "A recoverable failure", code: "E_TEST" },
    recoveryActions: [{
      id: "retry",
      label: "Retry",
      command: "cursorSubscription.retryRun",
      arguments: ["run-1"],
    }],
  };
}

test("Run Center preserves the intended section order", () => {
  assert.deepEqual(
    runCenterSections(completeState()).map((node) => node.sectionId),
    ["plan", "progress", "changes", "verification", "error", "recovery"],
  );
});

test("Run Center has pure nodes for every host-pushable state facet", () => {
  const state = completeState();
  assert.equal(runCenterEntries(state, "plan")[0].kind, "plan");
  assert.equal(runCenterEntries(state, "progress")[0].kind, "progress");
  assert.equal(runCenterEntries(state, "changes")[0].kind, "change");
  assert.equal(runCenterEntries(state, "verification")[0].kind, "verification");
  assert.equal(runCenterEntries(state, "error")[0].kind, "error");
  assert.equal(runCenterEntries(state, "recovery")[0].kind, "recovery");
  assert.deepEqual(runCenterSections({}), []);
});

test("progress descriptions clamp invalid host values", () => {
  assert.equal(
    runCenterProgressDescription({ message: "Run", status: "running", completed: 8, total: 5 }),
    "5/5",
  );
  assert.equal(
    runCenterProgressDescription({ message: "Run", status: "running", percent: 150 }),
    "100%",
  );
  assert.equal(
    runCenterProgressDescription({ message: "Waiting", status: "queued" }),
    "queued",
  );
});

test("snapshot cloning prevents later array and command-argument mutation", () => {
  const source = completeState();
  const cloned = cloneRunCenterState(source);
  source.plan.push({ id: "late", label: "Late mutation", status: "pending" });
  source.plan[0].label = "Mutated label";
  source.recoveryActions[0].arguments.push("late");
  source.changes[0].open.arguments.push("late");
  assert.equal(cloned.plan.length, 1);
  assert.equal(cloned.plan[0].label, "Inspect");
  assert.deepEqual(cloned.recoveryActions[0].arguments, ["run-1"]);
  assert.deepEqual(cloned.changes[0].open, {
    command: "cursorSubscription.openSessionFile",
    arguments: ["session-1", "C:\\repo\\src\\feature.ts"],
  });
});

test("TreeDataProvider accepts pushed snapshots and exposes recovery commands", () => {
  const provider = new RunCenterTreeDataProvider(false);
  let changeEvents = 0;
  const subscription = provider.onDidChangeTreeData(() => changeEvents++);

  provider.pushState(completeState());
  assert.equal(changeEvents, 1);

  const roots = provider.getChildren();
  assert.deepEqual(roots.map((node) => node.sectionId), [
    "plan",
    "progress",
    "changes",
    "verification",
    "error",
    "recovery",
  ]);
  const recoverySection = roots.at(-1);
  const [recoveryNode] = provider.getChildren(recoverySection);
  const recoveryItem = provider.getTreeItem(recoveryNode);
  assert.deepEqual(recoveryItem.command, {
    command: "cursorSubscription.retryRun",
    title: "Retry",
    arguments: ["run-1"],
  });

  const planItem = provider.getTreeItem(roots[0]);
  assert.equal(planItem.description, "1");
  assert.equal(planItem.accessibilityInformation.label, "Plan: 1");

  const changesSection = roots.find((node) => node.sectionId === "changes");
  const [changeNode] = provider.getChildren(changesSection);
  const changeItem = provider.getTreeItem(changeNode);
  assert.equal(changeItem.description, "Modified +4 -1");
  assert.deepEqual(changeItem.command, {
    command: "cursorSubscription.openSessionFile",
    title: "src/feature.ts",
    arguments: ["session-1", "C:\\repo\\src\\feature.ts"],
  });

  provider.clear();
  assert.deepEqual(provider.getChildren(), []);
  assert.equal(changeEvents, 2);
  subscription.dispose();
  provider.dispose();
});

test("change status labels localize in the tree description", () => {
  const provider = new RunCenterTreeDataProvider(true, {
    changes: [
      { path: "a.ts", status: "added" },
      { path: "b.ts", status: "modified", additions: 2 },
      { path: "c.ts", status: "deleted" },
      { path: "d.ts", status: "renamed", previousPath: "old.ts" },
    ],
  });
  const [changesSection] = provider.getChildren();
  const items = provider.getChildren(changesSection).map((node) => provider.getTreeItem(node));
  assert.deepEqual(
    items.map((item) => item.description),
    ["追加", "変更 +2", "削除", "名前変更"],
  );
  provider.dispose();
});
