import { constants as fsConstants, type BigIntStats } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  lstat,
  open,
  realpath,
  readdir,
  rename,
  rm,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import * as path from "node:path";

export interface StableDirectoryIdentity {
  lexicalPath: string;
  canonicalPath: string;
  details: BigIntStats;
}

interface StableAllowedRoot {
  lexicalPath: string;
  canonicalPath: string;
  lexicalDetails: BigIntStats;
  targetDetails: BigIntStats;
}

/** Internal deterministic seam used by filesystem race regression tests. */
export interface StableReadHooks {
  afterOpen?: () => Promise<void>;
}

/** Internal deterministic seam used by filesystem race regression tests. */
export interface StableRemoveHooks {
  beforeRemove?: () => Promise<void>;
}

export async function captureStableDirectory(
  candidate: string,
): Promise<StableDirectoryIdentity> {
  const lexicalPath = path.resolve(candidate);
  const before = await lstat(lexicalPath, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(`Attachment path is not a regular directory: ${lexicalPath}`);
  }
  const canonicalPath = await realpath(lexicalPath);
  const [after, canonicalAfter] = await Promise.all([
    lstat(lexicalPath, { bigint: true }),
    realpath(lexicalPath),
  ]);
  if (after.isSymbolicLink()
    || !after.isDirectory()
    || !sameFileIdentity(before, after)
    || !samePath(canonicalPath, canonicalAfter)) {
    throw new Error(`Attachment directory changed while being validated: ${lexicalPath}`);
  }
  return { lexicalPath, canonicalPath, details: after };
}

export async function captureStableDirectChildDirectory(
  parent: string,
  candidate: string,
): Promise<{ parent: StableDirectoryIdentity; candidate: StableDirectoryIdentity }> {
  const lexicalParent = path.resolve(parent);
  const lexicalCandidate = path.resolve(candidate);
  if (!isDirectChild(lexicalParent, lexicalCandidate)) {
    throw new Error("Attachment directory is not an immediate managed child.");
  }
  const parentIdentity = await captureStableDirectory(lexicalParent);
  const candidateIdentity = await captureStableDirectory(lexicalCandidate);
  if (!isDirectChild(parentIdentity.canonicalPath, candidateIdentity.canonicalPath)) {
    throw new Error("Attachment directory resolves outside its managed parent.");
  }
  await requireDirectoryIdentity(parentIdentity);
  await requireDirectoryIdentity(candidateIdentity);
  return { parent: parentIdentity, candidate: candidateIdentity };
}

/**
 * Opens and reads a local file through one handle, then verifies both the open
 * identity and lexical path again. Symlinks, root escapes, and in-place changes
 * during the read fail closed.
 */
export async function readStableLocalFile(
  allowedRoot: string,
  file: string,
  maxBytes: number,
  hooks: StableReadHooks = {},
): Promise<Uint8Array> {
  const root = await captureStableAllowedRoot(allowedRoot);
  const lexicalFile = path.resolve(file);
  const initial = await lstat(lexicalFile, { bigint: true });
  if (initial.isSymbolicLink() || !initial.isFile() || initial.size > BigInt(maxBytes)) {
    throw new Error("Attachment source is not a permitted regular file.");
  }
  const initialRealPath = await realpath(lexicalFile);
  if (!isInside(root.canonicalPath, initialRealPath)) {
    throw new Error("Attachment source resolves outside its allowed root.");
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(
      lexicalFile,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const openedBefore = await handle.stat({ bigint: true });
    await hooks.afterOpen?.();
    const [pathBefore, realBefore] = await Promise.all([
      lstat(lexicalFile, { bigint: true }),
      realpath(lexicalFile),
    ]);
    if (!validStableFile(initial, openedBefore, pathBefore)
      || pathBefore.isSymbolicLink()
      || !samePath(initialRealPath, realBefore)
      || !isInside(root.canonicalPath, realBefore)
      || openedBefore.size > BigInt(maxBytes)) {
      throw new Error("Attachment source changed before it could be read.");
    }
    await requireAllowedRoot(root);

    const bytes = await handle.readFile();
    const [openedAfter, pathAfter, realAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(lexicalFile, { bigint: true }),
      realpath(lexicalFile),
    ]);
    if (!validStableFile(openedBefore, openedAfter, pathAfter)
      || pathAfter.isSymbolicLink()
      || !samePath(initialRealPath, realAfter)
      || !isInside(root.canonicalPath, realAfter)
      || bytes.byteLength > maxBytes) {
      throw new Error("Attachment source changed while it was being read.");
    }
    await requireAllowedRoot(root);
    return new Uint8Array(bytes);
  } finally {
    await handle?.close();
  }
}

