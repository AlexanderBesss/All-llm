import crypto from "node:crypto";
import path from "node:path";
import { adfToText } from "./jira.mjs";
import { abortError, isAbortError } from "./git.mjs";
import { formatFactoryLog, makeRunId, makeRunMarker, nowIso, RUN_STATUSES, STAGES, sanitizeBranchPart } from "./types.mjs";

function hashInput(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function due(value) {
  return !value || new Date(value).getTime() <= Date.now();
}

function isJiraIssueMissing(error) {
  return error?.code === "JIRA_ISSUE_NOT_FOUND" || error?.status === 404;
}

function nextRetryAt(backoffMs, attempts) {
  return new Date(Date.now() + backoffMs * (2 ** Math.max(0, attempts - 1))).toISOString();
}

async function sleep(ms, signal) {
  if (signal?.aborted) throw abortError("Factory shutdown requested.");
  await new Promise((resolve, reject) => {
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

function normalizedText(value) {
  return adfToText(value).replace(/\s+/g, " ").trim();
}

function subtaskSummaryIdentity(value) {
  return normalizedText(value)
    .replace(/^(?:[A-Z][A-Z0-9]+-\d+)\s*[-–—:]\s*/i, "")
    .replace(/\s+(?:[-–—:]\s*)?(?:\(|\[)?[A-Z][A-Z0-9]+-\d+(?:\)|\])?\s*$/i, "")
    .trim()
    .toLocaleLowerCase();
}

function matchesSubtask(expected, issue, marker) {
  const fields = issue.fields || {};
  const summaryMatches = subtaskSummaryIdentity(fields.summary) === subtaskSummaryIdentity(expected.summary);
  const description = normalizedText(fields.description);
  return summaryMatches
    && description.includes(normalizedText(marker));
}

function missingSubtasks(planned, found, marker) {
  return planned.filter((expected) => !found.some((issue) => matchesSubtask(expected, issue, marker)));
}

function normalizePlan(plan) {
  if (!plan || typeof plan !== "object") throw new Error("Planner result must be an object.");
  if (!Array.isArray(plan.subtasks)) throw new Error("Planner result must include a subtasks array.");
  const directImplementation = typeof plan.directImplementation === "boolean"
    ? plan.directImplementation
    : plan.subtasks.length === 0;
  if (directImplementation && plan.subtasks.length > 0) {
    throw new Error("Planner marked the ticket for direct implementation but also returned subtasks.");
  }
  return { ...plan, directImplementation };
}

export class FactoryWorker {
  constructor({ config, db, jira, github, git, agent, logger = console, signal }) {
    this.config = config;
    this.db = db;
    this.jira = jira;
    this.github = github;
    this.git = git;
    this.agent = agent;
    this.logger = logger;
    this.signal = signal;
    this.leaseOwner = `factory-${process.pid}`;
  }

  throwIfStopping() {
    if (this.signal?.aborted) throw abortError("Factory shutdown requested.");
  }

  log(level, event, details = undefined) {
    const suffix = details && Object.keys(details).length ? ` ${JSON.stringify(details)}` : "";
    this.logger[level]?.(formatFactoryLog(`${event}${suffix}`));
  }

  runResult(action, run, issueKey) {
    const effectiveAction = run?.status === RUN_STATUSES.RETRY_WAIT
      ? "retry_scheduled"
      : run?.status === RUN_STATUSES.BLOCKED
        ? "blocked"
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

  async runOnce({ dryRun = false } = {}) {
    this.throwIfStopping();
    this.log("info", "poll:start", { dryRun });
    this.db.reapExpiredLeases();
    const resumable = this.db.listRuns(50).find((run) =>
      (run.status === RUN_STATUSES.RETRY_WAIT && due(run.next_attempt_at))
      || (run.status === RUN_STATUSES.ACTIVE
        && (!run.lease_owner || run.lease_owner === this.leaseOwner)
        && run.stage !== STAGES.REVIEW
        && run.stage !== STAGES.BLOCKED));
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
        return { action: "cancelled", runId: resumable.id, issueKey: resumable.issue_key, reason: "Jira issue no longer exists." };
      }
      if (!this.db.acquireLease(
        resumable.id,
        this.leaseOwner,
        new Date(Date.now() + this.config.leaseMs).toISOString(),
      )) {
        this.log("info", "run:busy", { runId: resumable.id });
        return { action: "busy", runId: resumable.id };
      }
      const leased = this.db.getRun(resumable.id);
      this.log("info", "run:resume", { runId: leased.id, stage: leased.stage });
      await this.advanceRun(leased, { dryRun });
      return this.runResult("resumed", this.db.getRun(leased.id), leased.issue_key);
    }

    if (!this.jira.enabled()) {
      this.log("warn", "jira:disabled", { reason: "Jira adapter is not configured." });
      return { action: "disabled", reason: "Jira adapter is not configured." };
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
        stage: STAGES.PLANNING,
        leaseOwner: this.leaseOwner,
        leaseUntil,
      });
      if (!claimed.claimed) {
        this.log("info", "issue:claim-skipped", { issueKey, runId });
        continue;
      }
      this.log("info", "issue:claimed", { issueKey, runId, stage: STAGES.PLANNING, dryRun });
      if (!dryRun) await this.transitionIfNeeded(issueKey, this.config.jira.statuses.planning);
      await this.advanceRun(claimed.run, { dryRun });
      return this.runResult("claimed", this.db.getRun(runId), issueKey);
    }
    this.log("info", "poll:idle");
    return { action: "idle" };
  }

  async advanceRun(run, { dryRun = false } = {}) {
    let current = run;
    for (let step = 0; step < 3; step += 1) {
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
      this.db.recordEvent(run.id, "run_cancelled", {
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
    if (run.stage === STAGES.PLANNING) return this.processPlanning(run, { dryRun });
    if (run.stage === STAGES.IMPLEMENTATION) return this.processImplementation(run, { dryRun });
    if (run.stage === STAGES.PULL_REQUEST) return this.processPullRequest(run, { dryRun });
    return { stage: run.stage, status: run.status };
  }

  async processPlanning(run, { dryRun }) {
    this.throwIfStopping();
    const marker = makeRunMarker(run.id);
    this.log("info", "planning:start", { runId: run.id, issueKey: run.issue_key, dryRun });
    const issue = await this.jira.getIssue(run.issue_key);
    this.throwIfStopping();
    this.log("info", "planning:issue-loaded", {
      runId: run.id,
      issueKey: run.issue_key,
      status: issue.fields?.status?.name || "",
      summary: normalizedText(issue.fields?.summary || "").slice(0, 160),
    });
    const attempt = this.db.startStage(run.id, STAGES.PLANNING, hashInput({ issue, marker }));
    this.log("info", "planning:attempt", { runId: run.id, attempt, marker });
    try {
      let plan;
      let raw = null;
      if (run.plan_json) {
        plan = JSON.parse(run.plan_json);
        this.log("info", "planning:reuse-plan", { runId: run.id, subtasks: plan.subtasks?.length || 0 });
      } else {
        if (dryRun) {
          plan = {
            summary: "Dry-run planning result",
            acceptanceCriteria: ["Planning agent is configured and can produce structured output."],
            risks: [],
            files: [],
            tests: [],
            directImplementation: false,
            subtasks: [{ summary: "Validate factory configuration", description: `${marker}\nValidate the factory configuration.`, dependsOn: [], files: [], tests: [] }],
          };
          this.log("info", "planning:dry-run-plan", { runId: run.id, subtasks: plan.subtasks.length });
        } else {
          this.log("info", "planning:agent-start", { runId: run.id });
          ({ result: plan, raw } = await this.agent.plan({ issue, runId: run.id, marker }));
          this.throwIfStopping();
          this.log("info", "planning:agent-complete", {
            runId: run.id,
            summary: normalizedText(plan.summary || "").slice(0, 160),
            subtasks: plan.subtasks?.length || 0,
            acceptanceCriteria: plan.acceptanceCriteria?.length || 0,
          });
        }
      }
      plan = normalizePlan(plan);
      this.db.updateRun(run.id, {
        plan_json: JSON.stringify(plan),
        issue_json: JSON.stringify(issue),
        lease_until: new Date(Date.now() + this.config.leaseMs).toISOString(),
      });
      this.log("info", "planning:plan-persisted", {
        runId: run.id,
        subtasks: plan.subtasks.length,
        directImplementation: plan.directImplementation,
      });
      const subtasks = dryRun || plan.directImplementation
        ? []
        : await this.reconcileSubtasks(run.issue_key, marker, plan.subtasks);
      if (!dryRun && plan.directImplementation) {
        this.log("info", "planning:subtasks-skipped", {
          runId: run.id,
          issueKey: run.issue_key,
          reason: "trivial-ticket",
        });
      }
      this.log("info", "planning:subtasks-reconciled", {
        runId: run.id,
        expected: plan.subtasks.length,
        found: subtasks.length,
      });
      if (!dryRun && subtasks.length < plan.subtasks.length) {
        throw new Error(`Planning agent created ${subtasks.length}/${plan.subtasks.length} expected Jira subtasks for ${run.issue_key}.`);
      }
      if (!dryRun) {
        const missing = missingSubtasks(plan.subtasks, subtasks, marker);
        if (missing.length) {
          throw new Error(`Jira subtasks did not match the plan identity for ${run.issue_key}: ${missing.map((item) => item.summary).join(", ")}.`);
        }
      }
      this.db.finishStage(run.id, STAGES.PLANNING, attempt, { plan, agent: raw }, "completed");
      this.db.updateRun(run.id, {
        stage: STAGES.IMPLEMENTATION,
        status: RUN_STATUSES.ACTIVE,
        lease_until: new Date(Date.now() + this.config.leaseMs).toISOString(),
        last_error: null,
        next_attempt_at: null,
      });
      this.log("info", "planning:complete", {
        runId: run.id,
        issueKey: run.issue_key,
        nextStage: STAGES.IMPLEMENTATION,
        subtasks: plan.subtasks.length,
      });
      return { stage: STAGES.PLANNING, plan };
    } catch (error) {
      return this.failStage(run, STAGES.PLANNING, attempt, error);
    }
  }

  async reconcileSubtasks(parentKey, marker, expectedSubtasks) {
    let found = [];
    const maxChecks = Math.max(1, this.config.maxAttempts || 1);
    for (let attempt = 0; attempt < maxChecks; attempt += 1) {
      this.throwIfStopping();
      this.log("info", "planning:subtasks-check", {
        parentKey,
        attempt: attempt + 1,
        expected: expectedSubtasks.length,
      });
      found = await this.jira.findRunSubtasks(parentKey, marker);
      this.log("info", "planning:subtasks-found", {
        parentKey,
        attempt: attempt + 1,
        found: found.length,
      });
      if (found.length >= expectedSubtasks.length && missingSubtasks(expectedSubtasks, found, marker).length === 0) return found;
      if (attempt + 1 < maxChecks) {
        this.log("info", "planning:subtasks-wait", { parentKey, delayMs: 1_000 });
        await sleep(1_000, this.signal);
      }
    }
    return found;
  }

  async processImplementation(run, { dryRun }) {
    this.throwIfStopping();
    const issue = JSON.parse(run.issue_json);
    const plan = JSON.parse(run.plan_json);
    const branchName = run.branch_name || `${this.config.factory.branchPrefix}/${sanitizeBranchPart(run.issue_key)}`;
    const worktreePath = run.worktree_path || path.join(this.config.stateDir, "worktrees", run.id);
    this.log("info", "implementation:start", {
      runId: run.id,
      issueKey: run.issue_key,
      branchName,
      worktreePath,
      subtasks: plan.subtasks?.length || 0,
      dryRun,
    });
    const attempt = this.db.startStage(run.id, STAGES.IMPLEMENTATION, hashInput({ issue, plan, branchName }));
    this.log("info", "implementation:attempt", { runId: run.id, attempt });
    try {
      if (dryRun) {
        this.log("info", "implementation:dry-run", { runId: run.id, branchName });
        this.db.finishStage(run.id, STAGES.IMPLEMENTATION, attempt, { dryRun: true, branchName }, "completed");
        this.db.updateRun(run.id, { stage: STAGES.PULL_REQUEST, branch_name: branchName, worktree_path: worktreePath });
        return { stage: STAGES.IMPLEMENTATION, dryRun: true };
      }
      await this.transitionIfNeeded(run.issue_key, this.config.jira.statuses.implementation);
      this.log("info", "implementation:status-ready", {
        runId: run.id,
        issueKey: run.issue_key,
        status: this.config.jira.statuses.implementation,
      });
      await this.transitionSubtasksToImplementation(run, plan);
      this.log("info", "implementation:worktree-preparing", { runId: run.id, branchName });
      const worktree = await this.git.prepareWorktree(run.id, branchName);
      this.log("info", "implementation:worktree-ready", { runId: run.id, worktree });
      this.db.updateRun(run.id, { branch_name: branchName, worktree_path: worktree });
      this.log("info", "implementation:agent-start", { runId: run.id, branchName, worktree });
      const result = await this.agent.implement({ issue, plan, runId: run.id, branchName, cwd: worktree });
      this.throwIfStopping();
      this.log("info", "implementation:agent-complete", {
        runId: run.id,
        committed: result.result?.committed === true,
        pushed: result.result?.pushed === true,
        tests: result.result?.tests?.length || 0,
        subtasks: result.result?.subtasks?.length || 0,
        blockers: result.result?.blockers?.length || 0,
      });
      const commitSha = await this.git.headSha(worktree);
      this.log("info", "implementation:head", { runId: run.id, commitSha });
      if (!result.result?.committed || !result.result?.pushed) {
        throw new Error("Implementation agent did not confirm both commit and push.");
      }
      this.db.finishStage(run.id, STAGES.IMPLEMENTATION, attempt, { ...result.result, commitSha }, "completed");
      this.db.updateRun(run.id, {
        stage: STAGES.PULL_REQUEST,
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
        nextStage: STAGES.PULL_REQUEST,
      });
      return { stage: STAGES.IMPLEMENTATION, commitSha };
    } catch (error) {
      return this.failStage(run, STAGES.IMPLEMENTATION, attempt, error);
    }
  }

  async transitionSubtasksToImplementation(run, plan) {
    const expectedSubtasks = plan.subtasks || [];
    if (expectedSubtasks.length === 0) {
      this.log("info", "implementation:subtasks-none", { runId: run.id, issueKey: run.issue_key });
      return;
    }

    const marker = makeRunMarker(run.id);
    this.log("info", "implementation:subtasks-loading", {
      runId: run.id,
      issueKey: run.issue_key,
      expected: expectedSubtasks.length,
    });
    const found = await this.jira.findRunSubtasks(run.issue_key, marker);
    const missing = missingSubtasks(expectedSubtasks, found, marker);
    if (missing.length) {
      throw new Error(`Cannot start implementation because Jira subtasks are missing for ${run.issue_key}: ${missing.map((item) => item.summary).join(", ")}.`);
    }

    for (const expected of expectedSubtasks) {
      this.throwIfStopping();
      const subtask = found.find((issue) => matchesSubtask(expected, issue, marker));
      this.log("info", "implementation:subtask-status-check", {
        runId: run.id,
        parentKey: run.issue_key,
        subtaskKey: subtask.key,
        summary: normalizedText(expected.summary),
        targetStatus: this.config.jira.statuses.implementation,
      });
      await this.transitionIfNeeded(subtask.key, this.config.jira.statuses.implementation);
      this.log("info", "implementation:subtask-status-ready", {
        runId: run.id,
        parentKey: run.issue_key,
        subtaskKey: subtask.key,
        status: this.config.jira.statuses.implementation,
      });
    }
  }

  async processPullRequest(run, { dryRun }) {
    this.throwIfStopping();
    const issue = JSON.parse(run.issue_json);
    const plan = JSON.parse(run.plan_json);
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
      if (!dryRun) this.log("info", "pull-request:creating", { runId: run.id, branchName });
      const pr = dryRun
        ? { number: 0, html_url: "dry-run", head: { ref: branchName } }
        : await this.github.createPullRequest({
          title: `[${run.issue_key}] ${plan.summary || issue.fields?.summary || "Factory change"}`,
          body: `${makeRunMarker(run.id)}\n\nJira: ${run.issue_key}\n\n${plan.summary || ""}\n\nAcceptance criteria:\n${(plan.acceptanceCriteria || []).map((item) => `- ${item}`).join("\n")}`,
          head: branchName,
          base: this.config.git.baseBranch,
        });
      this.throwIfStopping();
      this.log("info", "pull-request:created", {
        runId: run.id,
        number: pr?.number,
        url: pr?.html_url,
        dryRun,
      });
      if (!dryRun) {
        if (!pr?.html_url) throw new Error("GitHub did not return a pull-request URL.");
        this.log("info", "pull-request:jira-comment", { runId: run.id, issueKey: run.issue_key });
        await this.jira.addComment(run.issue_key, `${makeRunMarker(run.id)}\nPull request created: ${pr.html_url}`);
        await this.transitionIfNeeded(run.issue_key, this.config.jira.statuses.review);
      }
      this.db.finishStage(run.id, STAGES.PULL_REQUEST, attempt, pr, "completed");
      this.db.recordArtifact(run.id, "pull_request", `${this.config.github.repositoryFullName}:${branchName}`, pr.html_url || "dry-run");
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
    this.db.finishStage(run.id, stage, attempt, null, "failed", message.slice(0, 10_000));
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
    await this.jira.transition(issueKey, statusName);
    this.log("info", "jira:status-changed", { issueKey, status: statusName });
  }
}

export async function runLoop(worker, { signal = worker.signal, pollIntervalMs = 60_000 } = {}) {
  let stopped = false;
  const stop = () => {
    if (!stopped) worker.log?.("info", "loop:shutdown-requested");
    stopped = true;
  };
  signal?.addEventListener("abort", stop, { once: true });
  worker.log?.("info", "loop:started", { pollIntervalMs });
  while (!stopped) {
    try {
      const result = await worker.runOnce();
      worker.logger.info?.(formatFactoryLog(JSON.stringify(result)));
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) {
        stop();
        break;
      }
      worker.logger.error?.(formatFactoryLog(`poll failed: ${error.stack || error.message || error}`));
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
  worker.log?.("info", "loop:stopped");
}
