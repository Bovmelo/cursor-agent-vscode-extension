export function slugifyBranchTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "change";
}

export function branchStartsAtBase(currentHead: string, baseHead: string): boolean {
  return currentHead.trim() === baseHead.trim();
}

export function expandCommandBody(body: string, trailingText: string): string {
  const extra = trailingText.trim();
  if (!extra) {
    return body.trim();
  }
  return `${body.trim()}\n\n${extra}`;
}

/**
 * Detects the Windows local-runtime IPC failure surfaced when a pending write
 * is cancelled underneath the Cursor SDK. Keep this narrower than generic
 * cancellation matching so an ordinary user stop is not treated as a broken
 * runtime unless the SDK returned the specific transport error.
 */
export function isLocalRuntimeWriteCancelled(
  code: string | undefined,
  message: string | undefined,
): boolean {
  return /\b(?:write\s+)?ECANCELED\b/i.test(`${code ?? ""} ${message ?? ""}`);
}