/** Validates a local file without trusting a provider stat that may follow links. */
export async function validateStableLocalFile(
  allowedRoot: string,
  file: string,
  maxBytes: number,
): Promise<boolean> {
  let handle: FileHandle | undefined;
  try {
    const root = await captureStableAllowedRoot(allowedRoot);
    const lexicalFile = path.resolve(file);
    const before = await lstat(lexicalFile, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile() || before.size > BigInt(maxBytes)) return false;
    const canonicalFile = await realpath(lexicalFile);
    if (!isInside(root.canonicalPath, canonicalFile)) return false;
    handle = await open(lexicalFile, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const [opened, current, canonicalCurrent] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(lexicalFile, { bigint: true }),
      realpath(lexicalFile),
    ]);
    await requireAllowedRoot(root);
    return validStableFile(before, opened, current)
      && !current.isSymbolicLink()
      && samePath(canonicalFile, canonicalCurrent)
      && isInside(root.canonicalPath, canonicalCurrent);
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

/** Writes through a no-follow handle after anchoring the target's direct parent. */
export async function writeStableLocalFile(
  parent: string,
  file: string,
  bytes: Uint8Array,
  expectedParent?: StableDirectoryIdentity,
): Promise<boolean> {
  const parentIdentity = await captureStableDirectory(parent);
  if (expectedParent && !sameDirectoryIdentity(expectedParent, parentIdentity)) return false;
  const lexicalFile = path.resolve(file);
  if (!isDirectChild(parentIdentity.lexicalPath, lexicalFile)) return false;

  let handle: FileHandle | undefined;
  let created = false;
  let openedIdentity: BigIntStats | undefined;
  try {
    await requireDirectoryIdentity(parentIdentity);
    try {
      handle = await open(lexicalFile, fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
      handle = await open(
        lexicalFile,
        fsConstants.O_WRONLY
          | fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | (fsConstants.O_NOFOLLOW ?? 0),
        0o600,
      );
      created = true;
    }
    openedIdentity = await handle.stat({ bigint: true });
    const [current, canonicalFile] = await Promise.all([
      lstat(lexicalFile, { bigint: true }),
      realpath(lexicalFile),
    ]);
    if (!openedIdentity.isFile()
      || openedIdentity.nlink !== 1n
      || current.isSymbolicLink()
      || !current.isFile()
      || !sameFileIdentity(openedIdentity, current)
      || !isDirectChild(parentIdentity.canonicalPath, canonicalFile)) {
      throw new Error("Managed attachment target changed before writing.");
    }
    await requireDirectoryIdentity(parentIdentity);
    await handle.truncate(0);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(
        bytes,
        offset,
        bytes.byteLength - offset,
        offset,
      );
      if (bytesWritten <= 0) throw new Error("Unable to finish writing the attachment.");
      offset += bytesWritten;
    }
    await handle.sync();
    const [openedAfter, pathAfter, realAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(lexicalFile, { bigint: true }),
      realpath(lexicalFile),
    ]);
    if (!sameFileIdentity(openedIdentity, openedAfter)
      || !sameFileIdentity(openedAfter, pathAfter)
      || pathAfter.isSymbolicLink()
      || !openedAfter.isFile()
      || openedAfter.size !== BigInt(bytes.byteLength)
      || !isDirectChild(parentIdentity.canonicalPath, realAfter)) {
      throw new Error("Managed attachment target changed while writing.");
    }
    await requireDirectoryIdentity(parentIdentity);
    return true;
  } catch {
    await handle?.close();
    handle = undefined;
    if (created && openedIdentity) {
      await removeCreatedFileIfUnchanged(lexicalFile, openedIdentity);
    }
    return false;
  } finally {
    await handle?.close();
  }
}

