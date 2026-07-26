import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { register } from "node:module";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";

register(new URL("./hooks.vscode-loader.mjs", import.meta.url), import.meta.url);

const [
  { runConfiguredHooks },
  { resetHooksVscodeMock },
] = await Promise.all([
  import("../out/hooks.js"),
  import("./hooks.vscode-mock.mjs"),
]);

async function waitForFile(file, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(file);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${file}`);
}

test("runConfiguredHooks aborts the active command and skips later hooks", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "cursor-hooks-abort-"));
  const started = path.join(root, "started.txt");
  const later = path.join(root, "later.txt");
  const blockingScript = path.join(root, "blocking.mjs");
  const laterScript = path.join(root, "later.mjs");
  const outputLines = [];
  const output = {
    appendLine(value) {
      outputLines.push(value);
    },
  };

  try {
    await writeFile(
      blockingScript,
      [
        'import { writeFileSync } from "node:fs";',
        'writeFileSync(process.argv[2], "started");',
        "setInterval(() => {}, 1_000);",
      ].join("\n"),
    );
    await writeFile(
      laterScript,
      [
        'import { writeFileSync } from "node:fs";',
        'writeFileSync(process.argv[2], "later");',
      ].join("\n"),
    );
    resetHooksVscodeMock({
      preEditCommands: [
        `"${process.execPath}" "${blockingScript}" "${started}"`,
        `"${process.execPath}" "${laterScript}" "${later}"`,
      ],
    });

    const controller = new AbortController();
    const hooks = runConfiguredHooks("preEdit", root, output, controller.signal);
    await waitForFile(started);
    controller.abort();

    let stopTimeout;
    try {
      await Promise.race([
        hooks,
        new Promise((_, reject) => {
          stopTimeout = setTimeout(
            () => reject(new Error("Hook process did not stop after abort")),
            5_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(stopTimeout);
    }

    await assert.rejects(
      () => access(later),
      (error) => error?.code === "ENOENT",
    );
    assert.match(outputLines.join("\n"), /run was cancelled/i);
  } finally {
    resetHooksVscodeMock();
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  }
});
