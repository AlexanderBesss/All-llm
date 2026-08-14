import { abortError, isAbortError } from "../git.js";
import { FactoryLoop, formatFactoryLog } from "../types.js";
import {
  captureFactoryLogs,
  flushFactoryLogs,
  isFactoryLogColorEnabled,
  runWithFactoryLoop,
  runWithoutFactoryLogCapture,
  writeFactoryLog,
} from "../logging.js";
import type { FactoryLogRecord } from "../logging.js";
import type { FactoryLogger } from "../model/worker.js";
import { normalizeConcurrency, runBounded } from "./concurrency.js";

type LoopLogLevel = "info" | "warn" | "error";

export interface FactoryLoopWorker {
  signal?: AbortSignal;
  logger: FactoryLogger;
  log?(level: LoopLogLevel, event: string, details?: Record<string, unknown>): void;
}

export interface FactoryLoopOptions<TResult extends object> {
  signal?: AbortSignal;
  intervalMs: number;
  label: string;
  shutdownEvent: string;
  failureMessage: string;
  concurrency?: number;
  isIdle?(result: object, records: readonly FactoryLogRecord[]): boolean;
  isActive?(record: FactoryLogRecord, records: readonly FactoryLogRecord[]): boolean;
  execute(): Promise<TResult>;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  return String(error);
}

