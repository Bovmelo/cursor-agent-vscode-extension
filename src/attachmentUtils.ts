import * as path from "node:path";

const MAX_DROPPED_FILE_BYTES = 20 * 1024 * 1024;

/**
 * Keep workspace-resolved paths, and absolute paths for clipboard/picker files
 * staged outside the workspace (e.g. pending-attachments under globalStorage).
 */
export function normalizeAttachedFilePath(
  requested: string,
  workspaceAbsolute: string | undefined,
): string | undefined {
  if (workspaceAbsolute) {
    return workspaceAbsolute;
  }
  if (!path.isAbsolute(requested)) {
    return undefined;
  }
  return path.resolve(requested);
}

function isByte(value: unknown): value is number {
  return typeof value === "number"
    && Number.isInteger(value)
    && value >= 0
    && value <= 255;
}

/**
 * Revive clipboard/drop payloads after webview postMessage serialization.
 * Prefer number[] from the webview; also accept TypedArrays and the older
 * object-shaped `{0:n,1:n,...}` form some hosts still emit.
 */
export function coerceUploadBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (
    Array.isArray(data)
    && data.length <= MAX_DROPPED_FILE_BYTES
    && data.every(isByte)
  ) {
    return Uint8Array.from(data);
  }
  if (
    data
    && typeof data === "object"
    && Array.isArray((data as { data?: unknown }).data)
    && (
      (data as { type?: unknown }).type === "Buffer"
      || (data as { type?: unknown }).type === "Uint8Array"
    )
  ) {
    return coerceUploadBytes((data as { data: unknown[] }).data);
  }
  // Legacy / host-specific: TypedArray serialized as a plain object with
  // contiguous numeric keys (and optional length).
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    const length = typeof record.length === "number" && Number.isInteger(record.length)
      ? record.length
      : undefined;
    if (length !== undefined) {
      if (length < 0 || length > MAX_DROPPED_FILE_BYTES) return undefined;
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) {
        const value = record[String(i)];
        if (!isByte(value)) return undefined;
        bytes[i] = value;
      }
      return bytes;
    }
    const keys = Object.keys(record).filter((key) => /^\d+$/.test(key));
    if (keys.length === 0 || keys.length > MAX_DROPPED_FILE_BYTES) return undefined;
    const maxIndex = Math.max(...keys.map((key) => Number(key)));
    if (maxIndex !== keys.length - 1) return undefined;
    const bytes = new Uint8Array(keys.length);
    for (let i = 0; i < keys.length; i += 1) {
      const value = record[String(i)];
      if (!isByte(value)) return undefined;
      bytes[i] = value;
    }
    return bytes;
  }
  return undefined;
}
