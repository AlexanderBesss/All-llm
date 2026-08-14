import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryJiraAdapter } from "../jira.js";
import { assertPlanningResult } from "../agent/codex-protocol.js";
import { formatPlannedDescription, PlanningAction } from "../worker/planning.js";
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
