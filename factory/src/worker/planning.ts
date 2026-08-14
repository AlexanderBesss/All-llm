import type { FactoryWorker } from "../worker.js";
import { adfToText } from "../jira.js";
import type { JiraIssue } from "../model/jira.js";
import { isAbortError } from "../git.js";
import { runBounded } from "./concurrency.js";
import type { BoundedBatchResult } from "./concurrency.js";

export enum PlanningAction {
  Disabled = "disabled",
  Idle = "idle",
  Planned = "planned",
  DryRun = "dry_run",
}

export interface PlanningRunResult {
  action: PlanningAction;
  issueKey?: string;
  acceptanceCriteria?: number;
  targetStatus?: string;
  reason?: string;
}

type BeforePlanning = (selected: boolean) => Promise<void>;

export function formatPlannedDescription(description: string, acceptanceCriteria: string[]): string {
  const body = description.trim();
  const criteria = acceptanceCriteria.map((criterion) => criterion.trim());
  return `${body}\n\n## Acceptance criteria\n\n${criteria.map((criterion) => `- ${criterion}`).join("\n")}`;
}

export function formatPlannedSummary(issueKey: string, summary: string): string {
  const key = String(issueKey).trim();
  const body = String(summary || "").trim();
  const prefix = `[${key}]`;
  return body.toLowerCase().startsWith(prefix.toLowerCase())
    ? body
    : `${prefix} ${body || key}`;
}

export async function planNextIssue(
  worker: FactoryWorker,
  { dryRun = false, beforePlan }: { dryRun?: boolean; beforePlan?: BeforePlanning } = {},
  inFlightIssueKeys: Set<string> = new Set(),
): Promise<PlanningRunResult> {
  worker.throwIfStopping();
  worker.log("info", "planning:task-start", { dryRun });
  if (!worker.jira.enabled()) {
    await beforePlan?.(false);
    return { action: PlanningAction.Disabled, reason: "Jira adapter is not configured." };
  }
  const issues = await worker.jira.searchPlanning();
  worker.log("info", "jira:planning-issues", {
    count: issues.length,
    issueKeys: issues.slice(0, 20).map((issue) => issue.key),
  });
  const issue = issues.find((candidate) => !inFlightIssueKeys.has(candidate.key));
  if (!issue) {
    await beforePlan?.(false);
    return { action: PlanningAction.Idle };
  }

  inFlightIssueKeys.add(issue.key);
  try {
    await beforePlan?.(true);
    return await planIssue(worker, issue, dryRun);
  } finally {
    inFlightIssueKeys.delete(issue.key);
  }
}

export async function planIssues(
  worker: FactoryWorker,
  { dryRun = false, concurrency = 1 }: { dryRun?: boolean; concurrency?: number } = {},
  inFlightIssueKeys: Set<string> = new Set(),
): Promise<BoundedBatchResult<PlanningRunResult>> {
  const limit = Number.isInteger(concurrency) && concurrency > 0 ? concurrency : 1;
  if (limit === 1) {
    return {
      concurrency: limit,
      completed: 1,
      failed: 0,
      results: [await planNextIssue(worker, { dryRun }, inFlightIssueKeys)],
    };
  }

  let arrived = 0;
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
  const results: PlanningRunResult[] = [];
  const failures: unknown[] = [];
  const slots = Array.from({ length: limit }, (_, index) => index);

  await runBounded(slots, limit, async () => {
    let joined = false;
    const joinSelectionBarrier = () => {
      if (joined) return;
      joined = true;
      arrived += 1;
      if (arrived === limit) releaseGate();
    };
    try {
      results.push(await planNextIssue(worker, {
        dryRun,
        beforePlan: async () => {
          joinSelectionBarrier();
          await gate;
        },
      }, inFlightIssueKeys));
    } catch (error) {
      joinSelectionBarrier();
      if (isAbortError(error) || worker.signal?.aborted) throw error;
      failures.push(error);
      worker.log("error", "planning:item-failed", {
        error: error instanceof Error ? error.stack || error.message : String(error),
      });
    }
  }, worker.signal);

  return {
    concurrency: limit,
    completed: results.length,
    failed: failures.length,
    results,
  };
}

async function planIssue(worker: FactoryWorker, issue: JiraIssue, dryRun: boolean): Promise<PlanningRunResult> {
  worker.throwIfStopping();
  worker.log("info", "planning:agent-start", { issueKey: issue.key });
  const { result } = await worker.agent.planIssue({ issue });
  worker.throwIfStopping();
  const summary = formatPlannedSummary(issue.key, issue.fields?.summary || "");
  const description = formatPlannedDescription(result.description, result.acceptanceCriteria);
  const targetStatus = worker.config.jira.statuses.todo;
  if (dryRun) {
    worker.log("info", "planning:dry-run-complete", { issueKey: issue.key, targetStatus });
    return {
      action: PlanningAction.DryRun,
      issueKey: issue.key,
      acceptanceCriteria: result.acceptanceCriteria.length,
      targetStatus,
    };
  }

  const originalSummary = issue.fields?.summary || "";
  const originalDescription = adfToText(issue.fields?.description);
  let issueMutationStarted = false;
  try {
    issueMutationStarted = true;
    await worker.jira.updateSummaryAndDescription(issue.key, summary, description);
    worker.throwIfStopping();
    await worker.transitionIfNeeded(issue.key, targetStatus, { skipStatusCheck: true });
  } catch (error) {
    if (!issueMutationStarted) throw error;
    try {
      await worker.jira.updateSummaryAndDescription(issue.key, originalSummary, originalDescription);
      worker.log("warn", "planning:issue-rolled-back", { issueKey: issue.key });
    } catch (rollbackError) {
      worker.log("error", "planning:issue-rollback-failed", {
        issueKey: issue.key,
        error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      });
      throw new AggregateError(
        [error, rollbackError],
        `Planning failed for ${issue.key}, and restoring the original title and description also failed.`,
      );
    }
    throw error;
  }
  worker.log("info", "planning:complete", {
    issueKey: issue.key,
    acceptanceCriteria: result.acceptanceCriteria.length,
    targetStatus,
  });
  return {
    action: PlanningAction.Planned,
    issueKey: issue.key,
    acceptanceCriteria: result.acceptanceCriteria.length,
    targetStatus,
  };
}
