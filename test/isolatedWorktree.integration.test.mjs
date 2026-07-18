import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const loader = new URL("./vscode-runtime-loader.mjs", import.meta.url).href;
const child = fileURLToPath(new URL("./isolatedWorktree.integration.child.mjs", import.meta.url));

test("isolated worktree prepares, collects, applies, and cleans up a dirty Git workspace", async () => {
  try {
    await execFileAsync(process.execPath, ["--experimental-loader", loader, child], {
      windowsHide: true,
      timeout: 30_000,
    });
  } catch (error) {
    assert.fail(`isolated-worktree integration child failed: ${error.stderr ?? error.message}`);
  }
});
