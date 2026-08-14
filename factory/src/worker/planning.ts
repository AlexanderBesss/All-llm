import type { FactoryWorker } from "../worker.js";
import { adfToText } from "../jira.js";

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

export function formatPlannedDescription(description: string, acceptanceCriteria: string[]): string {
  const body = description.trim();
  const criteria = acceptanceCriteria.map((criterion) => criterion.trim());
  return `${body}\n\n## Acceptance criteria\n\n${criteria.map((criterion) => `- ${criterion}`).join("\n")}`;
}

export async function planNextIssue(worker: FactoryWorker, { dryRun = false }: { dryRun?: boolean } = {}): Promise<PlanningRunResult> {
  worker.throwIfStopping();
  worker.log("info", "planning:poll-start", { dryRun });
  if (!worker.jira.enabled()) {
    return { action: PlanningAction.Disabled, reason: "Jira adapter is not configured." };
  }
  const issues = await worker.jira.searchPlanning();
  worker.log("info", "jira:planning-issues", {
    count: issues.length,
    issueKeys: issues.slice(0, 20).map((issue) => issue.key),
  });
  const issue = issues[0];
  if (!issue) return { action: PlanningAction.Idle };

  worker.throwIfStopping();
  worker.log("info", "planning:agent-start", { issueKey: issue.key });
  const { result } = await worker.agent.planIssue({ issue });
  worker.throwIfStopping();
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

  const originalDescription = adfToText(issue.fields?.description);
  let descriptionMutationStarted = false;
  try {
    descriptionMutationStarted = true;
    await worker.jira.updateDescription(issue.key, description);
    worker.throwIfStopping();
    await worker.transitionIfNeeded(issue.key, targetStatus, { skipStatusCheck: true });
  } catch (error) {
    if (!descriptionMutationStarted) throw error;
    try {
      await worker.jira.updateDescription(issue.key, originalDescription);
      worker.log("warn", "planning:description-rolled-back", { issueKey: issue.key });
    } catch (rollbackError) {
      worker.log("error", "planning:description-rollback-failed", {
        issueKey: issue.key,
        error: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
      });
      throw new AggregateError(
        [error, rollbackError],
        `Planning failed for ${issue.key}, and restoring the original description also failed.`,
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
