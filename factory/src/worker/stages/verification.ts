import type { FactoryRun } from "../../model/database.js";
import type { JiraIssue } from "../../model/jira.js";
import type { FactoryWorker } from "../../worker.js";
import { hashInput, normalizePlan } from "../format.js";
import { ArtifactKind, RUN_STATUSES, STAGES, StageRunStatus } from "../../types.js";

export async function processPrePrVerification(worker: FactoryWorker, run: FactoryRun, { dryRun }: { dryRun: boolean }) {
  worker.throwIfStopping();
  const issue = JSON.parse(run.issue_json) as JiraIssue;
  const previousPlan = normalizePlan(JSON.parse(run.plan_json || "null"));
  const branchName = run.branch_name;
  const worktreePath = run.worktree_path;
  const specPath = worker.db.findArtifact(ArtifactKind.Spec, branchName)?.artifact_value || "specification unavailable";
  const attempt = worker.db.startStage(run.id, STAGES.PRE_PR_VERIFICATION, hashInput({
    issue,
    previousPlan,
    branchName,
    commit: run.commit_sha,
  }));
  worker.log("info", "pre-pr-verification:start", {
    runId: run.id,
    issueKey: run.issue_key,
    branchName,
    worktreePath,
    commitSha: run.commit_sha,
    dryRun,
  });
  try {
    if (dryRun) {
      worker.db.finishStage(run.id, STAGES.PRE_PR_VERIFICATION, attempt, { dryRun: true }, StageRunStatus.Completed);
      worker.db.updateRun(run.id, { stage: STAGES.PULL_REQUEST });
      return { stage: STAGES.PRE_PR_VERIFICATION, dryRun: true };
    }
    if (!worktreePath) throw new Error("Pre-PR verification requires the implementation worktree path.");

    const beforeSha = await worker.git.assertBranchPublished(worktreePath, branchName);
    worker.log("info", "pre-pr-verification:agent-start", {
      runId: run.id,
      branchName,
      worktree: worktreePath,
      commitSha: beforeSha,
    });
    const result = await worker.agent.execute({
      issue,
      runId: run.id,
      branchName,
      baseBranch: worker.config.git.baseBranch,
      cwd: worktreePath,
      previousPlan,
      specPath,
      verificationPass: true,
    });
    worker.throwIfStopping();
    if (result.result.blockers.length) {
      throw new Error(`Pre-PR verification could not complete autonomously: ${result.result.blockers.join("; ")}`);
    }

    const commitSha = await worker.git.assertBranchPublished(worktreePath, branchName);
    if (specPath !== "specification unavailable") await worker.git.assertFileCommitted(worktreePath, specPath);
    const plan = {
      ...normalizePlan(result.result.plan),
      files: await worker.git.changedFiles(worktreePath),
    };
    worker.db.updateRun(run.id, { plan_json: JSON.stringify(plan), commit_sha: commitSha });
    worker.db.finishStage(
      run.id,
      STAGES.PRE_PR_VERIFICATION,
      attempt,
      { ...result.result, commitSha, changed: commitSha !== beforeSha },
      StageRunStatus.Completed,
    );
    worker.db.updateRun(run.id, {
      stage: STAGES.PULL_REQUEST,
      status: RUN_STATUSES.ACTIVE,
      commit_sha: commitSha,
      last_error: null,
      next_attempt_at: null,
    });
    worker.log("info", "pre-pr-verification:complete", {
      runId: run.id,
      issueKey: run.issue_key,
      beforeSha,
      commitSha,
      changed: commitSha !== beforeSha,
      tests: result.result.tests.length,
      nextStage: STAGES.PULL_REQUEST,
    });
    return { stage: STAGES.PRE_PR_VERIFICATION, commitSha, changed: commitSha !== beforeSha };
  } catch (error) {
    return worker.failStage(run, STAGES.PRE_PR_VERIFICATION, attempt, error);
  }
}
