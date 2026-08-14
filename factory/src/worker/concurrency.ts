import { abortError, isAbortError } from "../git.js";

export interface BoundedBatchResult<T> {
  concurrency: number;
  completed: number;
  failed: number;
  results: T[];
}

export function normalizeConcurrency(value: number | undefined, fallback = 1): number {
  const candidate = Number(value);
  return Number.isInteger(candidate) && candidate > 0 ? candidate : fallback;
}

/**
 * Run a set of independent items with a hard upper bound on active tasks.
 * Normal task failures are isolated so unrelated items continue; cancellation
 * is propagated only after every already-started task has settled.
 */
export async function runBounded<T>(
  items: readonly T[],
  requestedLimit: number | undefined,
  execute: (item: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw abortError("Factory shutdown requested.");
  if (!items.length) return;

  const limit = Math.min(items.length, normalizeConcurrency(requestedLimit));
  let nextIndex = 0;
  let hasCancellation = false;
  let cancellationError: unknown;
  let hasFailure = false;
  let firstFailure: unknown;

  const runWorker = async () => {
    while (true) {
      if (hasCancellation || signal?.aborted) return;
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      try {
        await execute(items[index]);
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) {
          hasCancellation = true;
          cancellationError = error;
          return;
        }
        if (!hasFailure) {
          hasFailure = true;
          firstFailure = error;
        }
        // A failed item must not consume the worker slot for the remainder of
        // the batch. Continue with the next queued item.
      }
    }
  };

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
  if (hasCancellation) throw cancellationError || abortError("Factory shutdown requested.");
  if (signal?.aborted) throw abortError("Factory shutdown requested.");
  if (hasFailure) throw firstFailure;
}
