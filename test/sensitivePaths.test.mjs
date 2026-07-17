import assert from "node:assert/strict";
import test from "node:test";
import {
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

test("createSecretContentMatcher covers secrets but not lockfiles", () => {
  const isSecret = createSecretContentMatcher();
  assert.equal(isSecret(".env"), true);
  assert.equal(isSecret("config/.env.production"), true);
  assert.equal(isSecret("secrets/api.credential.json"), true);
  assert.equal(isSecret("keys/service.key"), true);
  assert.equal(isSecret("tls/server.pem"), true);
  assert.equal(isSecret("package-lock.json"), false);
  assert.equal(isSecret("pnpm-lock.yaml"), false);
  assert.equal(isSecret("yarn.lock"), false);
  assert.equal(isSecret("src/app.ts"), false);
});
