import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, readFile } from "node:fs/promises";
import { openStateDatabase } from "../db.js";
import { RUN_STATUSES, STAGES, RunAction, ArtifactKind } from "../types.js";
import { executionFor, fixture, makeWorker, planFor } from "./support.js";
import { pullRequestDescription } from "../worker.js";
test("processes one parent ticket with one agent and one aggregate PR", async () => {
  const fixtureData = await fixture();
  const events = [];
  const logs = [];
  let agentCalls = 0;
  let implementationInput;
  let verificationInput;
  const agent = {
    async execute(input) {
      agentCalls += 1;
      if (input.verificationPass) {
        verificationInput = input;
        events.push("pre-pr-verification");
      } else {
        implementationInput = input;
        events.push("implementation");
      }
      return { result: executionFor(), raw: {} };
    },
  };
  const worker = makeWorker(fixtureData, agent, { events, logs });
  const result = await worker.runOnce();
  assert.equal(result.action, RunAction.Claimed);
  assert.equal(agentCalls, 2);
  assert.equal(fixtureData.github.pullRequests.length, 1);
  assert.deepEqual(events.filter((event) => event.startsWith("status:")), ["status:In Progress", "status:In Review"]);
  assert.ok(events.indexOf("status:In Progress") < events.indexOf("implementation"));
  assert.ok(events.indexOf("implementation") < events.indexOf("pre-pr-verification"));
  assert.ok(events.indexOf("pre-pr-verification") < events.indexOf("pull-request"));
  assert.ok(events.indexOf("implementation") < events.indexOf("pull-request"));
  assert.equal(fixtureData.github.pullRequests[0].title, "[FACT-1] Add factory coverage (Task)");
  assert.match(fixtureData.github.pullRequests[0].title, /Add factory coverage/);
  const pullRequestBody = fixtureData.github.pullRequests[0].body;
  assert.match(pullRequestBody, /## Intent\nFactory coverage/);
  assert.match(pullRequestBody, /## What this changes/);
  assert.match(pullRequestBody, /### Implementation areas\n- factory/);
  assert.match(pullRequestBody, /## Acceptance criteria/);
  assert.match(pullRequestBody, /## Validation\nThe implementation agent was asked to run:/);
  assert.match(pullRequestBody, /## References\n- Jira issue: `FACT-1`\n- Factory specification: `specs\/factory-FACT-1\.md`/);
  assert.equal(fixtureData.jira.issues.size, 1);
  const description = String((await fixtureData.jira.getIssue("FACT-1")).fields.description || "");
  assert.match(description, /^> Implement the requested change\./);
  assert.ok(description.indexOf("[factory-run:") > description.indexOf("> Implement the requested change."));
  assert.ok(description.indexOf("## Implementation plan") > description.indexOf("[factory-run:"));
  assert.equal(implementationInput.specPath, "specs/factory-FACT-1.md");
  assert.equal(verificationInput.verificationPass, true);
  assert.equal(verificationInput.baseBranch, "main");
  assert.match(await readFile(path.join(implementationInput.cwd, implementationInput.specPath), "utf8"), /# Specification: \[FACT-1\]/);
  assert.equal(fixtureData.db.findArtifact(ArtifactKind.Spec, "factory/FACT-1").artifact_value, "specs/factory-FACT-1.md");
  assert.match(description, /specs\/factory-FACT-1\.md/);
  assert.ok(logs.some((entry) => entry.includes("implementation:agent-start")));
  assert.ok(logs.some((entry) => entry.includes("implementation:spec-ready")));
  assert.ok(logs.some((entry) => entry.includes("implementation:agent-complete")));
  assert.ok(logs.every((entry) => /^\[\d{4}-\d{2}-\d{2}T[^\]]+Z\] \[factory\] /.test(entry)));
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
  });
  assert.ok(body.indexOf("## Intent") < body.indexOf("## Acceptance criteria"));
  assert.ok(body.indexOf("## Acceptance criteria") < body.indexOf("## Validation"));
  assert.ok(body.indexOf("## Validation") < body.indexOf("## References"));
  assert.match(body, /Allow reviewers to understand the factory result/);
  assert.match(body, /factory\/src\/worker\.ts/);
  assert.match(body, /npm test — verifies the factory workflow\./);
});

test("pre-PR verification is an editable autonomous refinement pass", async () => {
  const fixtureData = await fixture();
  let agentCalls = 0;
  let verificationInput;
  const agent = {
    async execute(input) {
      agentCalls += 1;
      if (input.verificationPass) verificationInput = input;
      return { result: executionFor({ summary: input.verificationPass ? "Verified and refined the implementation" : "Implemented the parent task" }), raw: {} };
    },
  };
  const worker = makeWorker(fixtureData, agent);
  const result = await worker.runOnce();
  assert.equal(result.action, RunAction.Claimed);
  assert.equal(agentCalls, 2);
  assert.equal(verificationInput.branchName, "factory/FACT-1");
  assert.equal(verificationInput.verificationPass, true);
  assert.equal(verificationInput.baseBranch, "main");
  assert.equal(fixtureData.github.pullRequests.length, 1);
  assert.equal(fixtureData.db.getRun(result.runId).stage, STAGES.REVIEW);
  fixtureData.db.close();
});

test("an unresolved pre-PR verification blocker prevents pull-request creation", async () => {
  const fixtureData = await fixture({ maxAttempts: 1 });
  const agent = {
    async execute(input) {
      return { result: executionFor(input.verificationPass
        ? { blockers: ["The implementation requires unavailable authority."] }
        : {}), raw: {} };
    },
  };
  const worker = makeWorker(fixtureData, agent);
  const result = await worker.runOnce();
  assert.equal(result.action, RunAction.Blocked);
  assert.equal(fixtureData.github.pullRequests.length, 0);
  assert.equal(fixtureData.db.getLastFailedStage(result.runId), STAGES.PRE_PR_VERIFICATION);
  fixtureData.db.close();
});

test("dry-run still records the pre-PR verification stage before pull-request generation", async () => {
  const fixtureData = await fixture();
  const worker = makeWorker(fixtureData, { async execute() { return { result: executionFor(), raw: {} }; } });
  const result = await worker.runOnce({ dryRun: true });
  assert.equal(result.action, RunAction.Claimed);
  assert.equal(fixtureData.db.countStageAttempts(result.runId, STAGES.IMPLEMENTATION), 1);
  assert.equal(fixtureData.db.countStageAttempts(result.runId, STAGES.PRE_PR_VERIFICATION), 1);
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
  assert.equal(calls, 3);
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
  assert.equal(agentCalls, 3);
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
  assert.equal(agentCalls, 2);
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
  assert.equal(agentCalls, 2);
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
  assert.equal(agentCalls, 2);
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
  assert.ok(fixtureData.jira.comments.find(c => c.body.includes("Task auto-closed")));
  fixtureData.db.close();
});

test("merged pull request forces the Jira transition despite a target-status read", async () => {
  const fixtureData = await fixture();
  const worker = makeWorker(
    fixtureData,
    { async execute() { return { result: executionFor(), raw: {} }; } },
    { events: [], logs: [] }
  );
  const originalGetIssue = worker.jira.getIssue;
  worker.jira.getIssue = async (issueKey) => {
    const issue = await originalGetIssue(issueKey);
    issue.fields.status = { name: "Done" };
    return issue;
  };

  const result = await worker.runOnce();
  const run = fixtureData.db.getRun(result.runId);
  await fixtureData.github.mergePullRequest(run.pr_number);
  const checkResult = await worker.checkMergedPullRequests();

  assert.equal(checkResult.closed, 1);
  assert.equal(fixtureData.jira.transitions.at(-1)?.statusName, "Done");
  assert.equal(fixtureData.jira.issues.get("FACT-1")?.fields?.status?.name, "Done");
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
    { id: "thread-actionable", isResolved: false, comments: [{ id: "comment-1", author: "reviewer", body: "Add validation" }] },
    { id: "thread-incorrect", isResolved: false, comments: [{ id: "comment-2", author: "reviewer", body: "Remove required behavior" }] },
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
            { threadId: "thread-incorrect", disposition: "disputed", reply: "That change conflicts with the documented requirement." },
          ],
          tests: [],
          blockers: [],
        }),
        events: [],
      };
    },
  });

  const result = await worker.fixPullRequestReviews();

  assert.deepEqual(result, { pullRequests: 1, addressed: 1, disputed: 1, failed: 0 });
  assert.equal(fixtureData.github.reviewThreads.get(pr.number)?.[0].isResolved, true);
  assert.equal(fixtureData.github.reviewThreads.get(pr.number)?.[1].isResolved, false);
  assert.deepEqual(fixtureData.github.reviewReplies, [{
    prNumber: pr.number,
    threadId: "thread-incorrect",
    body: "That change conflicts with the documented requirement.",
  }]);
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
    { id: "thread-actionable", isResolved: false, comments: [{ id: "comment-1", author: "reviewer", body: "Add validation" }] },
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
