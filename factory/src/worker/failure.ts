import { isAbortError } from "../git.js";
import { makeRunMarker, RUN_STATUSES, STAGES, StageRunStatus } from "../types.js";
import type { FactoryRun } from "../model/database.js";
import type { FactoryWorker } from "../worker.js";
import { nextRetryAt } from "./state.js";

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") return error.message;
  return String(error);
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message;
  return errorMessage(error);
}

export class JiraTransitionFailedError extends Error {
  issueKey: string;
  targetStatus: string;
  currentStatus: string;
  originalError: unknown;

  constructor(issueKey: string, targetStatus: string, currentStatus: string, originalError: unknown) {
    const observed = currentStatus || "unknown";
    const original = errorMessage(originalError);
    super(
      `Jira transition for ${issueKey} did not reach "${targetStatus}"; `
      + `the issue is still "${observed}". ${original}`,
      { cause: originalError },
    );
    this.name = "JiraTransitionFailedError";
    this.issueKey = issueKey;
    this.targetStatus = targetStatus;
    this.currentStatus = currentStatus;
    this.originalError = originalError;
  }
}

export async function failStage(worker: FactoryWorker, run: FactoryRun, stage: string, attempt: number, error: unknown) {
  if (isAbortError(error) || worker.signal?.aborted) {
    worker.log("warn", "stage:cancelled", { runId: run.id, issueKey: run.issue_key, stage });
    throw error;
  }
  const message = errorDetails(error);
  const attempts = worker.db.countStageAttempts(run.id, stage);
  worker.log("error", "stage:failed", {
    runId: run.id,
    issueKey: run.issue_key,
    stage,
    attempt,
    attempts,
    error: errorMessage(error),
  });
  worker.db.finishStage(run.id, stage, attempt, null, StageRunStatus.Failed, message.slice(0, 10_000));
  if (attempts >= worker.config.maxAttempts) {
    worker.db.updateRun(run.id, {
      stage: STAGES.BLOCKED,
      status: RUN_STATUSES.BLOCKED,
      attempts,
      last_error: message.slice(0, 10_000),
      lease_owner: null,
      lease_until: null,
      next_attempt_at: null,
    });
    worker.log("error", "run:blocked", {
      runId: run.id,
      issueKey: run.issue_key,
      stage,
      attempts,
    });
    const reportErrors: string[] = [];
    worker.log("info", "blocked:jira-report", { runId: run.id, issueKey: run.issue_key });
    try {
      await worker.jira.addComment(run.issue_key, `${makeRunMarker(run.id)}\nFactory blocked after ${attempts} attempts in ${stage}.\n\n${message}`);
    } catch (reportError) {
      reportErrors.push(`comment: ${errorDetails(reportError)}`);
    }
    try {
      await worker.transitionIfNeeded(run.issue_key, worker.config.jira.statuses.error);
    } catch (reportError) {
      reportErrors.push(`transition to ${worker.config.jira.statuses.error}: ${errorDetails(reportError)}`);
    }
    if (reportErrors.length) {
      const diagnostic = `${message}\n\nTerminal Jira reporting failures:\n${reportErrors.map((item) => `- ${item}`).join("\n")}`;
      worker.db.updateRun(run.id, { last_error: diagnostic.slice(0, 10_000) });
      worker.log("error", "blocked:jira-report-failed", {
        runId: run.id,
        issueKey: run.issue_key,
        errors: reportErrors,
      });
    }
    return { stage, status: RUN_STATUSES.BLOCKED, error: message };
  }
  const retryAt = nextRetryAt(worker.config.retryBackoffMs, attempts);
  worker.db.updateRun(run.id, {
    status: RUN_STATUSES.RETRY_WAIT,
    attempts,
    next_attempt_at: retryAt,
    last_error: message.slice(0, 10_000),
    lease_owner: null,
    lease_until: null,
  });
  worker.log("warn", "run:retry-scheduled", {
    runId: run.id,
    issueKey: run.issue_key,
    stage,
    attempts,
    retryAt,
    error: errorMessage(error),
  });
  return { stage, status: RUN_STATUSES.RETRY_WAIT, retryAt, error: message };
}

export async function transitionIfNeeded(worker: FactoryWorker, issueKey: string, statusName: string, { skipStatusCheck = false }: { skipStatusCheck?: boolean } = {}): Promise<void> {
  worker.throwIfStopping();
  let currentStatus = "";
  if (!skipStatusCheck) {
    worker.log("info", "jira:status-check", { issueKey, targetStatus: statusName });
    const issue = await worker.jira.getIssue(issueKey);
    currentStatus = issue.fields?.status?.name || "";
    if (String(currentStatus).toLowerCase() === String(statusName).toLowerCase()) {
      worker.log("info", "jira:status-unchanged", { issueKey, status: currentStatus });
      return;
    }
  } else {
    worker.log("info", "jira:status-check-skipped", { issueKey, targetStatus: statusName });
  }
  worker.log("info", "jira:status-changing", {
    issueKey,
    ...(currentStatus ? { from: currentStatus } : {}),
    to: statusName,
  });
  try {
    await worker.jira.transition(issueKey, statusName);
  } catch (error) {
    // A Jira transition can succeed while the agent exhausts its final
    // response step. Confirm the authoritative issue state before treating
    // that ambiguous mutation as a failure.
    const observed = await worker.jira.getIssue(issueKey);
    const observedStatus = observed.fields?.status?.name || "";
    if (String(observedStatus).toLowerCase() !== String(statusName).toLowerCase()) {
      throw new JiraTransitionFailedError(issueKey, statusName, observedStatus, error);
    }
    worker.log("warn", "jira:status-confirmed-after-error", {
      issueKey,
      status: observedStatus,
      error: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  worker.log("info", "jira:status-changed", { issueKey, status: statusName });
}
