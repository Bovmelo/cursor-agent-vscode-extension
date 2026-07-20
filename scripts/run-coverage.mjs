import { spawnSync } from "node:child_process";

const thresholds = Object.freeze({
  branches: 70,
  functions: 80,
  lines: 75,
});

const result = spawnSync(
  process.execPath,
  [
    "--experimental-test-coverage",
    "--test",
    `--test-coverage-branches=${thresholds.branches}`,
    `--test-coverage-functions=${thresholds.functions}`,
    `--test-coverage-lines=${thresholds.lines}`,
    "--test-coverage-exclude=test/**",
    "test/*.test.mjs",
  ],
  {
    stdio: "inherit",
  },
);

if (result.error) {
  throw result.error;
}

if (result.signal) {
  console.error(`Coverage test runner terminated by ${result.signal}.`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
