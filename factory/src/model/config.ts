export type JiraAdapterKind = "codex-mcp" | "rest";

export interface FactoryStatuses {
  ready: string;
  implementation: string;
  review: string;
  done: string;
  error: string;
}

export interface FactorySettings {
  branchPrefix: string;
}

export interface JiraConfig {
  adapter?: JiraAdapterKind;
  baseUrl?: string;
  projectKey?: string;
  email?: string;
  apiToken?: string;
  readyStatus?: string;
  statuses?: FactoryStatuses;
  repoPath?: string;
  signal?: AbortSignal;
}

export interface GitHubConfig {
  provider?: string;
  repositoryFullName?: string;
  cliCommand?: string;
  baseBranch?: string;
  repoPath?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface GitConfig {
  remote: string;
  baseBranch: string;
  repoPath: string;
  stateDir?: string;
  signal?: AbortSignal;
}

export interface CodexSettings {
  model?: string;
  reasoningEffort?: string;
  sandbox?: string;
  approvalPolicy?: string;
  contextWindowTokens?: number;
  autoCompactTokenLimit?: number;
  timeoutMs?: number;
  command?: string;
}

export interface FactoryConfig {
  repoPath: string;
  stateDir: string;
  pollIntervalMs: number;
  leaseMs: number;
  maxAttempts: number;
  continueFailedTasks: boolean;
  retryBackoffMs: number;
  factory: FactorySettings;
  jira: JiraConfig;
  github: GitHubConfig;
  git: GitConfig;
  codex: CodexSettings;
  signal?: AbortSignal;
}
