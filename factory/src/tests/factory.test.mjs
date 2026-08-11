import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { defaultConfig, validateConfig } from "../config.mjs";
import { openStateDatabase } from "../db.mjs";
import { runProcess } from "../git.mjs";
import { InMemoryJiraAdapter } from "../jira.mjs";
import { GitHubCliAdapter, InMemoryGitHubAdapter } from "../github.mjs";
import { FactoryWorker } from "../worker.mjs";
import { RUN_STATUSES, STAGES } from "../types.mjs";
import { CodexAgentExecutor, parseJsonLines } from "../codex.mjs";
import { CodexJiraAdapter } from "../codex-jira.mjs";

async function fixture({ maxAttempts = 1 } = {}) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "all-llm-factory-"));
  const db = await openStateDatabase(stateDir);
  const jira = new InMemoryJiraAdapter([{
    key: "FACT-1",
    fields: {
      summary: "Add factory coverage",
      description: "Implement the requested change.",
      project: { key: "FACT" },
      status: { name: "Ready" },
      labels: [],
    },
  }]);
  const github = new InMemoryGitHubAdapter();
  const git = {
    async prepareWorktree(runId) { return path.join(stateDir, "worktrees", runId); },
    async headSha() { return "0123456789abcdef"; },
  };
  const config = {
    stateDir,
    repoPath: stateDir,
    leaseMs: 60_000,
    maxAttempts,
    retryBackoffMs: 0,
    factory: { branchPrefix: "factory" },
    jira: {
      projectKey: "FACT",
      statuses: { ready: "Ready", implementation: "In Progress", review: "In Review", done: "Done", error: "Error" },
    },
    github: { repositoryFullName: "example/factory" },
    git: { baseBranch: "main" },
  };
  return { db, jira, github, git, config };
}

function planFor() {
  return {
    summary: "Factory coverage",
    acceptanceCriteria: ["The behavior is covered by tests."],
    risks: [],
    files: ["factory"],
    tests: ["node --test"],
  };
}

function executionFor(overrides = {}) {
  return {
    plan: planFor(),
    summary: "Implemented the parent task",
    committed: true,
    pushed: true,
    tests: [{ command: "node --test", status: "passed", output: "ok" }],
    blockers: [],
    ...overrides,
  };
}

function makeWorker(fixtureData, agent, { events = [], logs = [] } = {}) {
  const jira = {
    enabled: fixtureData.jira.enabled.bind(fixtureData.jira),
    searchReady: fixtureData.jira.searchReady.bind(fixtureData.jira),
    getIssue: fixtureData.jira.getIssue.bind(fixtureData.jira),
    updateDescription: fixtureData.jira.updateDescription.bind(fixtureData.jira),
    addComment: fixtureData.jira.addComment.bind(fixtureData.jira),
    async transition(key, statusName) {
      events.push(key === "FACT-1" ? `status:${statusName}` : `unexpected-child-status:${key}:${statusName}`);
      return fixtureData.jira.transition(key, statusName);
    },
  };
  const github = {
    enabled: fixtureData.github.enabled.bind(fixtureData.github),
    async createPullRequest(input) {
      events.push("pull-request");
      return fixtureData.github.createPullRequest(input);
    },
  };
  return new FactoryWorker({
    ...fixtureData,
    jira,
    github,
    agent,
    logger: {
      info(message) { logs.push(message); },
      warn(message) { logs.push(message); },
      error(message) { logs.push(message); },
    },
  });
}

