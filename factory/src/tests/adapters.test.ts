import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultConfig, validateConfig } from "../config.js";
import { InMemoryJiraAdapter, JiraRestAdapter } from "../jira.js";
import { GitHubCliAdapter } from "../github.js";
import { buildPullRequestTitle, normalizePullRequestTaskType } from "../pull-request-title.js";
import { McpJiraAdapter } from "../mcp-jira.js";
import type { ProcessOptions, ProcessResult, ProcessRunner } from "../model/process.js";
import type { JiraExecutor } from "../model/jira.js";
import { AgentToolScope, AgentWorkspaceAccess } from "../model/codex.js";
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
    assert.ok(validateConfig({ ...config, planningConcurrency: 0 }, { live: false }).includes("planningConcurrency must be a positive integer"));
    assert.ok(validateConfig({ ...config, implementationConcurrency: 0 }, { live: false }).includes("implementationConcurrency must be a positive integer"));
    assert.ok(validateConfig({ ...config, mergeCheckConcurrency: 0 }, { live: false }).includes("mergeCheckConcurrency must be a positive integer"));
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
  assert.deepEqual(calls[1].args.slice(-2), ["--label", "review"]);
});

test("GitHub CLI adapter lists ai-fix pull requests and reads unresolved review threads", async () => {
  const calls: Array<{ command: string; args: string[]; options?: ProcessOptions }> = [];
  const responses: ProcessResult[] = [
    { stdout: JSON.stringify([{ number: 7, url: "https://github.com/example/factory/pull/7", headRefName: "factory/FACT-1", baseRefName: "main", title: "Title", body: "", labels: [{ name: "ai-fix" }] }]), stderr: "" },
    { stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [
      { id: "thread-open", isResolved: false },
      { id: "thread-done", isResolved: true },
    ], pageInfo: { hasNextPage: false, endCursor: null } } } } } }), stderr: "" },
    { stdout: JSON.stringify({ data: { node: { comments: { nodes: [{ id: "comment-1", author: { login: "reviewer" }, body: "Fix this", path: "src/a.ts", line: 4, createdAt: "2026-08-13T00:00:00Z" }], pageInfo: { hasNextPage: false, endCursor: null } } } } }), stderr: "" },
  ];
  const runner: ProcessRunner = async (command, args, options) => { calls.push({ command, args, options }); return responses.shift() || { stdout: "", stderr: "" }; };
  const github = new GitHubCliAdapter({ cliCommand: "gh-test", repositoryFullName: "example/factory", baseBranch: "main", repoPath: "." }, runner);

  const pullRequests = await github.listOpenPullRequestsByLabel("ai-fix");
  const threads = await github.getUnresolvedReviewThreads(7);

  assert.equal(pullRequests.length, 1);
  assert.deepEqual(pullRequests[0].labels, ["ai-fix"]);
  assert.deepEqual(threads.map((thread) => thread.id), ["thread-open"]);
  assert.equal(threads[0].comments[0].body, "Fix this");
  assert.ok(calls[0].args.includes("ai-fix"));
  assert.equal(calls[1].args[1], "graphql");
  assert.equal(calls[2].args[1], "graphql");
});

test("GitHub CLI adapter requeues an AI review by replacing the review-loop labels", async () => {
  const calls: Array<{ command: string; args: string[]; options?: ProcessOptions }> = [];
  const runner: ProcessRunner = async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: "", stderr: "" };
  };
  const github = new GitHubCliAdapter({ cliCommand: "gh-test", repositoryFullName: "example/factory", baseBranch: "main", repoPath: "." }, runner);

  await github.requestAiReview(7);

  assert.deepEqual(calls[0].args, [
    "pr", "edit", "7", "--repo", "example/factory",
    "--add-label", "ai-review", "--remove-label", "ai-fix",
  ]);
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

