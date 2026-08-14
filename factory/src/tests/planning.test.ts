import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryJiraAdapter } from "../jira.js";
import { assertPlanningResult } from "../agent/codex-protocol.js";
import { formatPlannedDescription, PlanningAction } from "../worker/planning.js";
import { runPlanningLoop } from "../worker/loops.js";
import { fixture, makeWorker } from "./support.js";

function planningAgent() {
  return {
    async planIssue() {
      return {
        result: {
          description: "Allow a separate AI pass to refine work before implementation.",
          acceptanceCriteria: [
            "Planning issues receive a refined description.",
            "Planned issues move to To Do for user verification.",
          ],
        },
        raw: { output: "{}", events: [] },
      };
    },
  };
}

test("planning refines a Planning issue and moves it to To Do", async () => {
  const data = await fixture();
  const existing = await data.jira.getIssue("FACT-1");
  existing.fields.status = { name: "Planning" };
  data.jira = new InMemoryJiraAdapter([existing]);
  const events: string[] = [];
  const worker = makeWorker(data, planningAgent(), { events });

  const result = await worker.planNextIssue();
  const planned = await data.jira.getIssue("FACT-1");

  assert.deepEqual(result, {
    action: PlanningAction.Planned,
    issueKey: "FACT-1",
    acceptanceCriteria: 2,
    targetStatus: "To Do",
  });
  assert.equal(planned.fields.description, [
    "Allow a separate AI pass to refine work before implementation.",
    "",
    "## Acceptance criteria",
    "",
    "- Planning issues receive a refined description.",
    "- Planned issues move to To Do for user verification.",
  ].join("\n"));
  assert.deepEqual(events, ["status:To Do"]);
});

test("planning processes two issues concurrently once each within a bounded poll", async () => {
  const data = await fixture();
  const first = await data.jira.getIssue("FACT-1");
  first.fields.status = { name: "Planning" };
  data.jira.issues.set("FACT-1", first);
  data.jira.issues.set("FACT-2", {
    key: "FACT-2",
    fields: {
      summary: "Second planning item",
      description: "Second original description",
      project: { key: "FACT" },
      status: { name: "Planning" },
      issuetype: { name: "Task" },
      labels: [],
    },
  });

  let active = 0;
  let maxActive = 0;
  const calls: string[] = [];
  let resolveBothStarted: (() => void) | undefined;
  const bothStarted = new Promise<void>((resolve) => { resolveBothStarted = resolve; });
  let releasePlanning: (() => void) | undefined;
  const release = new Promise<void>((resolve) => { releasePlanning = resolve; });
  let transitionCount = 0;
  const originalTransition = data.jira.transition.bind(data.jira);
  data.jira.transition = async (key, statusName) => {
    const result = await originalTransition(key, statusName);
    transitionCount += 1;
    if (transitionCount === 2) controller.abort();
    return result;
  };
  const controller = new AbortController();
  const worker = makeWorker(data, {
    async planIssue({ issue }) {
      calls.push(issue.key);
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === 2) resolveBothStarted?.();
      await release;
      active -= 1;
      return {
        result: {
          description: `Refined ${issue.key}`,
          acceptanceCriteria: [`${issue.key} is ready for verification.`],
        },
        raw: { output: "{}", events: [] },
      };
    },
  });
  worker.config.planningConcurrency = 2;

  const loop = runPlanningLoop(worker, { signal: controller.signal, intervalMs: 1, concurrency: 2 });
  await bothStarted;
  assert.equal(maxActive, 2);
  releasePlanning?.();
  await loop;

  assert.deepEqual(calls.sort(), ["FACT-1", "FACT-2"]);
  assert.equal(transitionCount, 2);
  assert.equal((await data.jira.getIssue("FACT-1")).fields.description, "Refined FACT-1\n\n## Acceptance criteria\n\n- FACT-1 is ready for verification.");
  assert.equal((await data.jira.getIssue("FACT-2")).fields.description, "Refined FACT-2\n\n## Acceptance criteria\n\n- FACT-2 is ready for verification.");
  assert.equal((await data.jira.getIssue("FACT-1")).fields.status?.name, "To Do");
  assert.equal((await data.jira.getIssue("FACT-2")).fields.status?.name, "To Do");
  data.db.close();
});

