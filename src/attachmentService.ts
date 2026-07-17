import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import * as path from "node:path";
import type { SDKImage } from "@cursor/sdk";
import * as vscode from "vscode";
import type {
  AttachedFileReference,
  Conversation,
  DroppedFileUpload,
  WorkspaceFileItem,
} from "./chatTypes.js";
import { resolveAbsoluteInWorkspaceResolved } from "./workspaceFolder.js";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_DROPPED_FILE_BYTES = 20 * 1024 * 1024;
const MAX_DROPPED_FILES = 20;
const MAX_TOTAL_DROPPED_BYTES = 80 * 1024 * 1024;
const IMAGE_FORMATS: Record<string, { mimeType: string; vision: boolean }> = {
  ".avif": { mimeType: "image/avif", vision: false },
  ".bmp": { mimeType: "image/bmp", vision: false },
  ".gif": { mimeType: "image/gif", vision: true },
  ".heic": { mimeType: "image/heic", vision: false },
  ".heif": { mimeType: "image/heif", vision: false },
  ".ico": { mimeType: "image/x-icon", vision: false },
  ".jfif": { mimeType: "image/jpeg", vision: true },
  ".jpeg": { mimeType: "image/jpeg", vision: true },
  ".jpg": { mimeType: "image/jpeg", vision: true },
  ".png": { mimeType: "image/png", vision: true },
  ".svg": { mimeType: "image/svg+xml", vision: false },
  ".tif": { mimeType: "image/tiff", vision: false },
  ".tiff": { mimeType: "image/tiff", vision: false },
  ".webp": { mimeType: "image/webp", vision: true },
};
const IMAGE_FILE_EXTENSIONS = Object.keys(IMAGE_FORMATS).map((extension) => extension.slice(1));

