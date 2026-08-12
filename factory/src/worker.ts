import crypto from "node:crypto";
import path from "node:path";
import { abortError, isAbortError } from "./git.js";
import { adfToText } from "./jira.js";
import { buildPullRequestTitle } from "./pull-request-title.js";
import { ensureSpecFile } from "./spec.js";
import { formatFactoryLog, makeRunId, makeRunMarker, nowIso, RUN_STATUSES, STAGES, sanitizeBranchPart, StageRunStatus, ArtifactKind, EventType, RunAction } from "./types.js";
import type { PullRequest } from "./model/github.js";
import type { FactoryRun } from "./model/database.js";
import type { FactoryConfig } from "./model/config.js";
import { ReviewVerdict } from "./model/codex.js";
import type { CodexAgent, ImplementationPlan } from "./model/codex.js";
import type { GitAdapterLike } from "./model/git.js";
import type { GitHubAdapter } from "./model/github.js";
import { JiraErrorCode } from "./model/jira.js";
import type { JiraAdapter, JiraIssue } from "./model/jira.js";
import type { FactoryLogger, FactoryRunResult, FactoryWorkerOptions } from "./model/worker.js";

function jiraText(value: unknown, property: "name" | "key" | "summary" = "name"): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const direct = record[property];
  if (typeof direct === "string") return direct;
  if (direct && typeof direct === "object") return jiraText(direct, property);
  if (property !== "name" && typeof record.name === "string") return record.name;
  if (property !== "key" && typeof record.key === "string") return record.key;
  return "";
}

function hashInput(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function due(value: string | null | undefined): boolean {
  return !value || new Date(value).getTime() <= Date.now();
}

function isJiraIssueMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: string; status?: number };
  return candidate.code === JiraErrorCode.IssueNotFound || candidate.status === 404;
}

function nextRetryAt(backoffMs: number, attempts: number): string {
  return new Date(Date.now() + backoffMs * (2 ** Math.max(0, attempts - 1))).toISOString();
}

function leaseOwnerProcessId(owner: string | null | undefined): number | null {
  const match = /^factory-(\d+)(?:-|$)/.exec(String(owner || ""));
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but cannot be inspected. Treat it as
    // alive; only an explicit missing-process result is reclaimable.
    return error?.code === "EPERM";
  }
}

function resumableStage(stage: string | null): boolean {
  return stage === STAGES.IMPLEMENTATION || stage === STAGES.CODE_REVIEW || stage === STAGES.PULL_REQUEST;
}

