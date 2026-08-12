import type { JiraIssue } from "./jira.js";

export interface CodexAgentConfig {
  repoPath: string;
  stateDir?: string;
  codex: import("./config.js").CodexSettings;
  opencode?: import("./config.js").OpenCodeSettings;
  signal?: AbortSignal;
}

export interface CodexRunInput {
  task: string;
  context?: string;
  cwd: string;
  outputSchema?: string;
}

export interface CodexEvent {
  type?: string;
  item?: {
    type?: string;
    text?: string;
  };
  [key: string]: unknown;
}

export interface CodexJsonLinesResult {
  output: string;
  events: CodexEvent[];
}

export interface ImplementationPlan {
  summary: string;
  acceptanceCriteria: string[];
  risks: string[];
  files: string[];
  tests: string[];
}

export enum TestStatus {
  Passed = "passed",
  Failed = "failed",
  Skipped = "skipped",
}

export interface ExecutionTestResult {
  command: string;
  status: TestStatus;
  output: string;
}

export interface ExecutionResult {
  plan: ImplementationPlan;
  summary: string;
  committed: boolean;
  pushed: boolean;
  tests: ExecutionTestResult[];
  blockers: string[];
}

export interface CodexExecutionResult {
  result: ExecutionResult;
  raw: CodexJsonLinesResult;
}

export enum FindingSeverity {
  Critical = "critical",
  Major = "major",
  Minor = "minor",
  Suggestion = "suggestion",
}

export interface ReviewFinding {
  severity: FindingSeverity;
  file: string;
  line?: number;
  description: string;
  resolution: string;
}

export enum ReviewVerdict {
  Passed = "passed",
  Blocked = "blocked",
}

export interface ReviewResult {
  verdict: ReviewVerdict;
  summary: string;
  findings: ReviewFinding[];
  changed: boolean;
  committed: boolean;
  pushed: boolean;
  tests: ExecutionTestResult[];
  blockers: string[];
}

export interface CodexReviewResult {
  result: ReviewResult;
  raw: CodexJsonLinesResult;
}

export interface CodexAgent {
  run(input: CodexRunInput): Promise<CodexJsonLinesResult>;
  execute(input: {
    issue: JiraIssue;
    runId: string;
    branchName: string;
    cwd: string;
    previousPlan: ImplementationPlan | null;
    specPath: string;
  }): Promise<CodexExecutionResult>;
}

export interface CodexReviewer {
  review(input: {
    issue: JiraIssue;
    runId: string;
    branchName: string;
    baseBranch: string;
    cwd: string;
    specPath: string;
    plan: ImplementationPlan;
    commitSha: string | null;
  }): Promise<CodexReviewResult>;
}
