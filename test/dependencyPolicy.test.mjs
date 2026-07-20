import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const auditSource = await readFile(
  new URL("../scripts/audit-dependencies.mjs", import.meta.url),
  "utf8",
);

test("production transport pins the audited undici release", async () => {
  assert.equal(packageJson.overrides?.["@connectrpc/connect-node"]?.undici, "7.28.0");

  const undiciPackage = JSON.parse(
    await readFile(new URL("../node_modules/undici/package.json", import.meta.url), "utf8"),
  );
  assert.equal(undiciPackage.version, "7.28.0");

  const [undici, connectNode] = await Promise.all([
    import("undici"),
    import("@connectrpc/connect-node"),
  ]);
  assert.equal(typeof undici.Headers, "function");
  assert.equal(typeof undici.request, "function");
  assert.equal(typeof connectNode.createConnectTransport, "function");
});

test("production dependency audit contains no temporary advisory exceptions", () => {
  assert.doesNotMatch(auditSource, /acceptedAdvisories|acceptanceExpires/u);
  assert.match(
    auditSource,
    /Dependency audit passed with no high\/critical production vulnerabilities\./u,
  );
});