async function sleep(ms, signal) {
  if (signal?.aborted) throw abortError("Factory shutdown requested.");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError("Factory shutdown requested."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizePlan(plan: unknown): ImplementationPlan {
  if (!plan || typeof plan !== "object") throw new Error("Planner result must be an object.");
  const candidate = plan as Partial<ImplementationPlan>;
  if (typeof candidate.summary !== "string" || !candidate.summary.trim()) throw new Error("Implementation plan must include a summary.");
  if (!Array.isArray(candidate.acceptanceCriteria) || candidate.acceptanceCriteria.length === 0) {
    throw new Error("Implementation plan must include acceptanceCriteria.");
  }
  return {
    summary: candidate.summary,
    acceptanceCriteria: candidate.acceptanceCriteria.map(String),
    risks: Array.isArray(candidate.risks) ? candidate.risks.map(String) : [],
    files: Array.isArray(candidate.files) ? candidate.files.map(String) : [],
    tests: Array.isArray(candidate.tests) ? candidate.tests.map(String) : [],
  };
}

function quotedDescription(description: unknown): string {
  return adfToText(description)
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

function planDescription(originalDescription: unknown, plan: ImplementationPlan, marker: string, specPath = ""): string {
  return [
    quotedDescription(originalDescription),
    "",
    marker,
    "",
    ...(specPath ? ["## Specification", `- \`${specPath}\` (committed on the factory branch)`, ""] : []),
    "## Implementation plan",
    plan.summary,
    "",
    "## Acceptance criteria",
    ...plan.acceptanceCriteria.map((item) => `- ${item}`),
    "",
    "## Affected files",
    ...(plan.files.length ? plan.files.map((item) => `- ${item}`) : ["- To be confirmed during implementation"]),
    "",
    "## Tests",
    ...(plan.tests.length ? plan.tests.map((item) => `- ${item}`) : ["- Appropriate repository validation"]),
  ].join("\n");
}

export function pullRequestDescription({ runId, issueKey, plan, specPath = "" }: {
  runId: string;
  issueKey: string;
  plan: ImplementationPlan;
  specPath?: string;
}): string {
  const implementationAreas = plan.files.length
    ? plan.files.map((item) => `- ${item}`)
    : ["- See the committed diff for the implementation areas."];
  const validationChecks = plan.tests.length
    ? plan.tests.map((item) => `- ${item}`)
    : ["- Relevant repository tests and validation checks."];
  return [
    makeRunMarker(runId),
    "",
    "## Intent",
    plan.summary.trim(),
    "",
    "## What this changes",
    "This pull request implements the requested behavior for Jira issue " + `\`${issueKey}\`.`,
    "",
    "### Implementation areas",
    ...implementationAreas,
    "",
    "## Acceptance criteria",
    ...plan.acceptanceCriteria.map((item) => `- ${item}`),
    "",
    "## Validation",
    "The implementation agent was asked to run:",
    ...validationChecks,
    "",
    "## References",
    `- Jira issue: \`${issueKey}\``,
    ...(specPath ? [`- Factory specification: \`${specPath}\``] : []),
  ].join("\n");
}

export class FactoryWorker {
  config: FactoryConfig;
  db: FactoryWorkerOptions["db"];
  jira: JiraAdapter;
  github: GitHubAdapter;
  git: GitAdapterLike;
  agent: CodexAgent;
  reviewer: FactoryWorkerOptions["reviewer"];
  logger: FactoryLogger;
  signal?: AbortSignal;
  leaseOwner: string;
  loopLabel?: string;

  constructor({ config, db, jira, github, git, agent, reviewer, logger = console, signal }: FactoryWorkerOptions) {
    this.config = config;
    this.db = db;
    this.jira = jira;
    this.github = github;
    this.git = git;
    this.agent = agent;
    this.reviewer = reviewer;
    this.logger = logger;
    this.signal = signal;
    // Include a per-process nonce so a restarted worker never looks like the
    // previous worker merely because the operating system reused its PID.
    this.leaseOwner = `factory-${process.pid}-${crypto.randomUUID()}`;
  }

  throwIfStopping() {
    if (this.signal?.aborted) throw abortError("Factory shutdown requested.");
  }

  log(level: keyof FactoryLogger, event: string, details?: Record<string, unknown>) {
    const prefix = this.loopLabel ? `[${this.loopLabel}] ` : "";
    const suffix = details && Object.keys(details).length ? ` ${JSON.stringify(details)}` : "";
    this.logger[level]?.(formatFactoryLog(`${prefix}${event}${suffix}`));
  }

  runResult(action: string, run: FactoryRun | null, issueKey?: string): FactoryRunResult {
    const effectiveAction = run?.status === RUN_STATUSES.RETRY_WAIT
      ? RunAction.RetryScheduled
      : run?.status === RUN_STATUSES.BLOCKED
        ? RunAction.Blocked
        : action;
    return {
      action: effectiveAction,
      runId: run?.id,
      issueKey: run?.issue_key || issueKey,
      status: run?.status,
      stage: run?.stage,
      ...(run?.next_attempt_at ? { nextAttemptAt: run.next_attempt_at } : {}),
    };
  }

  async runOnce({ dryRun = false }: { dryRun?: boolean } = {}): Promise<FactoryRunResult> {
    this.throwIfStopping();
    this.log("info", "poll:start", { dryRun });
    const deadOwners = this.db.listRuns(50)
      .map((run) => run.lease_owner)
      .filter((owner): owner is string => {
        const pid = leaseOwnerProcessId(owner);
        return pid !== null && owner !== this.leaseOwner && !processIsAlive(pid);
      });
    const reclaimed = this.db.reapLeasesForOwners(deadOwners);
    if (reclaimed) {
      this.log("info", "run:dead-lease-reclaimed", { count: reclaimed });
    }
    this.db.reapExpiredLeases();
    const resumable = this.db.listRuns(50).find((run) =>
      (run.status === RUN_STATUSES.RETRY_WAIT && due(run.next_attempt_at))
      || (run.status === RUN_STATUSES.ACTIVE
        && (!run.lease_owner || run.lease_owner === this.leaseOwner)
        && run.stage !== STAGES.REVIEW
        && run.stage !== STAGES.BLOCKED)
      || (this.config.continueFailedTasks === true
        && run.status === RUN_STATUSES.BLOCKED
        && run.stage === STAGES.BLOCKED
        && resumableStage(this.db.getLastFailedStage(run.id))));
    if (resumable) {
      this.throwIfStopping();
      this.log("info", "run:resume-found", {
        runId: resumable.id,
        issueKey: resumable.issue_key,
        stage: resumable.stage,
        status: resumable.status,
      });
      const issue = await this.verifyResumableIssue(resumable);
      if (!issue) {
        return { action: RunAction.Cancelled, runId: resumable.id, issueKey: resumable.issue_key, reason: "Jira issue no longer exists." };
      }
      if (!this.db.acquireLease(
        resumable.id,
        this.leaseOwner,
        new Date(Date.now() + this.config.leaseMs).toISOString(),
      )) {
        this.log("info", "run:busy", { runId: resumable.id });
        return { action: RunAction.Busy, runId: resumable.id };
      }
      let leased = this.db.getRun(resumable.id);
      if (leased.status === RUN_STATUSES.BLOCKED) {
        const failedStage = this.db.getLastFailedStage(leased.id);
        if (!resumableStage(failedStage)) {
          this.db.updateRun(leased.id, { lease_owner: null, lease_until: null });
          this.log("warn", "run:resume-skipped", {
            runId: leased.id,
            issueKey: leased.issue_key,
            reason: "No supported failed stage was recorded.",
          });
            return { action: RunAction.Idle };
        }
        try {
          await this.transitionIfNeeded(leased.issue_key, this.config.jira.statuses.implementation);
        } catch (error) {
          this.db.updateRun(leased.id, { lease_owner: null, lease_until: null });
          throw error;
        }
        leased = this.db.updateRun(leased.id, {
          status: RUN_STATUSES.ACTIVE,
          stage: failedStage,
          next_attempt_at: null,
          last_error: null,
        });
        this.log("info", "run:failed-task-continued", {
          runId: leased.id,
          issueKey: leased.issue_key,
          stage: failedStage,
          jiraStatus: this.config.jira.statuses.implementation,
        });
      }
      this.log("info", "run:resume", { runId: leased.id, stage: leased.stage });
      await this.advanceRun(leased, { dryRun });
      return this.runResult(RunAction.Resumed, this.db.getRun(leased.id), leased.issue_key);
    }

    if (!this.jira.enabled()) {
      this.log("warn", "jira:disabled", { reason: "Jira adapter is not configured." });
      return { action: RunAction.Disabled, reason: "Jira adapter is not configured." };
    }
    this.throwIfStopping();
    const issues = await this.jira.searchReady();
    this.log("info", "jira:ready-issues", {
      count: issues.length,
      issueKeys: issues.slice(0, 20).map((issue) => issue.key),
    });
    for (const issue of issues) {
      this.throwIfStopping();
      const issueKey = issue.key;
      if (this.db.getActiveRunForIssue(issueKey)) {
        this.log("info", "issue:skip-active", { issueKey });
        continue;
      }
      const runId = makeRunId(issueKey);
      const leaseUntil = new Date(Date.now() + this.config.leaseMs).toISOString();
      const claimed = this.db.claimRun({
        id: runId,
        issueKey,
        projectKey: issue.fields?.project?.key || this.config.jira.projectKey,
        issue,
        stage: STAGES.IMPLEMENTATION,
        leaseOwner: this.leaseOwner,
        leaseUntil,
      });
      if (!claimed.claimed) {
        this.log("info", "issue:claim-skipped", { issueKey, runId });
        continue;
      }
      this.log("info", "issue:claimed", { issueKey, runId, stage: STAGES.IMPLEMENTATION, dryRun });
      await this.advanceRun(claimed.run, { dryRun });
      return this.runResult(RunAction.Claimed, this.db.getRun(runId), issueKey);
    }
    this.log("info", "poll:idle");
    return { action: RunAction.Idle };
  }

  async advanceRun(run, { dryRun = false } = {}) {
    let current = run;
    for (let step = 0; step < 4; step += 1) {
      this.throwIfStopping();
      if (!current || current.status === RUN_STATUSES.CANCELLED || current.stage === STAGES.REVIEW || current.stage === STAGES.BLOCKED) return current;
      this.log("info", "run:stage", {
        runId: current.id,
        issueKey: current.issue_key,
        stage: current.stage,
        status: current.status,
        step: step + 1,
        dryRun,
      });
      await this.processRun(current, { dryRun });
      current = this.db.getRun(current.id);
      if (!current || current.status !== RUN_STATUSES.ACTIVE) return current;
    }
    return current;
  }

  async verifyResumableIssue(run) {
    this.throwIfStopping();
    try {
      const issue = await this.jira.getIssue(run.issue_key);
      this.log("info", "run:resume-issue-found", {
        runId: run.id,
        issueKey: run.issue_key,
        status: issue.fields?.status?.name || "",
      });
      return issue;
    } catch (error) {
      if (!isJiraIssueMissing(error)) throw error;
      const message = `Jira issue ${run.issue_key} no longer exists; cancelling persisted factory run ${run.id}.`;
      this.db.updateRun(run.id, {
        status: RUN_STATUSES.CANCELLED,
        last_error: message,
        lease_owner: null,
        lease_until: null,
        next_attempt_at: null,
      });
      this.db.recordEvent(run.id, EventType.RunCancelled, {
        reason: "jira_issue_missing",
        issueKey: run.issue_key,
        message,
      });
      this.log("warn", "run:cancelled-missing-jira", {
        runId: run.id,
        issueKey: run.issue_key,
        stage: run.stage,
        reason: message,
      });
      return null;
    }
  }

  async processRun(run, { dryRun = false } = {}) {
    if (run.stage === STAGES.PLANNING) return this.migrateLegacyPlanning(run);
    if (run.stage === STAGES.IMPLEMENTATION) return this.processImplementation(run, { dryRun });
    if (run.stage === STAGES.CODE_REVIEW) return this.processCodeReview(run, { dryRun });
    if (run.stage === STAGES.PULL_REQUEST) return this.processPullRequest(run, { dryRun });
    return { stage: run.stage, status: run.status };
  }

  async migrateLegacyPlanning(run) {
    const plan = run.plan_json ? normalizePlan(JSON.parse(run.plan_json)) : null;
    this.log("info", "planning:legacy-migrated", {
      runId: run.id,
      issueKey: run.issue_key,
      hadPersistedPlan: Boolean(plan),
      subtasksIgnored: true,
    });
    this.db.updateRun(run.id, {
      stage: STAGES.IMPLEMENTATION,
      status: RUN_STATUSES.ACTIVE,
      ...(plan ? { plan_json: JSON.stringify(plan) } : {}),
      next_attempt_at: null,
      lease_until: new Date(Date.now() + this.config.leaseMs).toISOString(),
    });
    return { stage: STAGES.PLANNING, nextStage: STAGES.IMPLEMENTATION };
  }

  async processImplementation(run, { dryRun }) {
    this.throwIfStopping();
      const issue = JSON.parse(run.issue_json) as JiraIssue;
    const branchName = run.branch_name || `${this.config.factory.branchPrefix}/${sanitizeBranchPart(run.issue_key)}`;
    const worktreePath = run.worktree_path || path.join(this.config.stateDir, "worktrees", run.id);
    this.log("info", "implementation:start", {
      runId: run.id,
      issueKey: run.issue_key,
      branchName,
      worktreePath,
      dryRun,
    });
    const previousPlan = run.plan_json ? normalizePlan(JSON.parse(run.plan_json)) : null;
    const attempt = this.db.startStage(run.id, STAGES.IMPLEMENTATION, hashInput({ issue, previousPlan, branchName }));
    this.log("info", "implementation:attempt", { runId: run.id, attempt });
    try {
      if (dryRun) {
        this.log("info", "implementation:dry-run", { runId: run.id, branchName });
        const plan = previousPlan || normalizePlan({
          summary: "Dry-run factory execution",
          acceptanceCriteria: ["The factory can execute one parent task without creating subtasks."],
          risks: [],
          files: [],
          tests: [],
        });
        this.db.updateRun(run.id, { plan_json: JSON.stringify(plan), issue_json: JSON.stringify(issue) });
        this.db.finishStage(run.id, STAGES.IMPLEMENTATION, attempt, { dryRun: true, branchName }, StageRunStatus.Completed);
        this.db.updateRun(run.id, { stage: STAGES.CODE_REVIEW, branch_name: branchName, worktree_path: worktreePath });
        return { stage: STAGES.IMPLEMENTATION, dryRun: true };
      }
      await this.transitionIfNeeded(run.issue_key, this.config.jira.statuses.implementation);
      this.log("info", "implementation:status-ready", {
        runId: run.id,
        issueKey: run.issue_key,
        status: this.config.jira.statuses.implementation,
      });
      this.log("info", "implementation:worktree-preparing", { runId: run.id, branchName });
      const worktree = await this.git.prepareWorktree(run.id, branchName);
      this.log("info", "implementation:worktree-ready", { runId: run.id, worktree });
      this.db.updateRun(run.id, { branch_name: branchName, worktree_path: worktree });
      const spec = await ensureSpecFile({
        cwd: worktree,
        issue,
        runId: run.id,
        branchName,
        generatedAt: run.created_at || nowIso(),
      });
      this.db.recordArtifact(run.id, ArtifactKind.Spec, branchName, spec.relativePath);
      this.log("info", "implementation:spec-ready", {
        runId: run.id,
        branchName,
        specPath: spec.relativePath,
        created: spec.created,
      });
      this.log("info", "implementation:agent-start", { runId: run.id, branchName, worktree });
      const result = await this.agent.execute({
        issue,
        runId: run.id,
        branchName,
        cwd: worktree,
        previousPlan,
        specPath: spec.relativePath,
      });
      this.throwIfStopping();
      const plan = normalizePlan(result.result?.plan);
      this.log("info", "implementation:agent-complete", {
        runId: run.id,
        committed: result.result?.committed === true,
        pushed: result.result?.pushed === true,
        tests: result.result?.tests?.length || 0,
        blockers: result.result?.blockers?.length || 0,
      });
      const commitSha = await this.git.headSha(worktree);
      this.log("info", "implementation:head", { runId: run.id, commitSha });
      if (!result.result?.committed || !result.result?.pushed) {
        throw new Error("Implementation agent did not confirm both commit and push.");
      }
      if (typeof this.git.assertFileCommitted === "function") {
        await this.git.assertFileCommitted(worktree, spec.relativePath);
      }
      this.log("info", "implementation:plan-persisting", { runId: run.id });
      this.db.updateRun(run.id, {
        plan_json: JSON.stringify(plan),
        issue_json: JSON.stringify(issue),
        lease_until: new Date(Date.now() + this.config.leaseMs).toISOString(),
      });
      this.log("info", "implementation:parent-description", { runId: run.id, issueKey: run.issue_key });
      await this.jira.updateDescription(run.issue_key, planDescription(
        issue.fields?.description,
        plan,
        makeRunMarker(run.id),
        spec.relativePath,
      ));
      this.db.finishStage(run.id, STAGES.IMPLEMENTATION, attempt, { ...result.result, commitSha }, StageRunStatus.Completed);
      this.db.updateRun(run.id, {
        stage: STAGES.CODE_REVIEW,
        status: RUN_STATUSES.ACTIVE,
        branch_name: branchName,
        worktree_path: worktree,
        commit_sha: commitSha,
        last_error: null,
        next_attempt_at: null,
      });
      this.log("info", "implementation:complete", {
        runId: run.id,
        issueKey: run.issue_key,
        commitSha,
        branchName,
        nextStage: STAGES.CODE_REVIEW,
      });
      return { stage: STAGES.IMPLEMENTATION, commitSha };
    } catch (error) {
      return this.failStage(run, STAGES.IMPLEMENTATION, attempt, error);
    }
  }

  async processCodeReview(run, { dryRun }) {
    this.throwIfStopping();
    const issue = JSON.parse(run.issue_json) as JiraIssue;
    const plan = normalizePlan(JSON.parse(run.plan_json));
    const branchName = run.branch_name;
    const worktreePath = run.worktree_path;
    const specPath = this.db.findArtifact(ArtifactKind.Spec, branchName)?.artifact_value || "specification unavailable";
    const attempt = this.db.startStage(run.id, STAGES.CODE_REVIEW, hashInput({
      issue,
      plan,
      branchName,
      commit: run.commit_sha,
    }));
    this.log("info", "code-review:start", {
      runId: run.id,
      issueKey: run.issue_key,
      branchName,
      worktreePath,
      commitSha: run.commit_sha,
      dryRun,
    });
    try {
      if (dryRun) {
        this.db.finishStage(run.id, STAGES.CODE_REVIEW, attempt, { dryRun: true }, StageRunStatus.Completed);
        this.db.updateRun(run.id, { stage: STAGES.PULL_REQUEST });
        return { stage: STAGES.CODE_REVIEW, dryRun: true };
      }
      if (!worktreePath) throw new Error("Code review requires the implementation worktree path.");
      const beforeSha = run.commit_sha || await this.git.headSha(worktreePath);
      this.log("info", "code-review:agent-start", { runId: run.id, branchName, worktree: worktreePath });
      const result = await this.reviewer.review({
        issue,
        runId: run.id,
        branchName,
        baseBranch: this.config.git.baseBranch,
        cwd: worktreePath,
        specPath,
        plan,
        commitSha: beforeSha,
      });
      this.throwIfStopping();
      const review = result.result;
      const afterSha = await this.git.headSha(worktreePath);
      const changed = review.changed || afterSha !== beforeSha;
      this.log("info", "code-review:agent-complete", {
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
      if (typeof this.git.hasChanges === "function" && await this.git.hasChanges(worktreePath)) {
        throw new Error("Code review completed with uncommitted worktree changes.");
      }
      if (typeof this.git.assertFileCommitted === "function" && specPath !== "specification unavailable") {
        await this.git.assertFileCommitted(worktreePath, specPath);
      }
      this.db.finishStage(run.id, STAGES.CODE_REVIEW, attempt, { ...review, commitSha: afterSha }, StageRunStatus.Completed);
      this.db.updateRun(run.id, {
        stage: STAGES.PULL_REQUEST,
        status: RUN_STATUSES.ACTIVE,
        commit_sha: afterSha,
        last_error: null,
        next_attempt_at: null,
      });
      this.log("info", "code-review:complete", {
        runId: run.id,
        issueKey: run.issue_key,
        commitSha: afterSha,
        nextStage: STAGES.PULL_REQUEST,
      });
      return { stage: STAGES.CODE_REVIEW, commitSha: afterSha, changed };
    } catch (error) {
      return this.failStage(run, STAGES.CODE_REVIEW, attempt, error);
    }
  }

  async processPullRequest(run, { dryRun }) {
    this.throwIfStopping();
    const issue = JSON.parse(run.issue_json);
    const plan = normalizePlan(JSON.parse(run.plan_json));
    const branchName = run.branch_name;
    this.log("info", "pull-request:start", {
      runId: run.id,
      issueKey: run.issue_key,
      branchName,
      baseBranch: this.config.git.baseBranch,
      dryRun,
    });
    const attempt = this.db.startStage(run.id, STAGES.PULL_REQUEST, hashInput({ branchName, commit: run.commit_sha }));
    this.log("info", "pull-request:attempt", { runId: run.id, attempt });
    try {
      const taskNumber = run.issue_key;
      // A run may persist an older MCP response where fields such as
      // issuetype.name were themselves Jira objects. Normalize again at the
      // stage boundary so resumed runs do not turn them into [object Object].
      const taskName = jiraText(issue.fields?.summary, "summary");
      const taskType = jiraText(issue.fields?.issuetype);
      const title = buildPullRequestTitle({ taskNumber, taskName, taskType });
      const specPath = this.db.findArtifact(ArtifactKind.Spec, branchName)?.artifact_value || "";
      const persistedPr = !dryRun && run.pr_number && run.pr_url
        ? { number: run.pr_number, html_url: run.pr_url, head: { ref: branchName } }
        : null;
      if (persistedPr) {
        this.log("info", "pull-request:recovered", {
          runId: run.id,
          number: persistedPr.number,
          url: persistedPr.html_url,
        });
      } else if (!dryRun) {
        this.log("info", "pull-request:creating", { runId: run.id, branchName });
      }
      const pr = dryRun
        ? { number: 0, html_url: "dry-run", head: { ref: branchName } }
        : persistedPr || await this.github.createPullRequest({
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
            base: this.config.git.baseBranch,
          });
      this.log("info", "pull-request:created", {
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
        this.db.updateRun(run.id, {
          pr_number: pr.number || null,
          pr_url: pr.html_url,
          lease_until: new Date(Date.now() + this.config.leaseMs).toISOString(),
        });
        this.db.recordArtifact(run.id, ArtifactKind.PullRequest, `${this.config.github.repositoryFullName}:${branchName}`, pr.html_url);
        this.throwIfStopping();
        this.log("info", "pull-request:jira-comment", { runId: run.id, issueKey: run.issue_key });
        await this.jira.addComment(run.issue_key, `${makeRunMarker(run.id)}\nPull request created: ${pr.html_url}`);
        await this.transitionIfNeeded(run.issue_key, this.config.jira.statuses.review);
      } else {
        this.throwIfStopping();
      }
      this.db.finishStage(run.id, STAGES.PULL_REQUEST, attempt, pr, StageRunStatus.Completed);
      this.db.recordArtifact(run.id, ArtifactKind.PullRequest, `${this.config.github.repositoryFullName}:${branchName}`, pr.html_url || "dry-run");
      this.db.updateRun(run.id, {
        stage: STAGES.REVIEW,
        status: RUN_STATUSES.AWAITING_REVIEW,
        pr_number: pr.number || null,
        pr_url: pr.html_url || null,
        lease_owner: null,
        lease_until: null,
        last_error: null,
      });
      this.log("info", "pull-request:complete", {
        runId: run.id,
        issueKey: run.issue_key,
        url: pr.html_url,
        nextStage: STAGES.REVIEW,
      });
      return { stage: STAGES.REVIEW, pr };
    } catch (error) {
      return this.failStage(run, STAGES.PULL_REQUEST, attempt, error);
    }
  }

  async checkMergedPullRequests(): Promise<{ closed: number }> {
    this.throwIfStopping();
    this.log("info", "merge-check:start");
    const runs = this.db.getAwaitingReviewRuns(50);
    this.log("info", "merge-check:pending", { count: runs.length });
    let closed = 0;
    for (const run of runs) {
      this.throwIfStopping();
      try {
        const pr = await this.github.getPullRequest(run.pr_number);
        if (!pr) {
          this.log("warn", "merge-check:pr-not-found", {
            runId: run.id,
            issueKey: run.issue_key,
            prNumber: run.pr_number,
          });
          continue;
        }
        if (pr.number !== run.pr_number) {
          this.log("warn", "merge-check:pr-mismatch", {
            runId: run.id,
            expected: run.pr_number,
            found: pr.number,
          });
          continue;
        }
        if (!pr.merged) {
          this.log("info", "merge-check:not-merged", {
            runId: run.id,
            issueKey: run.issue_key,
            prNumber: pr.number,
          });
          continue;
        }
        this.log("info", "merge-check:merged", {
          runId: run.id,
          issueKey: run.issue_key,
          prNumber: pr.number,
          prUrl: pr.html_url,
          mergedAt: pr.mergedAt,
        });
        try {
          await this.transitionIfNeeded(run.issue_key, this.config.jira.statuses.done);
        } catch (error) {
          this.log("error", "merge-check:transition-failed", {
            runId: run.id,
            issueKey: run.issue_key,
            error: error?.message || String(error),
          });
          continue;
        }
        this.log("info", "merge-check:task-closed", {
          runId: run.id,
          issueKey: run.issue_key,
          prNumber: pr.number,
        });
        try {
          await this.jira.addComment(run.issue_key, `${makeRunMarker(run.id)}\nTask auto-closed: pull request #${pr.number} was merged (${pr.html_url}).`);
        } catch (error) {
          this.log("warn", "merge-check:comment-failed", {
            runId: run.id,
            issueKey: run.issue_key,
            error: error?.message || String(error),
          });
        }
        this.db.updateRun(run.id, {
          status: RUN_STATUSES.COMPLETED,
          last_error: null,
        });
        closed += 1;
      } catch (error) {
        this.log("error", "merge-check:error", {
          runId: run.id,
          issueKey: run.issue_key,
          prNumber: run.pr_number,
          error: error?.message || String(error),
        });
      }
    }
    this.log("info", "merge-check:complete", { closed });
    return { closed };
  }

  async failStage(run, stage, attempt, error) {
    if (isAbortError(error) || this.signal?.aborted) {
      this.log("warn", "stage:cancelled", { runId: run.id, issueKey: run.issue_key, stage });
      throw error;
    }
    const message = error?.stack || error?.message || String(error);
    const attempts = this.db.countStageAttempts(run.id, stage);
    this.log("error", "stage:failed", {
      runId: run.id,
      issueKey: run.issue_key,
      stage,
      attempt,
      attempts,
      error: error?.message || String(error),
    });
    this.db.finishStage(run.id, stage, attempt, null, StageRunStatus.Failed, message.slice(0, 10_000));
    if (attempts >= this.config.maxAttempts) {
      this.db.updateRun(run.id, {
        stage: STAGES.BLOCKED,
        status: RUN_STATUSES.BLOCKED,
        attempts,
        last_error: message.slice(0, 10_000),
        lease_owner: null,
        lease_until: null,
        next_attempt_at: null,
      });
      this.log("error", "run:blocked", {
        runId: run.id,
        issueKey: run.issue_key,
        stage,
        attempts,
      });
      const reportErrors = [];
      this.log("info", "blocked:jira-report", { runId: run.id, issueKey: run.issue_key });
      try {
        await this.jira.addComment(run.issue_key, `${makeRunMarker(run.id)}\nFactory blocked after ${attempts} attempts in ${stage}.\n\n${message}`);
      } catch (reportError) {
        reportErrors.push(`comment: ${reportError?.stack || reportError?.message || String(reportError)}`);
      }
      try {
        await this.transitionIfNeeded(run.issue_key, this.config.jira.statuses.error);
      } catch (reportError) {
        reportErrors.push(`transition to ${this.config.jira.statuses.error}: ${reportError?.stack || reportError?.message || String(reportError)}`);
      }
      if (reportErrors.length) {
        const diagnostic = `${message}\n\nTerminal Jira reporting failures:\n${reportErrors.map((item) => `- ${item}`).join("\n")}`;
        this.db.updateRun(run.id, { last_error: diagnostic.slice(0, 10_000) });
        this.log("error", "blocked:jira-report-failed", {
          runId: run.id,
          issueKey: run.issue_key,
          errors: reportErrors,
        });
      }
      return { stage, status: RUN_STATUSES.BLOCKED, error: message };
    }
    const retryAt = nextRetryAt(this.config.retryBackoffMs, attempts);
    this.db.updateRun(run.id, {
      status: RUN_STATUSES.RETRY_WAIT,
      attempts,
      next_attempt_at: retryAt,
      last_error: message.slice(0, 10_000),
      lease_owner: null,
      lease_until: null,
    });
    this.log("warn", "run:retry-scheduled", {
      runId: run.id,
      issueKey: run.issue_key,
      stage,
      attempts,
      retryAt,
      error: error?.message || String(error),
    });
    return { stage, status: RUN_STATUSES.RETRY_WAIT, retryAt, error: message };
  }

  async transitionIfNeeded(issueKey, statusName) {
    this.throwIfStopping();
    this.log("info", "jira:status-check", { issueKey, targetStatus: statusName });
    const issue = await this.jira.getIssue(issueKey);
    const currentStatus = issue.fields?.status?.name || "";
    if (String(currentStatus).toLowerCase() === String(statusName).toLowerCase()) {
      this.log("info", "jira:status-unchanged", { issueKey, status: currentStatus });
      return;
    }
    this.log("info", "jira:status-changing", { issueKey, from: currentStatus, to: statusName });
    try {
      await this.jira.transition(issueKey, statusName);
    } catch (error) {
      // A Jira transition can succeed while the agent exhausts its final
      // response step. Confirm the authoritative issue state before treating
      // that ambiguous mutation as a failure.
      const observed = await this.jira.getIssue(issueKey);
      const observedStatus = observed.fields?.status?.name || "";
      if (String(observedStatus).toLowerCase() !== String(statusName).toLowerCase()) throw error;
      this.log("warn", "jira:status-confirmed-after-error", {
        issueKey,
        status: observedStatus,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    this.log("info", "jira:status-changed", { issueKey, status: statusName });
  }
}

export async function runLoop(worker, { signal = worker.signal, pollIntervalMs = 60_000 } = {}) {
  const label = "poll";
  let stopped = false;
  const stop = () => {
    if (!stopped) worker.log?.("info", "loop:shutdown-requested");
    stopped = true;
  };
  signal?.addEventListener("abort", stop, { once: true });
  worker.log?.("info", `${label}:loop:started`, { pollIntervalMs });
  while (!stopped) {
    try {
      const result = await worker.runOnce();
      worker.logger.info?.(formatFactoryLog(JSON.stringify({ ...result, loop: label })));
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) {
        stop();
        break;
      }
      worker.logger.error?.(formatFactoryLog(`[${label}] poll failed: ${error.stack || error.message || error}`));
    }
    if (!stopped) {
      try {
        await sleep(pollIntervalMs, signal);
      } catch (error) {
        if (isAbortError(error)) {
          stop();
          break;
        }
        throw error;
      }
    }
  }
  signal?.removeEventListener("abort", stop);
  worker.log?.("info", `${label}:loop:stopped`);
}

export async function runMergeCheckLoop(worker, { signal = worker.signal, intervalMs = 300_000 } = {}) {
  const label = "merge-check";
  let stopped = false;
  const stop = () => {
    if (!stopped) worker.log?.("info", "merge-check-loop:shutdown-requested");
    stopped = true;
  };
  signal?.addEventListener("abort", stop, { once: true });
  worker.log?.("info", `${label}:loop:started`, { intervalMs });
  while (!stopped) {
    try {
      const result = await worker.checkMergedPullRequests();
      worker.logger.info?.(formatFactoryLog(JSON.stringify({ ...result, loop: label })));
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) {
        stop();
        break;
      }
      worker.logger.error?.(formatFactoryLog(`[${label}] merge-check failed: ${error.stack || error.message || error}`));
    }
    if (!stopped) {
      try {
        await sleep(intervalMs, signal);
      } catch (error) {
        if (isAbortError(error)) {
          stop();
          break;
        }
        throw error;
      }
    }
  }
  signal?.removeEventListener("abort", stop);
  worker.log?.("info", `${label}:loop:stopped`);
}
