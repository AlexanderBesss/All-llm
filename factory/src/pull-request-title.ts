export const PULL_REQUEST_TASK_TYPES = Object.freeze(["Task", "feature", "bug fix"]);

const TASK_TYPE_ALIASES = new Map([
  ["task", "Task"],
  ["feature", "feature"],
  ["bug", "bug fix"],
  ["bug fix", "bug fix"],
  ["bug-fix", "bug fix"],
  ["bugfix", "bug fix"],
]);

function requiredText(value, name) {
  const text = String(value ?? "");
  if (!text.trim()) throw new Error(`${name} is required for a pull-request title.`);
  return text;
}

export function normalizePullRequestTaskType(value) {
  const normalized = String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const taskType = TASK_TYPE_ALIASES.get(normalized);
  if (!taskType) {
    throw new Error(
      `Unsupported Jira task type '${String(value ?? "")}'. Pull-request titles support only: ${PULL_REQUEST_TASK_TYPES.join(", ")}.`,
    );
  }
  return taskType;
}

export function buildPullRequestTitle({ taskNumber, taskName, taskType }) {
  const number = requiredText(taskNumber, "Jira task number");
  const name = requiredText(taskName, "Jira task name");
  const type = normalizePullRequestTaskType(taskType);
  return `[${number}] ${name} (${type})`;
}

export function assertPullRequestTitle(title, details) {
  const actual = requiredText(title, "Pull-request title");
  const taskNumber = requiredText(details?.taskNumber, "Jira task number");
  const taskName = requiredText(details?.taskName, "Jira task name");
  const taskType = normalizePullRequestTaskType(details?.taskType);
  const missing = [
    [taskNumber, "Jira task number"],
    [taskName, "exact Jira task name"],
    [taskType, "supported task type"],
  ].filter(([part]) => !actual.includes(part));
  if (missing.length) {
    throw new Error(`Pull-request title must contain ${missing.map(([, name]) => name).join(", ")}.`);
  }
  return actual;
}
