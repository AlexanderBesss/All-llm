import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { openStateDatabase } from "../db.js";
import { InMemoryJiraAdapter } from "../jira.js";
import { InMemoryGitHubAdapter } from "../github.js";
import { FactoryWorker } from "../worker.js";
import type { JiraDescription } from "../model/jira.js";

export async function fixture({ maxAttempts = 1, description = "Implement the requested change.", continueFailedTasks = false }: { maxAttempts?: number; description?: JiraDescription; continueFailedTasks?: boolean } = {}) {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "all-llm-factory-"));
  const db = await openStateDatabase(stateDir);
  const jira = new InMemoryJiraAdapter([{
    key: "FACT-1",
    fields: {
      summary: "Add factory coverage",
      description,
      project: { key: "FACT" },
      status: { name: "Ready" },
      sprint: [{ id: 1, name: "Sprint 1", state: "active" }],
      issuetype: { name: "Task" },
      labels: [],
    },
  }]);
  const github = new InMemoryGitHubAdapter();
  const git = {
    async prepareWorktree(runId) { return path.join(stateDir, "worktrees", runId); },
    async headSha() { return "0123456789abcdef"; },
    async assertFileCommitted(worktreePath, relativePath) {
      const content = await readFile(path.join(worktreePath, relativePath), "utf8");
      assert.match(content, /factory-spec:/);
    },
  };
  const config = {
    stateDir,
    repoPath: stateDir,
    leaseMs: 60_000,
    maxAttempts,
    continueFailedTasks,
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

export function planFor() {
  return {
    summary: "Factory coverage",
    acceptanceCriteria: ["The behavior is covered by tests."],
    risks: [],
    files: ["factory"],
    tests: ["node --test"],
  };
}

export function executionFor(overrides = {}) {
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

export function makeWorker(fixtureData, agent, { events = [], logs = [] } = {}) {
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

