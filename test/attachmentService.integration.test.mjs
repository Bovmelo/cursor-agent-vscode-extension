import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const loader = new URL("./attachmentService.vscode-loader.mjs", import.meta.url).href;
const child = fileURLToPath(new URL("./attachmentService.integration.child.mjs", import.meta.url));

test("attachment service enforces staging, recovery, and orphan cleanup boundaries", async () => {
  try {
    await execFileAsync(process.execPath, ["--experimental-loader", loader, child], {
      windowsHide: true,
      timeout: 30_000,
    });
  } catch (error) {
    assert.fail(`attachment-service integration child failed: ${error.stderr ?? error.message}`);
  }
});