test("planning batch isolates one failed item and keeps it eligible for a later poll", async () => {
  const data = await fixture();
  const first = await data.jira.getIssue("FACT-1");
  first.fields.status = { name: "Planning" };
  data.jira.issues.set("FACT-1", first);
  data.jira.issues.set("FACT-2", {
    key: "FACT-2",
    fields: {
      summary: "Second planning item",
      description: "Second original description",
      project: { key: "FACT" },
      status: { name: "Planning" },
      issuetype: { name: "Task" },
      labels: [],
    },
  });
  const logs: string[] = [];
  const calls: string[] = [];
  let failFirst = true;
  const worker = makeWorker(data, {
    async planIssue({ issue }) {
      calls.push(issue.key);
      if (issue.key === "FACT-1" && failFirst) throw new Error("planner item failed");
      return {
        result: {
          description: `Refined ${issue.key}`,
          acceptanceCriteria: [`${issue.key} is ready for verification.`],
        },
        raw: { output: "{}", events: [] },
      };
    },
  }, { logs });

  const firstPoll = await worker.planBatch({ concurrency: 2 });

  assert.equal(firstPoll.failed, 1);
  assert.equal((await data.jira.getIssue("FACT-1")).fields.status?.name, "Planning");
  assert.equal((await data.jira.getIssue("FACT-2")).fields.status?.name, "To Do");
  assert.ok(logs.some((entry) => entry.includes("planning:item-failed")));

  failFirst = false;
  const secondPoll = await worker.planBatch({ concurrency: 2 });

  assert.equal(secondPoll.failed, 0);
  assert.equal((await data.jira.getIssue("FACT-1")).fields.status?.name, "To Do");
  assert.deepEqual(calls.sort(), ["FACT-1", "FACT-1", "FACT-2"]);
  data.db.close();
});

test("planning dry-run performs no Jira mutations", async () => {
  const data = await fixture({ description: "Original description" });
  const existing = await data.jira.getIssue("FACT-1");
  existing.fields.status = { name: "Planning" };
  data.jira = new InMemoryJiraAdapter([existing]);
  const events: string[] = [];
  const worker = makeWorker(data, planningAgent(), { events });

  const result = await worker.planNextIssue({ dryRun: true });
  const unchanged = await data.jira.getIssue("FACT-1");

  assert.equal(result.action, PlanningAction.DryRun);
  assert.equal(unchanged.fields.description, "Original description");
  assert.equal(unchanged.fields.status?.name, "Planning");
  assert.deepEqual(events, []);
});

test("planning restores the original description when the transition fails", async () => {
  const data = await fixture({ description: "Original description" });
  const existing = await data.jira.getIssue("FACT-1");
  existing.fields.status = { name: "Planning" };
  data.jira = new InMemoryJiraAdapter([existing]);
  data.jira.transition = async () => {
    throw new Error("transition unavailable");
  };
  const worker = makeWorker(data, planningAgent());

  await assert.rejects(worker.planNextIssue(), /transition unavailable/);

  const unchanged = await data.jira.getIssue("FACT-1");
  assert.equal(unchanged.fields.description, "Original description");
  assert.equal(unchanged.fields.status?.name, "Planning");
});

test("planning is idle when no issue is in Planning", async () => {
  const data = await fixture();
  const worker = makeWorker(data, planningAgent());
  assert.deepEqual(await worker.planNextIssue(), { action: PlanningAction.Idle });
});

test("planned description formatting is deterministic", () => {
  assert.equal(formatPlannedDescription("  Scope  ", [" First ", "Second"]),
    "Scope\n\n## Acceptance criteria\n\n- First\n- Second");
});

test("planning result validation rejects missing acceptance criteria", () => {
  assert.throws(() => assertPlanningResult({ description: "Refined", acceptanceCriteria: [] }),
    /acceptance criteria/);
});
