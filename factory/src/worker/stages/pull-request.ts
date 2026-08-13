import { buildPullRequestTitle } from "../../pull-request-title.js";
import { makeRunMarker, RUN_STATUSES, STAGES, StageRunStatus, ArtifactKind } from "../../types.js";
import type { FactoryRun } from "../../model/database.js";
import type { JiraIssue } from "../../model/jira.js";
import type { FactoryWorker } from "../../worker.js";
import { hashInput, jiraText, normalizePlan, pullRequestDescription } from "../format.js";

export async function processPullRequest(worker: FactoryWorker, run: FactoryRun, { dryRun }: { dryRun: boolean }) {
  worker.throwIfStopping();
  const issue = JSON.parse(run.issue_json) as JiraIssue;
  const plan = normalizePlan(JSON.parse(run.plan_json || "null"));
  const branchName = run.branch_name;
  worker.log("info", "pull-request:start", {
    runId: run.id,
    issueKey: run.issue_key,
    branchName,
    baseBranch: worker.config.git.baseBranch,
    dryRun,
  });
  const attempt = worker.db.startStage(run.id, STAGES.PULL_REQUEST, hashInput({ branchName, commit: run.commit_sha }));
  worker.log("info", "pull-request:attempt", { runId: run.id, attempt });
  try {
    const taskNumber = run.issue_key;
    // A run may persist an older MCP response where fields such as
    // issuetype.name were themselves Jira objects. Normalize again at the
    // stage boundary so resumed runs do not turn them into [object Object].
    const taskName = jiraText(issue.fields?.summary, "summary");
    const taskType = jiraText(issue.fields?.issuetype);
    const title = buildPullRequestTitle({ taskNumber, taskName, taskType });
    const specPath = worker.db.findArtifact(ArtifactKind.Spec, branchName)?.artifact_value || "";
    const persistedPr = !dryRun && run.pr_number && run.pr_url
      ? { number: run.pr_number, html_url: run.pr_url, head: { ref: branchName } }
      : null;
    if (persistedPr) {
      worker.log("info", "pull-request:recovered", {
        runId: run.id,
        number: persistedPr.number,
        url: persistedPr.html_url,
      });
    } else if (!dryRun) {
      worker.log("info", "pull-request:creating", { runId: run.id, branchName });
    }
    const pr = dryRun
      ? { number: 0, html_url: "dry-run", head: { ref: branchName } }
      : persistedPr || await worker.github.createPullRequest({
          title,
          taskNumber,
          taskName,
          taskType,
          body: pullRequestDescription({
            runId: run.id,
            issueKey: run.issue_key,
            plan,
            specPath,
          }),
          head: branchName,
          base: worker.config.git.baseBranch,
        });
    worker.log("info", "pull-request:created", {
      runId: run.id,
      number: pr?.number,
      url: pr?.html_url,
      dryRun,
    });
    if (!dryRun) {
      if (!pr?.html_url) throw new Error("GitHub did not return a pull-request URL.");
      // Checkpoint the remote PR before Jira reporting. If the worker is
      // interrupted after GitHub succeeds, the next attempt can resume
      // reporting without recreating the PR.
      worker.db.updateRun(run.id, {
        pr_number: pr.number || null,
        pr_url: pr.html_url,
        lease_until: new Date(Date.now() + worker.config.leaseMs).toISOString(),
      });
      worker.db.recordArtifact(run.id, ArtifactKind.PullRequest, `${worker.config.github.repositoryFullName}:${branchName}`, pr.html_url);
      worker.throwIfStopping();
      worker.log("info", "pull-request:jira-comment", { runId: run.id, issueKey: run.issue_key });
      await worker.jira.addComment(run.issue_key, `${makeRunMarker(run.id)}\nPull request created: ${pr.html_url}`);
      await worker.transitionIfNeeded(run.issue_key, worker.config.jira.statuses.review);
    } else {
      worker.throwIfStopping();
    }
    worker.db.finishStage(run.id, STAGES.PULL_REQUEST, attempt, pr, StageRunStatus.Completed);
    worker.db.recordArtifact(run.id, ArtifactKind.PullRequest, `${worker.config.github.repositoryFullName}:${branchName}`, pr.html_url || "dry-run");
    worker.db.updateRun(run.id, {
      stage: STAGES.REVIEW,
      status: RUN_STATUSES.AWAITING_REVIEW,
      pr_number: pr.number || null,
      pr_url: pr.html_url || null,
      lease_owner: null,
      lease_until: null,
      last_error: null,
    });
    worker.log("info", "pull-request:complete", {
      runId: run.id,
      issueKey: run.issue_key,
      url: pr.html_url,
      nextStage: STAGES.REVIEW,
    });
    return { stage: STAGES.REVIEW, pr };
  } catch (error) {
    return worker.failStage(run, STAGES.PULL_REQUEST, attempt, error);
  }
}
