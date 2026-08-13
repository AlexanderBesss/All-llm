import { RUN_STATUSES } from "../types.js";
import type { FactoryWorker } from "../worker.js";

export async function checkMergedPullRequests(worker: FactoryWorker): Promise<{ closed: number }> {
  worker.throwIfStopping();
  worker.log("info", "merge-check:start");
  const runs = worker.db.getAwaitingReviewRuns(50);
  worker.log("info", "merge-check:pending", { count: runs.length });
  let closed = 0;
  for (const run of runs) {
    worker.throwIfStopping();
    try {
      const pr = await worker.github.getPullRequest(run.pr_number);
      if (!pr) {
        worker.log("warn", "merge-check:pr-not-found", {
          runId: run.id,
          issueKey: run.issue_key,
          prNumber: run.pr_number,
        });
        continue;
      }
      if (pr.number !== run.pr_number) {
        worker.log("warn", "merge-check:pr-mismatch", {
          runId: run.id,
          expected: run.pr_number,
          found: pr.number,
        });
        continue;
      }
      if (!pr.merged) {
        worker.log("info", "merge-check:not-merged", {
          runId: run.id,
          issueKey: run.issue_key,
          prNumber: pr.number,
        });
        continue;
      }
      worker.log("info", "merge-check:merged", {
        runId: run.id,
        issueKey: run.issue_key,
        prNumber: pr.number,
        prUrl: pr.html_url,
        mergedAt: pr.mergedAt,
      });
      try {
        // The adapter reconciles an ambiguous mutation with one authoritative
        // read, so the normal path does not pay for a redundant status lookup.
        await worker.transitionIfNeeded(run.issue_key, worker.config.jira.statuses.done, { skipStatusCheck: true });
      } catch (error) {
        worker.log("error", "merge-check:transition-failed", {
          runId: run.id,
          issueKey: run.issue_key,
          error: error?.message || String(error),
        });
        continue;
      }
      worker.log("info", "merge-check:task-closed", {
        runId: run.id,
        issueKey: run.issue_key,
        prNumber: pr.number,
      });
      worker.db.updateRun(run.id, {
        status: RUN_STATUSES.COMPLETED,
        last_error: null,
      });
      closed += 1;
    } catch (error) {
      worker.log("error", "merge-check:error", {
        runId: run.id,
        issueKey: run.issue_key,
        prNumber: run.pr_number,
        error: error?.message || String(error),
      });
    }
  }
  worker.log("info", "merge-check:complete", { closed });
  return { closed };
}