test("Codex executor uses configurable Luna max-effort settings", async () => {
  const calls = [];
  const config = {
    repoPath: "C:/projects/All-llm",
    codex: {
      command: "codex",
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      contextWindowTokens: 250000,
      autoCompactTokenLimit: 225000,
      timeoutMs: 1234,
    },
  };
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    return {
      stdout: [
        JSON.stringify({ type: "thread.started" }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{}" } }),
      ].join("\n"),
    };
  };
  const executor = new CodexAgentExecutor(config, runner);
  await executor.run({ task: "Return a JSON health result.", cwd: "C:/factory-worktree", outputSchema: "C:/projects/All-llm/factory/src/schemas/execution-result.schema.json" });
  assert.equal(calls[0].command, "codex");
  assert.deepEqual(calls[0].args.slice(0, 6), ["exec", "--ephemeral", "--json", "--model", "gpt-5.6-luna", "-c"]);
  assert.ok(calls[0].args.includes('model_reasoning_effort="max"'));
  assert.ok(calls[0].args.includes('approval_policy="never"'));
  assert.ok(calls[0].args.includes("model_context_window=250000"));
  assert.ok(calls[0].args.includes("model_auto_compact_token_limit=225000"));
  assert.ok(calls[0].args.includes("danger-full-access"));
  assert.equal(calls[0].args[calls[0].args.indexOf("-C") + 1], "C:/factory-worktree");
  assert.equal(calls[0].options.cwd, "C:/projects/All-llm");
  assert.equal(calls[0].options.timeoutMs, 1234);
});

test("the single-agent prompt forbids subtasks and delegates the complete parent task", async () => {
  const calls = [];
  const executor = new CodexAgentExecutor({
    repoPath: "C:/projects/All-llm",
    codex: { command: "codex", timeoutMs: 1234 },
  }, async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(executionFor()) } }) };
  });
  await executor.execute({
    issue: { key: "FACT-1", fields: { summary: "Implement change", description: "Details" } },
    runId: "FACT-1-run",
    branchName: "factory/FACT-1",
    cwd: "C:/factory-worktree",
  });
  const prompt = calls[0].args.at(-1);
  assert.match(prompt, /only software implementation agent/);
  assert.match(prompt, /one parent request, one agent, one factory branch, and one pull request/);
  assert.match(prompt, /Do not create Jira subtasks, child tasks, delegated agents/);
  assert.match(prompt, /Do not make Jira mutations/);
});

test("Codex health uses the runtime CODEX_HOME and verifies the Jira MCP", async () => {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    return args.includes("--version") ? { stdout: "codex 1.0.0" } : { stdout: "", stderr: "Atlassian-Rovo-MCP" };
  };
  const executor = new CodexAgentExecutor({ repoPath: "C:/projects/All-llm", codex: { command: "codex", timeoutMs: 1234 } }, runner);
  const health = await executor.health();
  assert.equal(health.version, "codex 1.0.0");
  assert.equal(health.mcp, "Atlassian-Rovo-MCP");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.env.CODEX_HOME, path.join(os.homedir(), ".codex"));
});

