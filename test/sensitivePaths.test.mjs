import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEFAULT_SECRET_CONTENT_GLOBS,
  DEFAULT_SENSITIVE_GLOBS,
  createSecretContentMatcher,
  globRegex,
} from "../out/sensitivePathMatch.js";

test("globRegex matches optional ** prefixes and is case-insensitive", () => {
  const env = globRegex("**/.env*");
  assert.equal(env.test(".env"), true);
  assert.equal(env.test("apps/api/.env.local"), true);
  assert.equal(env.test("README.md"), false);

  const pem = globRegex("**/*.pem");
  assert.equal(pem.test("certs/server.PEM"), true);
  assert.equal(pem.test("certs/server.crt"), false);
});

test("createSecretContentMatcher covers secrets and conventional auth files but not lockfiles", () => {
  const isSecret = createSecretContentMatcher();
  assert.equal(isSecret(".env"), true);
  assert.equal(isSecret("config/.env.production"), true);
  assert.equal(isSecret("secrets/api.credential.json"), true);
  assert.equal(isSecret("keys/service.key"), true);
  assert.equal(isSecret("tls/server.pem"), true);
  assert.equal(isSecret(".netrc"), true);
  assert.equal(isSecret("home/_netrc"), true);
  assert.equal(isSecret("packages/widget/.npmrc"), true);
  assert.equal(isSecret("python/.pypirc"), true);
  assert.equal(isSecret("ruby/.gem/credentials"), true);
  assert.equal(isSecret("frontend/.yarnrc"), true);
  assert.equal(isSecret("frontend/.yarnrc.yml"), true);
  assert.equal(isSecret(".docker/config.json"), true);
  assert.equal(isSecret("home/.config/gh/hosts.yml"), true);
  assert.equal(isSecret("cluster/.kube/config"), true);
  assert.equal(isSecret("package-lock.json"), false);
  assert.equal(isSecret("pnpm-lock.yaml"), false);
  assert.equal(isSecret("yarn.lock"), false);
  assert.equal(isSecret("examples/.npmrc.example"), false);
  assert.equal(isSecret("src/app.ts"), false);
});

test("default apply exclusions include every secret-content glob", () => {
  for (const pattern of DEFAULT_SECRET_CONTENT_GLOBS) {
    assert.equal(
      DEFAULT_SENSITIVE_GLOBS.includes(pattern),
      true,
      `${pattern} should also be excluded from apply`,
    );
  }
});

test("manifest apply exclusions stay synchronized with the runtime defaults", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const configured = manifest.contributes.configuration.properties[
    "cursorSubscription.supervisorExcludedGlobs"
  ].default;
  assert.deepEqual(new Set(configured), new Set(DEFAULT_SENSITIVE_GLOBS));
});
