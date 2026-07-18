import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../out/webviewController.js", import.meta.url), "utf8");
const marker = "return /* html */ `<!doctype html>";
const markerIndex = source.indexOf(marker);
if (markerIndex < 0) {
  throw new Error("Could not find the webview HTML template in out/webviewController.js");
}

const templateStart = markerIndex + "return /* html */ ".length;
const htmlEnd = source.indexOf("</html>", templateStart);
const templateEnd = source.indexOf("`;", htmlEnd) + 1;
if (htmlEnd < 0 || templateEnd <= 0) {
  throw new Error("Could not find the end of the webview HTML template");
}

const templateLiteral = source.slice(templateStart, templateEnd);
const render = new Function(
  "ui",
  "nonce",
  "markedUri",
  "purifyUri",
  "IS_JAPANESE",
  "webview",
  "extensionVersion",
  "MAX_DROPPED_FILE_BYTES",
  "SUPPORTS_LOCAL_SANDBOX",
  `return ${templateLiteral};`,
);
const html = render(
  {},
  "test-nonce",
  "marked.js",
  "purify.js",
  false,
  { cspSource: "test-csp-source" },
  "0.0.0",
  20 * 1024 * 1024,
  false,
);

const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i)?.[1];
if (!csp) {
  throw new Error("No Content-Security-Policy was found");
}
const imgSources = csp
  .split(";")
  .map((directive) => directive.trim().split(/\s+/))
  .find(([name]) => name === "img-src")
  ?.slice(1);
if (!imgSources
  || imgSources.length !== 3
  || !["test-csp-source", "https:", "data:"].every((source) => imgSources.includes(source))
  || imgSources.includes("http:")
  || imgSources.includes("javascript:")) {
  throw new Error("img-src must allow only webview, HTTPS, and data image sources");
}

const inlineScripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1])
  .filter(Boolean);

if (inlineScripts.length === 0) {
  throw new Error("No inline webview script was found");
}
for (const script of inlineScripts) {
  new Function(script);
}

const clientScript = inlineScripts.join("\n");
const imageSourceValidatorSource = clientScript.match(
  /function isAllowedMarkdownImageSource\(value\) \{[\s\S]*?\n    \}/,
)?.[0];
if (!imageSourceValidatorSource) {
  throw new Error("No Markdown image-source validator was found");
}
const isAllowedMarkdownImageSource = new Function(
  `${imageSourceValidatorSource}; return isAllowedMarkdownImageSource;`,
)();
for (const source of [
  "https://example.com/image.png",
  "vscode-resource:/extension/image.png",
  "vscode-webview-resource://view/extension/image.png",
  "data:image/png;base64,iVBORw0KGgo=",
]) {
  if (!isAllowedMarkdownImageSource(source)) {
    throw new Error(`Expected Markdown image source to be allowed: ${source}`);
  }
}
for (const source of [
  "http://example.com/image.png",
  "javascript:alert(1)",
  "data:text/html;base64,PHNjcmlwdD4=",
  "data:image/svg+xml,<svg onload=alert(1)>",
]) {
  if (isAllowedMarkdownImageSource(source)) {
    throw new Error(`Unsafe Markdown image source was allowed: ${source}`);
  }
}
if (!clientScript.includes('FORBID_ATTR: ["srcset"]')
  || !clientScript.includes('if (!isAllowedMarkdownImageSource(src)) image.removeAttribute("src");')
  || !clientScript.includes('template.content.querySelectorAll("img[src]")')
  || !clientScript.includes("body.replaceChildren(template.content)")) {
  throw new Error("Markdown images must remove alternate or unsafe sources");
}
if (!clientScript.includes("const attachmentsReady = await waitForPendingAttachments();")
  || !clientScript.includes("if (!attachmentsReady) {")
  || !clientScript.includes("i18n.attachmentResolveTimeout")) {
  throw new Error("Attachment-resolution timeout must block sending and show a retryable error");
}

console.log(`Validated ${inlineScripts.length} inline webview script(s).`);