test("process cancellation terminates an active child process", async () => {
  const controller = new AbortController();
  const running = runProcess(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { timeoutMs: 60_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(running, (error) => error.code === "ABORT_ERR");
});

test("Codex JSONL parser selects the final agent message", () => {
  const result = parseJsonLines([
    JSON.stringify({ type: "item.completed", item: { type: "tool_call", text: "ignored" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{\"step\":1}" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{\"step\":2}" } }),
  ].join("\n"));
  assert.equal(result.output, "{\"step\":2}");
});

test("factory defaults to one attempt and no subtask configuration", () => {
  const previous = process.env.FACTORY_MAX_ATTEMPTS;
  delete process.env.FACTORY_MAX_ATTEMPTS;
  try {
    const config = defaultConfig("C:/projects/All-llm");
    assert.equal(config.maxAttempts, 1);
    assert.equal(config.factory.preferredMaxSubtasks, undefined);
    process.env.FACTORY_MAX_ATTEMPTS = "4";
    assert.equal(defaultConfig("C:/projects/All-llm").maxAttempts, 4);
    assert.deepEqual(validateConfig({ ...config, maxAttempts: 4 }, { live: false }), []);
    assert.ok(validateConfig({ ...config, maxAttempts: 0 }, { live: false }).includes("maxAttempts must be a positive integer"));
  } finally {
    if (previous === undefined) delete process.env.FACTORY_MAX_ATTEMPTS;
    else process.env.FACTORY_MAX_ATTEMPTS = previous;
  }
});

test("GitHub CLI adapter creates an idempotent pull request without a token", async () => {
  const calls = [];
  const responses = [
    { stdout: "[]" },
    { stdout: "https://github.com/example/factory/pull/7\n" },
    { stdout: JSON.stringify({ number: 7, url: "https://github.com/example/factory/pull/7", headRefName: "factory/FACT-1", baseRefName: "main", title: "Factory change", body: "Details" }) },
  ];
  const runner = async (command, args, options) => { calls.push({ command, args, options }); return responses.shift(); };
  const github = new GitHubCliAdapter({ cliCommand: "gh-test", repositoryFullName: "example/factory", baseBranch: "main", repoPath: "C:/factory" }, runner);
  const pr = await github.createPullRequest({ title: "Factory change", body: "Details", head: "factory/FACT-1", base: "main" });
  assert.equal(pr.number, 7);
  assert.equal(pr.html_url, "https://github.com/example/factory/pull/7");
  assert.equal(calls.length, 3);
});

test("Codex Jira adapter has no subtask mutation or lookup operations", async () => {
  const executor = { async run() { return { output: JSON.stringify({ issues: [] }) }; } };
  const adapter = new CodexJiraAdapter({ repoPath: "C:/projects/All-llm", projectKey: "FACT", readyStatus: "Ready" }, executor);
  assert.equal(typeof adapter.createSubtask, "undefined");
  assert.equal(typeof adapter.findRunSubtasks, "undefined");
});

test("processes one parent ticket with one agent and one aggregate PR", async () => {
  const fixtureData = await fixture();
  const events = [];
  const logs = [];
  let agentCalls = 0;
  const agent = {
    async execute() { agentCalls += 1; events.push("implementation"); return { result: executionFor(), raw: {} }; },
  };
  const worker = makeWorker(fixtureData, agent, { events, logs });
  const result = await worker.runOnce();
  assert.equal(result.action, "claimed");
  assert.equal(agentCalls, 1);
  assert.equal(fixtureData.github.pullRequests.length, 1);
  assert.deepEqual(events.filter((event) => event.startsWith("status:")), ["status:In Progress", "status:In Review"]);
  assert.ok(events.indexOf("status:In Progress") < events.indexOf("implementation"));
  assert.ok(events.indexOf("implementation") < events.indexOf("pull-request"));
  assert.equal(fixtureData.jira.issues.size, 1);
  assert.match((await fixtureData.jira.getIssue("FACT-1")).fields.description, /factory-run/);
  assert.ok(logs.some((entry) => entry.includes("implementation:agent-start")));
  assert.ok(logs.some((entry) => entry.includes("implementation:agent-complete")));
  assert.ok(logs.every((entry) => /^\[\d{4}-\d{2}-\d{2}T[^\]]+Z\] \[factory\] /.test(entry)));
  const run = fixtureData.db.getRun(result.runId);
  assert.equal(run.stage, STAGES.REVIEW);
  assert.equal(run.status, RUN_STATUSES.AWAITING_REVIEW);
  fixtureData.db.close();
});

test("retries the same parent run without creating child work", async () => {
  const fixtureData = await fixture({ maxAttempts: 2 });
  let calls = 0;
  const agent = {
    async execute() {
      calls += 1;
      if (calls === 1) throw new Error("temporary model outage");
      return { result: executionFor(), raw: {} };
    },
  };
  const worker = makeWorker(fixtureData, agent);
  const first = await worker.runOnce();
  assert.equal(first.action, "retry_scheduled");
  const second = await worker.runOnce();
  assert.equal(second.action, "resumed");
  assert.equal(calls, 2);
  assert.equal(fixtureData.db.listRuns(20).length, 1);
  assert.equal(fixtureData.github.pullRequests.length, 1);
  assert.equal(fixtureData.jira.issues.size, 1);
  fixtureData.db.close();
});

test("persists the returned plan before parent description reporting", async () => {
  const fixtureData = await fixture({ maxAttempts: 2 });
  let failDescription = true;
  let previousPlan = null;
  const originalUpdate = fixtureData.jira.updateDescription.bind(fixtureData.jira);
  fixtureData.jira.updateDescription = async (...args) => {
    if (failDescription) {
      failDescription = false;
      throw new Error("temporary Jira description outage");
    }
    return originalUpdate(...args);
  };
  const agent = {
    async execute(input) {
      previousPlan = input.previousPlan;
      return { result: executionFor(), raw: {} };
    },
  };
  const worker = makeWorker(fixtureData, agent);
  const first = await worker.runOnce();
  assert.equal(first.action, "retry_scheduled");
  assert.ok(fixtureData.db.getRun(first.runId).plan_json);
  await worker.runOnce();
  assert.equal(previousPlan.summary, "Factory coverage");
  assert.equal(fixtureData.db.getRun(first.runId).status, RUN_STATUSES.AWAITING_REVIEW);
  fixtureData.db.close();
});

test("blocks a run after bounded single-agent failures", async () => {
  const fixtureData = await fixture({ maxAttempts: 2 });
  const worker = makeWorker(fixtureData, { async execute() { throw new Error("implementation failure"); } });
  const first = await worker.runOnce();
  await worker.runOnce();
  const run = fixtureData.db.getRun(first.runId);
  assert.equal(run.stage, STAGES.BLOCKED);
  assert.equal(run.status, RUN_STATUSES.BLOCKED);
  assert.equal(fixtureData.jira.transitions.at(-1).statusName, "Error");
  assert.match(fixtureData.jira.comments.at(-1).body, /implementation failure/);
  fixtureData.db.close();
});

test("retains terminal Jira reporting failures in durable diagnostics", async () => {
  const fixtureData = await fixture({ maxAttempts: 1 });
  const originalTransition = fixtureData.jira.transition.bind(fixtureData.jira);
  fixtureData.jira.addComment = async () => { throw new Error("Jira comment outage"); };
  fixtureData.jira.transition = async (key, statusName) => {
    if (statusName === "Error") throw new Error("Error transition unavailable");
    return originalTransition(key, statusName);
  };
  const logs = [];
  const worker = makeWorker(fixtureData, { async execute() { throw new Error("implementation failure"); } }, { logs });
  const result = await worker.runOnce();
  const run = fixtureData.db.getRun(result.runId);
  assert.equal(result.action, "blocked");
  assert.match(run.last_error, /implementation failure/);
  assert.match(run.last_error, /Jira comment outage/);
  assert.match(run.last_error, /Error transition unavailable/);
  assert.ok(logs.some((entry) => entry.includes("blocked:jira-report-failed")));
  fixtureData.db.close();
});

test("SQLite claim is idempotent for the same Jira issue", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "all-llm-factory-db-"));
  const db = await openStateDatabase(stateDir);
  const first = db.claimRun({ id: "FACT-1-a", issueKey: "FACT-1", projectKey: "FACT", issue: {}, stage: STAGES.IMPLEMENTATION, leaseOwner: "one", leaseUntil: "2099-01-01T00:00:00.000Z" });
  const second = db.claimRun({ id: "FACT-1-b", issueKey: "FACT-1", projectKey: "FACT", issue: {}, stage: STAGES.IMPLEMENTATION, leaseOwner: "two", leaseUntil: "2099-01-01T00:00:00.000Z" });
  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
  assert.equal(second.run.id, "FACT-1-a");
  db.close();
});