/**
 * Removes one verified direct child. Links inside the tree are unlinked first;
 * directory identities and realpath boundaries are rechecked immediately
 * before local recursive removal.
 */
export async function removeStableLocalDirectory(
  parent: string,
  candidate: string,
  expectedParent?: StableDirectoryIdentity,
  expectedCandidate?: StableDirectoryIdentity,
  hooks: StableRemoveHooks = {},
): Promise<boolean> {
  let quarantine: string | undefined;
  let original: string | undefined;
  let originalIdentity: BigIntStats | undefined;
  try {
    const captured = await captureStableDirectChildDirectory(parent, candidate);
    if ((expectedParent && !sameDirectoryIdentity(expectedParent, captured.parent))
      || (expectedCandidate && !sameDirectoryIdentity(expectedCandidate, captured.candidate))) {
      return false;
    }
    await unlinkNestedLinks(captured.candidate.canonicalPath, captured.candidate);
    await hooks.beforeRemove?.();
    await requireDirectoryIdentity(captured.parent);
    await requireDirectoryIdentity(captured.candidate);
    const finalCanonical = await realpath(captured.candidate.lexicalPath);
    if (!samePath(finalCanonical, captured.candidate.canonicalPath)
      || !isDirectChild(captured.parent.canonicalPath, finalCanonical)) return false;
    quarantine = path.join(
      captured.parent.canonicalPath,
      `.attachment-delete-${randomUUID()}`,
    );
    original = captured.candidate.lexicalPath;
    originalIdentity = captured.candidate.details;
    await rename(finalCanonical, quarantine);
    const moved = await captureStableDirectory(quarantine);
    if (!sameFileIdentity(captured.candidate.details, moved.details)
      || !isDirectChild(captured.parent.canonicalPath, moved.canonicalPath)) {
      await restoreMovedDirectory(quarantine, captured.candidate.lexicalPath, captured.candidate.details);
      return false;
    }
    await requireDirectoryIdentity(captured.parent);
    await requireDirectoryIdentity(moved);
    await rm(moved.canonicalPath, { recursive: true, force: false, maxRetries: 0 });
    return true;
  } catch {
    if (quarantine && original && originalIdentity) {
      await restoreMovedDirectory(quarantine, original, originalIdentity);
    }
    return false;
  }
}

export function sameDirectoryIdentity(
  left: StableDirectoryIdentity,
  right: StableDirectoryIdentity,
): boolean {
  return samePath(left.lexicalPath, right.lexicalPath)
    && samePath(left.canonicalPath, right.canonicalPath)
    && sameFileIdentity(left.details, right.details);
}

async function requireDirectoryIdentity(expected: StableDirectoryIdentity): Promise<void> {
  const current = await captureStableDirectory(expected.lexicalPath);
  if (!sameDirectoryIdentity(expected, current)) {
    throw new Error(`Managed attachment directory changed: ${expected.lexicalPath}`);
  }
}

