import { JiraErrorCode } from "../model/jira.js";
import { STAGES } from "../types.js";

export function due(value: string | null | undefined): boolean {
  return !value || new Date(value).getTime() <= Date.now();
}

export function isJiraIssueMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: string; status?: number };
  return candidate.code === JiraErrorCode.IssueNotFound || candidate.status === 404;
}

export function nextRetryAt(backoffMs: number, attempts: number): string {
  return new Date(Date.now() + backoffMs * (2 ** Math.max(0, attempts - 1))).toISOString();
}

export function leaseOwnerProcessId(owner: string | null | undefined): number | null {
  const match = /^factory-(\d+)(?:-|$)/.exec(String(owner || ""));
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but cannot be inspected. Treat it as
    // alive; only an explicit missing-process result is reclaimable.
    return error?.code === "EPERM";
  }
}

export function resumableStage(stage: string | null): boolean {
  return stage === STAGES.IMPLEMENTATION || stage === STAGES.CODE_REVIEW || stage === STAGES.PULL_REQUEST;
}
