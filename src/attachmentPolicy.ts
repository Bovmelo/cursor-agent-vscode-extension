import * as path from "node:path";

export const MAX_ATTACHMENT_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_BATCH_BYTES = 80 * 1024 * 1024;
export const MAX_ATTACHMENT_FILES = 20;
export const DEFAULT_ATTACHMENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Keep this as a denylist so existing document, source, archive, and media
// attachments remain compatible. These extensions are directly executable or
// commonly delegated to a script/link handler by desktop operating systems.
const DANGEROUS_ATTACHMENT_EXTENSIONS = new Set([
  ".appref-ms",
  ".application",
  ".bat",
  ".bash",
  ".cmd",
  ".com",
  ".command",
  ".cpl",
  ".desktop",
  ".dll",
  ".exe",
  ".fish",
  ".gadget",
  ".hta",
  ".inf",
  ".ins",
  ".iso",
  ".isp",
  ".jar",
  ".js",
  ".jse",
  ".library-ms",
  ".lnk",
  ".msh",
  ".msh1",
  ".msh2",
  ".msh1xml",
  ".msh2xml",
  ".msi",
  ".msp",
  ".mst",
  ".pif",
  ".ps1",
  ".ps1xml",
  ".ps2",
  ".ps2xml",
  ".psc1",
  ".psc2",
  ".psd1",
  ".psm1",
  ".reg",
  ".scf",
  ".scr",
  ".sh",
  ".url",
  ".vb",
  ".vbe",
  ".vbs",
  ".webloc",
  ".ws",
  ".wsc",
  ".wsf",
  ".wsh",
  ".zsh",
]);

const WINDOWS_RESERVED_BASENAME = /^(?:aux|clock\$|con|nul|prn|com[1-9]|lpt[1-9])$/i;
const MAX_SAFE_NAME_CHARACTERS = 180;

/** Returns true only for names whose final extension is explicitly denied. */
export function isDangerousAttachmentName(name: string): boolean {
  const basename = portableBasename(name).normalize("NFKC").replace(/[. ]+$/g, "");
  return DANGEROUS_ATTACHMENT_EXTENSIONS.has(path.extname(basename).toLowerCase());
}

/** Produces a single portable path segment while retaining a useful extension. */
export function sanitizeAttachmentFileName(name: string, fallback = "attachment"): string {
  let safe = portableBasename(name.trim()).normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!safe || safe === "." || safe === "..") safe = fallback;

  const extension = path.extname(safe);
  const stem = extension ? safe.slice(0, -extension.length) : safe;
  if (WINDOWS_RESERVED_BASENAME.test(stem.replace(/[. ]+$/g, ""))) safe = `_${safe}`;

  const characters = Array.from(safe);
  if (characters.length <= MAX_SAFE_NAME_CHARACTERS) return safe;
  const extensionCharacters = Array.from(path.extname(safe)).slice(0, 32);
  const stemLimit = Math.max(1, MAX_SAFE_NAME_CHARACTERS - extensionCharacters.length);
  return `${characters.slice(0, stemLimit).join("")}${extensionCharacters.join("")}`;
}

/** True when candidate is an immediate child of root (never root itself). */
export function isDirectChildPath(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative.length > 0
    && !relative.startsWith("..")
    && !path.isAbsolute(relative)
    && path.dirname(relative) === ".";
}

function portableBasename(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}
