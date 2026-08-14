import crypto from "node:crypto";
import { adfToText } from "../jira.js";
import { AgentProvider } from "../model/config.js";
import { makeRunMarker } from "../types.js";
import type { CodexSettings, FactoryConfig } from "../model/config.js";
import type { ImplementationPlan } from "../model/codex.js";
import type { JiraIssue } from "../model/jira.js";

function usableValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized || undefined;
}

export interface ImplementationMetadata {
  model?: string;
  reasoningEffort?: string;
}

export function codexImplementationMetadata(settings: CodexSettings, issue: JiraIssue): ImplementationMetadata {
  const isFeature = jiraText(issue.fields?.issuetype).trim().toLowerCase() === "feature";
  const model = isFeature ? settings.featureModel : settings.model;
  const reasoningEffort = isFeature ? settings.featureReasoningEffort : settings.reasoningEffort;
  return {
    model: usableValue(model) || (isFeature ? usableValue(settings.model) : undefined),
    reasoningEffort: usableValue(reasoningEffort) || (isFeature ? usableValue(settings.reasoningEffort) : undefined),
  };
}

export function codexImplementationModel(settings: CodexSettings, issue: JiraIssue): string | undefined {
  return codexImplementationMetadata(settings, issue).model;
}

export function implementationMetadata(config: Pick<FactoryConfig, "provider" | "codex" | "opencode">, issue: JiraIssue): ImplementationMetadata {
  if (config.provider === AgentProvider.OpenCode) return { model: usableValue(config.opencode?.model) };
  return codexImplementationMetadata(config.codex, issue);
}

export function implementationModel(config: Pick<FactoryConfig, "provider" | "codex" | "opencode">, issue: JiraIssue): string | undefined {
  return implementationMetadata(config, issue).model;
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

export function pullRequestDescription({ runId, issueKey, plan, specPath = "", model, reasoningEffort }: {
  runId: string;
  issueKey: string;
  plan: ImplementationPlan;
  specPath?: string;
  model?: string;
  reasoningEffort?: string;
}): string {
  const validationChecks = plan.tests.length
    ? plan.tests.map((item) => `- ${item}`)
    : ["- Relevant repository tests and validation checks."];
  const normalizedModel = usableValue(model);
  const normalizedReasoningEffort = usableValue(reasoningEffort);
  const attribution = normalizedModel
    ? `Implemented by ${normalizedModel}${normalizedReasoningEffort ? ` (reasoning effort: ${normalizedReasoningEffort})` : ""}`
    : undefined;
  return [
    ...(attribution ? [attribution, ""] : []),
    makeRunMarker(runId),
    "",
    "## Intent",
    plan.summary.trim(),
    "",
    "## What this changes",
    `This pull request implements the requested behavior for Jira issue \`${issueKey}\`.`,
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