async function waitForInterval(intervalMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError("Factory shutdown requested.");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, intervalMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError("Factory shutdown requested."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function executeBoundedTask<TResult extends object>(
  worker: FactoryLoopWorker,
  {
    label,
    failureMessage,
    concurrency,
    signal,
    execute,
  }: Pick<FactoryLoopOptions<TResult>, "label" | "failureMessage" | "concurrency" | "signal" | "execute">,
): Promise<object> {
  const limit = normalizeConcurrency(concurrency);
  if (limit === 1) return execute();

  const results: TResult[] = [];
  const failures: unknown[] = [];
  const slots = Array.from({ length: limit }, (_, index) => index);
  await runBounded(slots, limit, async () => {
    try {
      results.push(await execute());
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      failures.push(error);
      writeFactoryLog(worker.logger, "error", formatFactoryLog(`${failureMessage}: ${errorMessage(error)}`, Date.now(), {
        loop: label,
        colors: isFactoryLogColorEnabled(),
      }));
    }
  }, signal);
  return {
    concurrency: limit,
    completed: results.length,
    failed: failures.length,
    results,
  };
}

export async function runFactoryLoop<TResult extends object>(
  worker: FactoryLoopWorker,
  {
    signal = worker.signal,
    intervalMs,
    label,
    shutdownEvent,
    failureMessage,
    concurrency = 1,
    isIdle,
    isActive,
    execute,
  }: FactoryLoopOptions<TResult>,
): Promise<void> {
  return runWithFactoryLoop(label, async () => {
    let stopped = false;
    let streamed = 0;
    let streaming = false;
    const emitCapturedLogs = (records: readonly FactoryLogRecord[]) => {
      if (streamed >= records.length) return;
      const pending = records.slice(streamed);
      streamed = records.length;
      runWithoutFactoryLogCapture(() => flushFactoryLogs(worker.logger, pending));
    };
    const onCapturedLog = (record: FactoryLogRecord, records: readonly FactoryLogRecord[]) => {
      if (!streaming && isActive?.(record, records)) streaming = true;
      if (streaming) emitCapturedLogs(records);
    };
    const stop = () => {
      if (!stopped) runWithoutFactoryLogCapture(() => worker.log?.("info", shutdownEvent));
      stopped = true;
    };
    signal?.addEventListener("abort", stop, { once: true });
    worker.log?.("info", `${label}:loop:started`, { intervalMs });
    while (!stopped) {
      streamed = 0;
      streaming = false;
      const execution = await captureFactoryLogs(() => executeBoundedTask(worker, {
        label,
        failureMessage,
        concurrency,
        signal,
        execute,
      }), { onRecord: onCapturedLog });
      if (execution.ok === false) {
        emitCapturedLogs(execution.records);
        const error = execution.error;
        if (isAbortError(error) || signal?.aborted) {
          stop();
          break;
        }
        writeFactoryLog(worker.logger, "error", formatFactoryLog(`${failureMessage}: ${errorMessage(error)}`, Date.now(), {
          loop: label,
          colors: isFactoryLogColorEnabled(),
        }));
      } else if (
        execution.records.every((record) => record.level === "info")
        && (isIdle?.(execution.result, execution.records) || isRegularIdleResult(execution.result, execution.records))
      ) {
        worker.log?.("info", `${label}:idle`);
      } else {
        emitCapturedLogs(execution.records);
        writeFactoryLog(worker.logger, "info", formatFactoryLog(JSON.stringify({ ...execution.result, loop: label }), Date.now(), {
          loop: label,
          colors: isFactoryLogColorEnabled(),
        }));
      }
      if (!stopped) {
        try {
          await waitForInterval(intervalMs, signal);
        } catch (error) {
          if (isAbortError(error)) {
            stop();
            break;
          }
          throw error;
        }
      }
    }
    signal?.removeEventListener("abort", stop);
    worker.log?.("info", `${label}:loop:stopped`);
  });
}

function isRegularIdleResult(result: object, records: readonly FactoryLogRecord[]): boolean {
  if (records.some((record) => record.level !== "info")) return false;
  if ("action" in result) return result.action === "idle";
  if (!("results" in result) || !Array.isArray(result.results) || result.results.length === 0) return false;
  return result.results.every((item) =>
    item !== null && typeof item === "object" && "action" in item && item.action === "idle",
  );
}

export interface TaskLoopWorker extends FactoryLoopWorker {
  runOnce(): Promise<object>;
  runBatch?(options?: { concurrency?: number }): Promise<object>;
}

export interface PlanningLoopWorker extends FactoryLoopWorker {
  planNextIssue(): Promise<object>;
  planBatch?(options?: { concurrency?: number }): Promise<object>;
}

export function runPlanningLoop(
  worker: PlanningLoopWorker,
  { signal = worker.signal, intervalMs = 60_000, concurrency = 1 }: { signal?: AbortSignal; intervalMs?: number; concurrency?: number } = {},
): Promise<void> {
  return runFactoryLoop(worker, {
    signal,
    intervalMs,
    label: FactoryLoop.Planning,
    shutdownEvent: "planning-loop:shutdown-requested",
    failureMessage: "planning task failed",
    isIdle: (result) => isIdleBatchResult(result),
    isActive: (record) => record.message.includes("planning:agent-start"),
    // FactoryWorker.planBatch discovers and claims the bounded batch before
    // advancing any selected issue. Keep the outer loop serial for that batch
    // scheduler; small test doubles can still use the generic fallback.
    concurrency: worker.planBatch ? 1 : concurrency,
    execute: () => worker.planBatch
      ? worker.planBatch({ concurrency })
      : worker.planNextIssue(),
  });
}

export function runLoop(
  worker: TaskLoopWorker,
  { signal = worker.signal, pollIntervalMs = 60_000, concurrency = 1 }: { signal?: AbortSignal; pollIntervalMs?: number; concurrency?: number } = {},
): Promise<void> {
  return runFactoryLoop(worker, {
    signal,
    intervalMs: pollIntervalMs,
    label: FactoryLoop.Task,
    shutdownEvent: "loop:shutdown-requested",
    failureMessage: "task failed",
    isIdle: (result) => isIdleBatchResult(result),
    isActive: (record) => record.message.includes("issue:claimed") || record.message.includes("run:resume-found"),
    // FactoryWorker.runBatch claims every slot before advancing any run. Keep
    // the outer loop serial for that batch scheduler; test doubles without it
    // retain the generic bounded runOnce fallback.
    concurrency: worker.runBatch ? 1 : concurrency,
    execute: () => worker.runBatch
      ? worker.runBatch({ concurrency })
      : worker.runOnce(),
  });
}

export interface MergeCheckLoopWorker extends FactoryLoopWorker {
  checkMergedPullRequests(concurrency?: number): Promise<{ closed: number }>;
}

export function runMergeCheckLoop(
  worker: MergeCheckLoopWorker,
  { signal = worker.signal, intervalMs = 300_000, concurrency = 1 }: { signal?: AbortSignal; intervalMs?: number; concurrency?: number } = {},
): Promise<void> {
  return runFactoryLoop(worker, {
    signal,
    intervalMs,
    label: FactoryLoop.MergeCheck,
    shutdownEvent: "merge-check-loop:shutdown-requested",
    failureMessage: "merge-check failed",
    isIdle: (_result, records) => records.some((record) => record.message.includes("merge-check:pending {\"count\":0}")),
    isActive: (record) => record.message.includes("merge-check:pending") && !record.message.includes("{\"count\":0}"),
    // Merge-check discovers its whole batch in one poll and applies this
    // limit while evaluating individual pull requests.
    concurrency: 1,
    execute: () => worker.checkMergedPullRequests(concurrency),
  });
}

export interface ReviewFixLoopWorker extends FactoryLoopWorker {
  fixPullRequestReviews(): Promise<{ pullRequests: number; addressed: number; disputed: number; failed: number }>;
}

export function runReviewFixLoop(
  worker: ReviewFixLoopWorker,
  { signal = worker.signal, intervalMs = 300_000 }: { signal?: AbortSignal; intervalMs?: number } = {},
): Promise<void> {
  return runFactoryLoop(worker, {
    signal,
    intervalMs,
    label: FactoryLoop.ReviewFix,
    shutdownEvent: "review-fix-loop:shutdown-requested",
    failureMessage: "review-fix failed",
    isIdle: (result) => "pullRequests" in result && result.pullRequests === 0,
    isActive: (record) => record.message.includes("review-fix:pending") && !record.message.includes("{\"count\":0}"),
    execute: () => worker.fixPullRequestReviews(),
  });
}

function isIdleBatchResult(result: object): boolean {
  if (!("results" in result) || !Array.isArray(result.results) || result.results.length === 0) return false;
  if ("failed" in result && result.failed !== 0) return false;
  return result.results.every((item) =>
    item !== null && typeof item === "object" && "action" in item && item.action === "idle",
  );
}
