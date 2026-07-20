import assert from "node:assert/strict";
import test from "node:test";
import {
  localizeWorkflowRecipe,
  workflowRecipe,
  workflowRecipes,
} from "../out/workflowRecipes.js";

test("workflow recipes reduce the product to four user intents", () => {
  assert.deepEqual(workflowRecipes().map((recipe) => recipe.id), ["ask", "change", "delegate", "review"]);
  assert.equal(workflowRecipe("delegate")?.command, "cursorSubscription.startBackgroundJob");
  assert.equal(workflowRecipe("missing"), undefined);
});

test("mutating workflows remain trust-bound", () => {
  assert.equal(workflowRecipe("ask")?.trustRequired, false);
  assert.equal(workflowRecipe("change")?.trustRequired, true);
  assert.equal(localizeWorkflowRecipe(workflowRecipe("review"), true).label, "確認・適用する");
});
