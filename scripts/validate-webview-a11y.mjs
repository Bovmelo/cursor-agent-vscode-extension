import { register } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import axe from "axe-core";
import { JSDOM } from "jsdom";

register(new URL("./vscode-a11y-loader.mjs", import.meta.url));

const [{ WebviewController }, { Uri }] = await Promise.all([
  import("../out/webviewController.js"),
  import("./vscode-a11y-mock.mjs"),
]);

const workspaceRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const context = {
  extension: { packageJSON: { version: "0.0.0-a11y" } },
  extensionUri: Uri.file(workspaceRoot),
};
const webview = {
  asWebviewUri(uri) {
    return `https://webview.test/${path.basename(uri.fsPath)}`;
  },
  cspSource: "https://webview.test",
};

const controller = new WebviewController(context, false, false, 20 * 1024 * 1024);
const html = controller.getHtml(webview);
const dom = new JSDOM(html, {
  pretendToBeVisual: true,
  runScripts: "outside-only",
  url: "https://webview.test/",
});

dom.window.eval(axe.source);
const results = await dom.window.axe.run(dom.window.document, {
  rules: {
    // jsdom has no layout engine, so this rule can only be verified in browser E2E.
    "color-contrast": { enabled: false },
  },
  runOnly: {
    type: "tag",
    values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"],
  },
});

dom.window.close();

if (results.violations.length > 0) {
  const details = results.violations
    .map((violation) => {
      const nodes = violation.nodes.map((node) => `    ${node.target.join(" ")}`).join("\n");
      return `${violation.id}: ${violation.help}\n${nodes}`;
    })
    .join("\n\n");
  throw new Error(`Webview accessibility violations:\n${details}`);
}

console.log(
  `Validated Webview accessibility with axe-core (${results.passes.length} rules passed).`,
);