test("GitHub CLI adapter reads merged status from supported pull-request fields", async () => {
  const calls: Array<{ command: string; args: string[]; options?: ProcessOptions }> = [];
  const runner: ProcessRunner = async (command, args, options) => {
    calls.push({ command, args, options });
    return {
      stdout: JSON.stringify({
        number: 7,
        url: "https://github.com/example/factory/pull/7",
        headRefName: "factory/FACT-1",
        baseRefName: "main",
        title: "[FACT-1] Add factory coverage (Task)",
        body: "Details",
        state: "CLOSED",
        mergedAt: "2026-08-12T17:00:00Z",
      }),
      stderr: "",
    };
  };
  const github = new GitHubCliAdapter({ cliCommand: "gh-test", repositoryFullName: "example/factory", baseBranch: "main", repoPath: "." }, runner);

  const pr = await github.getPullRequest(7);

  assert.equal(pr?.merged, true);
  assert.equal(pr?.state, "CLOSED");
  assert.equal(pr?.mergedAt, "2026-08-12T17:00:00Z");
  assert.ok(calls[0].args.includes("number,url,headRefName,baseRefName,title,body,state,mergedAt"));
  assert.ok(!calls[0].args.includes("number,url,headRefName,baseRefName,title,body,merged,mergedAt"));
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

test("MCP Jira description updates use a bounded timeout and strict Markdown payload", async () => {
  const requests = [];
  const executor: JiraExecutor = {
    async run(input) {
      requests.push(input);
      return {
        output: JSON.stringify(requests.length === 1
          ? { ok: false, issueKey: "FACT-1", key: "FACT-1", details: "description must be a Markdown string, not an object" }
          : { ok: true, issueKey: "FACT-1", key: "FACT-1", details: "updated" }),
      };
    },
  };
  const adapter = new McpJiraAdapter({
    repoPath: ".",
    projectKey: "FACT",
    mcpTimeoutMs: 12_345,
    mcpAgent: "factory-jira",
    mcpModel: "gpt-5.6-luna",
    mcpReasoningEffort: "low",
  }, executor);

  await adapter.updateDescription("FACT-1", "## Plan\n\nKeep this exact text.");

  assert.equal(requests.length, 2);
  assert.equal(requests[0].timeoutMs, 12_345);
  assert.equal(requests[1].timeoutMs, 12_345);
  assert.equal(requests[0].agent, "factory-jira");
  assert.equal(requests[1].agent, "factory-jira");
  assert.equal(requests[0].model, "gpt-5.6-luna");
  assert.equal(requests[1].model, "gpt-5.6-luna");
  assert.equal(requests[0].reasoningEffort, "low");
  assert.equal(requests[1].reasoningEffort, "low");
  assert.equal(requests[0].toolScope, AgentToolScope.Jira);
  assert.equal(requests[1].toolScope, AgentToolScope.Jira);
  assert.equal(requests[0].workspaceAccess, AgentWorkspaceAccess.ReadOnly);
  assert.equal(requests[1].workspaceAccess, AgentWorkspaceAccess.ReadOnly);
  assert.match(requests[0].task, /one JSON string, not an object/);
  assert.match(requests[0].task, /"fields":\{"description":"## Plan\\n\\nKeep this exact text\."\}/);
  assert.doesNotMatch(requests[0].task, /BEGIN EXACT DESCRIPTION/);
  assert.match(requests[0].task, /Keep this exact text\./);
  assert.match(requests[1].task, /description must be a Markdown string/);
  assert.match(requests[1].task, /one permitted correction attempt/);
});

test("MCP Jira serializes calls and gives queued mutations priority over reads", async () => {
  const order: string[] = [];
  let releaseFirst!: () => void;
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  const executor: JiraExecutor = {
    async run(input) {
      calls += 1;
      const mutation = /transition Jira issue/.test(input.task);
      order.push(mutation ? "mutation" : "read");
      if (calls === 1) {
        markFirstStarted();
        await firstBlocked;
      }
      return mutation
        ? { output: JSON.stringify({ ok: true, issueKey: "FACT-1", key: "FACT-1", details: "transitioned" }) }
        : { output: JSON.stringify({ issues: [] }) };
    },
  };
  const adapter = new McpJiraAdapter({ repoPath: ".", projectKey: "FACT", readyStatus: "Ready" }, executor);

  const activeRead = adapter.searchReady();
  await firstStarted;
  const queuedRead = adapter.searchReady();
  const queuedMutation = adapter.transition("FACT-1", "Done");
  releaseFirst();
  await Promise.all([activeRead, queuedRead, queuedMutation]);

  assert.deepEqual(order, ["read", "mutation", "read"]);
});

test("MCP Jira emits queue, request, validation, and duration telemetry", async () => {
  const events: Array<{ event: string; details?: Record<string, unknown> }> = [];
  const executor: JiraExecutor = {
    async run() {
      return { output: JSON.stringify({ issues: [] }), events: [{ type: "item.completed" }] };
    },
  };
  const adapter = new McpJiraAdapter({
    repoPath: ".",
    projectKey: "FACT",
    readyStatus: "Ready",
    log(_level, event, details) { events.push({ event, details }); },
  }, executor);

  await adapter.searchReady();

  assert.ok(events.some((entry) => entry.event === "jira:mcp:queued"));
  assert.ok(events.some((entry) => entry.event === "jira:mcp:start" && typeof entry.details?.queueMs === "number"));
  assert.ok(events.some((entry) => entry.event === "jira:mcp:request-complete" && typeof entry.details?.durationMs === "number"));
  assert.ok(events.some((entry) => entry.event === "jira:mcp:response-validated"));
  assert.ok(events.some((entry) => entry.event === "jira:mcp:complete" && typeof entry.details?.durationMs === "number"));
});

test("MCP Jira description correction follows a format error instead of repeating the bad payload", async () => {
  const requests = [];
  const executor: JiraExecutor = {
    async run(input) {
      requests.push(input);
      return requests.length === 1
        ? { output: JSON.stringify({ ok: false, issueKey: "FACT-1", key: "FACT-1", details: "Invalid value for field description: expected a markdown string when contentFormat is markdown, got object. Pass contentFormat: adf when supplying an ADF document object." }) }
        : { output: JSON.stringify({ ok: true, issueKey: "FACT-1", key: "FACT-1", details: "updated" }) };
    },
  };
  const adapter = new McpJiraAdapter({ repoPath: ".", projectKey: "FACT" }, executor);

  await adapter.updateDescription("FACT-1", "Updated description");

  assert.equal(requests.length, 2);
  assert.match(requests[1].task, /switch contentFormat to "adf"/);
  assert.match(requests[1].task, /valid ADF document object/);
});

test("MCP Jira transition correction stays focused on the destination status", async () => {
  const requests = [];
  const executor: JiraExecutor = {
    async run(input) {
      requests.push(input);
      return requests.length === 1
        ? { output: JSON.stringify({ ok: false, issueKey: "FACT-1", key: "FACT-1", details: 'The issue remained "In Review".' }) }
        : { output: JSON.stringify({ ok: true, issueKey: "FACT-1", key: "FACT-1", details: "transitioned" }) };
    },
  };
  const adapter = new McpJiraAdapter({ repoPath: ".", projectKey: "FACT" }, executor);

  await adapter.transition("FACT-1", "Done");

  assert.equal(requests.length, 2);
  assert.match(requests[0].task, /destination status named exactly/);
  assert.match(requests[1].task, /destination status is exactly the requested target status/);
  assert.doesNotMatch(requests[1].task, /fields\.description/);
});

test("MCP Jira mutations do not retry an unknown provider-timeout outcome", async () => {
  const requests = [];
  const executor: JiraExecutor = {
    async run(input) {
      requests.push(input);
      if (requests.length === 1) throw new Error("timed out after 240000 ms");
      return { output: JSON.stringify({ issues: [{ key: "FACT-1", summary: "", description: "Old description", status: null, issuetype: null, labels: [], parentKey: null, projectKey: "FACT", sprint: null }] }) };
    },
  };
  const adapter = new McpJiraAdapter({ repoPath: ".", projectKey: "FACT", mcpTimeoutMs: 12_345, mcpAgent: "factory-jira" }, executor);

  await assert.rejects(
    adapter.updateDescription("FACT-1", "Updated description"),
    /outcome is unknown and was not retried/,
  );

  assert.equal(requests.length, 2);
  assert.equal(requests.filter((request) => /replace the description/.test(request.task)).length, 1);
});

test("MCP Jira comments reconcile an ambiguous failure without duplicating the mutation", async () => {
  const requests = [];
  const executor: JiraExecutor = {
    async run(input) {
      requests.push(input);
      if (/read the comments/.test(input.task)) {
        return { output: JSON.stringify({ exists: requests.length > 1 }) };
      }
      throw new Error("timed out after the comment was accepted");
    },
  };
  const adapter = new McpJiraAdapter({ repoPath: ".", projectKey: "FACT" }, executor);

  const result = await adapter.addComment("FACT-1", "[factory-run:FACT-1-run]\nPull request created");

  assert.equal(result.ok, true);
  assert.equal(requests.filter((request) => /add exactly one comment/.test(request.task)).length, 1);
  assert.equal(requests.filter((request) => /read the comments/.test(request.task)).length, 2);
});

test("MCP Jira mutations recover a completed tool when OpenCode exhausts its response step", async () => {
  const executor: JiraExecutor = {
    async run() {
      return {
        output: "CRITICAL - MAXIMUM STEPS REACHED",
        events: [{
          type: "tool",
          part: {
            tool: "jira_transitionJiraIssue",
            state: {
              status: "completed",
              input: { issueIdOrKey: "FACT-1" },
              output: '{"success":true}',
            },
          },
        }],
      };
    },
  };
  const adapter = new McpJiraAdapter({ repoPath: ".", projectKey: "FACT" }, executor);

  await adapter.transition("FACT-1", "In Progress");
});

test("MCP Jira mutations use the MCP error as the single correction reason", async () => {
  const requests = [];
  const executor: JiraExecutor = {
    async run(input) {
      requests.push(input);
      if (requests.length === 1) {
        return {
          output: "CRITICAL - MAXIMUM STEPS REACHED",
          events: [{
            type: "tool",
            part: {
              tool: "jira_editJiraIssue",
              state: {
                status: "error",
                input: { issueIdOrKey: "FACT-1" },
                error: '{"error":true,"message":"description must be a Markdown string"}',
              },
            },
          }],
        };
      }
      return { output: JSON.stringify({ ok: true, issueKey: "FACT-1", key: "FACT-1", details: "updated" }) };
    },
  };
  const adapter = new McpJiraAdapter({ repoPath: ".", projectKey: "FACT" }, executor);

  await adapter.updateDescription("FACT-1", "Updated description");

  assert.equal(requests.length, 2);
  assert.match(requests[1].task, /description must be a Markdown string/);
});

test("Jira ready discovery includes Ready issues with or without a sprint", async () => {
  const jira = new InMemoryJiraAdapter([
    { key: "FACT-BOARD", fields: { status: { name: "Ready" }, sprint: [{ id: 1, name: "Sprint 1" }] } },
    { key: "FACT-BACKLOG", fields: { status: { name: "Ready" } } },
    { key: "FACT-DONE", fields: { status: { name: "Done" }, sprint: [{ id: 1, name: "Sprint 1" }] } },
  ]);
  assert.deepEqual((await jira.searchReady()).map((issue) => issue.key), ["FACT-BOARD", "FACT-BACKLOG"]);
});

test("Jira planning discovery includes only Planning issues", async () => {
  const jira = new InMemoryJiraAdapter([
    { key: "FACT-PLAN", fields: { status: { name: "Planning" } } },
    { key: "FACT-READY", fields: { status: { name: "Ready" } } },
  ]);
  assert.deepEqual((await jira.searchPlanning()).map((issue) => issue.key), ["FACT-PLAN"]);
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

test("REST Jira planning discovery uses the configured Planning status", async () => {
  const requests: Array<{ url: string; options?: RequestInit }> = [];
  const jira = new JiraRestAdapter({
    baseUrl: "https://jira.example.test",
    projectKey: "FACT",
    planningStatus: "Refinement",
    email: "factory@example.test",
    apiToken: "token",
  }, async (url, options) => {
    requests.push({ url: String(url), options });
    return { ok: true, status: 200, async text() { return JSON.stringify({ issues: [] }); } };
  });
  await jira.searchPlanning();
  const body = JSON.parse(String(requests[0].options?.body));
  assert.equal(body.jql, 'project = FACT AND status = "Refinement" ORDER BY priority DESC, updated ASC');
});

test("Codex Jira ready discovery includes backlog issues without sprint metadata", async () => {
  const calls = [];
  const executor = {
    async run(input) {
      calls.push(input);
      return {
        output: JSON.stringify({
          issues: [
            { key: "FACT-BOARD", summary: "On board", description: "", status: "Ready", issuetype: "Task", labels: [], parentKey: null, projectKey: "FACT", sprint: [{ id: 1, name: "Sprint 1", state: null, boardId: null, originBoardId: null, startDate: null, endDate: null, completeDate: null, goal: null }] },
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
  assert.deepEqual(issues[0].fields.sprint, [{ id: 1, name: "Sprint 1", state: null, boardId: null, originBoardId: null, startDate: null, endDate: null, completeDate: null, goal: null }]);
});

test("MCP Jira planning discovery uses configured project and status", async () => {
  const calls = [];
  const executor: JiraExecutor = {
    async run(input) {
      calls.push(input);
      return { output: JSON.stringify({ issues: [] }) };
    },
  };
  const adapter = new McpJiraAdapter({ repoPath: ".", projectKey: "FACT", planningStatus: "Refinement" }, executor);
  await adapter.searchPlanning();
  assert.match(calls[0].task, /project = FACT AND status = "Refinement"/);
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

test("MCP Jira lookup normalizes native Jira field objects", async () => {
  const executor: JiraExecutor = {
    async run() {
      return {
        output: JSON.stringify({
          issues: [{
            key: "FACT-1",
            summary: "Native fields",
            description: "",
            status: { name: "In Progress" },
            issuetype: { name: "Task" },
            labels: [],
            projectKey: { key: "FACT" },
            parentKey: { key: "FACT-0" },
            sprint: null,
          }],
        }),
      };
    },
  };
  const adapter = new McpJiraAdapter({ repoPath: ".", projectKey: "FACT" }, executor);

  const issue = await adapter.getIssue("FACT-1");

  assert.equal(issue.fields.status?.name, "In Progress");
  assert.equal(issue.fields.issuetype?.name, "Task");
  assert.equal(issue.fields.project?.key, "FACT");
  assert.equal(issue.fields.parent?.key, "FACT-0");
});

test("MCP Jira inconclusive lookup is not treated as deletion", async () => {
  let calls = 0;
  const executor: JiraExecutor = { async run() { calls += 1; return { output: JSON.stringify({ issues: [] }) }; } };
  const adapter = new McpJiraAdapter({ repoPath: ".", projectKey: "FACT" }, executor);
  await assert.rejects(adapter.getIssue("FACT-404"), (error: Error & { code?: string }) => {
    assert.match(error.message, /lookup was inconclusive/);
    assert.notEqual(error.code, "JIRA_ISSUE_NOT_FOUND");
    return true;
  });
  assert.equal(calls, 2);
});

test("MCP Jira lookup retries an empty response before accepting the issue", async () => {
  let calls = 0;
  const executor: JiraExecutor = {
    async run() {
      calls += 1;
      return calls === 1
        ? { output: JSON.stringify({ issues: [] }) }
        : { output: JSON.stringify({ issues: [{ key: "FACT-1", summary: "Found", description: null, status: "In Progress", issuetype: null, labels: [], parentKey: null, projectKey: "FACT", sprint: null }] }) };
    },
  };
  const adapter = new McpJiraAdapter({ repoPath: ".", projectKey: "FACT" }, executor);
  assert.equal((await adapter.getIssue("FACT-1")).key, "FACT-1");
  assert.equal(calls, 2);
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

