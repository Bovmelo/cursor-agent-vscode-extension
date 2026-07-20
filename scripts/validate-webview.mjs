import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../out/webviewController.js", import.meta.url), "utf8");
const extensionHostSource = readFileSync(new URL("../src/extension.ts", import.meta.url), "utf8");
const messageContractSource = readFileSync(
  new URL("../src/webviewMessages.ts", import.meta.url),
  "utf8",
);
const clientScript = readFileSync(new URL("../media/webview.js", import.meta.url), "utf8");
const stylesheet = readFileSync(new URL("../media/webview.css", import.meta.url), "utf8");
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
  "assetVersion",
  "markedUri",
  "purifyUri",
  "styleUri",
  "clientUri",
  "clientConfig",
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
  "test-nonce",
  "marked.js",
  "purify.js",
  "webview.css",
  "webview.js",
  '{"i18n":{}}',
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
if (
  !imgSources ||
  imgSources.length !== 3 ||
  !["test-csp-source", "https:", "data:"].every((source) => imgSources.includes(source)) ||
  imgSources.includes("http:") ||
  imgSources.includes("javascript:")
) {
  throw new Error("img-src must allow only webview, HTTPS, and data image sources");
}

const scriptElements = [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)];
if (
  scriptElements.length !== 4 ||
  scriptElements.some((match) => !match[1].includes('nonce="test-nonce"')) ||
  !scriptElements.some((match) => match[1].includes('src="webview.js?v=test-nonce"')) ||
  !html.includes('<link rel="stylesheet" href="webview.css?v=test-nonce">')
) {
  throw new Error(
    "All webview scripts and extracted assets must retain their nonce/CSP and cache-busting wiring",
  );
}

const inlineScripts = scriptElements
  .filter((match) => !match[1].includes(" src="))
  .map((match) => match[2])
  .filter((script) => script.trim().length > 0);

if (inlineScripts.length === 0) {
  throw new Error("No inline webview script was found");
}
for (const script of [...inlineScripts, clientScript]) {
  new Function(script);
}

if (
  clientScript.includes("${JSON.stringify(ui)}") ||
  clientScript.includes("${SUPPORTS_LOCAL_SANDBOX") ||
  clientScript.includes("${MAX_DROPPED_FILE_BYTES}")
) {
  throw new Error("The reusable client asset must not retain host template interpolation");
}

const promptMarkup = html.match(/<textarea id="prompt"[^>]*>/u)?.[0];
if (
  !promptMarkup ||
  !promptMarkup.includes('aria-autocomplete="list"') ||
  !promptMarkup.includes('aria-haspopup="listbox"') ||
  !promptMarkup.includes('aria-expanded="false"')
) {
  throw new Error("The prompt must expose its listbox autocomplete state");
}
if (
  !html.includes('<div id="filePicker" role="listbox"') ||
  !html.includes('<div id="slashPicker" role="listbox"')
) {
  throw new Error("Composer suggestion listboxes must have stable IDs");
}

