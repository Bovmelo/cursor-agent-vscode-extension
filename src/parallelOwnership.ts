import * as path from "node:path";

export interface FileOwnershipConflict {
  file: string;
  owner: string;
}

export interface FileOwnershipLease {
  readonly owner: string;
  readonly files: readonly string[];
  release(): void;
}

function identity(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * All-or-nothing file ownership for parallel chat agents. Claims are advisory while
 * agents work and exclusive while their isolated changes pass through the apply queue.
 */
export class FileOwnershipCoordinator {
  private readonly owners = new Map<string, { owner: string; file: string }>();
  private readonly waiters = new Set<() => void>();

  public tryAcquire(
    owner: string,
    files: readonly string[],
  ): { lease?: FileOwnershipLease; conflicts: FileOwnershipConflict[] } {
    const unique = new Map<string, string>();
    for (const file of files) {
      unique.set(identity(file), path.resolve(file));
    }
    const conflicts: FileOwnershipConflict[] = [];
    for (const [key, file] of unique) {
      const current = this.owners.get(key);
      if (current && current.owner !== owner) {
        conflicts.push({ file, owner: current.owner });
      }
    }
    if (conflicts.length > 0) {
      return { conflicts };
    }

    for (const [key, file] of unique) {
      this.owners.set(key, { owner, file });
    }
    let released = false;
    const lease: FileOwnershipLease = {
      owner,
      files: [...unique.values()],
      release: () => {
        if (released) {
          return;
        }
        released = true;
        for (const key of unique.keys()) {
          if (this.owners.get(key)?.owner === owner) {
            this.owners.delete(key);
          }
        }
        this.notifyWaiters();
      },
    };
    return { lease, conflicts: [] };
  }

  public async acquire(owner: string, files: readonly string[]): Promise<FileOwnershipLease> {
    while (true) {
      const attempt = this.tryAcquire(owner, files);
      if (attempt.lease) {
        return attempt.lease;
      }
      await new Promise<void>((resolve) => this.waiters.add(resolve));
    }
  }

  public releaseOwner(owner: string): void {
    let changed = false;
    for (const [key, current] of this.owners) {
      if (current.owner === owner) {
        this.owners.delete(key);
        changed = true;
      }
    }
    if (changed) {
      this.notifyWaiters();
    }
  }

  public conflicts(owner: string, files: readonly string[]): FileOwnershipConflict[] {
    return files.flatMap((file) => {
      const current = this.owners.get(identity(file));
      return current && current.owner !== owner
        ? [{ file: path.resolve(file), owner: current.owner }]
        : [];
    });
  }

  private notifyWaiters(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const resolve of waiters) {
      resolve();
    }
  }
}

/** A FIFO promise queue that remains usable after a failed operation. */
export class ApplyQueue {
  private tail: Promise<void> = Promise.resolve();

  public run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
