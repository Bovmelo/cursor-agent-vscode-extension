import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import * as path from "node:path";
import { isBackgroundJob, type BackgroundJob } from "./backgroundJobTypes.js";
import { isBackgroundJobDocument } from "./backgroundWorkerProtocol.js";

const repositoryRevision = Symbol("backgroundJobRepositoryRevision");

type TrackedBackgroundJob = BackgroundJob & {
  [repositoryRevision]?: string;
};

export class BackgroundJobWriteConflictError extends Error {
  public constructor(jobFile: string) {
    super(`Background job changed before it could be saved: ${path.basename(jobFile)}`);
    this.name = "BackgroundJobWriteConflictError";
  }
}

/** Durable storage boundary used by the host-side job state machine. */
export interface BackgroundJobRepository {
  initialize(): Promise<void>;
  list(): Promise<BackgroundJobLoadResult[]>;
  read(jobFile: string): Promise<BackgroundJob>;
  save(job: BackgroundJob): Promise<void>;
  validateOperationalBoundaries(job: BackgroundJob): Promise<void>;
}

export interface BackgroundJobRepositoryBoundaries {
  storageRoot: string;
  worktreesRoot: string;
}

export type BackgroundJobLoadResult =
  { ok: true; job: BackgroundJob } | { ok: false; jobFile: string; error: unknown };

export class FileBackgroundJobRepository implements BackgroundJobRepository {
  private readonly saveQueues = new Map<string, Promise<void>>();

  public constructor(
    private readonly jobsRoot: string,
    private readonly boundaries: BackgroundJobRepositoryBoundaries,
  ) {}

  public async initialize(): Promise<void> {
    await mkdir(this.jobsRoot, { recursive: true });
    const [jobsRoot, storageRoot] = await Promise.all([
      this.requireStableDirectory(this.jobsRoot),
      this.requireStableDirectory(this.boundaries.storageRoot),
    ]);
    if (!this.samePath(path.dirname(jobsRoot), storageRoot)) {
      throw new Error("Background job repository resolves outside extension storage.");
    }
  }

  public async list(): Promise<BackgroundJobLoadResult[]> {
    const files = await readdir(this.jobsRoot).catch(() => []);
    const jobs: BackgroundJobLoadResult[] = [];
    for (const file of files.filter(isBackgroundJobDocument)) {
      const jobFile = path.join(this.jobsRoot, file);
      try {
        jobs.push({ ok: true, job: await this.read(jobFile) });
      } catch (error) {
        jobs.push({ ok: false, jobFile, error });
      }
    }
    return jobs;
  }

  public async read(jobFile: string): Promise<BackgroundJob> {
    const normalizedJobFile = this.normalizeJobFile(jobFile);
    await this.requireStableJobFile(normalizedJobFile);
    const raw = await readFile(normalizedJobFile, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isBackgroundJob(parsed)) {
      throw new Error(`Invalid background job document: ${path.basename(normalizedJobFile)}`);
    }
    if (this.normalizePath(parsed.jobFile) !== this.normalizePath(normalizedJobFile)) {
      throw new Error(`Background job file identity mismatch: ${path.basename(normalizedJobFile)}`);
    }
    if (path.basename(normalizedJobFile) !== `${parsed.id}.json`) {
      throw new Error(`Background job id mismatch: ${path.basename(normalizedJobFile)}`);
    }
    this.validateDocumentBoundaries(parsed);
    this.trackRevision(parsed, raw);
    return parsed;
  }

