export enum JiraAdapterKind {
  CodexMcp = "codex-mcp",
  OpenCodeMcp = "opencode-mcp",
  Rest = "rest",
}

export enum AgentProvider {
  Codex = "codex",
  OpenCode = "opencode",
}

export enum JiraStatusKey {
  Ready = "ready",
  Implementation = "implementation",
  Review = "review",
  Done = "done",
  Error = "error",
}

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
  /** Maximum time for one provider-backed Jira MCP request. */
  mcpTimeoutMs?: number;
  /** OpenCode agent used for provider-backed Jira MCP requests. */
  mcpAgent?: string;
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
  serviceTier?: string;
  highCapacityServiceTier?: string;
  sandbox?: string;
  approvalPolicy?: string;
  contextWindowTokens?: number;
  autoCompactTokenLimit?: number;
  timeoutMs?: number;
  command?: string;
}

export interface OpenCodeSettings {
  model?: string;
  agent?: string;
  command?: string;
  timeoutMs?: number;
  directory?: string;
  configPath?: string;
}

export interface FactoryConfig {
  /** Provider strategy used for implementation, review, and structured Jira operations. */
  provider: AgentProvider;
  /** Backward/forward-compatible descriptive alias for provider. */
  agentProvider?: AgentProvider;
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
  opencode: OpenCodeSettings;
  signal?: AbortSignal;
}
