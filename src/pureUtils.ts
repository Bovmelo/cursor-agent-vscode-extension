export function slugifyBranchTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "change";
}

export function expandCommandBody(body: string, trailingText: string): string {
  const extra = trailingText.trim();
  if (!extra) {
    return body.trim();
  }
  return `${body.trim()}\n\n${extra}`;
}
