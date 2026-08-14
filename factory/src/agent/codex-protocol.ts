import type { CodexEvent, CodexJsonLinesResult, ExecutionResult, JiraPlanningResult } from "../model/codex.js";

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

export function assertPlanningResult(value: unknown): JiraPlanningResult {
  if (!value || typeof value !== "object") throw new Error("Planning result must be an object.");
  const candidate = value as Partial<JiraPlanningResult>;
  if (typeof candidate.description !== "string" || !candidate.description.trim()) {
    throw new Error("Planning result must include a non-empty description.");
  }
  if (!Array.isArray(candidate.acceptanceCriteria) || candidate.acceptanceCriteria.length === 0
    || candidate.acceptanceCriteria.some((criterion) => typeof criterion !== "string" || !criterion.trim())) {
    throw new Error("Planning result must include non-empty acceptance criteria.");
  }
  return candidate as JiraPlanningResult;
}
