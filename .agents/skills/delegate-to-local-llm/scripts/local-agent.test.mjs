import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildRunArguments,
  LocalAgentError,
  parseOpenCodeEvents,
  prepareTask,
  REQUIRED_LOCAL_MODEL,
  resolveConfiguration,
  runTasks,
} from "./local-agent.mjs";

test("resolveConfiguration validates the OpenCode local provider", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "local-agent-config-"));
  await writeFile(
    path.join(workspace, "opencode.json"),
    JSON.stringify({
      model: REQUIRED_LOCAL_MODEL,
      provider: {
        llamacpp: {
          options: { baseURL: "http://192.168.0.96:8080/v1", apiKey: "local" },
          models: { "unsloth/Qwen3.6-27B-UD-Q4_K_XL": {} },
        },
      },
    }),
  );

  const config = await resolveConfiguration(workspace);
  assert.equal(config.baseUrl, "http://192.168.0.96:8080/v1");
  assert.equal(config.model, REQUIRED_LOCAL_MODEL);
  assert.equal(config.agent, "build");
  assert.ok(config.command);
});

test("resolveConfiguration requires the pinned Qwen 3.6 27B model", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "local-agent-model-"));
  await writeFile(
    path.join(workspace, "opencode.json"),
    JSON.stringify({
      model: "llamacpp/some-other-model",
      provider: {
        llamacpp: {
          options: { baseURL: "http://192.168.0.96:8080/v1" },
          models: { "some-other-model": {} },
        },
      },
    }),
  );

  await assert.rejects(resolveConfiguration(workspace), /Required local model/);
});

test("prepareTask includes workspace files as labeled context", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "local-agent-context-"));
  await writeFile(path.join(workspace, "example.txt"), "evidence");
  const config = { cwd: workspace, maxContextBytes: 1000 };

  const task = await prepareTask(
    {
      id: "review",
      role: "critic",
      task: "Review the evidence",
      context_files: ["example.txt"],
    },
    config,
    0,
  );

  assert.equal(task.id, "review");
  assert.match(task.context, /FILE: example\.txt/);
  assert.match(task.context, /evidence/);
});

test("prepareTask rejects context outside the workspace", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "local-agent-boundary-"));
  const config = { cwd: workspace, maxContextBytes: 1000 };

  await assert.rejects(
    prepareTask(
      { role: "critic", task: "Review", context_files: ["../outside.txt"] },
      config,
      0,
    ),
    LocalAgentError,
  );
});

test("prepareTask enforces the limit for inline context", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "local-agent-limit-"));
  const config = { cwd: workspace, maxContextBytes: 4 };

  await assert.rejects(
    prepareTask(
      { role: "critic", task: "Review", context: "too much context" },
      config,
      0,
    ),
    /LOCAL_LLM_MAX_CONTEXT_BYTES/,
  );
});

test("buildRunArguments uses the verified OpenCode parameters", () => {
  const config = {
    model: REQUIRED_LOCAL_MODEL,
    agent: "build",
    cwd: "workspace",
  };
  const task = { role: "reviewer", assignment: "Inspect the project", context: "" };
  const args = buildRunArguments(config, task);

  assert.deepEqual(args.slice(0, 10), [
    "run",
    "--model",
    REQUIRED_LOCAL_MODEL,
    "--agent",
    "build",
    "--format",
    "json",
    "--auto",
    "--dir",
    "workspace",
  ]);
  assert.match(args[10], /ASSIGNMENT:\nInspect the project/);
});

test("parseOpenCodeEvents returns final text and a compact tool trace", () => {
  const stdout = [
    JSON.stringify({ type: "step_start", sessionID: "session-1" }),
    JSON.stringify({
      type: "tool_use",
      sessionID: "session-1",
      part: { tool: "read", state: { status: "completed", title: "README.md" } },
    }),
    JSON.stringify({
      type: "text",
      sessionID: "session-1",
      part: { text: "Done" },
    }),
  ].join("\n");

  assert.deepEqual(parseOpenCodeEvents(stdout), {
    output: "Done",
    sessionId: "session-1",
    toolCalls: [{ tool: "read", title: "README.md", status: "completed" }],
  });
});

test("runTasks executes OpenCode workers one by one and isolates failures", async () => {
  const tasks = [
    { id: "one", role: "reader" },
    { id: "two", role: "critic" },
  ];
  const events = [];
  let activeCalls = 0;
  let peakCalls = 0;
  const client = {
    async complete(task) {
      events.push(`start:${task.id}`);
      activeCalls += 1;
      peakCalls = Math.max(peakCalls, activeCalls);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeCalls -= 1;
      events.push(`end:${task.id}`);
      if (task.id === "two") throw new Error("model failed");
      return {
        output: "first result",
        sessionId: "session-1",
        toolCalls: [{ tool: "read", title: "README.md", status: "completed" }],
      };
    },
  };

  const results = await runTasks(tasks, client);
  assert.equal(peakCalls, 1);
  assert.deepEqual(events, ["start:one", "end:one", "start:two", "end:two"]);
  assert.deepEqual(results, [
    {
      id: "one",
      role: "reader",
      status: "ok",
      output: "first result",
      session_id: "session-1",
      tool_calls: [{ tool: "read", title: "README.md", status: "completed" }],
    },
    { id: "two", role: "critic", status: "error", error: "model failed" },
  ]);
});
