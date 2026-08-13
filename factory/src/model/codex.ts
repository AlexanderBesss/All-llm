import type { JiraIssue } from "./jira.js";

export interface CodexAgentConfig {
  repoPath: string;
  stateDir?: string;
  codex: import("./config.js").CodexSettings;
  opencode?: import("./config.js").OpenCodeSettings;
  signal?: AbortSignal;
}

export enum AgentToolScope {
  Build = "build",
  Jira = "jira",
}

export enum AgentWorkspaceAccess {
  Configured = "configured",
  ReadOnly = "read-only",
}

export interface CodexRunInput {
  task: string;
  context?: string;
  cwd: string;
  outputSchema?: string;
  timeoutMs?: number;
  model?: string;
  reasoningEffort?: string;
  agent?: string;
  toolScope?: AgentToolScope;
  workspaceAccess?: AgentWorkspaceAccess;
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

export enum ReviewThreadDisposition {
  Addressed = "addressed",
  Disputed = "disputed",
}

export interface ReviewThreadResult {
  threadId: string;
  disposition: ReviewThreadDisposition;
  reply: string;
}

export interface ReviewFixResult {
  summary: string;
  committed: boolean;
  pushed: boolean;
  threads: ReviewThreadResult[];
  tests: ExecutionTestResult[];
  blockers: string[];
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

export interface CodexAgent {
  run(input: CodexRunInput): Promise<CodexJsonLinesResult>;
  execute(input: {
    issue: JiraIssue;
    runId: string;
    branchName: string;
    cwd: string;
    previousPlan: ImplementationPlan | null;
    specPath: string;
    baseBranch?: string;
    verificationPass?: boolean;
  }): Promise<CodexExecutionResult>;
}
