import crypto from "node:crypto";
import { abortError } from "./git.js";
import { formatFactoryLog, makeRunId, RUN_STATUSES, STAGES, EventType, RunAction } from "./types.js";
import type { FactoryRun } from "./model/database.js";
import type { FactoryConfig } from "./model/config.js";
import type { CodexAgent } from "./model/codex.js";
import type { GitAdapterLike } from "./model/git.js";
import type { GitHubAdapter } from "./model/github.js";
import type { JiraAdapter } from "./model/jira.js";
import type { FactoryLogger, FactoryRunResult, FactoryWorkerOptions } from "./model/worker.js";
import { due, isJiraIssueMissing, leaseOwnerProcessId, processIsAlive, resumableStage } from "./worker/state.js";
import { normalizePlan } from "./worker/format.js";
import { processImplementation, processPrePrVerification, processPullRequest } from "./worker/stages.js";
import { failStage, transitionIfNeeded } from "./worker/failure.js";
import { checkMergedPullRequests } from "./worker/merge-check.js";

export class FactoryWorker {
  config: FactoryConfig;
  db: FactoryWorkerOptions["db"];
  jira: JiraAdapter;
  github: GitHubAdapter;
  git: GitAdapterLike;
  agent: CodexAgent;
  logger: FactoryLogger;
  signal?: AbortSignal;
  leaseOwner: string;
  loopLabel?: string;

  constructor({ config, db, jira, github, git, agent, logger = console, signal }: FactoryWorkerOptions) {
    this.config = config;
    this.db = db;
    this.jira = jira;
    this.github = github;
    this.git = git;
    this.agent = agent;
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
    if (run.stage === STAGES.PRE_PR_VERIFICATION || run.stage === STAGES.CODE_REVIEW) {
      return this.processPrePrVerification(run, { dryRun });
    }
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

  async processImplementation(run, options) {
    return processImplementation(this, run, options);
  }

  async processPrePrVerification(run, options) {
    return processPrePrVerification(this, run, options);
  }

  async processPullRequest(run, options) {
    return processPullRequest(this, run, options);
  }

  async checkMergedPullRequests(): Promise<{ closed: number }> {
    return checkMergedPullRequests(this);
  }

  async failStage(run, stage, attempt, error) {
    return failStage(this, run, stage, attempt, error);
  }

  async transitionIfNeeded(issueKey, statusName, options = {}) {
    return transitionIfNeeded(this, issueKey, statusName, options);
  }
}

export { pullRequestDescription } from "./worker/format.js";
export { runLoop, runMergeCheckLoop } from "./worker/loops.js";
