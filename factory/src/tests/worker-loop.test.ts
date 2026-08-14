import assert from "node:assert/strict";
import test from "node:test";
import { runFactoryLoop, runLoop, runMergeCheckLoop, runPlanningLoop } from "../worker/loops.js";
import { formatFactoryLog } from "../types.js";
import { currentFactoryLoop, runWithFactoryLoop } from "../logging.js";

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

test("factory loop stops cleanly when its signal is aborted", async () => {
  const controller = new AbortController();
  const events: string[] = [];
  const messages: string[] = [];
  let executions = 0;
  const worker = {
    signal: controller.signal,
    logger: {
      info(message: string) { messages.push(message); },
      error(message: string) { messages.push(message); },
    },
    log(_level: "info" | "warn" | "error", event: string) { events.push(event); },
  };

  await runFactoryLoop(worker, {
    intervalMs: 0,
    label: "test",
    shutdownEvent: "test-loop:shutdown-requested",
    failureMessage: "test failed",
    execute: async () => {
      executions += 1;
      controller.abort();
      return { executions };
    },
  });

  assert.equal(executions, 1);
  assert.deepEqual(events, ["test:loop:started", "test-loop:shutdown-requested", "test:loop:stopped"]);
  assert.match(stripAnsi(messages[0]), /"executions":1/);
  assert.match(stripAnsi(messages[0]), /"loop":"test"/);
  assert.match(stripAnsi(messages[0]), /\[factory\] \[test\] /);
});

test("factory loop logs an execution failure and continues polling", async () => {
  const controller = new AbortController();
  const errors: string[] = [];
  let executions = 0;
  const worker = {
    signal: controller.signal,
    logger: {
      info() {},
      error(message: string) { errors.push(message); },
    },
    log() {},
  };

  await runFactoryLoop(worker, {
    intervalMs: 0,
    label: "retry-test",
    shutdownEvent: "retry-test:shutdown-requested",
    failureMessage: "retry failed",
    execute: async () => {
      executions += 1;
      if (executions === 1) throw new Error("temporary failure");
      controller.abort();
      return { executions };
    },
  });

  assert.equal(executions, 2);
  assert.equal(errors.length, 1);
  assert.match(stripAnsi(errors[0]), /\[factory\] \[retry-test\] /);
  assert.match(stripAnsi(errors[0]), /retry failed: Error: temporary failure/);
});

test("bounded loop polls isolate item failures and never exceed their configured limit", async () => {
  const controller = new AbortController();
  let executions = 0;
  let active = 0;
  let maxActive = 0;
  const errors: string[] = [];
  const worker = {
    signal: controller.signal,
    logger: {
      info() {},
      error(message: string) { errors.push(message); },
    },
    log() {},
  };

  await runFactoryLoop(worker, {
    intervalMs: 0,
    concurrency: 2,
    label: "bounded-test",
    shutdownEvent: "bounded-test:shutdown-requested",
    failureMessage: "bounded failed",
    execute: async () => {
      const id = ++executions;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      if (id === 1) throw new Error("one item failed");
      if (id === 4) controller.abort();
      return { id };
    },
  });

  assert.equal(executions, 4);
  assert.equal(maxActive, 2);
  assert.equal(active, 0);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /one item failed/);
});

test("factory loop labels can be colored without changing the log structure", () => {
  const plain = formatFactoryLog("poll:idle", 0, { loop: "poll" });
  const colored = formatFactoryLog("poll:idle", 0, { loop: "poll", colors: true });

  assert.equal(plain, "[1970-01-01T00:00:00.000Z] [factory] [poll] poll:idle");
  assert.equal(colored, "[1970-01-01T00:00:00.000Z] [factory] \u001b[36m[poll]\u001b[0m poll:idle");
});

test("concurrent factory loop contexts remain isolated across awaits", async () => {
  const observed: string[] = [];
  const run = (label: string, delayMs: number) => runWithFactoryLoop(label, async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    observed.push(`${currentFactoryLoop()}:before`);
    await new Promise((resolve) => setTimeout(resolve, 1));
    observed.push(`${currentFactoryLoop()}:after`);
  });

  await Promise.all([run("poll", 2), run("merge-check", 0)]);

  assert.deepEqual(observed.sort(), ["merge-check:after", "merge-check:before", "poll:after", "poll:before"]);
});

test("planning and implementation loops run independently", async () => {
  const controller = new AbortController();
  const errors: string[] = [];
  let planningAttempts = 0;
  let implementationPolls = 0;
  const common = {
    signal: controller.signal,
    logger: {
      info() {},
      error(message: string) { errors.push(message); },
    },
    log() {},
  };
  const planningWorker = {
    ...common,
    async planNextIssue() {
      planningAttempts += 1;
      throw new Error("planner unavailable");
    },
  };
  const implementationWorker = {
    ...common,
    async runOnce() {
      implementationPolls += 1;
      setImmediate(() => controller.abort());
      return { action: "idle" };
    },
  };

  await Promise.all([
    runPlanningLoop(planningWorker, { intervalMs: 1 }),
    runLoop(implementationWorker, { pollIntervalMs: 1 }),
  ]);

  assert.ok(planningAttempts >= 1);
  assert.equal(implementationPolls, 1);
  assert.ok(errors.some((message) => message.includes("planning poll failed") && message.includes("planner unavailable")));
});

test("planning, implementation, and merge-check loops start independently", async () => {
  const controller = new AbortController();
  const started = new Set<string>();
  const releases: Array<() => void> = [];
  let resolveStarted: (() => void) | undefined;
  const allStarted = new Promise<void>((resolve) => { resolveStarted = resolve; });
  const start = (label: string) => async () => {
    started.add(label);
    if (started.size === 3) resolveStarted?.();
    await new Promise<void>((resolve) => releases.push(resolve));
    return { action: "idle", closed: 0 };
  };
  const common = {
    signal: controller.signal,
    logger: { info() {}, error() {} },
    log() {},
  };

  const loops = [
    runPlanningLoop({ ...common, planNextIssue: start("planning") }, { signal: controller.signal, intervalMs: 1, concurrency: 1 }),
    runLoop({ ...common, runOnce: start("implementation") }, { signal: controller.signal, pollIntervalMs: 1, concurrency: 1 }),
    runMergeCheckLoop({ ...common, checkMergedPullRequests: start("merge-check") }, { signal: controller.signal, intervalMs: 1, concurrency: 1 }),
  ];
  await allStarted;
  assert.deepEqual([...started].sort(), ["implementation", "merge-check", "planning"]);
  controller.abort();
  releases.forEach((release) => release());
  await Promise.all(loops);
});

test("merge-check loop invokes its bounded batch once per poll", async () => {
  const controller = new AbortController();
  let calls = 0;
  const worker = {
    signal: controller.signal,
    logger: { info() {}, error() {} },
    log() {},
    async checkMergedPullRequests(concurrency?: number) {
      calls += 1;
      assert.equal(concurrency, 3);
      controller.abort();
      return { closed: 0 };
    },
  };

  await runMergeCheckLoop(worker, { signal: controller.signal, intervalMs: 0, concurrency: 3 });

  assert.equal(calls, 1);
});
