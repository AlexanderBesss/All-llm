import { AsyncLocalStorage } from "node:async_hooks";
import type { FactoryLogger } from "./model/worker.js";

const factoryLoopContext = new AsyncLocalStorage<string>();
const factoryLogCapture = new AsyncLocalStorage<FactoryLogRecord[] | undefined>();

export type FactoryLogLevel = "info" | "warn" | "error";

export interface FactoryLogRecord {
  level: FactoryLogLevel;
  message: string;
}

export function currentFactoryLoop(): string | undefined {
  return factoryLoopContext.getStore();
}

export function runWithFactoryLoop<TResult>(label: string, execute: () => Promise<TResult>): Promise<TResult> {
  return factoryLoopContext.run(label, execute);
}

export function writeFactoryLog(logger: FactoryLogger, level: FactoryLogLevel, message: string): void {
  const capture = factoryLogCapture.getStore();
  if (capture) {
    capture.push({ level, message });
    return;
  }
  logger[level]?.(message);
}

export async function captureFactoryLogs<TResult>(execute: () => Promise<TResult>): Promise<
  | { ok: true; result: TResult; records: FactoryLogRecord[] }
  | { ok: false; error: unknown; records: FactoryLogRecord[] }
> {
  const records: FactoryLogRecord[] = [];
  try {
    const result = await factoryLogCapture.run(records, execute);
    return { ok: true, result, records };
  } catch (error) {
    return { ok: false, error, records };
  }
}

export function flushFactoryLogs(logger: FactoryLogger, records: readonly FactoryLogRecord[]): void {
  records.forEach(({ level, message }) => writeFactoryLog(logger, level, message));
}

export function runWithoutFactoryLogCapture<TResult>(execute: () => TResult): TResult {
  return factoryLogCapture.run(undefined, execute);
}

export function isFactoryLogColorEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  const forced = process.env.FORCE_COLOR;
  if (forced !== undefined) return !["0", "false"].includes(forced.trim().toLowerCase());
  return process.stdout.isTTY === true;
}