  public async save(job: BackgroundJob): Promise<void> {
    const jobFile = this.normalizeJobFile(job.jobFile);
    if (!isBackgroundJob(job)) {
      throw new Error(`Invalid background job document: ${path.basename(jobFile)}`);
    }
    this.validateDocumentBoundaries(job);
    const expectedRevision = (job as TrackedBackgroundJob)[repositoryRevision];
    job.updatedAt = Math.max(Date.now(), job.updatedAt + 1);
    const serialized = JSON.stringify(job, undefined, 2);
    const previous = this.saveQueues.get(job.id) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(async () => {
        await this.requireStableJobFile(jobFile, true);
        const currentRevision = await readFile(jobFile, "utf8").catch((error: unknown) => {
          if (isNodeError(error, "ENOENT")) {
            return undefined;
          }
          throw error;
        });
        if (
          (expectedRevision === undefined && currentRevision !== undefined) ||
          (expectedRevision !== undefined && currentRevision !== expectedRevision)
        ) {
          throw new BackgroundJobWriteConflictError(jobFile);
        }
        const temporary = `${jobFile}.host.${process.pid}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, serialized, "utf8");
          await rename(temporary, jobFile);
        } finally {
          await unlink(temporary).catch(() => undefined);
        }
        this.trackRevision(job, serialized);
      });
    const queued = operation.catch(() => undefined);
    this.saveQueues.set(job.id, queued);
    try {
      await operation;
    } finally {
      if (this.saveQueues.get(job.id) === queued) {
        this.saveQueues.delete(job.id);
      }
    }
  }

  public async validateOperationalBoundaries(job: BackgroundJob): Promise<void> {
    this.validateDocumentBoundaries(job);
    const storageRoot = await this.requireStableDirectory(this.boundaries.storageRoot);
    if (!this.samePath(storageRoot, await realpath(job.storageRoot))) {
      throw new Error("Background job storage root changed after it was persisted.");
    }

    const expectedWorktreesRoot = path.resolve(this.boundaries.worktreesRoot);
    const worktreesRoot = await this.stableDirectoryIfPresent(expectedWorktreesRoot);
    const worktree = await this.stableDirectoryIfPresent(job.session.worktreePath);
    if (worktree) {
      if (!worktreesRoot || !this.samePath(path.dirname(worktree), worktreesRoot)) {
        throw new Error("Background worktree resolves outside its managed root.");
      }
    }

    const baselineFolder = path.join(storageRoot, "background-baselines");
    const baselineRoot = path.join(baselineFolder, job.id);
    const canonicalBaselineFolder = await this.stableDirectoryIfPresent(baselineFolder);
    const canonicalBaselineRoot = await this.stableDirectoryIfPresent(baselineRoot);
    if (
      canonicalBaselineRoot &&
      (!canonicalBaselineFolder ||
        !this.samePath(path.dirname(canonicalBaselineRoot), canonicalBaselineFolder) ||
        !this.isInside(storageRoot, canonicalBaselineRoot))
    ) {
      throw new Error("Background baseline storage resolves outside extension storage.");
    }
    if (!canonicalBaselineRoot) {
      return;
    }
    for (const snapshot of Object.values(job.session.baselineFiles)) {
      if (!snapshot.existed || !snapshot.backupName) {
        continue;
      }
      const backupFile = path.join(canonicalBaselineRoot, snapshot.backupName);
      let details;
      try {
        details = await lstat(backupFile);
      } catch (error) {
        if (isNodeError(error, "ENOENT")) {
          continue;
        }
        throw error;
      }
      if (details.isSymbolicLink() || !details.isFile()) {
        throw new Error("Background baseline backup is not a stable file.");
      }
      const canonicalBackup = await realpath(backupFile);
      if (!this.samePath(path.dirname(canonicalBackup), canonicalBaselineRoot)) {
        throw new Error("Background baseline backup resolves outside its managed root.");
      }
    }
  }

  private normalizeJobFile(jobFile: string): string {
    const normalized = path.resolve(jobFile);
    if (
      this.normalizePath(path.dirname(normalized)) !==
        this.normalizePath(path.resolve(this.jobsRoot)) ||
      !isBackgroundJobDocument(path.basename(normalized))
    ) {
      throw new Error("Background job path escapes its repository.");
    }
    return normalized;
  }

  private validateDocumentBoundaries(job: BackgroundJob): void {
    if (!this.samePath(job.storageRoot, this.boundaries.storageRoot)) {
      throw new Error("Background job storage root does not match extension storage.");
    }
    const expectedWorktree = path.join(this.boundaries.worktreesRoot, job.id);
    if (!this.samePath(job.session.worktreePath, expectedWorktree)) {
      throw new Error("Background job worktree is outside its managed root.");
    }
    const expectedBaselineRoot = path.join(
      this.boundaries.storageRoot,
      job.session.baselinesFolder,
      job.id,
    );
    if (!this.isInside(this.boundaries.storageRoot, expectedBaselineRoot)) {
      throw new Error("Background baseline storage is outside extension storage.");
    }
  }

  private normalizePath(value: string): string {
    const normalized = path.normalize(value);
    return process.platform === "win32" ? normalized.toLocaleLowerCase("en-US") : normalized;
  }

  private samePath(left: string, right: string): boolean {
    return this.normalizePath(path.resolve(left)) === this.normalizePath(path.resolve(right));
  }

  private isInside(root: string, candidate: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  }

  private async requireStableDirectory(candidate: string): Promise<string> {
    const canonical = await this.stableDirectoryIfPresent(candidate);
    if (!canonical) {
      throw new Error(`Background storage directory is unavailable: ${candidate}`);
    }
    return canonical;
  }

  private async stableDirectoryIfPresent(candidate: string): Promise<string | undefined> {
    let details;
    try {
      details = await lstat(candidate);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return undefined;
      }
      throw error;
    }
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new Error(`Background managed path is not a stable directory: ${candidate}`);
    }
    return realpath(candidate);
  }

  private async requireStableJobFile(jobFile: string, allowMissing = false): Promise<void> {
    let details;
    try {
      details = await lstat(jobFile);
    } catch (error) {
      if (allowMissing && isNodeError(error, "ENOENT")) {
        return;
      }
      throw error;
    }
    if (details.isSymbolicLink() || !details.isFile()) {
      throw new Error(`Background job document is not a stable file: ${jobFile}`);
    }
    const [canonicalJob, canonicalJobsRoot] = await Promise.all([
      realpath(jobFile),
      this.requireStableDirectory(this.jobsRoot),
    ]);
    if (!this.samePath(path.dirname(canonicalJob), canonicalJobsRoot)) {
      throw new Error("Background job document resolves outside its repository.");
    }
  }

  private trackRevision(job: BackgroundJob, revision: string): void {
    Object.defineProperty(job, repositoryRevision, {
      configurable: false,
      enumerable: true,
      value: revision,
      writable: true,
    });
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
