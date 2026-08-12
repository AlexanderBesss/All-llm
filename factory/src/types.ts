export enum StageName {
  PLANNING = "planning",
  IMPLEMENTATION = "implementation",
  CODE_REVIEW = "code_review",
  PULL_REQUEST = "pull_request",
  REVIEW = "review",
  BLOCKED = "blocked",
}

export const STAGES = StageName;

export enum RunStatus {
  ACTIVE = "active",
  RETRY_WAIT = "retry_wait",
  AWAITING_REVIEW = "awaiting_review",
  BLOCKED = "blocked",
  CANCELLED = "cancelled",
}

export const RUN_STATUSES = RunStatus;

export const TERMINAL_STAGES = new Set([StageName.REVIEW, StageName.BLOCKED]);

export enum StageRunStatus {
  Running = "running",
  Completed = "completed",
  Failed = "failed",
}

export enum ArtifactKind {
  Spec = "spec",
  PullRequest = "pull_request",
}

export enum EventType {
  StageStarted = "stage_started",
  StageFinished = "stage_finished",
  RunCancelled = "run_cancelled",
}

export enum RunAction {
  RetryScheduled = "retry_scheduled",
  Blocked = "blocked",
  Cancelled = "cancelled",
  Busy = "busy",
  Idle = "idle",
  Resumed = "resumed",
  Disabled = "disabled",
  Claimed = "claimed",
}

export function nowIso() {
  return new Date().toISOString();
}

export function formatFactoryLog(message: string, timestamp = Date.now()) {
  return `[${new Date(timestamp).toISOString()}] [factory] ${message}`;
}

export function makeRunId(issueKey: string, clock = Date.now()) {
  const safeKey = String(issueKey).replace(/[^A-Za-z0-9_-]+/g, "-");
  return `${safeKey}-${clock.toString(36)}`;
}

export function makeRunMarker(runId: string) {
  return `[factory-run:${runId}]`;
}

export function sanitizeBranchPart(value: string) {
  const result = String(value)
    .trim()
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/^[-/.]+|[-/.]+$/g, "");
  return result || "work";
}

export function assertNonEmpty(value: unknown, name: string) {
  if (value == null || String(value).trim() === "") {
    throw new Error(`${name} is required.`);
  }
  return String(value).trim();
}