async function captureStableAllowedRoot(candidate: string): Promise<StableAllowedRoot> {
  const lexicalPath = path.resolve(candidate);
  const lexicalBefore = await lstat(lexicalPath, { bigint: true });
  const canonicalPath = await realpath(lexicalPath);
  const targetBefore = await lstat(canonicalPath, { bigint: true });
  const [lexicalAfter, targetAfter, canonicalAfter] = await Promise.all([
    lstat(lexicalPath, { bigint: true }),
    lstat(canonicalPath, { bigint: true }),
    realpath(lexicalPath),
  ]);
  if (!targetBefore.isDirectory()
    || targetBefore.isSymbolicLink()
    || !targetAfter.isDirectory()
    || targetAfter.isSymbolicLink()
    || !sameFileIdentity(lexicalBefore, lexicalAfter)
    || !sameFileIdentity(targetBefore, targetAfter)
    || !samePath(canonicalPath, canonicalAfter)) {
    throw new Error(`Attachment allowed root changed while being validated: ${lexicalPath}`);
  }
  return {
    lexicalPath,
    canonicalPath,
    lexicalDetails: lexicalAfter,
    targetDetails: targetAfter,
  };
}

async function requireAllowedRoot(expected: StableAllowedRoot): Promise<void> {
  const current = await captureStableAllowedRoot(expected.lexicalPath);
  if (!samePath(expected.canonicalPath, current.canonicalPath)
    || !sameFileIdentity(expected.lexicalDetails, current.lexicalDetails)
    || !sameFileIdentity(expected.targetDetails, current.targetDetails)) {
    throw new Error(`Attachment allowed root changed: ${expected.lexicalPath}`);
  }
}

async function unlinkNestedLinks(
  canonicalRoot: string,
  directory: StableDirectoryIdentity,
): Promise<void> {
  await requireDirectoryIdentity(directory);
  const entries = await readdir(directory.canonicalPath, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(directory.canonicalPath, entry.name);
    const details = await lstat(candidate, { bigint: true });
    if (details.isSymbolicLink()) {
      await unlink(candidate);
      continue;
    }
    if (!details.isDirectory()) continue;
    const child = await captureStableDirectory(candidate);
    if (!isInside(canonicalRoot, child.canonicalPath)) {
      throw new Error("Managed attachment child resolves outside its root.");
    }
    await unlinkNestedLinks(canonicalRoot, child);
  }
  await requireDirectoryIdentity(directory);
}

async function removeCreatedFileIfUnchanged(file: string, expected: BigIntStats): Promise<void> {
  try {
    const current = await lstat(file, { bigint: true });
    if (current.isFile() && !current.isSymbolicLink() && sameFileIdentity(expected, current)) {
      await unlink(file);
    }
  } catch {
    // Best effort; never unlink a replacement path.
  }
}

async function restoreMovedDirectory(
  quarantine: string,
  original: string,
  expected: BigIntStats,
): Promise<void> {
  try {
    const moved = await lstat(quarantine, { bigint: true });
    if (!moved.isDirectory() || moved.isSymbolicLink() || !sameFileIdentity(expected, moved)) return;
    try {
      await lstat(original);
      return;
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) return;
    }
    await rename(quarantine, original);
  } catch {
    // Best effort; never move an identity that no longer matches.
  }
}

function validStableFile(
  first: BigIntStats,
  second: BigIntStats,
  lexical: BigIntStats,
): boolean {
  return first.isFile()
    && second.isFile()
    && lexical.isFile()
    && !lexical.isSymbolicLink()
    && sameFileIdentity(first, second)
    && sameFileIdentity(second, lexical)
    && sameFileSnapshot(first, second)
    && sameFileSnapshot(second, lexical);
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  if (left.ino === 0n || right.ino === 0n || left.ino !== right.ino) return false;
  return process.platform === "win32"
    ? left.dev === right.dev || left.dev === 0n || right.dev === 0n
    : left.dev === right.dev;
}

function isDirectChild(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative.length > 0
    && !relative.startsWith("..")
    && !path.isAbsolute(relative)
    && path.dirname(relative) === ".";
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function samePath(left: string, right: string): boolean {
  return path.relative(path.resolve(left), path.resolve(right)) === "";
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}
