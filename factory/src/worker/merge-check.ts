import { makeRunMarker, RUN_STATUSES } from "../types.js";
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
        // A provider-backed Jira read can report the target status without
        // proving that the issue was actually transitioned. Attempt the
        // mutation so a merged PR always drives the external state change;
        // transitionIfNeeded still handles an already-Done issue safely.
        await worker.transitionIfNeeded(run.issue_key, worker.config.jira.statuses.done, { force: true });
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
      try {
        await worker.jira.addComment(run.issue_key, `${makeRunMarker(run.id)}\nTask auto-closed: pull request #${pr.number} was merged (${pr.html_url}).`);
      } catch (error) {
        worker.log("warn", "merge-check:comment-failed", {
          runId: run.id,
          issueKey: run.issue_key,
          error: error?.message || String(error),
        });
      }
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
