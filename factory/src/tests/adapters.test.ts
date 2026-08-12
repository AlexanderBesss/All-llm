import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, validateConfig } from "../config.js";
import { InMemoryJiraAdapter, JiraRestAdapter } from "../jira.js";
import { GitHubCliAdapter } from "../github.js";
import { buildPullRequestTitle, normalizePullRequestTaskType } from "../pull-request-title.js";
import { McpJiraAdapter } from "../mcp-jira.js";
import type { ProcessOptions, ProcessResult, ProcessRunner } from "../model/process.js";
import type { JiraExecutor } from "../model/jira.js";
import { executionFor, fixture, makeWorker } from "./support.js";
test("factory defaults to one attempt and no subtask configuration", () => {
  const previous = process.env.FACTORY_MAX_ATTEMPTS;
  delete process.env.FACTORY_MAX_ATTEMPTS;
  try {
    const config = defaultConfig(".");
    assert.equal(config.maxAttempts, 1);
    assert.equal(config.continueFailedTasks, true);
    assert.equal("preferredMaxSubtasks" in config.factory, false);
    process.env.FACTORY_MAX_ATTEMPTS = "4";
    assert.equal(defaultConfig(".").maxAttempts, 4);
    assert.deepEqual(validateConfig({ ...config, maxAttempts: 4 }, { live: false }), []);
    assert.ok(validateConfig({ ...config, maxAttempts: 0 }, { live: false }).includes("maxAttempts must be a positive integer"));
  } finally {
    if (previous === undefined) delete process.env.FACTORY_MAX_ATTEMPTS;
    else process.env.FACTORY_MAX_ATTEMPTS = previous;
  }
});

test("GitHub CLI adapter creates an idempotent pull request without a token", async () => {
  const calls: Array<{ command: string; args: string[]; options?: ProcessOptions }> = [];
  const responses: ProcessResult[] = [
    { stdout: "[]", stderr: "" },
    { stdout: "https://github.com/example/factory/pull/7\n", stderr: "" },
    { stdout: JSON.stringify({ number: 7, url: "https://github.com/example/factory/pull/7", headRefName: "factory/FACT-1", baseRefName: "main", title: "[FACT-1] Add factory coverage (Task)", body: "Details" }), stderr: "" },
  ];
  const runner: ProcessRunner = async (command, args, options) => { calls.push({ command, args, options }); return responses.shift() || { stdout: "", stderr: "" }; };
  const github = new GitHubCliAdapter({ cliCommand: "gh-test", repositoryFullName: "example/factory", baseBranch: "main", repoPath: "." }, runner);
  const pr = await github.createPullRequest({
    title: "[FACT-1] Add factory coverage (Task)",
    taskNumber: "FACT-1",
    taskName: "Add factory coverage",
    taskType: "Task",
    body: "Details",
    head: "factory/FACT-1",
    base: "main",
  });
  assert.equal(pr.number, 7);
  assert.equal(pr.html_url, "https://github.com/example/factory/pull/7");
  assert.equal(calls.length, 3);
});

test("GitHub CLI adapter rejects an existing pull request with an incomplete title", async () => {
  const calls: Array<{ command: string; args: string[]; options?: ProcessOptions }> = [];
  const runner: ProcessRunner = async (command, args, options) => {
    calls.push({ command, args, options });
    return {
      stdout: JSON.stringify([{
        number: 7,
        url: "https://github.com/example/factory/pull/7",
        headRefName: "factory/FACT-1",
        baseRefName: "main",
        title: "[FACT-1] Wrong task name (Task)",
        body: "Details",
      }]),
      stderr: "",
    };
  };
  const github = new GitHubCliAdapter({ cliCommand: "gh-test", repositoryFullName: "example/factory", baseBranch: "main", repoPath: "." }, runner);
  await assert.rejects(
    github.createPullRequest({
      title: "[FACT-1] Add factory coverage (Task)",
      taskNumber: "FACT-1",
      taskName: "Add factory coverage",
      taskType: "Task",
      body: "Details",
      head: "factory/FACT-1",
      base: "main",
    }),
    /exact Jira task name/,
  );
  assert.equal(calls.length, 1);
});

test("pull-request title contract preserves the exact Jira name and canonical task type", () => {
  assert.equal(
    buildPullRequestTitle({ taskNumber: "KAN-16", taskName: "fine tune PR name", taskType: "Feature" }),
    "[KAN-16] fine tune PR name (feature)",
  );
  assert.equal(normalizePullRequestTaskType("Bug Fix"), "bug fix");
  assert.throws(
    () => buildPullRequestTitle({ taskNumber: "KAN-16", taskName: "fine tune PR name", taskType: "Story" }),
    /Unsupported Jira task type/,
  );
});

test("MCP Jira adapter has no subtask mutation or lookup operations", async () => {
  const executor: JiraExecutor = { async run() { return { output: JSON.stringify({ issues: [] }) }; } };
  const adapter = new McpJiraAdapter({ repoPath: ".", projectKey: "FACT", readyStatus: "Ready" }, executor);
  const adapterShape = adapter as unknown as Record<string, unknown>;
  assert.equal(adapterShape.createSubtask, undefined);
  assert.equal(adapterShape.findRunSubtasks, undefined);
});

