import assert from "node:assert/strict";
import test from "node:test";
import { runFactoryLoop, runLoop, runMergeCheckLoop, runPlanningLoop, runReviewFixLoop } from "../worker/loops.js";
import { formatFactoryLog } from "../types.js";
import { currentFactoryLoop, runWithFactoryLoop, writeFactoryLog } from "../logging.js";

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
  assert.match(stripAnsi(messages[0]), /\[test\] /);
  assert.doesNotMatch(stripAnsi(messages[0]), /\[factory\]/);
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
  assert.match(stripAnsi(errors[0]), /\[retry-test\] /);
  assert.doesNotMatch(stripAnsi(errors[0]), /\[factory\]/);
  assert.match(stripAnsi(errors[0]), /retry failed: Error: temporary failure/);
});

test("idle polls emit one loop message and discard duplicate discovery telemetry", async () => {
  const controller = new AbortController();
  const messages: string[] = [];
  const logger = {
    info(message: string) { messages.push(message); },
    warn(message: string) { messages.push(message); },
    error(message: string) { messages.push(message); },
  };
  const worker = {
    signal: controller.signal,
    logger,
    log(level: "info" | "warn" | "error", event: string, details?: Record<string, unknown>) {
      const suffix = details && Object.keys(details).length ? ` ${JSON.stringify(details)}` : "";
      writeFactoryLog(logger, level, formatFactoryLog(`${event}${suffix}`, Date.now(), { loop: "test" }));
    },
  };

  await runFactoryLoop(worker, {
    intervalMs: 0,
    label: "test",
    shutdownEvent: "test-loop:shutdown-requested",
    failureMessage: "test failed",
    execute: async () => {
      worker.log("info", "test:task-start");
      worker.log("info", "jira:mcp:queued", { operation: "regular-check" });
      controller.abort();
      return { action: "idle" };
    },
  });

  assert.equal(messages.filter((message) => message.includes("test:task-start")).length, 0);
  assert.equal(messages.filter((message) => message.includes("jira:mcp:queued")).length, 0);
  assert.equal(messages.filter((message) => message.includes("[test] test:idle")).length, 1);
});

test("idle summaries cover planning, merge-check, and review-fix loops", async () => {
  const runIdleLoop = async (run: (controller: AbortController, messages: string[]) => Promise<void>) => {
    const controller = new AbortController();
    const messages: string[] = [];
    await run(controller, messages);
    return messages;
  };
  const makeLogger = (controller: AbortController, messages: string[]) => {
    const logger = {
      info(message: string) { messages.push(message); },
      warn(message: string) { messages.push(message); },
      error(message: string) { messages.push(message); },
    };
    return {
      signal: controller.signal,
      logger,
      log(level: "info" | "warn" | "error", event: string, details?: Record<string, unknown>) {
        const suffix = details && Object.keys(details).length ? ` ${JSON.stringify(details)}` : "";
        writeFactoryLog(logger, level, formatFactoryLog(`${event}${suffix}`, Date.now(), { loop: currentFactoryLoop() || "test" }));
      },
    };
  };

  const planningMessages = await runIdleLoop(async (controller, messages) => {
    const worker = makeLogger(controller, messages);
    await runPlanningLoop({
      ...worker,
      async planNextIssue() {
        worker.log("info", "planning:task-start");
        worker.log("info", "jira:mcp:queued", { operation: "search-planning" });
        controller.abort();
        return { action: "idle" };
      },
    }, { signal: controller.signal, intervalMs: 0 });
  });
  const mergeMessages = await runIdleLoop(async (controller, messages) => {
    const worker = makeLogger(controller, messages);
    await runMergeCheckLoop({
      ...worker,
      async checkMergedPullRequests() {
        worker.log("info", "merge-check:start");
        worker.log("info", "merge-check:pending", { count: 0 });
        controller.abort();
        return { closed: 0 };
      },
    }, { signal: controller.signal, intervalMs: 0 });
  });
  const reviewMessages = await runIdleLoop(async (controller, messages) => {
    const worker = makeLogger(controller, messages);
    await runReviewFixLoop({
      ...worker,
      async fixPullRequestReviews() {
        worker.log("info", "review-fix:pending", { count: 0 });
        controller.abort();
        return { pullRequests: 0, addressed: 0, disputed: 0, failed: 0 };
      },
    }, { signal: controller.signal, intervalMs: 0 });
  });

  assert.equal(planningMessages.filter((message) => message.includes("[planning] planning:idle")).length, 1);
  assert.equal(mergeMessages.filter((message) => message.includes("[merge-check] merge-check:idle")).length, 1);
  assert.equal(reviewMessages.filter((message) => message.includes("[review-fix] review-fix:idle")).length, 1);
  assert.equal(planningMessages.filter((message) => message.includes("planning:task-start")).length, 0);
  assert.equal(mergeMessages.filter((message) => message.includes("merge-check:pending")).length, 0);
  assert.equal(reviewMessages.filter((message) => message.includes("review-fix:pending")).length, 0);
});

test("actual loop work keeps its nested telemetry", async () => {
  const controller = new AbortController();
  const messages: string[] = [];
  const logger = {
    info(message: string) { messages.push(message); },
    warn(message: string) { messages.push(message); },
    error(message: string) { messages.push(message); },
  };
  const worker = {
    signal: controller.signal,
    logger,
    log(level: "info" | "warn" | "error", event: string) {
      writeFactoryLog(logger, level, formatFactoryLog(event, Date.now(), { loop: currentFactoryLoop() }));
    },
  };

  await runLoop({
    ...worker,
    async runOnce() {
      worker.log("info", "task:start");
      worker.log("info", "issue:claimed");
      controller.abort();
      return { action: "claimed" };
    },
  }, { signal: controller.signal, pollIntervalMs: 0 });

  assert.equal(messages.filter((message) => message.includes("task:start")).length, 1);
  assert.equal(messages.filter((message) => message.includes("issue:claimed")).length, 1);
  assert.equal(messages.filter((message) => message.includes("[task] task:idle")).length, 0);
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
  const plain = formatFactoryLog("task:idle", 0, { loop: "task" });
  const colored = formatFactoryLog("task:idle", 0, { loop: "task", colors: true });

  assert.equal(plain, "[1970-01-01T00:00:00.000Z] [task] task:idle");
  assert.equal(colored, "[1970-01-01T00:00:00.000Z] \u001b[36m[task]\u001b[0m task:idle");
});

test("concurrent factory loop contexts remain isolated across awaits", async () => {
  const observed: string[] = [];
  const run = (label: string, delayMs: number) => runWithFactoryLoop(label, async () => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    observed.push(`${currentFactoryLoop()}:before`);
    await new Promise((resolve) => setTimeout(resolve, 1));
    observed.push(`${currentFactoryLoop()}:after`);
  });

  await Promise.all([run("task", 2), run("merge-check", 0)]);

  assert.deepEqual(observed.sort(), ["merge-check:after", "merge-check:before", "task:after", "task:before"]);
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
  assert.ok(errors.some((message) => message.includes("planning task failed") && message.includes("planner unavailable")));
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
