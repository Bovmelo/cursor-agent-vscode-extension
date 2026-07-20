export interface AsyncDisposable {
  dispose(): Promise<void>;
}

/** Owns deferred work and runs asynchronous shutdown exactly once. */
export class AsyncLifecycle {
  private disposing = false;
  private disposePromise: Promise<void> | undefined;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  public get isDisposing(): boolean {
    return this.disposing;
  }

  public defer(callback: () => void, delay = 0): void {
    if (this.disposing) {
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (!this.disposing) {
        callback();
      }
    }, delay);
    this.timers.add(timer);
  }

  public dispose(cleanup: () => Promise<void>): Promise<void> {
    if (!this.disposePromise) {
      this.disposing = true;
      for (const timer of this.timers) {
        clearTimeout(timer);
      }
      this.timers.clear();
      this.disposePromise = Promise.resolve().then(cleanup);
    }
    return this.disposePromise;
  }
}

/** Keeps the active provider available to VS Code's awaited deactivate hook. */
export class ExtensionDeactivation {
  private active: AsyncDisposable | undefined;

  public setActive(disposable: AsyncDisposable): void {
    this.active = disposable;
  }

  public deactivate(): Promise<void> {
    const active = this.active;
    this.active = undefined;
    return active?.dispose() ?? Promise.resolve();
  }
}