/** Owns attachment validation, staging, image loading, recovery, and cleanup. */
export class AttachmentService {
  private pendingAttachmentRoot: Promise<vscode.Uri> | undefined;
  private readonly pendingAttachmentLabels = new Map<string, string>();

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly isJapanese: boolean,
    private readonly saveConversations: () => Promise<void>,
  ) {}

  public async resolveAttachedFiles(
    requestedFiles: string[],
    workspace: vscode.WorkspaceFolder,
  ): Promise<string[]> {
    const resolved: string[] = [];
    for (const requested of [...new Set(requestedFiles)].slice(0, 20)) {
      const absolute = await resolveAbsoluteInWorkspaceResolved(requested, workspace);
      if (!absolute) continue;
      try {
        const uri = vscode.Uri.file(absolute);
        const stat = await vscode.workspace.fs.stat(uri);
        if ((stat.type & vscode.FileType.File) === 0) continue;
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        resolved.push((folder ? vscode.workspace.asRelativePath(uri, true) : absolute).replaceAll("\\", "/"));
      } catch {
        // Ignore stale or invalid file selections.
      }
    }
    return resolved;
  }

  public async loadAttachedImages(
    files: string[],
    workspace: vscode.WorkspaceFolder,
  ): Promise<SDKImage[]> {
    const images: SDKImage[] = [];
    let skippedLargeImages = 0;
    for (const file of files) {
      const format = IMAGE_FORMATS[path.extname(file).toLowerCase()];
      if (!format?.vision || images.length >= 8) continue;
      const absolute = await resolveAbsoluteInWorkspaceResolved(file, workspace);
      if (!absolute) continue;
      try {
        const uri = vscode.Uri.file(absolute);
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > MAX_IMAGE_BYTES) {
          skippedLargeImages += 1;
          continue;
        }
        const data = await vscode.workspace.fs.readFile(uri);
        images.push({ data: Buffer.from(data).toString("base64"), mimeType: format.mimeType });
      } catch {
        // Invalid or stale attachments are already omitted from the file list.
      }
    }
    if (skippedLargeImages > 0) {
      void vscode.window.showWarningMessage(this.localize(
        `${skippedLargeImages} image(s) exceeded the 20 MB image limit and were attached as files only.`,
        `${skippedLargeImages}件の画像が20 MBの上限を超えたため、ファイル参照としてのみ添付しました。`,
      ));
    }
    return images;
  }

  public async pickImages(): Promise<string[]> {
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      title: this.localize("Attach images", "画像を添付"),
      filters: { [this.localize("Images", "画像")]: IMAGE_FILE_EXTENSIONS },
    });
    return uris?.map((uri) => uri.fsPath) ?? [];
  }

  public parseDroppedFileUploads(
    uploads: { name?: unknown; data?: unknown }[] | undefined,
  ): DroppedFileUpload[] {
    if (!Array.isArray(uploads)) return [];
    const parsed: DroppedFileUpload[] = [];
    let totalBytes = 0;
    for (const upload of uploads.slice(0, MAX_DROPPED_FILES)) {
      if (typeof upload?.name !== "string") continue;
      let data: Uint8Array | undefined;
      if (upload.data instanceof Uint8Array) data = upload.data;
      else if (upload.data instanceof ArrayBuffer) data = new Uint8Array(upload.data);
      else if (
        Array.isArray(upload.data)
        && upload.data.length <= MAX_DROPPED_FILE_BYTES
        && upload.data.every(
          (value) => Number.isInteger(value) && value >= 0 && value <= 255,
        )
      ) {
        data = Uint8Array.from(upload.data);
      }
      if (!data || data.byteLength > MAX_DROPPED_FILE_BYTES) continue;
      if (totalBytes + data.byteLength > MAX_TOTAL_DROPPED_BYTES) break;
      totalBytes += data.byteLength;
      parsed.push({ name: upload.name, data });
    }
    return parsed;
  }

  public async stageDroppedFileUpload(
    upload: DroppedFileUpload,
  ): Promise<WorkspaceFileItem | undefined> {
    if (upload.data.byteLength > MAX_DROPPED_FILE_BYTES) return undefined;
    const originalName = path.basename(upload.name.trim());
    const safeName = originalName
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "") || "attachment";
    const hash = createHash("sha256").update(upload.data).digest("hex").slice(0, 12);
    const root = await this.ensurePendingAttachmentRoot();
    const uri = vscode.Uri.joinPath(root, `${hash}-${safeName}`);
    await vscode.workspace.fs.writeFile(uri, upload.data);
    const normalized = uri.fsPath.replaceAll("\\", "/");
    this.pendingAttachmentLabels.set(path.resolve(uri.fsPath).toLowerCase(), safeName);
    return { path: normalized, label: safeName, description: path.posix.dirname(normalized) };
  }

  public async stageExternalAttachments(
    files: string[],
    workspace: vscode.WorkspaceFolder,
    conversation: Conversation,
  ): Promise<AttachedFileReference[]> {
    const root = path.resolve(workspace.uri.fsPath);
    const references: AttachedFileReference[] = [];
    let attachmentRootUri: vscode.Uri | undefined;
    for (const file of files) {
      if (!path.isAbsolute(file)) {
        references.push({ displayPath: file, agentPath: file, external: false });
        continue;
      }
      const absolute = path.resolve(file);
      const relative = path.relative(root, absolute);
      const isInWorkspace = relative && !relative.startsWith("..") && !path.isAbsolute(relative);
      if (isInWorkspace) {
        const normalized = relative.replaceAll("\\", "/");
        references.push({ displayPath: normalized, agentPath: normalized, external: false });
        continue;
      }
      attachmentRootUri ??= vscode.Uri.joinPath(this.context.globalStorageUri, "attachments", conversation.id);
      await vscode.workspace.fs.createDirectory(attachmentRootUri);
      const hash = createHash("sha256").update(absolute).digest("hex").slice(0, 12);
      const stagedUri = vscode.Uri.joinPath(attachmentRootUri, `${hash}-${path.basename(absolute)}`);
      await vscode.workspace.fs.copy(vscode.Uri.file(absolute), stagedUri, { overwrite: true });
      const pendingLabel = this.pendingAttachmentLabels.get(absolute.toLowerCase());
      references.push({
        displayPath: pendingLabel ?? absolute.replaceAll("\\", "/"),
        agentPath: stagedUri.fsPath.replaceAll("\\", "/"),
        external: true,
      });
    }
    if (attachmentRootUri) {
      conversation.attachmentRoot = attachmentRootUri.fsPath;
      await this.saveConversations();
    }
    return references;
  }

  public async recoverStoredAttachment(
    filePath: string,
    conversations: Conversation[],
    activeId?: string,
  ): Promise<vscode.Uri | undefined> {
    const missingName = path.basename(filePath);
    if (!missingName) return undefined;
    const active = conversations.find((conversation) => conversation.id === activeId);
    const ordered = [...(active ? [active] : []), ...conversations.filter((item) => item !== active)];
    for (const conversation of ordered) {
      if (!conversation.attachmentRoot) continue;
      const root = vscode.Uri.file(conversation.attachmentRoot);
      let entries: [string, vscode.FileType][];
      try { entries = await vscode.workspace.fs.readDirectory(root); } catch { continue; }
      const lowerName = missingName.toLowerCase();
      const match = entries.find(([name, type]) =>
        (type & vscode.FileType.File) !== 0
        && (name.toLowerCase() === lowerName || name.toLowerCase().endsWith(`-${lowerName}`))
      );
      if (!match) continue;
      const recovered = vscode.Uri.joinPath(root, match[0]);
      const recoveredPath = recovered.fsPath.replaceAll("\\", "/");
      const label = missingName.replace(/^[0-9a-f]{12}-/i, "");
      let changed = false;
      for (const entry of conversation.transcript) {
        if (!entry.attachments) continue;
        entry.attachments = entry.attachments.map((attachment) => {
          const attachmentPath = typeof attachment === "string" ? attachment : attachment.path;
          if (path.resolve(attachmentPath).toLowerCase() !== path.resolve(filePath).toLowerCase()) return attachment;
          changed = true;
          return { path: recoveredPath, label };
        });
      }
      if (changed) await this.saveConversations();
      return recovered;
    }
    return undefined;
  }

  public async dispose(): Promise<void> {
    if (!this.pendingAttachmentRoot) return;
    try {
      await vscode.workspace.fs.delete(await this.pendingAttachmentRoot, { recursive: true });
    } catch {
      // Pending dropped files may already have been removed.
    }
  }

  private ensurePendingAttachmentRoot(): Promise<vscode.Uri> {
    this.pendingAttachmentRoot ??= (async () => {
      const root = vscode.Uri.joinPath(this.context.globalStorageUri, "pending-attachments");
      try { await vscode.workspace.fs.delete(root, { recursive: true }); } catch { /* no stale directory */ }
      await vscode.workspace.fs.createDirectory(root);
      return root;
    })();
    return this.pendingAttachmentRoot;
  }

  private localize(english: string, japanese: string): string {
    return this.isJapanese ? japanese : english;
  }
}
