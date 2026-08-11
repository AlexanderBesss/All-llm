import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";
import { openStateDatabase } from "../db.mjs";
import { runProcess } from "../git.mjs";
import { InMemoryJiraAdapter } from "../jira.mjs";
import { GitHubCliAdapter, InMemoryGitHubAdapter } from "../github.mjs";
import { FactoryWorker } from "../worker.mjs";
import { RUN_STATUSES, STAGES } from "../types.mjs";
import { CodexAgentExecutor, parseJsonLines } from "../codex.mjs";
import { CodexJiraAdapter } from "../codex-jira.mjs";

async function fixture({ maxAttempts = 3 } = {}) {
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
      statuses: { ready: "Ready", planning: "Planning", implementation: "In Progress", review: "In Review", done: "Done", error: "Error" },
    },
    github: { repositoryFullName: "example/factory" },
    git: { baseBranch: "main" },
  };
  return { db, jira, github, git, config };
}

function planFor(marker) {
  return {
    summary: "Factory coverage",
    acceptanceCriteria: ["The behavior is covered by tests."],
    risks: [],
    files: ["factory"],
    tests: ["node --test"],
    subtasks: [{
      summary: "Add tests",
      description: `${marker}\nAdd tests for the change.`,
      dependsOn: [],
      files: ["factory/src/tests"],
      tests: ["node --test"],
    }],
  };
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
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"ok":true}' } }),
      ].join("\n"),
    };
  };
  const executor = new CodexAgentExecutor(config, runner);
  const result = await executor.run({ task: "Return a JSON health result.", cwd: "C:/factory-worktree", outputSchema: "C:/projects/All-llm/factory/src/schemas/plan-result.schema.json" });
  assert.equal(result.output, '{"ok":true}');
  assert.equal(calls[0].command, "codex");
  assert.deepEqual(calls[0].args.slice(0, 6), ["exec", "--ephemeral", "--json", "--model", "gpt-5.6-luna", "-c"]);
  assert.ok(calls[0].args.includes('model_reasoning_effort="max"'));
  assert.ok(calls[0].args.includes('approval_policy="never"'));
  assert.ok(calls[0].args.includes("model_context_window=250000"));
  assert.ok(calls[0].args.includes("model_auto_compact_token_limit=225000"));
  assert.ok(calls[0].args.includes("--sandbox"));
  assert.ok(calls[0].args.includes("danger-full-access"));
  assert.equal(calls[0].args[calls[0].args.indexOf("-C") + 1], "C:/factory-worktree");
  assert.ok(calls[0].args.includes("--output-schema"));
  assert.ok(calls[0].args.includes("C:/projects/All-llm/factory/src/schemas/plan-result.schema.json"));
  assert.match(calls[0].args.at(-1), /Return only the requested structured result/);
  assert.equal(calls[0].options.cwd, "C:/projects/All-llm");
  assert.equal(calls[0].options.timeoutMs, 1234);
});

test("Codex health uses the runtime CODEX_HOME and verifies the Jira MCP", async () => {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    return args.includes("--version")
      ? { stdout: "codex 1.0.0" }
      : { stdout: "", stderr: "Atlassian-Rovo-MCP" };
  };
  const executor = new CodexAgentExecutor({
    repoPath: "C:/projects/All-llm",
    codex: { command: "codex", timeoutMs: 1234 },
  }, runner);

  const health = await executor.health();

  assert.equal(health.version, "codex 1.0.0");
  assert.equal(health.mcp, "Atlassian-Rovo-MCP");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.env.CODEX_HOME, path.join(os.homedir(), ".codex"));
  assert.equal(calls[1].options.env.CODEX_HOME, path.join(os.homedir(), ".codex"));
});

