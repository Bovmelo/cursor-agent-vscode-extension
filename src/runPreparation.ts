export type RunPreparationFailureKind = "cancelled" | "timeout";

export class RunPreparationError extends Error {
  public constructor(
    public readonly kind: RunPreparationFailureKind,
    public readonly phase: string,
  ) {
    super(
      kind === "cancelled"
        ? `Cursor run preparation was cancelled during ${phase}.`
        : `Cursor did not respond while ${phase}.`,
    );
    this.name = "RunPreparationError";
  }
}

export interface RunPreparationOptions<T> {
  signal: AbortSignal;
  timeoutMs: number;
  phase: string;
  onLateResolve?: (value: T) => void | Promise<void>;
  onOperationSettled?: (completion: Promise<void>) => void;
}

/**
 * Bounds an SDK preparation operation that does not accept an AbortSignal.
 * A late result is handed to the caller so orphaned agents/runs can be closed.
 */
export function waitForRunPreparation<T>(
  operation: () => Promise<T>,
  options: RunPreparationOptions<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    let timer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      options.signal.removeEventListener("abort", onAbort);
    };
    const rejectOnce = (error: unknown): void => {
      if (finished) {
        return;
      }
      finished = true;
      cleanup();
      reject(error);
    };
    const onAbort = (): void => {
      rejectOnce(new RunPreparationError("cancelled", options.phase));
    };

    if (options.signal.aborted) {
      onAbort();
      return;
    } else {
      options.signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        rejectOnce(new RunPreparationError("timeout", options.phase));
      }, Math.max(1, options.timeoutMs));
    }

    let operationPromise: Promise<T>;
    try {
      operationPromise = operation();
    } catch (error) {
      rejectOnce(error);
      return;
    }
    const completion = operationPromise.then(
      async (value) => {
        if (finished) {
          await options.onLateResolve?.(value);
          return;
        }
        finished = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        rejectOnce(error);
      },
    ).then(
      () => {},
      () => {},
    );
    options.onOperationSettled?.(completion);
  });
}

export function isRunPreparationError(error: unknown): error is RunPreparationError {
  return error instanceof RunPreparationError;
}
