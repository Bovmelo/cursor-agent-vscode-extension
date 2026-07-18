import assert from "node:assert/strict";
import test from "node:test";
import {
  integrationToggleId,
  isIntegrationEnabled,
  legacyIntegrationToggleId,
  toggleIntegration,
} from "../out/integrationToggles.js";

test("integration IDs are unique for same-named multi-root folders", () => {
  const first = integrationToggleId(
    "skill",
    "file:///C%3A/work/client-a",
    "C:\\work\\client-a\\.cursor\\skills\\review\\SKILL.md",
  );
  const second = integrationToggleId(
    "skill",
    "file:///D%3A/work/client-a",
    "D:\\work\\client-a\\.cursor\\skills\\review\\SKILL.md",
  );

  assert.notEqual(first, second);
  assert.match(first, /^skill:file%3A%2F%2F%2FC%253A/);
});

test("legacy disabled IDs remain effective after stable ID migration", () => {
  const legacyId = legacyIntegrationToggleId("command", "app", "deploy");
  const stableId = integrationToggleId(
    "command",
    "file:///C%3A/work/app",
    "C:\\work\\app\\.cursor\\commands\\deploy.md",
  );
  const state = toggleIntegration(undefined, legacyId, false);

  assert.equal(isIntegrationEnabled(state, stableId, [legacyId]), false);
  assert.equal(isIntegrationEnabled(state, stableId), true);

  const reEnabled = toggleIntegration(state, stableId, true, [legacyId]);
  assert.deepEqual(reEnabled.disabledIds, []);
  assert.equal(isIntegrationEnabled(reEnabled, stableId, [legacyId]), true);
});

test("disabling migrates legacy toggle state to the stable ID", () => {
  const legacyId = legacyIntegrationToggleId("skill", "app", "review");
  const stableId = integrationToggleId(
    "skill",
    "file:///C%3A/work/app",
    "C:\\work\\app\\.cursor\\skills\\review\\SKILL.md",
  );

  const disabled = toggleIntegration({ disabledIds: [legacyId] }, stableId, false, [legacyId]);
  assert.deepEqual(disabled.disabledIds, [stableId]);
});

test("enabling one shared-legacy item does not enable its sibling", () => {
  const legacyId = legacyIntegrationToggleId("skill", "app", "review");
  const idA = integrationToggleId(
    "skill",
    "file:///C%3A/work/client-a",
    "C:\\work\\client-a\\.cursor\\skills\\review\\SKILL.md",
  );
  const idB = integrationToggleId(
    "skill",
    "file:///D%3A/work/client-a",
    "D:\\work\\client-a\\.cursor\\skills\\review\\SKILL.md",
  );
  const state = { disabledIds: [legacyId] };

  const after = toggleIntegration(state, idA, true, [legacyId], { [legacyId]: [idB] });

  assert.equal(isIntegrationEnabled(after, idA, [legacyId]), true);
  assert.equal(isIntegrationEnabled(after, idB, [legacyId]), false);
  assert.ok(!after.disabledIds.includes(legacyId));
  assert.deepEqual(after.disabledIds, [idB]);
});

test("disabling keeps a shared legacyId while writing the stable id", () => {
  const legacyId = legacyIntegrationToggleId("skill", "app", "review");
  const idA = integrationToggleId(
    "skill",
    "file:///C%3A/work/client-a",
    "C:\\work\\client-a\\.cursor\\skills\\review\\SKILL.md",
  );
  const idB = integrationToggleId(
    "skill",
    "file:///D%3A/work/client-a",
    "D:\\work\\client-a\\.cursor\\skills\\review\\SKILL.md",
  );

  const disabled = toggleIntegration(
    { disabledIds: [legacyId] },
    idA,
    false,
    [legacyId],
    { [legacyId]: [idB] },
  );

  assert.ok(disabled.disabledIds.includes(idA));
  assert.ok(disabled.disabledIds.includes(legacyId));
  assert.equal(isIntegrationEnabled(disabled, idA, [legacyId]), false);
  assert.equal(isIntegrationEnabled(disabled, idB, [legacyId]), false);
});
