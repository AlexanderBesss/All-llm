import { ReviewVerdict } from "../../model/codex.js";
import type { FactoryRun } from "../../model/database.js";
import type { JiraIssue } from "../../model/jira.js";
import type { FactoryWorker } from "../../worker.js";
import { hashInput, normalizePlan } from "../format.js";
import { ArtifactKind, RUN_STATUSES, STAGES, StageRunStatus } from "../../types.js";

export async function processCodeReview(worker: FactoryWorker, run: FactoryRun, { dryRun }: { dryRun: boolean }) {
  worker.throwIfStopping();
  const issue = JSON.parse(run.issue_json) as JiraIssue;
  const plan = normalizePlan(JSON.parse(run.plan_json || "null"));
  const branchName = run.branch_name;
  const worktreePath = run.worktree_path;
  const specPath = worker.db.findArtifact(ArtifactKind.Spec, branchName)?.artifact_value || "specification unavailable";
  const attempt = worker.db.startStage(run.id, STAGES.CODE_REVIEW, hashInput({
    issue,
    plan,
    branchName,
    commit: run.commit_sha,
  }));
  worker.log("info", "code-review:start", {
    runId: run.id,
    issueKey: run.issue_key,
    branchName,
    worktreePath,
    commitSha: run.commit_sha,
    dryRun,
  });
  try {
    if (dryRun) {
      worker.db.finishStage(run.id, STAGES.CODE_REVIEW, attempt, { dryRun: true }, StageRunStatus.Completed);
      worker.db.updateRun(run.id, { stage: STAGES.PULL_REQUEST });
      return { stage: STAGES.CODE_REVIEW, dryRun: true };
    }
    if (!worktreePath) throw new Error("Code review requires the implementation worktree path.");
    const beforeSha = run.commit_sha || await worker.git.headSha(worktreePath);
    worker.log("info", "code-review:agent-start", { runId: run.id, branchName, worktree: worktreePath });
    const result = await worker.reviewer.review({
      issue,
      runId: run.id,
      branchName,
      baseBranch: worker.config.git.baseBranch,
      cwd: worktreePath,
      specPath,
      plan,
      commitSha: beforeSha,
    });
    worker.throwIfStopping();
    const review = result.result;
    const afterSha = await worker.git.headSha(worktreePath);
    const changed = review.changed || afterSha !== beforeSha;
    worker.log("info", "code-review:agent-complete", {
      runId: run.id,
      branchName,
      verdict: review.verdict,
      changed,
      findings: review.findings.length,
      tests: review.tests.length,
      blockers: review.blockers.length,
    });
    if (review.verdict !== ReviewVerdict.Passed) {
      throw new Error(`Independent code review blocked the run: ${review.blockers.join("; ") || review.summary}`);
    }
    if (changed && (!review.committed || !review.pushed)) {
      throw new Error("Code reviewer changed the implementation without confirming both commit and push.");
    }
    if (typeof worker.git.hasChanges === "function" && await worker.git.hasChanges(worktreePath)) {
      throw new Error("Code review completed with uncommitted worktree changes.");
    }
    if (typeof worker.git.assertFileCommitted === "function" && specPath !== "specification unavailable") {
      await worker.git.assertFileCommitted(worktreePath, specPath);
    }
    worker.db.finishStage(run.id, STAGES.CODE_REVIEW, attempt, { ...review, commitSha: afterSha }, StageRunStatus.Completed);
    worker.db.updateRun(run.id, {
      stage: STAGES.PULL_REQUEST,
      status: RUN_STATUSES.ACTIVE,
      commit_sha: afterSha,
      last_error: null,
      next_attempt_at: null,
    });
    worker.log("info", "code-review:complete", {
      runId: run.id,
      issueKey: run.issue_key,
      commitSha: afterSha,
      nextStage: STAGES.PULL_REQUEST,
    });
    return { stage: STAGES.CODE_REVIEW, commitSha: afterSha, changed };
  } catch (error) {
    return worker.failStage(run, STAGES.CODE_REVIEW, attempt, error);
  }
}
