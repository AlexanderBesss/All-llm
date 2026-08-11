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

export function makeRunId(issueKey, clock = Date.now()) {
  const safeKey = String(issueKey).replace(/[^A-Za-z0-9_-]+/g, "-");
  return `${safeKey}-${clock.toString(36)}`;
}

export function makeRunMarker(runId) {
  return `[factory-run:${runId}]`;
}

export function sanitizeBranchPart(value) {
  const result = String(value)
    .trim()
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/^[-/.]+|[-/.]+$/g, "");
  return result || "work";
}

export function assertNonEmpty(value, name) {
  if (value == null || String(value).trim() === "") {
    throw new Error(`${name} is required.`);
  }
  return String(value).trim();
}
