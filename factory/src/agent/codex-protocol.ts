import { ReviewVerdict } from "../model/codex.js";
import type { CodexEvent, CodexJsonLinesResult, ExecutionResult, ReviewResult } from "../model/codex.js";

export function parseJsonLines(stdout: string): CodexJsonLinesResult {
  const events: CodexEvent[] = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line) as CodexEvent); } catch {}
  }
  const messages = events
    .filter((event) => event.type === "item.completed" && event.item?.type === "agent_message")
    .map((event) => event.item.text)
    .filter(Boolean);
  if (!messages.length) throw new Error("Codex returned no final agent message.");
  return { output: messages.at(-1), events };
}

export function assertExecution(execution: unknown): ExecutionResult {
  if (!execution || typeof execution !== "object") throw new Error("Implementation result must be an object.");
  const candidate = execution as Partial<ExecutionResult>;
  if (!candidate.plan || typeof candidate.plan !== "object") throw new Error("Implementation result must include a plan.");
  const plan = candidate.plan;
  if (typeof plan.summary !== "string") throw new Error("Implementation plan must include a summary.");
  if (!Array.isArray(plan.acceptanceCriteria) || plan.acceptanceCriteria.length === 0) throw new Error("Planner result must include acceptanceCriteria.");
  if (!Array.isArray(plan.risks) || !Array.isArray(plan.files) || !Array.isArray(plan.tests)) {
    throw new Error("Implementation plan must include risks, files, and tests arrays.");
  }
  if (typeof candidate.summary !== "string") throw new Error("Implementation result must include a summary.");
  if (typeof candidate.committed !== "boolean" || typeof candidate.pushed !== "boolean") {
    throw new Error("Implementation result must confirm committed and pushed.");
  }
  if (!Array.isArray(candidate.tests) || !Array.isArray(candidate.blockers)) {
    throw new Error("Implementation result must include tests and blockers arrays.");
  }
  return candidate as ExecutionResult;
}

export function assertReview(review: unknown): ReviewResult {
  if (!review || typeof review !== "object") throw new Error("Code review result must be an object.");
  const candidate = review as Partial<ReviewResult>;
  if (candidate.verdict !== ReviewVerdict.Passed && candidate.verdict !== ReviewVerdict.Blocked) {
    throw new Error("Code review result must include a passed or blocked verdict.");
  }
  if (typeof candidate.summary !== "string") throw new Error("Code review result must include a summary.");
  if (!Array.isArray(candidate.findings) || typeof candidate.changed !== "boolean" ||
      typeof candidate.committed !== "boolean" || typeof candidate.pushed !== "boolean" ||
      !Array.isArray(candidate.tests) || !Array.isArray(candidate.blockers)) {
    throw new Error("Code review result has an invalid shape.");
  }
  return candidate as ReviewResult;
}
