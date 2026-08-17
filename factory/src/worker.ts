import crypto from "node:crypto";
import { abortError, isAbortError } from "./git.js";
import {
  formatFactoryLog,
  makeRunId,
  RUN_STATUSES,
  STAGES,
  EventType,
  RunAction,
  RunCancellationReason,
} from "./types.js";
import type { FactoryRun } from "./model/database.js";
import type { FactoryConfig } from "./model/config.js";
import type { CodexAgent } from "./model/codex.js";
import type { GitAdapterLike } from "./model/git.js";
import type { GitHubAdapter, PullRequest } from "./model/github.js";
import type { JiraAdapter } from "./model/jira.js";
import type { FactoryLogger, FactoryRunResult, FactoryWorkerOptions } from "./model/worker.js";
import { due, isJiraIssueMissing, leaseOwnerProcessId, processIsAlive, resumableStage } from "./worker/state.js";
import { normalizePlan } from "./worker/format.js";
import { processImplementation, processPullRequest } from "./worker/stages.js";
import { failStage, transitionIfNeeded } from "./worker/failure.js";
import { checkMergedPullRequests } from "./worker/merge-check.js";
import { fixPullRequestReviews } from "./worker/review-fix.js";
import { isRemovedReviewStage } from "./types.js";
import { currentFactoryLoop, isFactoryLogColorEnabled, writeFactoryLog } from "./logging.js";
import { planIssues, planNextIssue } from "./worker/planning.js";
import type { PlanningRunResult } from "./worker/planning.js";
import { normalizeConcurrency, runBounded } from "./worker/concurrency.js";
import type { BoundedBatchResult } from "./worker/concurrency.js";

type BeforeRunAdvance = (claimed: boolean) => Promise<void>;