test("Jira ready discovery includes Ready issues with or without a sprint", async () => {
  const jira = new InMemoryJiraAdapter([
    { key: "FACT-BOARD", fields: { status: { name: "Ready" }, sprint: [{ id: 1, name: "Sprint 1" }] } },
    { key: "FACT-BACKLOG", fields: { status: { name: "Ready" } } },
    { key: "FACT-DONE", fields: { status: { name: "Done" }, sprint: [{ id: 1, name: "Sprint 1" }] } },
  ]);
  assert.deepEqual((await jira.searchReady()).map((issue) => issue.key), ["FACT-BOARD", "FACT-BACKLOG"]);
});

test("factory claims a Ready issue without a sprint", async () => {
  const fixtureData = await fixture();
  fixtureData.jira.issues.set("FACT-2", {
    key: "FACT-2",
    fields: {
      summary: "Backlog work",
      description: "This issue should be claimed.",
      project: { key: "FACT" },
      status: { name: "Ready" },
      labels: [],
    },
  });
  let agentCalls = 0;
  const worker = makeWorker(fixtureData, {
    async execute() {
      agentCalls += 1;
      return { result: executionFor(), raw: {} };
    },
  });
  const claimed = await worker.runOnce();
  const nextPoll = await worker.runOnce();
  assert.equal(claimed.issueKey, "FACT-1");
  assert.equal(nextPoll.issueKey, "FACT-2");
  assert.equal(agentCalls, 2);
  fixtureData.db.close();
});

test("REST Jira ready discovery searches all Ready issues in the project", async () => {
  const requests: Array<{ url: string; options?: RequestInit }> = [];
  const jira = new JiraRestAdapter({
    baseUrl: "https://jira.example.test",
    projectKey: "FACT",
    readyStatus: "Ready",
    email: "factory@example.test",
    apiToken: "token",
  }, async (url, options) => {
    requests.push({ url: String(url), options });
    return { ok: true, status: 200, async text() { return JSON.stringify({ issues: [] }); } };
  });
  await jira.searchReady();
  const body = JSON.parse(String(requests[0].options?.body));
  assert.equal(body.jql, 'project = FACT AND status = "Ready" ORDER BY priority DESC, updated ASC');
});

test("Codex Jira ready discovery includes backlog issues without sprint metadata", async () => {
  const calls = [];
  const executor = {
    async run(input) {
      calls.push(input);
      return {
        output: JSON.stringify({
          issues: [
            { key: "FACT-BOARD", summary: "On board", description: "", status: "Ready", issuetype: "Task", labels: [], parentKey: "", projectKey: "FACT", sprint: [{ id: 1, name: "Sprint 1" }] },
            { key: "FACT-BACKLOG", summary: "In backlog", description: "", status: "Ready", issuetype: "Task", labels: [], parentKey: "", projectKey: "FACT", sprint: null },
          ],
        }),
      };
    },
  };
  const adapter = new McpJiraAdapter({ repoPath: ".", projectKey: "FACT", readyStatus: "Ready" }, executor);
  const issues = await adapter.searchReady();
  assert.match(calls[0].task, /status = "Ready" ORDER BY priority DESC/);
  assert.deepEqual(issues.map((issue) => issue.key), ["FACT-BOARD", "FACT-BACKLOG"]);
  assert.deepEqual(issues[0].fields.sprint, [{ id: 1, name: "Sprint 1" }]);
});

test("MCP Jira lookup accepts an existing issue in Error status", async () => {
  const executor: JiraExecutor = {
    async run() {
      return {
        output: JSON.stringify({
          issues: [{
            key: "FACT-1",
            summary: "Blocked task",
            description: "",
            status: "Error",
            issuetype: "Task",
            labels: [],
            parentKey: "",
            projectKey: "FACT",
            sprint: null,
          }],
        }),
      };
    },
  };
  const adapter = new McpJiraAdapter({ repoPath: ".", projectKey: "FACT" }, executor);
  const issue = await adapter.getIssue("FACT-1");
  assert.equal(issue.fields.status?.name, "Error");
});

test("MCP Jira inconclusive lookup is not treated as deletion", async () => {
  const executor: JiraExecutor = { async run() { return { output: JSON.stringify({ issues: [] }) }; } };
  const adapter = new McpJiraAdapter({ repoPath: ".", projectKey: "FACT" }, executor);
  await assert.rejects(adapter.getIssue("FACT-404"), (error: Error & { code?: string }) => {
    assert.match(error.message, /lookup was inconclusive/);
    assert.notEqual(error.code, "JIRA_ISSUE_NOT_FOUND");
    return true;
  });
});

test("MCP Jira read retries once after invalid JSON", async () => {
  let calls = 0;
  const executor: JiraExecutor = {
    async run() {
      calls += 1;
      return calls === 1
        ? { output: "I could not format that response." }
        : { output: JSON.stringify({ issues: [] }) };
    },
  };
  const adapter = new McpJiraAdapter({ repoPath: ".", projectKey: "FACT", readyStatus: "Ready" }, executor);
  assert.deepEqual(await adapter.searchReady(), []);
  assert.equal(calls, 2);
});