test("a new worker reclaims an expired active lease and resumes the parent agent", async () => {
  const fixtureData = await fixture();
  const claimed = fixtureData.db.claimRun({
    id: "FACT-1-recovery",
    issueKey: "FACT-1",
    projectKey: "FACT",
    issue: await fixtureData.jira.getIssue("FACT-1"),
    stage: STAGES.IMPLEMENTATION,
    leaseOwner: "dead-worker",
    leaseUntil: "2000-01-01T00:00:00.000Z",
  });
  fixtureData.db.updateRun(claimed.run.id, {
    stage: STAGES.IMPLEMENTATION,
    plan_json: JSON.stringify(planFor()),
    lease_owner: "dead-worker",
    lease_until: "2000-01-01T00:00:00.000Z",
  });
  let agentCalls = 0;
  const worker = makeWorker(fixtureData, { async execute() { agentCalls += 1; return { result: executionFor(), raw: {} }; } });
  const result = await worker.runOnce();
  assert.equal(result.action, "resumed");
  assert.equal(agentCalls, 1);
  assert.equal(fixtureData.github.pullRequests.length, 1);
  assert.equal(fixtureData.db.getRun("FACT-1-recovery").status, RUN_STATUSES.AWAITING_REVIEW);
  fixtureData.db.close();
});