const suggestionAriaSource = clientScript.match(
  /function syncPromptSuggestionAria\(\) \{[\s\S]*?\n\}/u,
)?.[0];
if (
  !suggestionAriaSource ||
  !clientScript.includes('row.id = "file-picker-option-" + index;') ||
  !clientScript.includes('row.id = "slash-picker-option-" + index;')
) {
  throw new Error("Composer suggestions must expose stable option IDs and synchronized ARIA state");
}
const suggestionAttributes = new Map();
const promptAriaHarness = {
  setAttribute: (name, value) => suggestionAttributes.set(name, value),
  removeAttribute: (name) => suggestionAttributes.delete(name),
};
const filePickerAriaHarness = {
  hidden: false,
  id: "filePicker",
  querySelector: () => ({ id: "file-picker-option-1" }),
};
const slashPickerAriaHarness = {
  hidden: true,
  id: "slashPicker",
  querySelector: () => ({ id: "slash-picker-option-2" }),
};
const syncPromptSuggestionAria = new Function(
  "prompt",
  "filePicker",
  "slashPicker",
  `${suggestionAriaSource}; return syncPromptSuggestionAria;`,
)(promptAriaHarness, filePickerAriaHarness, slashPickerAriaHarness);
syncPromptSuggestionAria();
if (
  suggestionAttributes.get("aria-expanded") !== "true" ||
  suggestionAttributes.get("aria-controls") !== "filePicker" ||
  suggestionAttributes.get("aria-activedescendant") !== "file-picker-option-1"
) {
  throw new Error("File suggestions must own the prompt's active descendant state");
}
filePickerAriaHarness.hidden = true;
slashPickerAriaHarness.hidden = false;
syncPromptSuggestionAria();
if (
  suggestionAttributes.get("aria-controls") !== "slashPicker" ||
  suggestionAttributes.get("aria-activedescendant") !== "slash-picker-option-2"
) {
  throw new Error("Slash suggestions must own the prompt's active descendant state");
}
slashPickerAriaHarness.hidden = true;
syncPromptSuggestionAria();
if (
  suggestionAttributes.get("aria-expanded") !== "false" ||
  suggestionAttributes.has("aria-controls") ||
  suggestionAttributes.has("aria-activedescendant")
) {
  throw new Error("Closing suggestions must clear the prompt's popup ARIA references");
}

if (
  !html.includes('<div id="addMenu" role="menu"') ||
  !html.match(/id="attachButton"[^>]*aria-haspopup="menu"[^>]*aria-controls="addMenu"/u) ||
  !html.match(/id="profileChip"[^>]*aria-haspopup="menu"[^>]*aria-controls="addMenu"/u) ||
  !clientScript.includes('row.setAttribute("role", options.role || "menuitem");') ||
  !clientScript.includes('separator.setAttribute("role", "separator");') ||
  !clientScript.includes("openAddMenu(profileChip);") ||
  !clientScript.includes("closeAddMenu({ restoreFocus: true });") ||
  !clientScript.includes('event.key === "ArrowDown"') ||
  !clientScript.includes('event.key === "ArrowUp"') ||
  !clientScript.includes('event.key === "Home"') ||
  !clientScript.includes('event.key === "End"')
) {
  throw new Error(
    "The add menu must track its launcher and support menu semantics and keyboard navigation",
  );
}
if (
  !html.match(/id="status" role="status" aria-live="polite" aria-atomic="true"/u) ||
  !html.match(/id="runningIndicator" role="status" aria-live="polite" aria-atomic="true"/u)
) {
  throw new Error("Connection and execution status must be announced as atomic live regions");
}
if (
  html.match(/id="messages"[^>]*aria-live=/u) ||
  !html.match(
    /id="messageAnnouncer"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/u,
  ) ||
  !clientScript.includes("function announcePolite(message)") ||
  !clientScript.includes("announcementTimer = setTimeout(") ||
  !clientScript.includes('status.setAttribute("aria-busy", "true")') ||
  !clientScript.includes('status.setAttribute("aria-busy", "false")')
) {
  throw new Error(
    "Streaming content must use a throttled, atomic live region and suppress busy status churn",
  );
}
for (const selector of [
  "button",
  "a[href]",
  "input",
  "textarea",
  "select",
  "summary",
  '[role="button"]',
  '[role="menuitem"]',
  '[role="option"]',
  '[tabindex]:not([tabindex="-1"])',
]) {
  if (!stylesheet.includes(selector)) {
    throw new Error(`The common focus-visible rule does not cover ${selector}`);
  }
}
if (
  !stylesheet.includes(":focus-visible") ||
  !stylesheet.includes("outline: 2px solid var(--vscode-focusBorder)")
) {
  throw new Error("Interactive controls must share a visible keyboard focus treatment");
}
if (
  !stylesheet.includes("textarea:not(#prompt)") ||
  !stylesheet.includes(".card:focus-within") ||
  !stylesheet.includes("0 0 18px color-mix(in srgb, var(--vscode-focusBorder) 24%, transparent)")
) {
  throw new Error("The prompt focus treatment must highlight the outer composer card");
}
if (!stylesheet.includes("@media (prefers-reduced-motion: reduce)")) {
  throw new Error("The webview must honor reduced-motion preferences");
}