interface RunOnceOptions {
  dryRun?: boolean;
  beforeAdvance?: BeforeRunAdvance;
  excludeRunIds?: ReadonlySet<string>;
}

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
  private readonly inFlightRunIds = new Set<string>();
  private readonly inFlightPlanningIssueKeys = new Set<string>();
  private readonly inFlightMergeCheckRunIds = new Set<string>();

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
    const suffix = details && Object.keys(details).length ? ` ${JSON.stringify(details)}` : "";
    const loop = this.loopLabel || currentFactoryLoop();
    writeFactoryLog(this.logger, level, formatFactoryLog(`${event}${suffix}`, Date.now(), {
      loop,
      colors: isFactoryLogColorEnabled(),
    }));
  }

  runResult(action: string, run: FactoryRun | null, issueKey?: string): FactoryRunResult {
    const effectiveAction = run?.status === RUN_STATUSES.COMPLETED
      ? RunAction.Completed
      : run?.status === RUN_STATUSES.CANCELLED
      ? RunAction.Cancelled
      : run?.status === RUN_STATUSES.RETRY_WAIT
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
      ...(run?.status === RUN_STATUSES.CANCELLED && run.last_error ? { reason: run.last_error } : {}),
    };
  }

  async runOnce({ dryRun = false, beforeAdvance, excludeRunIds = new Set<string>() }: RunOnceOptions = {}): Promise<FactoryRunResult> {
    this.throwIfStopping();
    this.log("info", "task:start", { dryRun });
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
      !this.inFlightRunIds.has(run.id)
      && !excludeRunIds.has(run.id)
      && ((run.status === RUN_STATUSES.RETRY_WAIT && due(run.next_attempt_at))
        || (run.status === RUN_STATUSES.ACTIVE
          && (!run.lease_owner || run.lease_owner === this.leaseOwner)
          && run.stage !== STAGES.REVIEW
          && run.stage !== STAGES.BLOCKED)
        || (this.config.continueFailedTasks === true
          && run.status === RUN_STATUSES.BLOCKED
          && run.stage === STAGES.BLOCKED
          && run.continuations < this.config.maxContinuations
          && resumableStage(this.db.getLastFailedStage(run.id)))));
    if (resumable) {
      this.inFlightRunIds.add(resumable.id);
      try {
        this.throwIfStopping();
        this.log("info", "run:resume-found", {
          runId: resumable.id,
          issueKey: resumable.issue_key,
          stage: resumable.stage,
          status: resumable.status,
        });
        if (!dryRun && resumable.pr_number && await this.closeResumableRunIfPullRequestMerged(resumable)) {
          await beforeAdvance?.(true);
          return this.runResult(RunAction.Completed, this.db.getRun(resumable.id), resumable.issue_key);
        }
        const issue = await this.verifyResumableIssue(resumable);
        if (!issue) {
          await beforeAdvance?.(false);
          const cancelled = this.db.getRun(resumable.id);
          return {
            action: RunAction.Cancelled,
            runId: resumable.id,
            issueKey: resumable.issue_key,
            status: cancelled?.status,
            stage: cancelled?.stage,
            reason: cancelled?.last_error || "Jira issue no longer exists.",
          };
        }
        if (!this.db.acquireLease(
          resumable.id,
          this.leaseOwner,
          new Date(Date.now() + this.config.leaseMs).toISOString(),
        )) {
          this.log("info", "run:busy", { runId: resumable.id });
          await beforeAdvance?.(false);
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
            await beforeAdvance?.(false);
            return { action: RunAction.Idle };
          }
          try {
            const currentIssue = await this.checkRunStatus(leased);
            if (!currentIssue) {
              await beforeAdvance?.(false);
              return this.runResult(RunAction.Cancelled, this.db.getRun(leased.id), leased.issue_key);
            }
            await this.transitionIfNeeded(leased.issue_key, this.config.jira.statuses.implementation);
          } catch (error) {
            this.db.updateRun(leased.id, { lease_owner: null, lease_until: null });
            throw error;
          }
          leased = this.db.updateRun(leased.id, {
            status: RUN_STATUSES.ACTIVE,
            stage: failedStage,
            continuations: leased.continuations + 1,
            next_attempt_at: null,
            last_error: null,
          });
          this.log("info", "run:failed-task-continued", {
            runId: leased.id,
            issueKey: leased.issue_key,
            stage: failedStage,
            continuation: leased.continuations,
            maxContinuations: this.config.maxContinuations,
            jiraStatus: this.config.jira.statuses.implementation,
          });
        }
        this.log("info", "run:resume", { runId: leased.id, stage: leased.stage });
        await beforeAdvance?.(true);
        await this.advanceRun(leased, { dryRun });
        return this.runResult(RunAction.Resumed, this.db.getRun(leased.id), leased.issue_key);
      } finally {
        if (this.signal?.aborted) {
          this.db.updateRun(resumable.id, { lease_owner: null, lease_until: null });
        }
        this.inFlightRunIds.delete(resumable.id);
      }
    }

    if (!this.jira.enabled()) {
      this.log("warn", "jira:disabled", { reason: "Jira adapter is not configured." });
      await beforeAdvance?.(false);
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
      this.inFlightRunIds.add(runId);
      try {
        await beforeAdvance?.(true);
        await this.advanceRun(claimed.run, { dryRun });
        return this.runResult(RunAction.Claimed, this.db.getRun(runId), issueKey);
      } finally {
        if (this.signal?.aborted) {
          this.db.updateRun(runId, { lease_owner: null, lease_until: null });
        }
        this.inFlightRunIds.delete(runId);
      }
    }
    await beforeAdvance?.(false);
    this.log("info", "task:idle");
    return { action: RunAction.Idle };
  }

  /**
   * Keep a bounded set of implementation lanes busy until the currently
   * available Ready queue is drained. The first claim in every lane passes a
   * barrier before advancing, so two available tickets are durably claimed
   * before either implementation begins. A lane that finishes early can then
   * claim another ticket without waiting for a slower sibling or the next
   * polling interval.
   */
  async runBatch({ dryRun = false, concurrency = this.config.implementationConcurrency }: { dryRun?: boolean; concurrency?: number } = {}): Promise<BoundedBatchResult<FactoryRunResult>> {
    const limit = normalizeConcurrency(concurrency);
    if (limit === 1) {
      return {
        concurrency: limit,
        completed: 1,
        failed: 0,
        results: [await this.runOnce({ dryRun })],
      };
    }

    let arrived = 0;
    let releaseGate!: () => void;
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
    const results: FactoryRunResult[] = [];
    const failures: unknown[] = [];
    const attemptedRunIds = new Set<string>();
    const slots = Array.from({ length: limit }, (_, index) => index);

    await runBounded(slots, limit, async () => {
      let joined = false;
      let handledRuns = 0;
      const joinClaimBarrier = () => {
        if (joined) return;
        joined = true;
        arrived += 1;
        if (arrived === limit) releaseGate();
      };
      try {
        while (true) {
          const result = await this.runOnce({
            dryRun,
            excludeRunIds: attemptedRunIds,
            ...(joined ? {} : {
              beforeAdvance: async () => {
                joinClaimBarrier();
                await gate;
              },
            }),
          });
          if (!result.runId) {
            // Preserve idle/disabled results for lanes that found no work so
            // the outer loop can still coalesce a completely idle poll.
            if (handledRuns === 0) results.push(result);
            break;
          }
          attemptedRunIds.add(result.runId);
          handledRuns += 1;
          results.push(result);
          this.log("info", "task:lane-available", {
            completedRunId: result.runId,
            issueKey: result.issueKey,
            action: result.action,
          });
        }
      } catch (error) {
        // A discovery or claim failure happens before runOnce can reach the
        // barrier. Count it as an arrived worker so siblings are not stranded.
        joinClaimBarrier();
        if (isAbortError(error) || this.signal?.aborted) throw error;
        failures.push(error);
        this.log("error", "task:item-failed", {
          error: error instanceof Error ? error.stack || error.message : String(error),
        });
      }
    }, this.signal);

    return {
      concurrency: limit,
      completed: results.length,
      failed: failures.length,
      results,
    };
  }

  async planNextIssue(options: { dryRun?: boolean } = {}) {
    return planNextIssue(this, options, this.inFlightPlanningIssueKeys);
  }

  async planBatch({ dryRun = false, concurrency = this.config.planningConcurrency }: { dryRun?: boolean; concurrency?: number } = {}): Promise<BoundedBatchResult<PlanningRunResult>> {
    return planIssues(this, { dryRun, concurrency }, this.inFlightPlanningIssueKeys);
  }

  async advanceRun(run, { dryRun = false } = {}) {
    let current = run;
    for (let step = 0; step < 4; step += 1) {
      this.throwIfStopping();
      if (!current || current.status === RUN_STATUSES.CANCELLED || current.stage === STAGES.REVIEW || current.stage === STAGES.BLOCKED) return current;
      const issue = await this.checkRunStatus(current);
      if (!issue) return this.db.getRun(current.id);
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

  async cancelRun(run: FactoryRun, reason: RunCancellationReason, message: string, details: Record<string, unknown> = {}) {
    this.db.updateRun(run.id, {
      status: RUN_STATUSES.CANCELLED,
      last_error: message,
      lease_owner: null,
      lease_until: null,
      next_attempt_at: null,
    });
    this.db.recordEvent(run.id, EventType.RunCancelled, {
      reason,
      issueKey: run.issue_key,
      message,
      ...details,
    });
    this.log("warn", reason === RunCancellationReason.JiraIssueDone ? "run:cancelled-done-jira" : "run:cancelled-missing-jira", {
      runId: run.id,
      issueKey: run.issue_key,
      stage: run.stage,
      reason: message,
      ...(reason === RunCancellationReason.JiraIssueDone ? { cancellationReason: reason } : {}),
      ...details,
    });
    return this.db.getRun(run.id);
  }

  async checkRunStatus(run: FactoryRun) {
    this.throwIfStopping();
    try {
      const issue = await this.jira.getIssue(run.issue_key);
      const observedStatus = String(issue.fields?.status?.name || "").trim();
      const configuredDoneStatus = String(this.config.jira.statuses.done || "").trim();
      this.log("info", "run:jira-status-checked", {
        runId: run.id,
        issueKey: run.issue_key,
        status: observedStatus,
        doneStatus: configuredDoneStatus,
      });
      if (configuredDoneStatus && observedStatus.toLowerCase() === configuredDoneStatus.toLowerCase()) {
        const message = `Jira issue ${run.issue_key} is in configured Done status "${configuredDoneStatus}"; cancelling factory run ${run.id}.`;
        await this.cancelRun(run, RunCancellationReason.JiraIssueDone, message, {
          doneStatus: configuredDoneStatus,
          observedStatus,
        });
        return null;
      }
      return issue;
    } catch (error) {
      if (!isJiraIssueMissing(error)) throw error;
      const message = `Jira issue ${run.issue_key} no longer exists; cancelling persisted factory run ${run.id}.`;
      await this.cancelRun(run, RunCancellationReason.JiraIssueMissing, message);
      return null;
    }
  }

  async completeMergedPullRequest(run: FactoryRun, pullRequest: PullRequest) {
    this.log("info", "merge-check:merged", {
      runId: run.id,
      issueKey: run.issue_key,
      prNumber: pullRequest.number,
      prUrl: pullRequest.html_url,
      mergedAt: pullRequest.mergedAt,
    });
    // The adapter reconciles an ambiguous mutation with one authoritative
    // read, so the normal path does not pay for a redundant status lookup.
    await this.transitionIfNeeded(run.issue_key, this.config.jira.statuses.done, { skipStatusCheck: true });
    this.db.updateRun(run.id, {
      status: RUN_STATUSES.COMPLETED,
      stage: STAGES.REVIEW,
      last_error: null,
      lease_owner: null,
      lease_until: null,
      next_attempt_at: null,
    });
    this.log("info", "merge-check:task-closed", {
      runId: run.id,
      issueKey: run.issue_key,
      prNumber: pullRequest.number,
    });
  }

  async closeResumableRunIfPullRequestMerged(run: FactoryRun): Promise<boolean> {
    if (!run.pr_number) return false;
    const pullRequest = await this.github.getPullRequest(run.pr_number);
    if (!pullRequest) {
      this.log("warn", "run:resume-pr-not-found", {
        runId: run.id,
        issueKey: run.issue_key,
        prNumber: run.pr_number,
      });
      return false;
    }
    if (pullRequest.number !== run.pr_number) {
      this.log("warn", "run:resume-pr-mismatch", {
        runId: run.id,
        issueKey: run.issue_key,
        expected: run.pr_number,
        found: pullRequest.number,
      });
      return false;
    }
    if (!pullRequest.merged) return false;
    await this.completeMergedPullRequest(run, pullRequest);
    return true;
  }

  async verifyResumableIssue(run) {
    const issue = await this.checkRunStatus(run);
    if (issue) {
      this.log("info", "run:resume-issue-found", {
        runId: run.id,
        issueKey: run.issue_key,
        status: issue.fields?.status?.name || "",
      });
    }
    return issue;
  }

  async processRun(run, { dryRun = false } = {}) {
    if (run.stage === STAGES.PLANNING) return this.migrateLegacyPlanning(run);
    if (run.stage === STAGES.IMPLEMENTATION) return this.processImplementation(run, { dryRun });
    if (isRemovedReviewStage(run.stage)) return this.migrateRemovedReviewStage(run);
    if (run.stage === STAGES.PULL_REQUEST) return this.processPullRequest(run, { dryRun });
    return { stage: run.stage, status: run.status };
  }

  async migrateRemovedReviewStage(run) {
    this.log("info", "review-stage:removed", {
      runId: run.id,
      issueKey: run.issue_key,
      previousStage: run.stage,
      nextStage: STAGES.PULL_REQUEST,
    });
    this.db.updateRun(run.id, {
      stage: STAGES.PULL_REQUEST,
      status: RUN_STATUSES.ACTIVE,
      last_error: null,
      next_attempt_at: null,
      lease_until: new Date(Date.now() + this.config.leaseMs).toISOString(),
    });
    return { stage: run.stage, nextStage: STAGES.PULL_REQUEST, skipped: true };
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

  async processPullRequest(run, options) {
    return processPullRequest(this, run, options);
  }

  async checkMergedPullRequests(concurrency = this.config.mergeCheckConcurrency): Promise<{ closed: number }> {
    return checkMergedPullRequests(this, concurrency, this.inFlightMergeCheckRunIds);
  }

  async fixPullRequestReviews(): Promise<{ pullRequests: number; addressed: number; disputed: number; failed: number }> {
    return fixPullRequestReviews(this);
  }

  async failStage(run, stage, attempt, error) {
    return failStage(this, run, stage, attempt, error);
  }

  async transitionIfNeeded(issueKey, statusName, options = {}) {
    return transitionIfNeeded(this, issueKey, statusName, options);
  }
}

export { implementationModel, pullRequestDescription } from "./worker/format.js";
export { runLoop, runMergeCheckLoop, runPlanningLoop, runReviewFixLoop } from "./worker/loops.js";