test("legacy planning runs migrate without invoking an agent or creating subtasks", async () => {
  const fixtureData = await fixture();
  const claimed = fixtureData.db.claimRun({
    id: "FACT-1-legacy",
    issueKey: "FACT-1",
    projectKey: "FACT",
    issue: await fixtureData.jira.getIssue("FACT-1"),
    stage: STAGES.PLANNING,
    leaseOwner: "dead-worker",
    leaseUntil: "2000-01-01T00:00:00.000Z",
  });
  fixtureData.db.updateRun(claimed.run.id, {
    stage: STAGES.PLANNING,
    plan_json: JSON.stringify({ ...planFor(), directImplementation: false, subtasks: [{ summary: "old child" }] }),
    lease_owner: "dead-worker",
    lease_until: "2000-01-01T00:00:00.000Z",
  });
  let agentCalls = 0;
  const worker = makeWorker(fixtureData, { async execute() { agentCalls += 1; return { result: executionFor(), raw: {} }; } });
  const result = await worker.runOnce();
  assert.equal(result.action, "resumed");
  assert.equal(agentCalls, 1);
  assert.equal(fixtureData.jira.issues.size, 1);
  assert.equal(fixtureData.db.getRun("FACT-1-legacy").status, RUN_STATUSES.AWAITING_REVIEW);
  fixtureData.db.close();
});

test("cancels a persisted run when its Jira parent was deleted", async () => {
  const fixtureData = await fixture();
  const claimed = fixtureData.db.claimRun({
    id: "FACT-1-deleted",
    issueKey: "FACT-1",
    projectKey: "FACT",
    issue: await fixtureData.jira.getIssue("FACT-1"),
    stage: STAGES.IMPLEMENTATION,
    leaseOwner: "dead-worker",
    leaseUntil: "2000-01-01T00:00:00.000Z",
  });
  fixtureData.db.updateRun(claimed.run.id, { stage: STAGES.IMPLEMENTATION, lease_owner: "dead-worker", lease_until: "2000-01-01T00:00:00.000Z" });
  fixtureData.jira.issues.delete("FACT-1");
  let implementationStarted = false;
  const worker = makeWorker(fixtureData, { async execute() { implementationStarted = true; return { result: executionFor(), raw: {} }; } });
  const result = await worker.runOnce();
  assert.equal(result.action, "cancelled");
  assert.equal(implementationStarted, false);
  assert.equal(fixtureData.github.pullRequests.length, 0);
  assert.equal(fixtureData.db.getRun("FACT-1-deleted").status, RUN_STATUSES.CANCELLED);
  fixtureData.db.close();
});

test("pull request retries are idempotent after a GitHub outage", async () => {
  const fixtureData = await fixture({ maxAttempts: 2 });
  let githubAttempts = 0;
  const github = {
    enabled() { return true; },
    async createPullRequest(input) {
      githubAttempts += 1;
      if (githubAttempts === 1) throw new Error("GitHub rate limit");
      return fixtureData.github.createPullRequest(input);
    },
  };
  const worker = makeWorker(fixtureData, { async execute() { return { result: executionFor(), raw: {} }; } });
  worker.github = github;
  const first = await worker.runOnce();
  assert.equal(fixtureData.db.getRun(first.runId).status, RUN_STATUSES.RETRY_WAIT);
  await worker.runOnce();
  assert.equal(fixtureData.github.pullRequests.length, 1);
  assert.equal(fixtureData.db.getRun(first.runId).status, RUN_STATUSES.AWAITING_REVIEW);
  fixtureData.db.close();
});