test("process cancellation terminates an active child process", async () => {
  const controller = new AbortController();
  const running = runProcess(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    timeoutMs: 60_000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(running, (error) => error.code === "ABORT_ERR");
});

test("Codex JSONL parser selects the final agent message", () => {
  const result = parseJsonLines([
    JSON.stringify({ type: "item.completed", item: { type: "tool_call", text: "ignored" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"step":1}' } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: '{"step":2}' } }),
  ].join("\n"));
  assert.equal(result.output, '{"step":2}');
  assert.equal(result.events.length, 3);
});

test("GitHub CLI adapter creates an idempotent pull request without a token", async () => {
  const calls = [];
  const responses = [
    { stdout: "[]" },
    { stdout: "https://github.com/example/factory/pull/7\n" },
    { stdout: JSON.stringify({
      number: 7,
      url: "https://github.com/example/factory/pull/7",
      headRefName: "factory/FACT-1",
      baseRefName: "main",
      title: "Factory change",
      body: "Details",
    }) },
  ];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    return responses.shift();
  };
  const github = new GitHubCliAdapter({
    cliCommand: "gh-test",
    repositoryFullName: "example/factory",
    baseBranch: "main",
    repoPath: "C:/factory",
  }, runner);

  const pr = await github.createPullRequest({
    title: "Factory change",
    body: "Details",
    head: "factory/FACT-1",
    base: "main",
  });

  assert.equal(pr.number, 7);
  assert.equal(pr.html_url, "https://github.com/example/factory/pull/7");
  assert.equal(pr.head.ref, "factory/FACT-1");
  assert.equal(calls.length, 3);
  assert.equal(calls[0].command, "gh-test");
  assert.deepEqual(calls[0].args.slice(0, 4), ["pr", "list", "--repo", "example/factory"]);
  assert.ok(calls[1].args.includes("pr"));
  assert.ok(calls[1].args.includes("create"));
  assert.equal(calls[2].args[0], "pr");
  assert.equal(calls[2].args[1], "view");
});

test("Codex Jira adapter normalizes MCP issue output and delegates mutations", async () => {
  const calls = [];
  const executor = {
    async run(input) {
      calls.push(input);
      if (input.outputSchema.endsWith("jira-issues-result.schema.json")) {
        return { output: JSON.stringify({ issues: [{
          key: "FACT-1",
          summary: "Factory ticket",
          description: "Details",
          status: "Ready",
          issuetype: "Task",
          labels: [],
          parentKey: "",
          projectKey: "FACT",
        }] }) };
      }
      return { output: JSON.stringify({ ok: true, issueKey: "FACT-1", key: "FACT-1-SUB1", details: "done" }) };
    },
  };
  const adapter = new CodexJiraAdapter({ repoPath: "C:/projects/All-llm", projectKey: "FACT", readyStatus: "Ready" }, executor);
  const issues = await adapter.searchReady();
  assert.equal(issues[0].fields.status.name, "Ready");
  assert.equal(issues[0].fields.project.key, "FACT");
  assert.match(calls[0].task, /project = FACT AND status = "Ready"/);
  assert.doesNotMatch(calls[0].task, /labels =/);
  const created = await adapter.createSubtask({ parentKey: "FACT-1", summary: "Subtask", description: "Details" });
  assert.equal(created.key, "FACT-1-SUB1");
  assert.equal(calls.length, 2);
  assert.match(calls[1].task, /create exactly one Jira subtask/);
});

test("processes one parent ticket through an aggregate PR", async () => {
  const fixtureData = await fixture();
  const events = [];
  const logs = [];
  const jira = Object.fromEntries(["enabled", "searchReady", "getIssue", "updateDescription", "createSubtask", "addComment", "findRunSubtasks"]
    .map((name) => [name, fixtureData.jira[name].bind(fixtureData.jira)]));
  jira.transition = async (key, statusName) => {
    events.push(key === "FACT-1" ? `status:${statusName}` : `subtask-status:${key}:${statusName}`);
    return fixtureData.jira.transition(key, statusName);
  };
  const github = {
    enabled: fixtureData.github.enabled.bind(fixtureData.github),
    async createPullRequest(input) {
      events.push("pull-request");
      return fixtureData.github.createPullRequest(input);
    },
  };
  const agent = {
    async plan({ marker }) {
      const plan = planFor(marker);
      await fixtureData.jira.createSubtask({ parentKey: "FACT-1", summary: plan.subtasks[0].summary, description: plan.subtasks[0].description });
      return { result: plan, raw: { output: "{}" } };
    },
    async implement() {
      events.push("implementation");
      return { result: { summary: "Implemented", committed: true, pushed: true, tests: [], subtasks: [], blockers: [] }, raw: {} };
    },
  };
  const worker = new FactoryWorker({
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
  const result = await worker.runOnce();
  assert.equal(result.action, "claimed");
  assert.equal(fixtureData.github.pullRequests.length, 1);
  assert.deepEqual(events.filter((event) => event.startsWith("status:")), ["status:Planning", "status:In Progress", "status:In Review"]);
  assert.deepEqual(events.filter((event) => event.startsWith("subtask-status:")), ["subtask-status:FACT-1-SUB1:In Progress"]);
  assert.ok(events.indexOf("subtask-status:FACT-1-SUB1:In Progress") < events.indexOf("implementation"));
  assert.equal((await fixtureData.jira.getIssue("FACT-1-SUB1")).fields.status.name, "In Progress");
  assert.ok(events.indexOf("status:In Progress") < events.indexOf("implementation"));
  assert.ok(events.indexOf("pull-request") < events.indexOf("status:In Review"));
  assert.equal(fixtureData.jira.transitions.at(-1).statusName, "In Review");
  assert.ok(logs.some((entry) => entry.includes("planning:agent-start")));
  assert.ok(logs.some((entry) => entry.includes("implementation:agent-complete")));
  assert.ok(logs.some((entry) => entry.includes("pull-request:created")));
  assert.ok(logs.some((entry) => entry.includes("jira:status-changing")));
  const run = fixtureData.db.getRun(result.runId);
  assert.equal(run.stage, STAGES.REVIEW);
  assert.equal(run.status, RUN_STATUSES.AWAITING_REVIEW);
  fixtureData.db.close();
});

test("allows direct implementation when the planner returns no subtasks", async () => {
  const fixtureData = await fixture();
  const agent = {
    async plan() {
      return {
        result: {
          summary: "Direct change",
          acceptanceCriteria: ["The parent ticket is implemented directly."],
          risks: [],
          files: ["factory"],
          tests: ["node --test"],
          subtasks: [],
        },
        raw: {},
      };
    },
    async implement() {
      return { result: { committed: true, pushed: true }, raw: {} };
    },
  };
  const worker = new FactoryWorker({ ...fixtureData, agent, logger: { info() {}, warn() {}, error() {} } });
  await worker.runOnce();
  assert.equal(fixtureData.jira.issues.size, 1);
  assert.equal(fixtureData.db.listRuns(20)[0].status, RUN_STATUSES.AWAITING_REVIEW);
  fixtureData.db.close();
});

test("accepts Jira-rendered subtask descriptions when identity and marker match", async () => {
  const fixtureData = await fixture();
  const agent = {
    async plan({ marker }) {
      const plan = planFor(marker);
      await fixtureData.jira.createSubtask({
        parentKey: "FACT-1",
        summary: plan.subtasks[0].summary,
        description: `${marker}\n## Scope\nThe Jira-rendered version of this subtask has equivalent scope.`,
      });
      return { result: plan, raw: {} };
    },
    async implement() { return { result: { committed: true, pushed: true }, raw: {} }; },
  };
  const worker = new FactoryWorker({ ...fixtureData, agent, logger: { info() {}, warn() {}, error() {} } });
  const result = await worker.runOnce();
  assert.equal(result.action, "claimed");
  assert.equal(fixtureData.db.getRun(result.runId).status, RUN_STATUSES.AWAITING_REVIEW);
  fixtureData.db.close();
});

test("blocks when a created subtask is missing the run marker", async () => {
  const fixtureData = await fixture({ maxAttempts: 1 });
  const agent = {
    async plan({ marker }) {
      const plan = planFor(marker);
      await fixtureData.jira.createSubtask({ parentKey: "FACT-1", summary: plan.subtasks[0].summary, description: "Wrong scope." });
      return { result: plan, raw: {} };
    },
  };
  const worker = new FactoryWorker({ ...fixtureData, agent, logger: { info() {}, warn() {}, error() {} } });
  const result = await worker.runOnce();
  assert.equal(fixtureData.db.getRun(result.runId).stage, STAGES.BLOCKED);
  assert.equal(result.action, "blocked");
  assert.equal(fixtureData.jira.transitions.at(-1).statusName, "Error");
  assert.match(fixtureData.jira.comments.at(-1).body, /expected Jira subtasks/);
  fixtureData.db.close();
});

test("retries a failed stage and does not create a duplicate run", async () => {
  const fixtureData = await fixture();
  let attempts = 0;
  const agent = {
    async plan({ marker }) {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary model outage");
      const plan = planFor(marker);
      await fixtureData.jira.createSubtask({ parentKey: "FACT-1", summary: plan.subtasks[0].summary, description: plan.subtasks[0].description });
      return { result: plan, raw: {} };
    },
    async implement() { return { result: { committed: true, pushed: true }, raw: {} }; },
  };
  const worker = new FactoryWorker({ ...fixtureData, agent, logger: { info() {}, warn() {}, error() {} } });
  const first = await worker.runOnce();
  assert.equal(first.action, "retry_scheduled");
  assert.equal(first.status, RUN_STATUSES.RETRY_WAIT);
  assert.equal(fixtureData.db.getRun(first.runId).status, RUN_STATUSES.RETRY_WAIT);
  const second = await worker.runOnce();
  assert.equal(second.action, "resumed");
  assert.equal(fixtureData.db.listRuns(20).length, 1);
  assert.equal(fixtureData.github.pullRequests.length, 1);
  fixtureData.db.close();
});

test("persists the plan before Jira reconciliation and reuses it on retry", async () => {
  const fixtureData = await fixture();
  let planningCalls = 0;
  let failFirstSubtaskRead = true;
  const findRunSubtasks = fixtureData.jira.findRunSubtasks.bind(fixtureData.jira);
  fixtureData.jira.findRunSubtasks = async (...args) => {
    if (failFirstSubtaskRead) {
      failFirstSubtaskRead = false;
      throw new Error("temporary Jira read outage");
    }
    return findRunSubtasks(...args);
  };
  const agent = {
    async plan({ marker }) {
      planningCalls += 1;
      const plan = planFor(marker);
      await fixtureData.jira.createSubtask({
        parentKey: "FACT-1",
        summary: plan.subtasks[0].summary,
        description: plan.subtasks[0].description,
      });
      return { result: plan, raw: {} };
    },
    async implement() { return { result: { committed: true, pushed: true }, raw: {} }; },
  };
  const worker = new FactoryWorker({ ...fixtureData, agent, logger: { info() {}, warn() {}, error() {} } });

  const first = await worker.runOnce();
  assert.equal(first.action, "retry_scheduled");
  assert.ok(fixtureData.db.getRun(first.runId).plan_json);

  const second = await worker.runOnce();
  assert.equal(second.action, "resumed");
  assert.equal(planningCalls, 1);
  assert.equal(fixtureData.db.getRun(first.runId).status, RUN_STATUSES.AWAITING_REVIEW);
  fixtureData.db.close();
});

test("blocks a run after bounded failures", async () => {
  const fixtureData = await fixture({ maxAttempts: 2 });
  const agent = { async plan() { throw new Error("invalid planner output"); } };
  const worker = new FactoryWorker({ ...fixtureData, agent, logger: { info() {}, warn() {}, error() {} } });
  const first = await worker.runOnce();
  await worker.runOnce();
  const run = fixtureData.db.getRun(first.runId);
  assert.equal(run.stage, STAGES.BLOCKED);
  assert.equal(run.status, RUN_STATUSES.BLOCKED);
  assert.equal(fixtureData.jira.transitions.at(-1).statusName, "Error");
  assert.match(fixtureData.jira.comments.at(-1).body, /invalid planner output/);
  fixtureData.db.close();
});

test("retains terminal Jira reporting failures in durable diagnostics", async () => {
  const fixtureData = await fixture({ maxAttempts: 1 });
  const originalTransition = fixtureData.jira.transition.bind(fixtureData.jira);
  fixtureData.jira.addComment = async () => {
    throw new Error("Jira comment outage");
  };
  fixtureData.jira.transition = async (key, statusName) => {
    if (statusName === "Error") throw new Error("Error transition unavailable");
    return originalTransition(key, statusName);
  };
  const logs = [];
  const worker = new FactoryWorker({
    ...fixtureData,
    agent: { async plan() { throw new Error("planner failure"); } },
    logger: {
      info(message) { logs.push(message); },
      warn(message) { logs.push(message); },
      error(message) { logs.push(message); },
    },
  });

  const result = await worker.runOnce();
  const run = fixtureData.db.getRun(result.runId);
  assert.equal(result.action, "blocked");
  assert.match(run.last_error, /planner failure/);
  assert.match(run.last_error, /Jira comment outage/);
  assert.match(run.last_error, /Error transition unavailable/);
  assert.ok(logs.some((entry) => entry.includes("blocked:jira-report-failed")));
  fixtureData.db.close();
});

test("SQLite claim is idempotent for the same Jira issue", async () => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "all-llm-factory-db-"));
  const db = await openStateDatabase(stateDir);
  const first = db.claimRun({ id: "FACT-1-a", issueKey: "FACT-1", projectKey: "FACT", issue: {}, stage: STAGES.PLANNING, leaseOwner: "one", leaseUntil: "2099-01-01T00:00:00.000Z" });
  const second = db.claimRun({ id: "FACT-1-b", issueKey: "FACT-1", projectKey: "FACT", issue: {}, stage: STAGES.PLANNING, leaseOwner: "two", leaseUntil: "2099-01-01T00:00:00.000Z" });
  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
  assert.equal(second.run.id, "FACT-1-a");
  db.close();
});

test("a new worker reclaims an expired active lease and resumes implementation", async () => {
  const fixtureData = await fixture();
  const plan = planFor("[factory-run:FACT-1-recovery]");
  await fixtureData.jira.createSubtask({
    parentKey: "FACT-1",
    summary: plan.subtasks[0].summary,
    description: plan.subtasks[0].description,
  });
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
    plan_json: JSON.stringify(plan),
    lease_owner: "dead-worker",
    lease_until: "2000-01-01T00:00:00.000Z",
  });
  const agent = {
    async implement() { return { result: { committed: true, pushed: true }, raw: {} }; },
  };
  const worker = new FactoryWorker({ ...fixtureData, agent, logger: { info() {}, warn() {}, error() {} } });
  const result = await worker.runOnce();
  assert.equal(result.action, "resumed");
  assert.equal(fixtureData.github.pullRequests.length, 1);
  assert.equal(fixtureData.db.getRun("FACT-1-recovery").status, RUN_STATUSES.AWAITING_REVIEW);
  fixtureData.db.close();
});

