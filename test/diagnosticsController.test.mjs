import assert from "node:assert/strict";
import test from "node:test";
import { DiagnosticsController } from "../out/diagnosticsController.js";

function diagnosticBundle() {
  return {
    generatedAt: "2026-07-20T00:00:00.000Z",
    extensionVersion: "0.1.19",
    vscodeVersion: "1.101.0",
    platform: "win32",
    architecture: "x64",
    language: "en",
    workspaceTrusted: true,
    workspaceCount: 1,
    approvalMode: "auto-review",
    checks: [{ label: "API", status: "ok", detail: "api_key=do-not-share" }],
  };
}

test("diagnostics controller collects, redacts, writes, and opens the export", async () => {
  const target = { fsPath: "C:\\tmp\\diagnostics.md" };
  let exportOptions;
  let written;
  let opened;
  const controller = new DiagnosticsController({
    japanese: false,
    collectBundle: diagnosticBundle,
    chooseExportTarget: async (options) => {
      exportOptions = options;
      return target;
    },
    writeText: async (selected, content) => {
      written = { selected, content };
    },
    targetPath: (selected) => selected.fsPath,
    showInformationMessage: async (message, actions) => {
      assert.match(message, /redacted diagnostics/u);
      return actions[0];
    },
    openTarget: async (selected) => {
      opened = selected;
    },
  });

  assert.deepEqual(await controller.exportDiagnostics(), { status: "exported", opened: true });
  assert.equal(exportOptions.defaultFileName, "cursor-agent-diagnostics.md");
  assert.equal(written.selected, target);
  assert.match(written.content, /api_key=<redacted>/u);
  assert.doesNotMatch(written.content, /do-not-share/u);
  assert.equal(opened, target);
});

test("diagnostics export cancellation performs no write", async () => {
  let collected = 0;
  let writes = 0;
  const controller = new DiagnosticsController({
    japanese: false,
    collectBundle: () => {
      collected += 1;
      return diagnosticBundle();
    },
    chooseExportTarget: async () => undefined,
    writeText: async () => {
      writes += 1;
    },
    targetPath: () => "unused",
    showInformationMessage: async () => undefined,
    openTarget: async () => undefined,
  });

  assert.deepEqual(await controller.exportDiagnostics(), { status: "cancelled" });
  assert.equal(collected, 1);
  assert.equal(writes, 0);
});
