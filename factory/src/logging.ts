import { AsyncLocalStorage } from "node:async_hooks";

const factoryLoopContext = new AsyncLocalStorage<string>();

export function currentFactoryLoop(): string | undefined {
  return factoryLoopContext.getStore();
}

export function runWithFactoryLoop<TResult>(label: string, execute: () => Promise<TResult>): Promise<TResult> {
  return factoryLoopContext.run(label, execute);
}

export function isFactoryLogColorEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined) return false;
  const forced = process.env.FORCE_COLOR;
  if (forced !== undefined) return !["0", "false"].includes(forced.trim().toLowerCase());
  return process.stdout.isTTY === true;
}
