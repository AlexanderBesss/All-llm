import { isAbortError } from "../git.js";
import type { FactoryRun } from "../model/database.js";
import type { FactoryWorker } from "../worker.js";
import { runBounded } from "./concurrency.js";
import { JiraTransitionFailedError } from "./failure.js";

export async function checkMergedPullRequests(
  worker: FactoryWorker,
  concurrency = 1,
  inFlightRunIds: Set<string> = new Set(),
): Promise<{ closed: number }> {
  worker.throwIfStopping();
  worker.log("info", "merge-check:start", { concurrency });
  const runs = worker.db.getAwaitingReviewRuns(50);
  const eligibleRuns = runs.filter((run) => !inFlightRunIds.has(run.id));
  worker.log("info", "merge-check:pending", { count: eligibleRuns.length });
  if (!eligibleRuns.length) {
    worker.log("info", "merge-check:complete", { closed: 0 });
    return { closed: 0 };
  }

  eligibleRuns.forEach((run) => inFlightRunIds.add(run.id));
  let closed = 0;
  try {
    await runBounded(eligibleRuns, concurrency, async (run) => {
      const didClose = await processPullRequest(worker, run);
      if (didClose) closed += 1;
    }, worker.signal);
  } finally {
    eligibleRuns.forEach((run) => inFlightRunIds.delete(run.id));
  }
  worker.log("info", "merge-check:complete", { closed });
  return { closed };
}

async function processPullRequest(worker: FactoryWorker, run: FactoryRun): Promise<boolean> {
  worker.throwIfStopping();
  try {
    const pr = await worker.github.getPullRequest(run.pr_number);
    if (!pr) {
      worker.log("warn", "merge-check:pr-not-found", {
        runId: run.id,
        issueKey: run.issue_key,
        prNumber: run.pr_number,
      });
      return false;
    }
    if (pr.number !== run.pr_number) {
      worker.log("warn", "merge-check:pr-mismatch", {
        runId: run.id,
        expected: run.pr_number,
        found: pr.number,
      });
      return false;
    }
    if (!pr.merged) {
      worker.log("info", "merge-check:not-merged", {
        runId: run.id,
        issueKey: run.issue_key,
        prNumber: pr.number,
      });
      return false;
    }
    try {
      await worker.completeMergedPullRequest(run, pr);
    } catch (error) {
      if (isAbortError(error) || worker.signal?.aborted) throw error;
      worker.log("error", "merge-check:transition-failed", {
        runId: run.id,
        issueKey: run.issue_key,
        prNumber: pr.number,
        targetStatus: worker.config.jira.statuses.done,
        ...(error instanceof JiraTransitionFailedError
          ? {
            currentStatus: error.currentStatus || "unknown",
            retryable: true,
            nextAction: "left-awaiting-review-for-next-poll",
          }
          : {}),
        error: error?.message || String(error),
      });
      return false;
    }
    return true;
  } catch (error) {
    if (isAbortError(error) || worker.signal?.aborted) throw error;
    worker.log("error", "merge-check:error", {
      runId: run.id,
      issueKey: run.issue_key,
      prNumber: run.pr_number,
      error: error?.message || String(error),
    });
    return false;
  }
}
