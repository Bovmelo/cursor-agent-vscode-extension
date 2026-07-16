import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../out/extension.js", import.meta.url), "utf8");
const marker = "return /* html */ `<!doctype html>";
const markerIndex = source.indexOf(marker);
if (markerIndex < 0) {
  throw new Error("Could not find the webview HTML template in out/extension.js");
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
);
const inlineScripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1])
  .filter(Boolean);

if (inlineScripts.length === 0) {
  throw new Error("No inline webview script was found");
}
for (const script of inlineScripts) {
  new Function(script);
}

console.log(`Validated ${inlineScripts.length} inline webview script(s).`);
