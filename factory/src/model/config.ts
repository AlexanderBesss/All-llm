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
  Planning = "planning",
  Todo = "todo",
  Ready = "ready",
  Implementation = "implementation",
  Review = "review",
  Done = "done",
  Error = "error",
}

export interface FactoryStatuses {
  planning: string;
  todo: string;
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
  /** Dedicated model used for short provider-backed Jira operations. */
  mcpModel?: string;
  /** Dedicated reasoning effort used for short provider-backed Jira operations. */
  mcpReasoningEffort?: string;
  /** Runtime telemetry sink; populated by the CLI rather than configuration files. */
  log?: (level: "info" | "warn" | "error", event: string, details?: Record<string, unknown>) => void;
  email?: string;
  apiToken?: string;
  planningStatus?: string;
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
  featureModel?: string;
  featureReasoningEffort?: string;
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
  planningIntervalMs: number;
  planningConcurrency: number;
  pollIntervalMs: number;
  implementationConcurrency: number;
  mergeCheckIntervalMs: number;
  mergeCheckConcurrency: number;
  reviewFixIntervalMs: number;
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
