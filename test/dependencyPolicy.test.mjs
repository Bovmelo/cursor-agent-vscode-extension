import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const auditSource = await readFile(
  new URL("../scripts/audit-dependencies.mjs", import.meta.url),
  "utf8",
);

test("production SDK resolves the patched Zod peer without the obsolete transport override", async () => {
  assert.equal(packageJson.dependencies["@cursor/sdk"], "1.5.2");
  assert.equal(packageJson.dependencies.zod, "4.6.7");
  assert.equal(packageJson.dependencies.dompurify, "3.5.0");
  assert.equal(packageJson.overrides?.["@connectrpc/connect-node"], undefined);

  const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  for (const [name, entry] of Object.entries(lock.packages)) {
    if (entry.dev) continue;
    if (name.endsWith("/zod")) assert.equal(entry.version, "4.6.7");
    assert.ok(!name.endsWith("/undici"), `Unexpected obsolete transport: ${name}`);
  }

  const [{ Agent, Cursor }, { z }] = await Promise.all([import("@cursor/sdk"), import("zod")]);
  assert.equal(typeof Agent.create, "function");
  assert.equal(typeof Cursor.models.list, "function");
  assert.equal(z.object({ model: z.string() }).parse({ model: "auto" }).model, "auto");
});

test("production dependency audit contains no temporary advisory exceptions", () => {
  assert.doesNotMatch(auditSource, /acceptedAdvisories|acceptanceExpires/u);
  assert.match(auditSource, /Dependency audit passed with no known production vulnerabilities\./u);
});
