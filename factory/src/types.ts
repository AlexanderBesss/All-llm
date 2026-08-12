export const STAGES = Object.freeze({
  PLANNING: "planning",
  IMPLEMENTATION: "implementation",
  PULL_REQUEST: "pull_request",
  REVIEW: "review",
  BLOCKED: "blocked",
});

export const RUN_STATUSES = Object.freeze({
  ACTIVE: "active",
  RETRY_WAIT: "retry_wait",
  AWAITING_REVIEW: "awaiting_review",
  BLOCKED: "blocked",
  CANCELLED: "cancelled",
});

export const TERMINAL_STAGES = new Set([STAGES.REVIEW, STAGES.BLOCKED]);

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
