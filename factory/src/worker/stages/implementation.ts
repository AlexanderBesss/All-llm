import path from "node:path";
import { ensureSpecFile } from "../../spec.js";
import { makeRunMarker, nowIso, RUN_STATUSES, STAGES, sanitizeBranchPart, StageRunStatus, ArtifactKind } from "../../types.js";
import type { FactoryRun } from "../../model/database.js";
import type { JiraIssue } from "../../model/jira.js";
import type { FactoryWorker } from "../../worker.js";
import { hashInput, normalizePlan, planDescription } from "../format.js";

export async function processImplementation(worker: FactoryWorker, run: FactoryRun, { dryRun }: { dryRun: boolean }) {
  worker.throwIfStopping();
  const issue = JSON.parse(run.issue_json) as JiraIssue;
  const branchName = run.branch_name || `${worker.config.factory.branchPrefix}/${sanitizeBranchPart(run.issue_key)}`;
  const worktreePath = run.worktree_path || path.join(worker.config.stateDir, "worktrees", run.id);
  worker.log("info", "implementation:start", {
    runId: run.id,
    issueKey: run.issue_key,
    branchName,
    worktreePath,
    dryRun,
  });
  const previousPlan = run.plan_json ? normalizePlan(JSON.parse(run.plan_json)) : null;
  const attempt = worker.db.startStage(run.id, STAGES.IMPLEMENTATION, hashInput({ issue, previousPlan, branchName }));
  worker.log("info", "implementation:attempt", { runId: run.id, attempt });
  try {
    if (dryRun) {
      worker.log("info", "implementation:dry-run", { runId: run.id, branchName });
      const plan = previousPlan || normalizePlan({
        summary: "Dry-run factory execution",
        acceptanceCriteria: ["The factory can execute one parent task without creating subtasks."],
        risks: [],
        files: [],
        tests: [],
      });
      worker.db.updateRun(run.id, { plan_json: JSON.stringify(plan), issue_json: JSON.stringify(issue) });
      worker.db.finishStage(run.id, STAGES.IMPLEMENTATION, attempt, { dryRun: true, branchName }, StageRunStatus.Completed);
      worker.db.updateRun(run.id, { stage: STAGES.PRE_PR_VERIFICATION, branch_name: branchName, worktree_path: worktreePath });
      return { stage: STAGES.IMPLEMENTATION, dryRun: true };
    }
    await worker.transitionIfNeeded(run.issue_key, worker.config.jira.statuses.implementation);
    worker.log("info", "implementation:status-ready", {
      runId: run.id,
      issueKey: run.issue_key,
      status: worker.config.jira.statuses.implementation,
    });
    worker.log("info", "implementation:worktree-preparing", { runId: run.id, branchName });
    const worktree = await worker.git.prepareWorktree(run.id, branchName);
    worker.log("info", "implementation:worktree-ready", { runId: run.id, worktree });
    worker.db.updateRun(run.id, { branch_name: branchName, worktree_path: worktree });
    const spec = await ensureSpecFile({
      cwd: worktree,
      issue,
      runId: run.id,
      branchName,
      generatedAt: run.created_at || nowIso(),
    });
    worker.db.recordArtifact(run.id, ArtifactKind.Spec, branchName, spec.relativePath);
    worker.log("info", "implementation:spec-ready", {
      runId: run.id,
      branchName,
      specPath: spec.relativePath,
      created: spec.created,
    });
    worker.log("info", "implementation:agent-start", { runId: run.id, branchName, worktree });
    const result = await worker.agent.execute({
      issue,
      runId: run.id,
      branchName,
      cwd: worktree,
      previousPlan,
      specPath: spec.relativePath,
    });
    worker.throwIfStopping();
    let plan = normalizePlan(result.result?.plan);
    worker.log("info", "implementation:agent-complete", {
      runId: run.id,
      committed: result.result?.committed === true,
      pushed: result.result?.pushed === true,
      tests: result.result?.tests?.length || 0,
      blockers: result.result?.blockers?.length || 0,
    });
    const commitSha = await worker.git.assertBranchPublished(worktree, branchName);
    worker.log("info", "implementation:head", { runId: run.id, commitSha });
    await worker.git.assertFileCommitted(worktree, spec.relativePath);
    plan = { ...plan, files: await worker.git.changedFiles(worktree) };
    worker.log("info", "implementation:plan-persisting", { runId: run.id });
    worker.db.updateRun(run.id, {
      plan_json: JSON.stringify(plan),
      issue_json: JSON.stringify(issue),
      lease_until: new Date(Date.now() + worker.config.leaseMs).toISOString(),
    });
    worker.log("info", "implementation:parent-description", { runId: run.id, issueKey: run.issue_key });
    await worker.jira.updateDescription(run.issue_key, planDescription(
      issue.fields?.description,
      plan,
      makeRunMarker(run.id),
      spec.relativePath,
    ));
    worker.db.finishStage(run.id, STAGES.IMPLEMENTATION, attempt, { ...result.result, commitSha }, StageRunStatus.Completed);
    worker.db.updateRun(run.id, {
      stage: STAGES.PRE_PR_VERIFICATION,
      status: RUN_STATUSES.ACTIVE,
      branch_name: branchName,
      worktree_path: worktree,
      commit_sha: commitSha,
      last_error: null,
      next_attempt_at: null,
    });
    worker.log("info", "implementation:complete", {
      runId: run.id,
      issueKey: run.issue_key,
      commitSha,
      branchName,
      nextStage: STAGES.PRE_PR_VERIFICATION,
    });
    return { stage: STAGES.IMPLEMENTATION, commitSha };
  } catch (error) {
    return worker.failStage(run, STAGES.IMPLEMENTATION, attempt, error);
  }
}
