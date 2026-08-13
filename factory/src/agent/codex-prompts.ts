import type { ImplementationPlan } from "../model/codex.js";
import type { JiraIssue } from "../model/jira.js";

export function buildExecutionTask({ issue, runId, branchName, specPath, previousPlan }: {
  issue: JiraIssue;
  runId: string;
  branchName: string;
  specPath: string;
  previousPlan: ImplementationPlan | null;
}): string {
  return `You are the lead software implementation agent for an AI software factory.\n\n` +
    `Parent Jira issue: ${issue.key}\nSummary: ${issue.fields?.summary || ""}\n` +
    `Description:\n${JSON.stringify(issue.fields?.description || "")}\n` +
    `Run ID: ${runId}\nBranch: ${branchName}\n` +
    `${specPath ? `Factory specification: ${specPath}\nRead this file before editing. It is generated for this run; preserve its scope, update its implementation notes or decision log with useful final context, and include it in the commit and push.\n` : ""}` +
    `${previousPlan ? `A previous attempt produced this plan; inspect the current worktree and continue it:\n${JSON.stringify(previousPlan)}\n` : ""}` +
    `Inspect the repository and the current worktree before editing. Form the implementation ` +
    `plan internally, then implement the entire parent issue as one cohesive task. Use several ` +
    `bounded sub-agents when useful for read-only investigation, repository exploration, test ` +
    `discovery, or independent analysis; parallelize that investigation when it is safe. ` +
    `Sub-agents must not create Jira subtasks or child implementation tasks, branches, pull ` +
    `requests, or competing worktree edits, and must not commit, push, or mutate Jira. You ` +
    `remain responsible for synthesizing their findings, making all implementation edits, ` +
    `and delivering the final result. There is one parent request, one lead agent, one ` +
    `factory branch, and one pull request. Keep related ` +
    `changes together even when they touch multiple files. Use local Git tools directly on ` +
    `this PC for status, diff, branch, commit, and push operations. Do not use GitHub REST ` +
    `or a remote repository API for local source changes. Never work on or merge the default ` +
    `branch. Run the relevant tests plus appropriate repository validation, preserve unrelated ` +
    `user changes, commit the completed implementation, and push the factory branch. If a ` +
    `branch or commit already exists, inspect it and continue rather than creating duplicates. ` +
    `Do not ask the user questions; resolve ambiguity with explicit assumptions recorded in the ` +
    `specification and implementation result. ` +
    `Do not make Jira mutations; the factory supervisor owns Jira status, comments, and the ` +
    `parent description. The plan summary, acceptance criteria, affected files, and tests are ` +
    `copied into the Jira update and pull-request description, so write them for a human ` +
    `reviewer rather than as internal planning shorthand. The plan summary MUST be one to ` +
    `three concise sentences that explain the intended outcome, the user-visible or operational ` +
    `problem being addressed, and the main approach or scope. Do not use vague phrases such as ` +
    `"implement the requested change", "update code", or "add coverage" without saying what ` +
    `behavior changes and why. Acceptance criteria MUST describe concrete, observable behavior ` +
    `or outcomes; affected files should identify the relevant implementation areas; tests should ` +
    `name the command and what it validates when that is useful. Use plain language, preserve ` +
    `important product terms, and avoid repeating the Jira key as the explanation. Apply the ` +
    `same human-readable standard to the top-level implementation summary. The factory derives ` +
    `the pull-request title from the exact Jira task name and type, so keep the Jira task name ` +
    `as the concise action-oriented title and put the fuller intent in the summaries. Return ONLY JSON with this shape: ` +
    `{ "plan": { "summary": string, "acceptanceCriteria": string[], "risks": string[], ` +
    `"files": string[], "tests": string[] }, "summary": string, "committed": boolean, ` +
    `"pushed": boolean, "tests": [{"command": string, "status": "passed"|"failed"|"skipped", ` +
    `"output": string}], "blockers": string[] }`;
}

export function buildReviewTask({ issue, runId, branchName, baseBranch, specPath, plan, commitSha }: {
  issue: JiraIssue;
  runId: string;
  branchName: string;
  baseBranch: string;
  specPath: string;
  plan: ImplementationPlan;
  commitSha: string | null;
}): string {
  return `You are an independent software reviewer operating in a fresh context after another agent implemented a Jira task.\n\n` +
    `Do not trust the implementation agent's summary, plan, test claims, or assumptions. Read the ` +
    `factory specification at ${specPath}, inspect the repository and the complete diff from ` +
    `${baseBranch} to HEAD, and evaluate the final code against the Jira request, acceptance ` +
    `criteria, correctness, security, maintainability, scope, and test coverage.\n\n` +
    `Parent Jira issue: ${issue.key}\nSummary: ${issue.fields?.summary || ""}\n` +
    `Description:\n${JSON.stringify(issue.fields?.description || "")}\n` +
    `Run ID: ${runId}\nBranch: ${branchName}\nCurrent commit: ${commitSha || "unknown"}\n` +
    `Implementation plan (untrusted context only): ${JSON.stringify(plan)}\n\n` +
    `You are allowed to correct defects directly in this existing factory worktree. Do not create ` +
    `branches, subtasks, pull requests, or Jira mutations. If you find an actionable defect, fix ` +
    `it, add or update tests when appropriate, run the relevant tests and repository validation, ` +
    `commit the correction, and push the same factory branch. If the code is acceptable, do not ` +
    `make cosmetic changes. A review passes only when the final worktree is acceptable. If you ` +
    `cannot safely correct a finding, leave the code unchanged and report a blocker.\n\n` +
    `Return ONLY JSON with this shape: { "verdict": "passed"|"blocked", "summary": string, ` +
    `"findings": [{ "severity": "critical"|"major"|"minor"|"suggestion", "file": string, ` +
    `"line": number, "description": string, "resolution": string }], "changed": boolean, ` +
    `"committed": boolean, "pushed": boolean, "tests": [{ "command": string, ` +
    `"status": "passed"|"failed"|"skipped", "output": string }], "blockers": string[] }`;
}
