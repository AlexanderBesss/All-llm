import type { JiraIssue } from "./jira.js";

export interface CodexAgentConfig {
  repoPath: string;
  codex: import("./config.js").CodexSettings;
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

export interface ExecutionTestResult {
  command: string;
  status: "passed" | "failed" | "skipped";
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

export interface ReviewFinding {
  severity: "critical" | "major" | "minor" | "suggestion";
  file: string;
  line?: number;
  description: string;
  resolution: string;
}

export interface ReviewResult {
  verdict: "passed" | "blocked";
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
