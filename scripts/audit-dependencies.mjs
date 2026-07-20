import { spawnSync } from "node:child_process";

const npmExecPath = process.env.npm_execpath;
if (!npmExecPath) {
  throw new Error("Run this check through npm so npm_execpath is available.");
}

const audit = spawnSync(process.execPath, [npmExecPath, "audit", "--json", "--omit=dev"], {
  encoding: "utf8",
  env: process.env,
  maxBuffer: 16 * 1024 * 1024,
});

if (audit.error) {
  throw audit.error;
}

let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  throw new Error(`npm audit did not return JSON:\n${audit.stderr || audit.stdout}`);
}

if (report.error) {
  throw new Error(`npm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
}

const vulnerabilities = report.vulnerabilities ?? {};
const advisoryIdsFor = (name, visited = new Set()) => {
  if (visited.has(name)) return new Set();
  visited.add(name);
  const ids = new Set();
  for (const via of vulnerabilities[name]?.via ?? []) {
    if (typeof via === "string") {
      for (const id of advisoryIdsFor(via, visited)) ids.add(id);
      continue;
    }
    const id = /\/advisories\/(GHSA-[\w-]+)/u.exec(via.url ?? "")?.[1];
    if (id) ids.add(id);
  }
  return ids;
};

const blocked = [];
for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
  if (!new Set(["high", "critical"]).has(vulnerability.severity)) continue;
  const ids = advisoryIdsFor(name);
  blocked.push({ ids: [...ids], name, severity: vulnerability.severity });
}

if (blocked.length > 0) {
  const details = blocked
    .map(
      ({ ids, name, severity }) =>
        `- ${name} (${severity}): ${ids.join(", ") || "unknown advisory"}`,
    )
    .join("\n");
  throw new Error(`Unaccepted high/critical production dependency vulnerabilities:\n${details}`);
}

console.log("Dependency audit passed with no high/critical production vulnerabilities.");
