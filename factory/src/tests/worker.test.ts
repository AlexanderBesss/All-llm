import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { openStateDatabase } from "../db.js";
import { abortError } from "../git.js";
import { RUN_STATUSES, STAGES, RunAction, ArtifactKind } from "../types.js";
import { AgentProvider } from "../model/config.js";
import { executionFor, fixture, makeWorker, planFor } from "./support.js";
import { implementationModel, pullRequestDescription } from "../worker.js";
import { runLoop } from "../worker/loops.js";

async function waitFor(condition: () => boolean, message: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(message);
}
test("processes one parent ticket with one agent and one aggregate PR", async () => {
  const fixtureData = await fixture();
  const events = [];
  const logs = [];
  let agentCalls = 0;
  let implementationInput;
  const agent = {
    async execute(input) {
      agentCalls += 1;
      implementationInput = input;
      events.push("implementation");
      input.onProgress?.({
        type: "item.completed",
        item: { type: "command_execution", status: "completed" },
      });
      input.onProgress?.({
        type: "turn.completed",
        usage: { input_tokens: 12_345, cached_input_tokens: 10_000, output_tokens: 678 },
      });
      return { result: executionFor(), raw: {} };
    },
  };
  const worker = makeWorker(fixtureData, agent, { events, logs });
  const result = await worker.runOnce();
  assert.equal(result.action, RunAction.Claimed);
  assert.equal(agentCalls, 1);
  assert.equal(fixtureData.github.pullRequests.length, 1);
  assert.deepEqual(events.filter((event) => event.startsWith("status:")), ["status:In Progress", "status:In Review"]);
  assert.ok(events.indexOf("status:In Progress") < events.indexOf("implementation"));
  assert.ok(events.indexOf("implementation") < events.indexOf("pull-request"));
  assert.equal(fixtureData.github.pullRequests[0].title, "[FACT-1] Add factory coverage (Task)");
  assert.match(fixtureData.github.pullRequests[0].title, /Add factory coverage/);
  assert.deepEqual(fixtureData.github.pullRequests[0].labels, ["review", "ai-review"]);
  const pullRequestBody = fixtureData.github.pullRequests[0].body;
  assert.match(pullRequestBody, /^Implemented by gpt-5\.6-luna \(reasoning effort: max\)\n\n\[factory-run:FACT-1-[^\]]+\]/);
  assert.match(pullRequestBody, /## Intent\nFactory coverage/);
  assert.match(pullRequestBody, /## What this changes/);
  assert.doesNotMatch(pullRequestBody, /Implementation areas/);
  assert.doesNotMatch(pullRequestBody, /- factory/);
  assert.match(pullRequestBody, /## Acceptance criteria/);
  assert.match(pullRequestBody, /## Validation\nThe implementation agent was asked to run:/);
  assert.match(pullRequestBody, /## References\n- Jira issue: `FACT-1`\n- Factory specification: `specs\/factory-FACT-1\.md`/);
  assert.equal(fixtureData.jira.issues.size, 1);
  const description = String((await fixtureData.jira.getIssue("FACT-1")).fields.description || "");
  assert.match(description, /^> Implement the requested change\./);
  assert.ok(description.indexOf("[factory-run:") > description.indexOf("> Implement the requested change."));
  assert.ok(description.indexOf("## Implementation plan") > description.indexOf("[factory-run:"));
  assert.equal(implementationInput.specPath, "specs/factory-FACT-1.md");
  assert.match(await readFile(path.join(implementationInput.cwd, implementationInput.specPath), "utf8"), /# Specification: \[FACT-1\]/);
  assert.equal(fixtureData.db.findArtifact(ArtifactKind.Spec, "factory/FACT-1").artifact_value, "specs/factory-FACT-1.md");
  assert.match(description, /specs\/factory-FACT-1\.md/);
  assert.ok(logs.some((entry) => entry.includes("implementation:agent-start")));
  assert.ok(logs.some((entry) => entry.includes("implementation:spec-ready")));
  assert.ok(logs.some((entry) => entry.includes("implementation:agent-complete")));
  assert.ok(logs.some((entry) => entry.includes("implementation:agent-token-usage") && entry.includes('"generatedTokens":678')));
  assert.ok(logs.some((entry) => entry.includes("implementation:agent-complete") && entry.includes('"generatedTokens":678')));
  assert.ok(!logs.some((entry) => entry.includes("implementation:agent-progress")));
  assert.ok(logs.every((entry) => /^\[\d{4}-\d{2}-\d{2}T[^\]]+Z\](?: \[[^\]]+\])? /.test(entry)));
  assert.ok(logs.every((entry) => !entry.includes("[factory]")));
  const run = fixtureData.db.getRun(result.runId);
  assert.equal(run.stage, STAGES.REVIEW);
  assert.equal(run.status, RUN_STATUSES.AWAITING_REVIEW);
  fixtureData.db.close();
});

test("pull-request description presents intent and review context in a predictable order", () => {
  const body = pullRequestDescription({
    runId: "FACT-1-run",
    issueKey: "FACT-1",
    plan: {
      summary: "Allow reviewers to understand the factory result from the PR itself.",
      acceptanceCriteria: ["The PR explains the delivered behavior in plain language."],
      risks: [],
      files: ["factory/src/worker.ts"],
      tests: ["npm test — verifies the factory workflow."],
    },
    specPath: "specs/factory-FACT-1.md",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
  });
  assert.match(body, /^Implemented by gpt-5\.6-sol \(reasoning effort: medium\)\n\n\[factory-run:FACT-1-run\]/);
  assert.ok(body.indexOf("## Intent") < body.indexOf("## Acceptance criteria"));
  assert.ok(body.indexOf("## Acceptance criteria") < body.indexOf("## Validation"));
  assert.ok(body.indexOf("## Validation") < body.indexOf("## References"));
  assert.match(body, /Allow reviewers to understand the factory result/);
  assert.doesNotMatch(body, /Implementation areas/);
  assert.doesNotMatch(body, /factory\/src\/worker\.ts/);
  assert.match(body, /npm test — verifies the factory workflow\./);
});

test("pull-request attribution follows the selected provider and Jira issue type", async () => {
  const featureFixture = await fixture();
  const featureIssue = await featureFixture.jira.getIssue("FACT-1");
  featureIssue.fields.issuetype = { name: "Feature" };
  featureFixture.jira.issues.set("FACT-1", featureIssue);
  const featureWorker = makeWorker(featureFixture, { async execute() { return { result: executionFor(), raw: {} }; } });

  await featureWorker.runOnce();

  assert.equal(implementationModel(featureFixture.config, featureIssue), "gpt-5.6-sol");
  assert.match(featureFixture.github.pullRequests[0].body, /^Implemented by gpt-5\.6-sol \(reasoning effort: medium\)\n\n/);
  featureFixture.db.close();

  const openCodeFixture = await fixture();
  openCodeFixture.config.provider = AgentProvider.OpenCode;
  Object.assign(openCodeFixture.config.opencode, { model: "llamacpp/unsloth/Qwen3.6-27B-UD-Q4_K_XL" });
  const openCodeIssue = await openCodeFixture.jira.getIssue("FACT-1");
  const openCodeWorker = makeWorker(openCodeFixture, { async execute() { return { result: executionFor(), raw: {} }; } });

  await openCodeWorker.runOnce();

  assert.equal(implementationModel(openCodeFixture.config, openCodeIssue), "llamacpp/unsloth/Qwen3.6-27B-UD-Q4_K_XL");
  assert.match(openCodeFixture.github.pullRequests[0].body, /^Implemented by llamacpp\/unsloth\/Qwen3\.6-27B-UD-Q4_K_XL\n\n/);
  openCodeFixture.db.close();
});

test("missing model metadata leaves the existing pull-request description usable", async () => {
  const fixtureData = await fixture();
  Object.assign(fixtureData.config.codex, { model: " " });
  const worker = makeWorker(fixtureData, { async execute() { return { result: executionFor(), raw: {} }; } });

  await worker.runOnce();

  assert.equal(implementationModel(fixtureData.config, await fixtureData.jira.getIssue("FACT-1")), undefined);
  assert.match(fixtureData.github.pullRequests[0].body, /^\[factory-run:FACT-1-[^\]]+\]/);
  fixtureData.db.close();
});

test("dry-run moves directly from implementation to pull-request generation", async () => {
  const fixtureData = await fixture();
  const worker = makeWorker(fixtureData, { async execute() { return { result: executionFor(), raw: {} }; } });
  const result = await worker.runOnce({ dryRun: true });
  assert.equal(result.action, RunAction.Claimed);
  assert.equal(fixtureData.db.countStageAttempts(result.runId, STAGES.IMPLEMENTATION), 1);
  assert.equal(fixtureData.db.countStageAttempts(result.runId, STAGES.PULL_REQUEST), 1);
  assert.equal(fixtureData.db.getRun(result.runId).stage, STAGES.REVIEW);
  fixtureData.db.close();
});

test("blocks a pull request when the Jira type is unsupported", async () => {
  const fixtureData = await fixture();
  const issue = await fixtureData.jira.getIssue("FACT-1");
  issue.fields.issuetype = { name: "Story" };
  fixtureData.jira.issues.set("FACT-1", issue);
  const worker = makeWorker(fixtureData, { async execute() { return { result: executionFor(), raw: {} }; } });
  const result = await worker.runOnce();
  assert.equal(result.action, RunAction.Blocked);
  assert.equal(fixtureData.github.pullRequests.length, 0);
  assert.match(fixtureData.db.getRun(result.runId).last_error, /Unsupported Jira task type/);
  fixtureData.db.close();
});

test("pull-request stage normalizes a legacy persisted Jira type object", async () => {
  const fixtureData = await fixture();
  const issue = await fixtureData.jira.getIssue("FACT-1");
  issue.fields.issuetype = { name: { name: "Task" } as unknown as string };
  fixtureData.jira.issues.set("FACT-1", issue);
  const worker = makeWorker(fixtureData, { async execute() { return { result: executionFor(), raw: {} }; } });

  const result = await worker.runOnce();

  assert.equal(result.action, RunAction.Claimed);
  assert.equal(fixtureData.github.pullRequests.length, 1);
  assert.match(fixtureData.github.pullRequests[0].title, /\(Task\)$/);
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
  assert.match(String((await fixtureData.jira.getIssue("FACT-1")).fields.description || ""), /^> Implement the requested change\./);
  fixtureData.db.close();
});

test("quotes every line of an ADF original description before implementation details", async () => {
  const fixtureData = await fixture({
    description: {
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Keep the first requirement." }] },
        { type: "paragraph", content: [{ type: "text", text: "Keep the second requirement." }] },
      ],
    },
  });
  const worker = makeWorker(fixtureData, { async execute() { return { result: executionFor(), raw: {} }; } });

  await worker.runOnce();

  const description = String((await fixtureData.jira.getIssue("FACT-1")).fields.description || "");
  assert.match(description, /^> Keep the first requirement\.\n> Keep the second requirement\./);
  assert.ok(description.indexOf("## Implementation plan") > description.indexOf("> Keep the second requirement."));
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

test("continues blocked implementation tasks from their failed stage when enabled", async () => {
  const fixtureData = await fixture({ continueFailedTasks: true });
  let shouldFail = true;
  let agentCalls = 0;
  const agent = {
    async execute() {
      agentCalls += 1;
      if (shouldFail) throw new Error("implementation timeout");
      return { result: executionFor(), raw: {} };
    },
  };
  const worker = makeWorker(fixtureData, agent);
  const first = await worker.runOnce();
  assert.equal(first.action, "blocked");
  assert.equal(fixtureData.db.getRun(first.runId).stage, STAGES.BLOCKED);
  assert.equal(fixtureData.jira.transitions.at(-1).statusName, "Error");

  shouldFail = false;
  const second = await worker.runOnce();
  assert.equal(second.action, "resumed");
  assert.equal(agentCalls, 2);
  assert.deepEqual(
    fixtureData.jira.transitions.map((item) => item.statusName),
    ["In Progress", "Error", "In Progress", "In Review"],
  );
  assert.equal(fixtureData.db.getRun(first.runId).status, RUN_STATUSES.AWAITING_REVIEW);
  fixtureData.db.close();
});

test("continues blocked pull-request tasks without rerunning implementation", async () => {
  const fixtureData = await fixture({ continueFailedTasks: true });
  const createPullRequest = fixtureData.github.createPullRequest.bind(fixtureData.github);
  let shouldFail = true;
  fixtureData.github.createPullRequest = async (input) => {
    if (shouldFail) throw new Error("GitHub timeout");
    return createPullRequest(input);
  };
  let agentCalls = 0;
  const worker = makeWorker(fixtureData, {
    async execute() {
      agentCalls += 1;
      return { result: executionFor(), raw: {} };
    },
  });

  const first = await worker.runOnce();
  assert.equal(first.action, "blocked");
  assert.equal(fixtureData.db.getLastFailedStage(first.runId), STAGES.PULL_REQUEST);
  assert.equal(fixtureData.github.pullRequests.length, 0);
  const callsBeforeResume = agentCalls;

  shouldFail = false;
  const second = await worker.runOnce();
  assert.equal(second.action, "resumed");
  assert.equal(agentCalls, callsBeforeResume);
  assert.equal(agentCalls, 1);
  assert.equal(fixtureData.github.pullRequests.length, 1);
  assert.equal(fixtureData.db.getRun(first.runId).status, RUN_STATUSES.AWAITING_REVIEW);
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
  assert.equal(result.action, RunAction.Blocked);
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
  assert.equal(result.action, RunAction.Resumed);
  assert.equal(agentCalls, 1);
  assert.equal(fixtureData.github.pullRequests.length, 1);
  assert.equal(fixtureData.db.getRun("FACT-1-recovery").status, RUN_STATUSES.AWAITING_REVIEW);
  fixtureData.db.close();
});

test("a restarted worker reclaims an interrupted PR-stage lease before timeout", async () => {
  const fixtureData = await fixture({ maxAttempts: 2 });
  const claimed = fixtureData.db.claimRun({
    id: "FACT-1-pr-restart",
    issueKey: "FACT-1",
    projectKey: "FACT",
    issue: await fixtureData.jira.getIssue("FACT-1"),
    stage: STAGES.PULL_REQUEST,
    leaseOwner: "factory-999999999-dead-worker",
    leaseUntil: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  fixtureData.db.updateRun(claimed.run.id, {
    stage: STAGES.PULL_REQUEST,
    status: RUN_STATUSES.ACTIVE,
    plan_json: JSON.stringify(planFor()),
    branch_name: "factory/FACT-1",
    commit_sha: "0123456789abcdef",
    lease_owner: "factory-999999999-dead-worker",
    lease_until: new Date(Date.now() + 60 * 60_000).toISOString(),
  });

  const worker = makeWorker(fixtureData, { async execute() {
    throw new Error("implementation must not run during PR recovery");
  } });
  const result = await worker.runOnce();

  assert.equal(result.action, RunAction.Resumed);
  assert.equal(fixtureData.github.pullRequests.length, 1);
  assert.equal(fixtureData.db.getRun(claimed.run.id).status, RUN_STATUSES.AWAITING_REVIEW);
  fixtureData.db.close();
});

test("resumes Jira reporting from a checkpointed pull request", async () => {
  const fixtureData = await fixture({ maxAttempts: 2 });
  const claimed = fixtureData.db.claimRun({
    id: "FACT-1-pr-checkpoint",
    issueKey: "FACT-1",
    projectKey: "FACT",
    issue: await fixtureData.jira.getIssue("FACT-1"),
    stage: STAGES.PULL_REQUEST,
    leaseOwner: "factory-999999998-dead-worker",
    leaseUntil: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  fixtureData.db.updateRun(claimed.run.id, {
    stage: STAGES.PULL_REQUEST,
    status: RUN_STATUSES.ACTIVE,
    plan_json: JSON.stringify(planFor()),
    branch_name: "factory/FACT-1",
    commit_sha: "0123456789abcdef",
    pr_number: 7,
    pr_url: "https://github.test/pr/7",
    lease_owner: "factory-999999998-dead-worker",
    lease_until: new Date(Date.now() + 60 * 60_000).toISOString(),
  });

  const worker = makeWorker(fixtureData, { async execute() {
    throw new Error("implementation must not run during PR reporting recovery");
  } });
  worker.github.createPullRequest = async () => {
    throw new Error("checkpointed PR must not be recreated");
  };
  const result = await worker.runOnce();

  assert.equal(result.action, RunAction.Resumed);
  assert.equal(fixtureData.jira.comments.length, 1);
  assert.equal(fixtureData.jira.comments[0].body, "[factory-run:FACT-1-pr-checkpoint]\nPull request created: https://github.test/pr/7");
  assert.equal(fixtureData.db.getRun(claimed.run.id).status, RUN_STATUSES.AWAITING_REVIEW);
  fixtureData.db.close();
});

test("legacy planning runs migrate without creating subtasks", async () => {
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
  assert.equal(result.action, RunAction.Resumed);
  assert.equal(agentCalls, 1);
  assert.equal(fixtureData.jira.issues.size, 1);
  assert.equal(fixtureData.db.getRun("FACT-1-legacy").status, RUN_STATUSES.AWAITING_REVIEW);
  fixtureData.db.close();
});

test("persisted post-implementation review stages migrate directly to pull-request creation", async () => {
  const fixtureData = await fixture();
  const claimed = fixtureData.db.claimRun({
    id: "FACT-1-removed-review",
    issueKey: "FACT-1",
    projectKey: "FACT",
    issue: await fixtureData.jira.getIssue("FACT-1"),
    stage: "pre_pr_verification",
    leaseOwner: "dead-worker",
    leaseUntil: "2000-01-01T00:00:00.000Z",
  });
  fixtureData.db.updateRun(claimed.run.id, {
    stage: "pre_pr_verification",
    status: RUN_STATUSES.ACTIVE,
    plan_json: JSON.stringify(planFor()),
    branch_name: "factory/FACT-1",
    commit_sha: "0123456789abcdef",
    lease_owner: "dead-worker",
    lease_until: "2000-01-01T00:00:00.000Z",
  });
  let agentCalls = 0;
  const worker = makeWorker(fixtureData, { async execute() {
    agentCalls += 1;
    throw new Error("removed review stage must not invoke the agent");
  } });

  const result = await worker.runOnce();

  assert.equal(result.action, RunAction.Resumed);
  assert.equal(agentCalls, 0);
  assert.equal(fixtureData.github.pullRequests.length, 1);
  assert.equal(fixtureData.db.getRun(claimed.run.id).stage, STAGES.REVIEW);
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
  assert.equal(result.action, RunAction.Cancelled);
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
    async getPullRequest(prNumber) {
      return fixtureData.github.getPullRequest(prNumber);
    },
    async requestAiReview(prNumber) {
      return fixtureData.github.requestAiReview(prNumber);
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

test("merged pull request auto-closes the task and marks run completed", async () => {
  const fixtureData = await fixture();
  const worker = makeWorker(
    fixtureData,
    { async execute() { return { result: executionFor(), raw: {} }; } },
    { events: [], logs: [] }
  );
  const result = await worker.runOnce();
  assert.equal(fixtureData.github.pullRequests.length, 1);
  const run = fixtureData.db.getRun(result.runId);
  assert.equal(run.status, RUN_STATUSES.AWAITING_REVIEW);
  await fixtureData.github.mergePullRequest(run.pr_number);
  const checkResult = await worker.checkMergedPullRequests();
  assert.equal(checkResult.closed, 1);
  assert.equal(fixtureData.db.getRun(result.runId).status, RUN_STATUSES.COMPLETED);
  assert.equal(fixtureData.jira.comments.some(c => c.body.includes("Task auto-closed")), false);
  fixtureData.db.close();
});

test("merged pull request transitions Jira without a preliminary target-status read", async () => {
  const fixtureData = await fixture();
  const worker = makeWorker(
    fixtureData,
    { async execute() { return { result: executionFor(), raw: {} }; } },
    { events: [], logs: [] }
  );
  const result = await worker.runOnce();
  const run = fixtureData.db.getRun(result.runId);
  await fixtureData.github.mergePullRequest(run.pr_number);
  let statusReads = 0;
  worker.jira.getIssue = async () => {
    statusReads += 1;
    throw new Error("merge transition should not read status on its success path");
  };
  const checkResult = await worker.checkMergedPullRequests();

  assert.equal(checkResult.closed, 1);
  assert.equal(statusReads, 0);
  assert.equal(fixtureData.jira.transitions.at(-1)?.statusName, "Done");
  assert.equal(fixtureData.jira.issues.get("FACT-1")?.fields?.status?.name, "Done");
  fixtureData.db.close();
});

test("merged pull request remains pending when Jira stays in review", async () => {
  const fixtureData = await fixture();
  const logs: string[] = [];
  const worker = makeWorker(
    fixtureData,
    { async execute() { return { result: executionFor(), raw: {} }; } },
    { logs },
  );
  const result = await worker.runOnce();
  const run = fixtureData.db.getRun(result.runId);
  await fixtureData.github.mergePullRequest(run.pr_number);
  worker.jira.transition = async () => {
    throw new Error('Transition succeeded, but the resulting status was "In Review" rather than "Done".');
  };

  const checkResult = await worker.checkMergedPullRequests();

  assert.equal(checkResult.closed, 0);
  assert.equal(fixtureData.db.getRun(run.id).status, RUN_STATUSES.AWAITING_REVIEW);
  const transitionLog = logs.find((entry) => entry.includes("merge-check:transition-failed"));
  assert.ok(transitionLog);
  assert.match(transitionLog, /"targetStatus":"Done"/);
  assert.match(transitionLog, /"currentStatus":"In Review"/);
  assert.match(transitionLog, /"retryable":true/);
  assert.match(transitionLog, /left-awaiting-review-for-next-poll/);
  assert.match(transitionLog, /did not reach/);
  fixtureData.db.close();
});

test("merge check skips pull requests that are not yet merged", async () => {
  const fixtureData = await fixture();
  const worker = makeWorker(
    fixtureData,
    { async execute() { return { result: executionFor(), raw: {} }; } },
    { events: [], logs: [] }
  );
  const result = await worker.runOnce();
  const run = fixtureData.db.getRun(result.runId);
  assert.equal(run.status, RUN_STATUSES.AWAITING_REVIEW);
  const checkResult = await worker.checkMergedPullRequests();
  assert.equal(checkResult.closed, 0);
  assert.equal(fixtureData.db.getRun(result.runId).status, RUN_STATUSES.AWAITING_REVIEW);
  fixtureData.db.close();
});

test("review-fix loop resolves addressed threads and replies to disputed feedback", async () => {
  const fixtureData = await fixture();
  const logs: string[] = [];
  fixtureData.config.repoPath = path.resolve(".");
  const pr = await fixtureData.github.createPullRequest({
    title: "[FACT-1] Add factory coverage (Task)",
    taskNumber: "FACT-1",
    taskName: "Add factory coverage",
    taskType: "Task",
    body: "Details",
    head: "factory/FACT-1",
    base: "main",
  });
  pr.labels = ["ai-fix"];
  fixtureData.github.reviewThreads.set(pr.number, [
    { id: "thread-actionable", isResolved: false, comments: [{ id: "comment-1", author: "ai-review", body: "<!-- ai-review -->\nAdd validation" }] },
    { id: "thread-incorrect", isResolved: false, comments: [{ id: "comment-2", author: "ai-review", body: "<!-- ai-review -->\nRemove required behavior" }] },
  ]);
  let publicationChecks = 0;
  fixtureData.git.assertBranchPublished = async () => publicationChecks++ === 0 ? "before-review-fix" : "after-review-fix";
  const worker = makeWorker(fixtureData, {
    async run() {
      return {
        output: JSON.stringify({
          summary: "Handled review feedback",
          committed: true,
          pushed: true,
          threads: [
            { threadId: "thread-actionable", disposition: "addressed", reply: "" },
            { threadId: "thread-incorrect", disposition: "disputed", reply: "❌ That change conflicts with the documented requirement." },
          ],
          tests: [],
          blockers: [],
        }),
        events: [],
      };
    },
  }, { logs });

  const result = await worker.fixPullRequestReviews();

  assert.deepEqual(result, { pullRequests: 1, addressed: 1, disputed: 1, failed: 0 });
  assert.equal(fixtureData.github.reviewThreads.get(pr.number)?.[0].isResolved, true);
  assert.equal(fixtureData.github.reviewThreads.get(pr.number)?.[1].isResolved, false);
  assert.deepEqual(fixtureData.github.reviewReplies, [{
    prNumber: pr.number,
    threadId: "thread-incorrect",
    body: "❌ That change conflicts with the documented requirement.",
  }]);
  assert.deepEqual(pr.labels, ["ai-review"]);
  assert.ok(logs.some((entry) => entry.includes("review-fix:requeued-ai-review")));
  fixtureData.db.close();
});

test("review-fix loop only sends unresolved AI findings without follow-ups to the agent", async () => {
  const fixtureData = await fixture();
  fixtureData.config.repoPath = path.resolve(".");
  const pr = await fixtureData.github.createPullRequest({
    title: "[FACT-1] Add factory coverage (Task)",
    taskNumber: "FACT-1",
    taskName: "Add factory coverage",
    taskType: "Task",
    body: "Details",
    head: "factory/FACT-1",
    base: "main",
  });
  pr.labels = ["ai-fix"];
  fixtureData.github.reviewThreads.set(pr.number, [
    { id: "thread-eligible", isResolved: false, comments: [{ id: "comment-eligible", author: "ai-review", body: "<!-- ai-review -->\nAdd validation" }] },
    { id: "thread-resolved", isResolved: true, comments: [{ id: "comment-resolved", author: "ai-review", body: "<!-- ai-review -->\nAlready handled" }] },
    { id: "thread-not-relevant", isResolved: false, comments: [
      { id: "comment-not-relevant", author: "ai-review", body: "<!-- ai-review -->\nChange this" },
      { id: "reply-not-relevant", author: "human", body: "not relevant" },
    ] },
    { id: "thread-do-not-fix", isResolved: false, comments: [
      { id: "comment-do-not-fix", author: "ai-review", body: "<!-- ai-review -->\nChange that" },
      { id: "reply-do-not-fix", author: "human", body: "do not fix this" },
    ] },
    { id: "thread-human", isResolved: false, comments: [{ id: "comment-human", author: "reviewer", body: "Please update this" }] },
  ]);
  let agentCalls = 0;
  let task = "";
  let publicationChecks = 0;
  fixtureData.git.assertBranchPublished = async () => publicationChecks++ === 0 ? "before-review-fix" : "after-review-fix";
  const worker = makeWorker(fixtureData, {
    async run(input) {
      agentCalls += 1;
      task = input.task;
      return {
        output: JSON.stringify({
          summary: "Handled the eligible review finding",
          committed: true,
          pushed: true,
          threads: [{ threadId: "thread-eligible", disposition: "addressed", reply: "" }],
          tests: [],
          blockers: [],
        }),
        events: [],
      };
    },
  });

  const result = await worker.fixPullRequestReviews();

  assert.deepEqual(result, { pullRequests: 1, addressed: 1, disputed: 0, failed: 0 });
  assert.equal(agentCalls, 1);
  assert.match(task, /thread-eligible/);
  assert.doesNotMatch(task, /thread-resolved|thread-not-relevant|thread-do-not-fix|thread-human/);
  assert.equal(fixtureData.github.reviewThreads.get(pr.number)?.find((thread) => thread.id === "thread-resolved")?.isResolved, true);
  assert.equal(fixtureData.github.reviewThreads.get(pr.number)?.find((thread) => thread.id === "thread-not-relevant")?.isResolved, false);
  assert.equal(fixtureData.github.reviewThreads.get(pr.number)?.find((thread) => thread.id === "thread-do-not-fix")?.isResolved, false);
  assert.equal(fixtureData.github.reviewThreads.get(pr.number)?.find((thread) => thread.id === "thread-human")?.isResolved, false);
  assert.deepEqual(fixtureData.github.reviewReplies, []);
  fixtureData.db.close();
});

test("review-fix loop does not resolve addressed threads without a newly published commit", async () => {
  const fixtureData = await fixture();
  fixtureData.config.repoPath = path.resolve(".");
  const pr = await fixtureData.github.createPullRequest({
    title: "[FACT-1] Add factory coverage (Task)",
    taskNumber: "FACT-1",
    taskName: "Add factory coverage",
    taskType: "Task",
    body: "Details",
    head: "factory/FACT-1",
    base: "main",
  });
  pr.labels = ["ai-fix"];
  fixtureData.github.reviewThreads.set(pr.number, [
    { id: "thread-actionable", isResolved: false, comments: [{ id: "comment-1", author: "ai-review", body: "<!-- ai-review -->\nAdd validation" }] },
  ]);
  const worker = makeWorker(fixtureData, {
    async run() {
      return {
        output: JSON.stringify({
          summary: "Claimed a fix without publishing a new commit",
          committed: true,
          pushed: true,
          threads: [{ threadId: "thread-actionable", disposition: "addressed", reply: "" }],
          tests: [],
          blockers: [],
        }),
        events: [],
      };
    },
  });

  const result = await worker.fixPullRequestReviews();

  assert.deepEqual(result, { pullRequests: 1, addressed: 0, disputed: 0, failed: 1 });
  assert.equal(fixtureData.github.reviewThreads.get(pr.number)?.[0].isResolved, false);
  fixtureData.db.close();
});

test("review-fix loop leaves an ai-fix pull request alone when no eligible threads remain", async () => {
  const fixtureData = await fixture();
  fixtureData.config.repoPath = path.resolve(".");
  const pr = await fixtureData.github.createPullRequest({
    title: "[FACT-1] Add factory coverage (Task)",
    taskNumber: "FACT-1",
    taskName: "Add factory coverage",
    taskType: "Task",
    body: "Details",
    head: "factory/FACT-1",
    base: "main",
  });
  pr.labels = ["ai-fix"];
  const worker = makeWorker(fixtureData, { async run() { throw new Error("agent should not run"); } });

  const result = await worker.fixPullRequestReviews();

  assert.deepEqual(result, { pullRequests: 1, addressed: 0, disputed: 0, failed: 0 });
  assert.deepEqual(pr.labels, ["ai-fix"]);
  fixtureData.db.close();
});

test("implementation loop claims two Ready issues concurrently with one durable run each", async () => {
  const fixtureData = await fixture();
  fixtureData.jira.issues.set("FACT-2", {
    key: "FACT-2",
    fields: {
      summary: "Second factory task",
      description: "Implement the second task.",
      project: { key: "FACT" },
      status: { name: "Ready" },
      issuetype: { name: "Task" },
      labels: [],
    },
  });
  const controller = new AbortController();
  let activeAgents = 0;
  let maxActiveAgents = 0;
  const startedIssues: string[] = [];
  let resolveBothStarted: (() => void) | undefined;
  const bothStarted = new Promise<void>((resolve) => { resolveBothStarted = resolve; });
  let releaseImplementations: (() => void) | undefined;
  const release = new Promise<void>((resolve) => { releaseImplementations = resolve; });
  const worker = makeWorker(fixtureData, {
    async execute(input) {
      activeAgents += 1;
      maxActiveAgents = Math.max(maxActiveAgents, activeAgents);
      startedIssues.push(input.issue.key);
      if (activeAgents === 2) resolveBothStarted?.();
      await release;
      activeAgents -= 1;
      return { result: executionFor(), raw: {} };
    },
  });
  worker.signal = controller.signal;
  worker.config.implementationConcurrency = 2;

  const loop = runLoop(worker, {
    signal: controller.signal,
    pollIntervalMs: 10_000,
    concurrency: 2,
  });
  await bothStarted;
  const activeRuns = fixtureData.db.listRuns(10).filter((run) => run.status === RUN_STATUSES.ACTIVE);
  assert.equal(maxActiveAgents, 2);
  assert.deepEqual(startedIssues.sort(), ["FACT-1", "FACT-2"]);
  assert.equal(activeRuns.length, 2);
  assert.deepEqual(new Set(activeRuns.map((run) => run.issue_key)), new Set(["FACT-1", "FACT-2"]));

  releaseImplementations?.();
  await waitFor(
    () => fixtureData.db.listRuns(10).filter((run) => run.status === RUN_STATUSES.AWAITING_REVIEW).length === 2,
    "both implementation runs should reach awaiting review",
  );
  controller.abort();
  await loop;

  const runs = fixtureData.db.listRuns(10);
  assert.equal(runs.length, 2);
  assert.equal(new Set(runs.map((run) => run.pr_number)).size, 2);
  assert.ok(runs.every((run) => run.status === RUN_STATUSES.AWAITING_REVIEW));
  assert.equal(fixtureData.github.pullRequests.length, 2);
  fixtureData.db.close();
});

test("implementation pool refills a free lane without exceeding two active agents", async () => {
  const fixtureData = await fixture();
  for (const [key, summary] of [["FACT-2", "Second factory task"], ["FACT-3", "Third factory task"]]) {
    fixtureData.jira.issues.set(key, {
      key,
      fields: {
        summary,
        description: `Implement ${key}.`,
        project: { key: "FACT" },
        status: { name: "Ready" },
        issuetype: { name: "Task" },
        labels: [],
      },
    });
  }

  let activeAgents = 0;
  let maxActiveAgents = 0;
  const startedIssues: string[] = [];
  let resolveThirdStarted: (() => void) | undefined;
  const thirdStarted = new Promise<void>((resolve) => { resolveThirdStarted = resolve; });
  let releaseLongImplementations: (() => void) | undefined;
  const holdLongImplementations = new Promise<void>((resolve) => { releaseLongImplementations = resolve; });
  const worker = makeWorker(fixtureData, {
    async execute(input) {
      activeAgents += 1;
      maxActiveAgents = Math.max(maxActiveAgents, activeAgents);
      startedIssues.push(input.issue.key);
      if (input.issue.key === "FACT-3") resolveThirdStarted?.();
      if (input.issue.key !== "FACT-2") await holdLongImplementations;
      activeAgents -= 1;
      return { result: executionFor(), raw: {} };
    },
  });

  const batch = worker.runBatch({ concurrency: 2 });
  await thirdStarted;

  assert.deepEqual(new Set(startedIssues), new Set(["FACT-1", "FACT-2", "FACT-3"]));
  assert.equal(activeAgents, 2);
  assert.equal(maxActiveAgents, 2);

  releaseLongImplementations?.();
  const result = await batch;

  assert.equal(result.concurrency, 2);
  assert.equal(result.completed, 3);
  assert.equal(result.failed, 0);
  assert.equal(maxActiveAgents, 2);
  assert.equal(fixtureData.github.pullRequests.length, 3);
  assert.ok(fixtureData.db.listRuns(10).every((run) => run.status === RUN_STATUSES.AWAITING_REVIEW));
  fixtureData.db.close();
});

test("implementation batch claims every selected issue before a fast agent can complete", async () => {
  const fixtureData = await fixture();
  fixtureData.jira.issues.set("FACT-2", {
    key: "FACT-2",
    fields: {
      summary: "Second factory task",
      description: "Implement the second task.",
      project: { key: "FACT" },
      status: { name: "Ready" },
      issuetype: { name: "Task" },
      labels: [],
    },
  });
  const worker = makeWorker(fixtureData, {
    async execute(input) {
      const activeIssueKeys = fixtureData.db.listRuns(10)
        .filter((run) => run.status === RUN_STATUSES.ACTIVE)
        .map((run) => run.issue_key);
      assert.deepEqual(new Set(activeIssueKeys), new Set(["FACT-1", "FACT-2"]));
      return { result: executionFor(), raw: {} };
    },
  });
  const searchReady = worker.jira.searchReady.bind(worker.jira);
  let searchCalls = 0;
  worker.jira.searchReady = async () => {
    searchCalls += 1;
    if (searchCalls === 1) await new Promise((resolve) => setTimeout(resolve, 10));
    return searchReady();
  };

  const result = await worker.runBatch({ concurrency: 2 });

  assert.equal(result.completed, 2);
  assert.equal(result.failed, 0);
  assert.equal(fixtureData.db.listRuns(10).length, 2);
  assert.equal(fixtureData.github.pullRequests.length, 2);
  assert.ok(fixtureData.db.listRuns(10).every((run) => run.status === RUN_STATUSES.AWAITING_REVIEW));
  fixtureData.db.close();
});

test("implementation batch records one item failure while its sibling completes", async () => {
  const fixtureData = await fixture();
  fixtureData.jira.issues.set("FACT-2", {
    key: "FACT-2",
    fields: {
      summary: "Second factory task",
      description: "Implement the second task.",
      project: { key: "FACT" },
      status: { name: "Ready" },
      issuetype: { name: "Task" },
      labels: [],
    },
  });
  const logs: string[] = [];
  const worker = makeWorker(fixtureData, {
    async execute(input) {
      if (input.issue.key === "FACT-1") throw new Error("first implementation failed");
      return { result: executionFor(), raw: {} };
    },
  }, { logs });

  const result = await worker.runBatch({ concurrency: 2 });
  const runs = fixtureData.db.listRuns(10);

  assert.equal(result.failed, 0);
  assert.equal(runs.length, 2);
  assert.equal(runs.find((run) => run.issue_key === "FACT-1")?.status, RUN_STATUSES.BLOCKED);
  assert.equal(runs.find((run) => run.issue_key === "FACT-2")?.status, RUN_STATUSES.AWAITING_REVIEW);
  assert.ok(logs.some((entry) => entry.includes("stage:failed") && entry.includes("first implementation failed")));
  assert.equal(fixtureData.github.pullRequests.length, 1);
  fixtureData.db.close();
});

test("merge-check evaluates awaiting-review pull requests concurrently and closes only merged items", async () => {
  const fixtureData = await fixture();
  fixtureData.jira.issues.set("FACT-2", {
    key: "FACT-2",
    fields: {
      summary: "Second factory task",
      description: "Implement the second task.",
      project: { key: "FACT" },
      status: { name: "Ready" },
      issuetype: { name: "Task" },
      labels: [],
    },
  });
  const worker = makeWorker(fixtureData, { async execute() { return { result: executionFor(), raw: {} }; } });
  const first = await worker.runOnce();
  const second = await worker.runOnce();
  const firstRun = fixtureData.db.getRun(first.runId);
  const secondRun = fixtureData.db.getRun(second.runId);
  await fixtureData.github.mergePullRequest(firstRun.pr_number);

  let activeChecks = 0;
  let maxActiveChecks = 0;
  let resolveBothStarted: (() => void) | undefined;
  const bothStarted = new Promise<void>((resolve) => { resolveBothStarted = resolve; });
  let releaseChecks: (() => void) | undefined;
  const release = new Promise<void>((resolve) => { releaseChecks = resolve; });
  const originalGetPullRequest = worker.github.getPullRequest.bind(worker.github);
  worker.github.getPullRequest = async (prNumber) => {
    activeChecks += 1;
    maxActiveChecks = Math.max(maxActiveChecks, activeChecks);
    if (activeChecks === 2) resolveBothStarted?.();
    await release;
    activeChecks -= 1;
    return originalGetPullRequest(prNumber);
  };
  worker.config.mergeCheckConcurrency = 2;

  const check = worker.checkMergedPullRequests();
  await bothStarted;
  assert.equal(maxActiveChecks, 2);
  releaseChecks?.();
  const result = await check;

  assert.equal(result.closed, 1);
  assert.equal(fixtureData.db.getRun(firstRun.id).status, RUN_STATUSES.COMPLETED);
  assert.equal(fixtureData.db.getRun(secondRun.id).status, RUN_STATUSES.AWAITING_REVIEW);
  assert.equal((await fixtureData.jira.getIssue("FACT-1")).fields.status?.name, "Done");
  assert.equal((await fixtureData.jira.getIssue("FACT-2")).fields.status?.name, "In Review");
  fixtureData.db.close();
});

test("merge-check isolates a pull-request read failure from a merged sibling", async () => {
  const fixtureData = await fixture();
  fixtureData.jira.issues.set("FACT-2", {
    key: "FACT-2",
    fields: {
      summary: "Second factory task",
      description: "Implement the second task.",
      project: { key: "FACT" },
      status: { name: "Ready" },
      issuetype: { name: "Task" },
      labels: [],
    },
  });
  const logs: string[] = [];
  const worker = makeWorker(fixtureData, { async execute() { return { result: executionFor(), raw: {} }; } }, { logs });
  const first = await worker.runOnce();
  const second = await worker.runOnce();
  const firstRun = fixtureData.db.getRun(first.runId);
  const secondRun = fixtureData.db.getRun(second.runId);
  await fixtureData.github.mergePullRequest(secondRun.pr_number);
  const originalGetPullRequest = worker.github.getPullRequest.bind(worker.github);
  worker.github.getPullRequest = async (prNumber) => {
    if (prNumber === firstRun.pr_number) throw new Error("GitHub read failed");
    return originalGetPullRequest(prNumber);
  };

  const result = await worker.checkMergedPullRequests(2);

  assert.equal(result.closed, 1);
  assert.equal(fixtureData.db.getRun(firstRun.id).status, RUN_STATUSES.AWAITING_REVIEW);
  assert.equal(fixtureData.db.getRun(secondRun.id).status, RUN_STATUSES.COMPLETED);
  assert.ok(logs.some((entry) => entry.includes("merge-check:error") && entry.includes("GitHub read failed")));
  fixtureData.db.close();
});

test("implementation shutdown cancels active work and releases its lease without starting new work", async () => {
  const fixtureData = await fixture();
  const controller = new AbortController();
  let resolveAgentStarted: (() => void) | undefined;
  const agentStarted = new Promise<void>((resolve) => { resolveAgentStarted = resolve; });
  const worker = makeWorker(fixtureData, {
    async execute() {
      resolveAgentStarted?.();
      await new Promise<void>((_resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(abortError("test shutdown")), { once: true });
      });
      throw new Error("unreachable");
    },
  });
  worker.signal = controller.signal;

  const loop = runLoop(worker, {
    signal: controller.signal,
    pollIntervalMs: 10_000,
    concurrency: 2,
  });
  await agentStarted;
  await waitFor(() => fixtureData.db.listRuns(10).length === 1, "the Ready issue should be claimed before shutdown");
  controller.abort();
  await loop;

  const run = fixtureData.db.listRuns(10)[0];
  assert.equal(run.lease_owner, null);
  assert.equal(run.lease_until, null);
  assert.equal(fixtureData.github.pullRequests.length, 0);
  assert.equal(fixtureData.db.listRuns(10).length, 1);
  fixtureData.db.close();
});
