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
import {
  captureStableDirectChildDirectory,
  readStableLocalFile,
  removeStableLocalDirectory,
  sameDirectoryIdentity,
  type StableDirectoryIdentity,
  validateStableLocalFile,
  writeStableLocalFile,
} from "./attachmentLocalFs.js";
import {
  DEFAULT_ATTACHMENT_RETENTION_MS,
  isDangerousAttachmentName,
  isDirectChildPath,
  MAX_ATTACHMENT_BATCH_BYTES,
  MAX_ATTACHMENT_FILE_BYTES,
  MAX_ATTACHMENT_FILES,
  sanitizeAttachmentFileName,
} from "./attachmentPolicy.js";
import { coerceUploadBytes, normalizeAttachedFilePath } from "./attachmentUtils.js";
import { resolveAbsoluteInWorkspaceResolved } from "./workspaceFolder.js";

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

export interface AttachmentCleanupOptions {
  /** How long an unreferenced conversation attachment directory must remain untouched. */
  retentionMs?: number;
  /** Primarily useful to make cleanup runs deterministic in callers and tests. */
  now?: number;
}

export interface AttachmentServiceLimits {
  maxFiles?: number;
  maxFileBytes?: number;
  maxBatchBytes?: number;
}

/** Owns attachment validation, staging, image loading, recovery, and cleanup. */
export class AttachmentService {
  private pendingAttachmentRoot: Promise<vscode.Uri> | undefined;
  private readonly pendingAttachmentLabels = new Map<string, string>();
  private pendingAttachmentCount = 0;
  private pendingAttachmentBytes = 0;
  private pendingAttachmentParentIdentity: StableDirectoryIdentity | undefined;
  private pendingAttachmentIdentity: StableDirectoryIdentity | undefined;
  private readonly maxFiles: number;
  private readonly maxFileBytes: number;
  private readonly maxBatchBytes: number;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly isJapanese: boolean,
    private readonly saveConversations: () => Promise<void>,
    limits: AttachmentServiceLimits = {},
  ) {
    this.maxFiles = positiveLimit(limits.maxFiles, MAX_ATTACHMENT_FILES);
    this.maxFileBytes = positiveLimit(limits.maxFileBytes, MAX_ATTACHMENT_FILE_BYTES);
    this.maxBatchBytes = positiveLimit(limits.maxBatchBytes, MAX_ATTACHMENT_BATCH_BYTES);
  }

  public async resolveAttachedFiles(
    requestedFiles: string[],
    workspace: vscode.WorkspaceFolder,
  ): Promise<string[]> {
    const resolved: string[] = [];
    for (const requested of [...new Set(requestedFiles)].slice(0, this.maxFiles)) {
      const workspaceAbsolute = await resolveAbsoluteInWorkspaceResolved(requested, workspace);
      const absolute = normalizeAttachedFilePath(requested, workspaceAbsolute);
      if (!absolute) continue;
      try {
        const uri = vscode.Uri.file(absolute);
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        const allowedRoot = folder?.uri.fsPath ?? path.dirname(absolute);
        if (this.isLocalFile(uri)) {
          if (!await validateStableLocalFile(
            allowedRoot,
            absolute,
            this.maxFileBytes,
          )) continue;
        } else {
          const stat = await vscode.workspace.fs.stat(uri);
          if (!this.isRegularFile(stat) || stat.size > this.maxFileBytes) continue;
        }
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
    let totalBytes = 0;
    for (const file of files.slice(0, this.maxFiles)) {
      const format = IMAGE_FORMATS[path.extname(file).toLowerCase()];
      if (!format?.vision || images.length >= 8) continue;
      const workspaceAbsolute = await resolveAbsoluteInWorkspaceResolved(file, workspace);
      const absolute = normalizeAttachedFilePath(file, workspaceAbsolute);
      if (!absolute) continue;
      try {
        const uri = vscode.Uri.file(absolute);
        const folder = vscode.workspace.getWorkspaceFolder(uri);
        const data = this.isLocalFile(uri)
          ? await readStableLocalFile(
            folder?.uri.fsPath ?? path.dirname(absolute),
            absolute,
            this.maxFileBytes,
          )
          : await this.readProviderFile(uri);
        if (data.byteLength > this.maxFileBytes
          || totalBytes + data.byteLength > this.maxBatchBytes) {
          skippedLargeImages += 1;
          continue;
        }
        totalBytes += data.byteLength;
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
    for (const upload of uploads.slice(0, this.maxFiles)) {
      if (typeof upload?.name !== "string") continue;
      if (isDangerousAttachmentName(upload.name)) continue;
      const data = coerceUploadBytes(upload.data);
      if (!data || data.byteLength > this.maxFileBytes) continue;
      if (totalBytes + data.byteLength > this.maxBatchBytes) break;
      totalBytes += data.byteLength;
      parsed.push({ name: upload.name, data });
    }
    return parsed;
  }

  public async stageDroppedFileUpload(
    upload: DroppedFileUpload,
  ): Promise<WorkspaceFileItem | undefined> {
    if (upload.data.byteLength > this.maxFileBytes
      || isDangerousAttachmentName(upload.name)) return undefined;
    if (this.pendingAttachmentCount >= this.maxFiles
      || this.pendingAttachmentBytes + upload.data.byteLength > this.maxBatchBytes) {
      return undefined;
    }
    // Reserve synchronously before the first await so concurrent direct callers
    // cannot race past either pending-upload limit.
    this.pendingAttachmentCount += 1;
    this.pendingAttachmentBytes += upload.data.byteLength;
    try {
      const safeName = sanitizeAttachmentFileName(upload.name);
      const hash = createHash("sha256").update(upload.data).digest("hex").slice(0, 12);
      const root = await this.ensurePendingAttachmentRoot();
      const uri = vscode.Uri.joinPath(root, `${hash}-${safeName}`);
      let written: boolean;
      if (this.isLocalFile(uri)) {
        const stableRoot = await captureStableDirectChildDirectory(
          this.context.globalStorageUri.fsPath,
          root.fsPath,
        );
        if ((this.pendingAttachmentParentIdentity
          && !sameDirectoryIdentity(this.pendingAttachmentParentIdentity, stableRoot.parent))
          || (this.pendingAttachmentIdentity
            && !sameDirectoryIdentity(this.pendingAttachmentIdentity, stableRoot.candidate))) {
          throw new Error("The pending attachment root changed before writing.");
        }
        written = await writeStableLocalFile(
          root.fsPath,
          uri.fsPath,
          upload.data,
          stableRoot.candidate,
        );
      } else {
        written = await this.writeProviderManagedFile(root, uri, upload.data);
      }
      if (!written) throw new Error("The pending attachment path changed before it could be written.");
      const normalized = uri.fsPath.replaceAll("\\", "/");
      this.pendingAttachmentLabels.set(this.canonicalPath(uri.fsPath), safeName);
      return { path: normalized, label: safeName, description: path.posix.dirname(normalized) };
    } catch (error) {
      this.pendingAttachmentCount -= 1;
      this.pendingAttachmentBytes -= upload.data.byteLength;
      throw error;
    }
  }

  public async stageExternalAttachments(
    files: string[],
    workspace: vscode.WorkspaceFolder,
    conversation: Conversation,
  ): Promise<AttachedFileReference[]> {
    const root = path.resolve(workspace.uri.fsPath);
    const references: AttachedFileReference[] = [];
    let attachmentRootUri: vscode.Uri | undefined;
    let totalExternalBytes = 0;
    for (const file of [...new Set(files)].slice(0, this.maxFiles)) {
      if (!path.isAbsolute(file)) {
        references.push({ displayPath: file, agentPath: file, external: false });
        continue;
      }
      const absolute = path.resolve(file);
      const relative = path.relative(root, absolute);
      const isInWorkspace = relative.length > 0
        && !relative.startsWith("..")
        && !path.isAbsolute(relative);
      if (isInWorkspace) {
        const normalized = relative.replaceAll("\\", "/");
        references.push({ displayPath: normalized, agentPath: normalized, external: false });
        continue;
      }
      if (isDangerousAttachmentName(absolute)) continue;
      let data: Uint8Array;
      try {
        const sourceUri = vscode.Uri.file(absolute);
        data = this.isLocalFile(sourceUri)
          ? await readStableLocalFile(
            path.dirname(absolute),
            absolute,
            this.maxFileBytes,
          )
          : await this.readProviderFile(sourceUri);
      } catch {
        continue;
      }
      if (data.byteLength > this.maxFileBytes) continue;
      if (totalExternalBytes + data.byteLength > this.maxBatchBytes) break;
      totalExternalBytes += data.byteLength;

      if (!attachmentRootUri) {
        const candidateRoot = this.conversationAttachmentRoot(conversation.id);
        if (!await this.ensureRegularManagedRoot(candidateRoot)) break;
        attachmentRootUri = candidateRoot;
      }
      const hash = createHash("sha256").update(absolute).digest("hex").slice(0, 12);
      const safeName = sanitizeAttachmentFileName(absolute);
      const stagedUri = vscode.Uri.joinPath(attachmentRootUri, `${hash}-${safeName}`);
      if (!isDirectChildPath(attachmentRootUri.fsPath, stagedUri.fsPath)) continue;
      let written: boolean;
      if (this.isLocalFile(stagedUri)) {
        const stableRoot = await this.captureLocalManagedAttachmentRoot(attachmentRootUri);
        written = Boolean(stableRoot) && await writeStableLocalFile(
          attachmentRootUri.fsPath,
          stagedUri.fsPath,
          data,
          stableRoot,
        );
      } else {
        written = await this.writeProviderManagedFile(attachmentRootUri, stagedUri, data);
      }
      if (!written) break;
      const pendingLabel = this.pendingAttachmentLabels.get(this.canonicalPath(absolute));
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
    if (!missingName || isDangerousAttachmentName(missingName)) return undefined;
    const active = conversations.find((conversation) => conversation.id === activeId);
    const ordered = [...(active ? [active] : []), ...conversations.filter((item) => item !== active)];
    for (const conversation of ordered) {
      if (!conversation.attachmentRoot) continue;
      const root = vscode.Uri.file(conversation.attachmentRoot);
      const expectedRoot = this.conversationAttachmentRoot(conversation.id);
      if (!this.isManagedAttachmentRoot(root.fsPath)
        || this.canonicalPath(root.fsPath) !== this.canonicalPath(expectedRoot.fsPath)) continue;
      let entries: [string, vscode.FileType][];
      try {
        if (!await this.isExistingRegularManagedRoot(root)) continue;
        entries = await vscode.workspace.fs.readDirectory(root);
      } catch { continue; }
      const lowerName = missingName.toLowerCase();
      let recovered: vscode.Uri | undefined;
      for (const [name, type] of entries) {
        if ((type & vscode.FileType.File) === 0 || (type & vscode.FileType.SymbolicLink) !== 0) continue;
        const lowerEntryName = name.toLowerCase();
        if (lowerEntryName !== lowerName && !lowerEntryName.endsWith(`-${lowerName}`)) continue;
        if (isDangerousAttachmentName(name)) continue;
        const candidate = vscode.Uri.joinPath(root, name);
        if (!isDirectChildPath(root.fsPath, candidate.fsPath)) continue;
        try {
          if (this.isLocalFile(candidate)) {
            if (!await validateStableLocalFile(
              root.fsPath,
              candidate.fsPath,
              this.maxFileBytes,
            )) continue;
          } else if (!this.isRegularFile(await vscode.workspace.fs.stat(candidate))) {
            continue;
          }
        } catch {
          continue;
        }
        recovered = candidate;
        break;
      }
      if (!recovered) continue;
      const recoveredPath = recovered.fsPath.replaceAll("\\", "/");
      const label = sanitizeAttachmentFileName(missingName.replace(/^[0-9a-f]{12}-/i, ""));
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

  /**
   * Removes old, unreferenced conversation attachment directories. Cleanup is
   * deliberately limited to regular directories immediately below the managed
   * global-storage attachment root.
   */
  public async cleanupOrphanedAttachments(
    conversations: Conversation[],
    options: AttachmentCleanupOptions = {},
  ): Promise<string[]> {
    const retentionMs = Number.isFinite(options.retentionMs) && (options.retentionMs ?? -1) >= 0
      ? options.retentionMs!
      : DEFAULT_ATTACHMENT_RETENTION_MS;
    const now = Number.isFinite(options.now) && (options.now ?? -1) >= 0
      ? options.now!
      : Date.now();
    const attachmentsRoot = this.attachmentsRoot();
    const referencedRoots = new Set(conversations.flatMap((conversation) => {
      const candidate = conversation.attachmentRoot;
      return candidate && this.isManagedAttachmentRoot(candidate)
        ? [this.canonicalPath(candidate)]
        : [];
    }));

    let entries: [string, vscode.FileType][];
    let localAttachmentsIdentity: StableDirectoryIdentity | undefined;
    try {
      if (this.isLocalFile(attachmentsRoot)) {
        const managed = await captureStableDirectChildDirectory(
          this.context.globalStorageUri.fsPath,
          attachmentsRoot.fsPath,
        );
        localAttachmentsIdentity = managed.candidate;
      } else {
        const rootStat = await vscode.workspace.fs.stat(attachmentsRoot);
        if (!this.isRegularDirectory(rootStat)) return [];
      }
      entries = await vscode.workspace.fs.readDirectory(attachmentsRoot);
    } catch {
      return [];
    }

    const removed: string[] = [];
    const cutoff = now - retentionMs;
    for (const [name, type] of entries) {
      if ((type & vscode.FileType.Directory) === 0
        || (type & vscode.FileType.SymbolicLink) !== 0) continue;
      const candidate = vscode.Uri.joinPath(attachmentsRoot, name);
      if (!isDirectChildPath(attachmentsRoot.fsPath, candidate.fsPath)
        || referencedRoots.has(this.canonicalPath(candidate.fsPath))) continue;
      try {
        let activityTime: number;
        let localCandidateIdentity: StableDirectoryIdentity | undefined;
        if (localAttachmentsIdentity) {
          const captured = await captureStableDirectChildDirectory(
            attachmentsRoot.fsPath,
            candidate.fsPath,
          );
          if (!sameDirectoryIdentity(localAttachmentsIdentity, captured.parent)) return removed;
          localCandidateIdentity = captured.candidate;
          activityTime = Math.max(
            Number(captured.candidate.details.mtimeMs),
            Number(captured.candidate.details.ctimeMs),
          );
        } else {
          const stat = await vscode.workspace.fs.stat(candidate);
          if (!this.isRegularDirectory(stat)) continue;
          activityTime = Math.max(stat.mtime, stat.ctime);
        }
        if (!Number.isFinite(activityTime) || activityTime <= 0 || activityTime > cutoff) continue;
        if (localAttachmentsIdentity && localCandidateIdentity) {
          if (!await removeStableLocalDirectory(
            attachmentsRoot.fsPath,
            candidate.fsPath,
            localAttachmentsIdentity,
            localCandidateIdentity,
          )) continue;
        } else {
          // Non-file providers retain the VS Code filesystem contract and are
          // revalidated immediately before provider-managed deletion.
          if (!await this.isExistingRegularManagedRoot(candidate)) continue;
          await vscode.workspace.fs.delete(candidate, { recursive: true });
        }
        removed.push(candidate.fsPath.replaceAll("\\", "/"));
      } catch {
        // A racing or inaccessible directory is safer to retain for a later run.
      }
    }
    return removed;
  }

  /** Deletes only the exact managed attachment directory owned by a conversation. */
  public async deleteConversationAttachments(conversation: Conversation): Promise<boolean> {
    if (!conversation.attachmentRoot) return false;
    const candidate = vscode.Uri.file(conversation.attachmentRoot);
    const expected = this.conversationAttachmentRoot(conversation.id);
    if (!this.isManagedAttachmentRoot(candidate.fsPath)
      || this.canonicalPath(candidate.fsPath) !== this.canonicalPath(expected.fsPath)) return false;
    try {
      if (this.isLocalFile(candidate)) {
        const managedParent = await captureStableDirectChildDirectory(
          this.context.globalStorageUri.fsPath,
          this.attachmentsRoot().fsPath,
        );
        const managedCandidate = await captureStableDirectChildDirectory(
          this.attachmentsRoot().fsPath,
          candidate.fsPath,
        );
        if (!sameDirectoryIdentity(managedParent.candidate, managedCandidate.parent)) return false;
        return await removeStableLocalDirectory(
          this.attachmentsRoot().fsPath,
          candidate.fsPath,
          managedParent.candidate,
          managedCandidate.candidate,
        );
      }
      if (!await this.isExistingRegularManagedRoot(candidate)) return false;
      await vscode.workspace.fs.delete(candidate, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  public async dispose(): Promise<void> {
    const pendingRoot = this.pendingAttachmentRoot;
    const pendingParentIdentity = this.pendingAttachmentParentIdentity;
    const pendingIdentity = this.pendingAttachmentIdentity;
    this.pendingAttachmentRoot = undefined;
    this.pendingAttachmentParentIdentity = undefined;
    this.pendingAttachmentIdentity = undefined;
    this.pendingAttachmentCount = 0;
    this.pendingAttachmentBytes = 0;
    this.pendingAttachmentLabels.clear();
    if (pendingRoot) {
      try {
        const root = await pendingRoot;
        if (this.isLocalFile(root)) {
          await removeStableLocalDirectory(
            this.context.globalStorageUri.fsPath,
            root.fsPath,
            pendingParentIdentity,
            pendingIdentity,
          );
        } else {
          await vscode.workspace.fs.delete(root, { recursive: true });
        }
      } catch {
        // Pending dropped files may already have been removed.
      }
    }
  }

  private ensurePendingAttachmentRoot(): Promise<vscode.Uri> {
    this.pendingAttachmentRoot ??= (async () => {
      const root = vscode.Uri.joinPath(this.context.globalStorageUri, "pending-attachments");
      let existing: vscode.FileStat | undefined;
      try { existing = await vscode.workspace.fs.stat(root); } catch { /* no stale directory */ }
      if (existing && !this.isRegularDirectory(existing)) {
        throw new Error("Refusing to replace a linked or non-directory pending attachment root.");
      }
      if (existing) {
        const removed = this.isLocalFile(root)
          ? await removeStableLocalDirectory(this.context.globalStorageUri.fsPath, root.fsPath)
          : await vscode.workspace.fs.delete(root, { recursive: true }).then(() => true);
        if (!removed) throw new Error("Refusing to replace a changed pending attachment root.");
      }
      await vscode.workspace.fs.createDirectory(root);
      if (this.isLocalFile(root)) {
        const stableRoot = await captureStableDirectChildDirectory(
          this.context.globalStorageUri.fsPath,
          root.fsPath,
        );
        this.pendingAttachmentParentIdentity = stableRoot.parent;
        this.pendingAttachmentIdentity = stableRoot.candidate;
      } else if (!this.isRegularDirectory(await vscode.workspace.fs.stat(root))) {
        throw new Error("Refusing to use a linked or non-directory pending attachment root.");
      }
      return root;
    })();
    return this.pendingAttachmentRoot;
  }

  private attachmentsRoot(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, "attachments");
  }

  private conversationAttachmentRoot(conversationId: string): vscode.Uri {
    const trimmed = conversationId.trim();
    const segment = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(trimmed)
      && sanitizeAttachmentFileName(trimmed) === trimmed
      ? trimmed
      : `conversation-${createHash("sha256").update(conversationId).digest("hex").slice(0, 24)}`;
    const root = vscode.Uri.joinPath(this.attachmentsRoot(), segment);
    if (!this.isManagedAttachmentRoot(root.fsPath)) {
      throw new Error("Refusing to create an attachment directory outside managed storage.");
    }
    return root;
  }

  private isManagedAttachmentRoot(candidate: string): boolean {
    return isDirectChildPath(this.attachmentsRoot().fsPath, candidate);
  }

  private async ensureRegularManagedRoot(candidate: vscode.Uri): Promise<boolean> {
    const attachmentsRoot = this.attachmentsRoot();
    if (!this.isManagedAttachmentRoot(candidate.fsPath)) return false;
    try {
      await vscode.workspace.fs.createDirectory(attachmentsRoot);
      await vscode.workspace.fs.createDirectory(candidate);
      if (this.isLocalFile(candidate)) {
        const managedParent = await captureStableDirectChildDirectory(
          this.context.globalStorageUri.fsPath,
          attachmentsRoot.fsPath,
        );
        const managedCandidate = await captureStableDirectChildDirectory(
          attachmentsRoot.fsPath,
          candidate.fsPath,
        );
        return sameDirectoryIdentity(managedParent.candidate, managedCandidate.parent);
      }
      if (!this.isRegularDirectory(await vscode.workspace.fs.stat(attachmentsRoot))) return false;
      return this.isRegularDirectory(await vscode.workspace.fs.stat(candidate));
    } catch {
      return false;
    }
  }

  private async isExistingRegularManagedRoot(candidate: vscode.Uri): Promise<boolean> {
    if (!this.isManagedAttachmentRoot(candidate.fsPath)) return false;
    try {
      if (this.isLocalFile(candidate)) {
        const managedParent = await captureStableDirectChildDirectory(
          this.context.globalStorageUri.fsPath,
          this.attachmentsRoot().fsPath,
        );
        const managedCandidate = await captureStableDirectChildDirectory(
          this.attachmentsRoot().fsPath,
          candidate.fsPath,
        );
        return sameDirectoryIdentity(managedParent.candidate, managedCandidate.parent);
      }
      return this.isRegularDirectory(await vscode.workspace.fs.stat(this.attachmentsRoot()))
        && this.isRegularDirectory(await vscode.workspace.fs.stat(candidate));
    } catch {
      return false;
    }
  }

  private async captureLocalManagedAttachmentRoot(
    candidate: vscode.Uri,
  ): Promise<StableDirectoryIdentity | undefined> {
    if (!this.isManagedAttachmentRoot(candidate.fsPath) || !this.isLocalFile(candidate)) {
      return undefined;
    }
    try {
      const managedParent = await captureStableDirectChildDirectory(
        this.context.globalStorageUri.fsPath,
        this.attachmentsRoot().fsPath,
      );
      const managedCandidate = await captureStableDirectChildDirectory(
        this.attachmentsRoot().fsPath,
        candidate.fsPath,
      );
      return sameDirectoryIdentity(managedParent.candidate, managedCandidate.parent)
        ? managedCandidate.candidate
        : undefined;
    } catch {
      return undefined;
    }
  }

  private isRegularFile(stat: vscode.FileStat): boolean {
    return (stat.type & vscode.FileType.File) !== 0
      && (stat.type & vscode.FileType.SymbolicLink) === 0;
  }

  private isRegularDirectory(stat: vscode.FileStat): boolean {
    return (stat.type & vscode.FileType.Directory) !== 0
      && (stat.type & vscode.FileType.SymbolicLink) === 0;
  }

  private async readProviderFile(uri: vscode.Uri): Promise<Uint8Array> {
    const before = await vscode.workspace.fs.stat(uri);
    if (!this.isRegularFile(before) || before.size > this.maxFileBytes) {
      throw new Error("Attachment source is not a permitted regular file.");
    }
    const data = await vscode.workspace.fs.readFile(uri);
    const after = await vscode.workspace.fs.stat(uri);
    if (!this.isRegularFile(after)
      || before.type !== after.type
      || before.size !== after.size
      || before.mtime !== after.mtime
      || before.ctime !== after.ctime
      || data.byteLength !== after.size
      || data.byteLength > this.maxFileBytes) {
      throw new Error("Attachment source changed while it was being read.");
    }
    return data;
  }

  private async writeProviderManagedFile(
    root: vscode.Uri,
    target: vscode.Uri,
    data: Uint8Array,
  ): Promise<boolean> {
    if (!isDirectChildPath(root.fsPath, target.fsPath)) return false;
    try {
      const before = await vscode.workspace.fs.stat(root);
      if (!this.isRegularDirectory(before)) return false;
      await vscode.workspace.fs.writeFile(target, data);
      const [rootAfter, targetAfter] = await Promise.all([
        vscode.workspace.fs.stat(root),
        vscode.workspace.fs.stat(target),
      ]);
      return this.isRegularDirectory(rootAfter)
        && this.isRegularFile(targetAfter)
        && targetAfter.size === data.byteLength;
    } catch {
      return false;
    }
  }

  private isLocalFile(uri: vscode.Uri): boolean {
    return uri.scheme === "file";
  }

  private canonicalPath(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  private localize(english: string, japanese: string): string {
    return this.isJapanese ? japanese : english;
  }
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}