test("cancels a persisted run when its Jira parent was deleted", async () => {
  const fixtureData = await fixture();
  const plan = planFor("[factory-run:FACT-1-deleted]");
  const claimed = fixtureData.db.claimRun({
    id: "FACT-1-deleted",
    issueKey: "FACT-1",
    projectKey: "FACT",
    issue: await fixtureData.jira.getIssue("FACT-1"),
    stage: STAGES.IMPLEMENTATION,
    leaseOwner: "dead-worker",
    leaseUntil: "2000-01-01T00:00:00.000Z",
  });
  fixtureData.db.updateRun(claimed.run.id, {
    stage: STAGES.IMPLEMENTATION,
    plan_json: JSON.stringify(plan),
    lease_owner: "dead-worker",
    lease_until: "2000-01-01T00:00:00.000Z",
  });
  fixtureData.jira.issues.delete("FACT-1");
  let implementationStarted = false;
  const agent = {
    async implement() {
      implementationStarted = true;
      return { result: { committed: true, pushed: true }, raw: {} };
    },
  };
  const worker = new FactoryWorker({ ...fixtureData, agent, logger: { info() {}, warn() {}, error() {} } });

  const result = await worker.runOnce();

  assert.equal(result.action, "cancelled");
  assert.equal(implementationStarted, false);
  assert.equal(fixtureData.github.pullRequests.length, 0);
  assert.equal(fixtureData.db.getRun("FACT-1-deleted").status, RUN_STATUSES.CANCELLED);
  fixtureData.db.close();
});

test("pull request retries are idempotent after a GitHub outage", async () => {
  const fixtureData = await fixture();
  let githubAttempts = 0;
  const github = {
    enabled() { return true; },
    async createPullRequest(input) {
      githubAttempts += 1;
      if (githubAttempts === 1) throw new Error("GitHub rate limit");
      return fixtureData.github.createPullRequest(input);
    },
  };
  const agent = {
    async plan({ marker }) {
      const plan = planFor(marker);
      await fixtureData.jira.createSubtask({ parentKey: "FACT-1", summary: plan.subtasks[0].summary, description: plan.subtasks[0].description });
      return { result: plan, raw: {} };
    },
    async implement() { return { result: { committed: true, pushed: true }, raw: {} }; },
  };
  const worker = new FactoryWorker({ ...fixtureData, github, agent, logger: { info() {}, warn() {}, error() {} } });
  const first = await worker.runOnce();
  assert.equal(fixtureData.db.getRun(first.runId).status, RUN_STATUSES.RETRY_WAIT);
  await worker.runOnce();
  assert.equal(fixtureData.github.pullRequests.length, 1);
  assert.equal(fixtureData.db.getRun(first.runId).status, RUN_STATUSES.AWAITING_REVIEW);
  fixtureData.db.close();
});