const imageSourceValidatorSource = clientScript.match(
  /function isAllowedMarkdownImageSource\(value\) \{[\s\S]*?\n\}/,
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
if (
  !clientScript.includes('FORBID_ATTR: ["srcset"]') ||
  !clientScript.includes('if (!isAllowedMarkdownImageSource(src)) image.removeAttribute("src");') ||
  !clientScript.includes('template.content.querySelectorAll("img[src]")') ||
  !clientScript.includes("body.replaceChildren(template.content)")
) {
  throw new Error("Markdown images must remove alternate or unsafe sources");
}
if (
  !clientScript.includes("const attachmentsReady = await waitForPendingAttachments();") ||
  !clientScript.includes("if (!attachmentsReady) {") ||
  !clientScript.includes("i18n.attachmentResolveTimeout")
) {
  throw new Error("Attachment-resolution timeout must block sending and show a retryable error");
}

const contractTypes = (constantName) => {
  const body = messageContractSource.match(
    new RegExp(`export const ${constantName} = \\[([\\s\\S]*?)\\] as const[^;]*;`, "u"),
  )?.[1];
  if (!body) throw new Error(`Could not read ${constantName} from the shared message contract`);
  const types = [...body.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
  if (types.length !== new Set(types).size) {
    throw new Error(`${constantName} contains duplicate message discriminants`);
  }
  return new Set(types);
};
const webviewToHostTypes = contractTypes("WEBVIEW_TO_HOST_MESSAGE_TYPES");
const hostToWebviewTypes = contractTypes("HOST_TO_WEBVIEW_MESSAGE_TYPES");
if (
  !messageContractSource.includes("export function parseWebviewMessage(") ||
  !messageContractSource.includes("export function parseHostToWebviewMessage(")
) {
  throw new Error("Both webview transport directions must have shared runtime payload parsers");
}
if (
  !source.includes("const parsed = parseWebviewMessage(message);") ||
  !source.includes("const parsed = parseHostToWebviewMessage(message);")
) {
  throw new Error("WebviewController must enforce both shared runtime payload parsers");
}
if (extensionHostSource.includes("view.webview.onDidReceiveMessage(")) {
  throw new Error(
    "The extension host must route inbound messages through WebviewController.attach",
  );
}
if (
  !extensionHostSource.match(
    /this\.webviewController\.attach\([\s\S]*?async \(message\) => \{[\s\S]*?switch \(message\.type\)/u,
  )
) {
  throw new Error("The WebviewController attach callback must own the typed message dispatch");
}
if (
  !clientScript.includes('profileChip.setAttribute("aria-label", accessibleLabel);') ||
  !clientScript.includes('labels.length > 0 ? labels.join(", ") : i18n.standardProfile')
) {
  throw new Error(
    "The profile chip must keep its accessible label synchronized with its profile text",
  );
}
const directlyPostedTypes = [
  ...clientScript.matchAll(/vscode\.postMessage\(\{\s*type:\s*"([^"]+)"/gu),
  ...clientScript.matchAll(/messagePayload\("([^"]+)"/gu),
].map((match) => match[1]);
const hostMessageListener = clientScript.slice(
  clientScript.indexOf('window.addEventListener("message"'),
);
const receivedTypes = [...hostMessageListener.matchAll(/case "([^"]+)":/gu)].map(
  (match) => match[1],
);
for (const type of directlyPostedTypes) {
  if (!webviewToHostTypes.has(type)) {
    throw new Error(`Webview-to-host message is missing from the shared contract: ${type}`);
  }
}
for (const type of receivedTypes) {
  if (!hostToWebviewTypes.has(type)) {
    throw new Error(`Host-to-webview message is missing from the shared contract: ${type}`);
  }
}

const regularPromptRestoreSource = clientScript.match(
  /function restorePromptFocusNow\(\) \{[\s\S]*?\n\}/u,
)?.[0];
const hostPromptRestoreSource = clientScript.match(
  /function restorePromptFocusFromHost\(\) \{[\s\S]*?\n\}/u,
)?.[0];
if (!regularPromptRestoreSource || !hostPromptRestoreSource) {
  throw new Error("Prompt focus-restoration helpers were not found");
}

const createPromptFocusHarness = new Function(
  "document",
  "prompt",
  "restorationTarget",
  `
    let restorePromptOnWindowFocus = restorationTarget;
    ${regularPromptRestoreSource}
    ${hostPromptRestoreSource}
    return { restorePromptFocusNow, restorePromptFocusFromHost };
  `,
);
const promptFocusHarness = ({ documentFocused, restorationTarget, activePrompt = false }) => {
  const focusCalls = [];
  const prompt = {
    focus: (options) => focusCalls.push(options),
  };
  const document = {
    activeElement: activePrompt ? prompt : {},
    hasFocus: () => documentFocused,
  };
  return {
    focusCalls,
    ...createPromptFocusHarness(document, prompt, restorationTarget),
  };
};

const inactiveRegularRestore = promptFocusHarness({
  documentFocused: false,
  restorationTarget: true,
});
inactiveRegularRestore.restorePromptFocusNow();
if (inactiveRegularRestore.focusCalls.length !== 0) {
  throw new Error("Scheduled prompt focus retries must not bypass document.hasFocus()");
}

const inactiveHostRestore = promptFocusHarness({
  documentFocused: false,
  restorationTarget: true,
  activePrompt: true,
});
if (
  inactiveHostRestore.restorePromptFocusFromHost() !== true ||
  inactiveHostRestore.focusCalls.length !== 1 ||
  inactiveHostRestore.focusCalls[0]?.preventScroll !== true
) {
  throw new Error(
    "The host window-focus signal must retry prompt focus before the webview reports focus",
  );
}

const cancelledHostRestore = promptFocusHarness({
  documentFocused: false,
  restorationTarget: false,
});
if (
  cancelledHostRestore.restorePromptFocusFromHost() !== false ||
  cancelledHostRestore.focusCalls.length !== 0
) {
  throw new Error("The host window-focus signal must not revive a cancelled prompt focus target");
}

const activeHostRestore = promptFocusHarness({
  documentFocused: true,
  restorationTarget: true,
  activePrompt: true,
});
activeHostRestore.restorePromptFocusFromHost();
if (activeHostRestore.focusCalls.length !== 0) {
  throw new Error("The host window-focus signal must not refocus an already-active prompt");
}

if (
  !clientScript.includes("if (restorePromptFocusFromHost()) schedulePromptFocusRestore();") ||
  !clientScript.includes("if (event.target !== prompt) cancelPromptFocusRestore();") ||
  !clientScript.includes("document.contains(event.relatedTarget)") ||
  !clientScript.includes('type: "promptDictationHotkey",') ||
  !clientScript.includes("occurredAt: Date.now(),")
) {
  throw new Error(
    "Prompt focus restoration must retry after host focus and remain cancellable by webview UI use",
  );
}

const providerStart = extensionHostSource.indexOf("class CursorChatProvider");
const constructorStart = extensionHostSource.indexOf("  constructor(", providerStart);
const constructorEnd = extensionHostSource.indexOf(
  "\n  public setApplyCoordination(",
  constructorStart,
);
const providerConstructor = extensionHostSource.slice(constructorStart, constructorEnd);
if (
  !providerConstructor.match(
    /this\.disposables\.push\(\s*vscode\.window\.onDidChangeWindowState/u,
  ) ||
  !providerConstructor.includes("this.promptFocusHandoff.hostWindowFocusChanged(") ||
  !providerConstructor.includes('this.post({ type: "hostWindowFocused" });') ||
  [...extensionHostSource.matchAll(/onDidChangeWindowState/gu)].length !== 1
) {
  throw new Error(
    "The extension host must scope one disposable window-focus listener to a prompt handoff",
  );
}
console.log(`Validated ${inlineScripts.length} inline webview script(s).`);
