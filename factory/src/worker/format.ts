import crypto from "node:crypto";
import { adfToText } from "../jira.js";
import { AgentProvider } from "../model/config.js";
import { makeRunMarker } from "../types.js";
import type { CodexSettings, FactoryConfig } from "../model/config.js";
import type { ImplementationPlan } from "../model/codex.js";
import type { JiraIssue } from "../model/jira.js";

function usableModel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const model = value.trim().replace(/\s+/g, " ");
  return model || undefined;
}

export function codexImplementationModel(settings: CodexSettings, issue: JiraIssue): string | undefined {
  const isFeature = jiraText(issue.fields?.issuetype).trim().toLowerCase() === "feature";
  const preferred = isFeature ? settings.featureModel : settings.model;
  return usableModel(preferred) || (isFeature ? usableModel(settings.model) : undefined);
}

export function implementationModel(config: Pick<FactoryConfig, "provider" | "codex" | "opencode">, issue: JiraIssue): string | undefined {
  if (config.provider === AgentProvider.OpenCode) return usableModel(config.opencode?.model);
  return codexImplementationModel(config.codex, issue);
}

export function jiraText(value: unknown, property: "name" | "key" | "summary" = "name"): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  const direct = record[property];
  if (typeof direct === "string") return direct;
  if (direct && typeof direct === "object") return jiraText(direct, property);
  if (property !== "name" && typeof record.name === "string") return record.name;
  if (property !== "key" && typeof record.key === "string") return record.key;
  return "";
}

export function hashInput(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function normalizePlan(plan: unknown): ImplementationPlan {
  if (!plan || typeof plan !== "object") throw new Error("Planner result must be an object.");
  const candidate = plan as Partial<ImplementationPlan>;
  if (typeof candidate.summary !== "string" || !candidate.summary.trim()) throw new Error("Implementation plan must include a summary.");
  if (!Array.isArray(candidate.acceptanceCriteria) || candidate.acceptanceCriteria.length === 0) {
    throw new Error("Implementation plan must include acceptanceCriteria.");
  }
  return {
    summary: candidate.summary,
    acceptanceCriteria: candidate.acceptanceCriteria.map(String),
    risks: Array.isArray(candidate.risks) ? candidate.risks.map(String) : [],
    files: Array.isArray(candidate.files) ? candidate.files.map(String) : [],
    tests: Array.isArray(candidate.tests) ? candidate.tests.map(String) : [],
  };
}

function quotedDescription(description: unknown): string {
  return adfToText(description)
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

export function planDescription(originalDescription: unknown, plan: ImplementationPlan, marker: string, specPath = ""): string {
  return [
    quotedDescription(originalDescription),
    "",
    marker,
    "",
    ...(specPath ? ["## Specification", `- \`${specPath}\` (committed on the factory branch)`, ""] : []),
    "## Implementation plan",
    plan.summary,
    "",
    "## Acceptance criteria",
    ...plan.acceptanceCriteria.map((item) => `- ${item}`),
    "",
    "## Affected files",
    ...(plan.files.length ? plan.files.map((item) => `- ${item}`) : ["- To be confirmed during implementation"]),
    "",
    "## Tests",
    ...(plan.tests.length ? plan.tests.map((item) => `- ${item}`) : ["- Appropriate repository validation"]),
  ].join("\n");
}

export function pullRequestDescription({ runId, issueKey, plan, specPath = "", model }: {
  runId: string;
  issueKey: string;
  plan: ImplementationPlan;
  specPath?: string;
  model?: string;
}): string {
  const implementationAreas = plan.files.length
    ? plan.files.map((item) => `- ${item}`)
    : ["- See the committed diff for the implementation areas."];
  const validationChecks = plan.tests.length
    ? plan.tests.map((item) => `- ${item}`)
    : ["- Relevant repository tests and validation checks."];
  const normalizedModel = usableModel(model);
  return [
    ...(normalizedModel ? [`Implemented by ${normalizedModel}`, ""] : []),
    makeRunMarker(runId),
    "",
    "## Intent",
    plan.summary.trim(),
    "",
    "## What this changes",
    `This pull request implements the requested behavior for Jira issue \`${issueKey}\`.`,
    "",
    "### Implementation areas",
    ...implementationAreas,
    "",
    "## Acceptance criteria",
    ...plan.acceptanceCriteria.map((item) => `- ${item}`),
    "",
    "## Validation",
    "The implementation agent was asked to run:",
    ...validationChecks,
    "",
    "## References",
    `- Jira issue: \`${issueKey}\``,
    ...(specPath ? [`- Factory specification: \`${specPath}\``] : []),
  ].join("\n");
}
