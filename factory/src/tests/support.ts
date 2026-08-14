import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { openStateDatabase } from "../db.js";
import { InMemoryJiraAdapter } from "../jira.js";
import { InMemoryGitHubAdapter } from "../github.js";
import { FactoryWorker } from "../worker.js";
import { AgentProvider, JiraAdapterKind } from "../model/config.js";
import { TestStatus } from "../model/codex.js";
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
    async preparePullRequestWorktree(runId) { return path.join(stateDir, "worktrees", runId); },
    async headSha() { return "0123456789abcdef"; },
    async hasChanges() { return false; },
    async assertBranchPublished() { return "0123456789abcdef"; },
    async changedFiles() { return ["factory"]; },
    async assertFileCommitted(worktreePath, relativePath) {
      const content = await readFile(path.join(worktreePath, relativePath), "utf8");
      assert.match(content, /factory-spec:/);
    },
  };
  const config = {
    provider: AgentProvider.Codex,
    stateDir,
    repoPath: stateDir,
    planningIntervalMs: 60_000,
    leaseMs: 60_000,
    reviewFixIntervalMs: 300_000,
    pollIntervalMs: 60_000,
    mergeCheckIntervalMs: 300_000,
    maxAttempts,
    continueFailedTasks,
    retryBackoffMs: 0,
    factory: { branchPrefix: "factory" },
    jira: {
      projectKey: "FACT",
      statuses: { planning: "Planning", todo: "To Do", ready: "Ready", implementation: "In Progress", review: "In Review", done: "Done", error: "Error" },
    },
    github: { repositoryFullName: "example/factory" },
    git: { baseBranch: "main" },
    codex: { model: "gpt-5.6-luna", reasoningEffort: "max", featureModel: "gpt-5.6-sol", featureReasoningEffort: "medium" },
    opencode: { model: "llamacpp/unsloth/Qwen3.6-27B-UD-Q4_K_XL" },
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
    tests: [{ command: "node --test", status: TestStatus.Passed, output: "ok" }],
    blockers: [],
    ...overrides,
  };
}

export function makeWorker(fixtureData, agent, { events = [], logs = [] } = {}) {
  const jira = {
    enabled: fixtureData.jira.enabled.bind(fixtureData.jira),
    searchPlanning: fixtureData.jira.searchPlanning.bind(fixtureData.jira),
    searchReady: fixtureData.jira.searchReady.bind(fixtureData.jira),
    getIssue: fixtureData.jira.getIssue.bind(fixtureData.jira),
    updateDescription: fixtureData.jira.updateDescription.bind(fixtureData.jira),
    addComment: fixtureData.jira.addComment.bind(fixtureData.jira),
    commentExists: fixtureData.jira.commentExists.bind(fixtureData.jira),
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
    async getPullRequest(prNumber) {
      return fixtureData.github.getPullRequest(prNumber);
    },
    async requestAiReview(prNumber) {
      return fixtureData.github.requestAiReview(prNumber);
    },
    async listOpenPullRequestsByLabel(label) {
      return fixtureData.github.listOpenPullRequestsByLabel(label);
    },
    async getUnresolvedReviewThreads(prNumber) {
      return fixtureData.github.getUnresolvedReviewThreads(prNumber);
    },
    async resolveReviewThread(threadId) {
      return fixtureData.github.resolveReviewThread(threadId);
    },
    async replyToReviewThread(prNumber, threadId, body) {
      return fixtureData.github.replyToReviewThread(prNumber, threadId, body);
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

