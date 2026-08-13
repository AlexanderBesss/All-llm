import assert from "node:assert/strict";
import test from "node:test";
import { runFactoryLoop } from "../worker/loops.js";

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
  assert.match(messages[0], /"executions":1/);
  assert.match(messages[0], /"loop":"test"/);
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
  assert.match(errors[0], /retry failed: Error: temporary failure/);
});
