import type { FactoryConfig } from "./config.js";

export enum CliCommand {
  Help = "help",
  Doctor = "doctor",
  Status = "status",
  Metrics = "metrics",
  Install = "install",
  RunOnce = "run-once",
  Start = "start",
  StartPlanning = "start-planning",
  StartJiraTasks = "start-jira-tasks",
  StartPullRequestCheck = "start-pull-request-check",
  StartReviewFix = "start-review-fix",
}

export interface CliArgs {
  command: string;
  config?: string;
  dryRun?: boolean;
  json?: boolean;
}

export interface CheckReport {
  ok?: boolean;
  error?: string;
  command?: string;
  host?: string;
  repository?: string;
  mcp?: string;
  mcpStatus?: string;
  [key: string]: unknown;
}

export interface RepositoryCheck extends CheckReport {
  path: string;
  remoteName: string;
  baseBranch: string;
  root?: string;
  rootMatchesConfiguredPath?: boolean;
  clean?: boolean;
  remote?: { ok: boolean; url?: string; error?: string };
  baseBranchReachable?: boolean;
}

export interface DoctorReport {
  repoPath: string;
  stateDir: string;
  provider?: string;
  configPath?: string;
  model?: string;
  mcp?: string;
  mcpStatus?: string;
  reasoningEffort?: string;
  sandbox?: string;
  approvalPolicy?: string;
  contextWindowTokens?: number;
  outputTokens?: number;
  autoCompactTokenLimit?: number;
  compactionAuto?: boolean;
  compactionPrune?: boolean;
  compactionReservedTokens?: number;
  jiraAdapter?: string;
  configured: boolean;
  configurationErrors: string[];
  checks: Record<string, CheckReport>;
  failures?: Array<{ check: string; error: string }>;
  ok?: boolean;
}

export interface CliContext {
  config: FactoryConfig;
}
