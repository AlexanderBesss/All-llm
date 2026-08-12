import type { CodexAgent } from "./codex.js";
import type { CodexReviewer } from "./codex.js";
import type { FactoryConfig } from "./config.js";
import type { StateDatabaseLike } from "./database.js";
import type { GitAdapterLike } from "./git.js";
import type { GitHubAdapter } from "./github.js";
import type { JiraAdapter } from "./jira.js";

export interface FactoryLogger {
  info?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
}

export interface FactoryWorkerOptions {
  config: FactoryConfig;
  db: StateDatabaseLike;
  jira: JiraAdapter;
  github: GitHubAdapter;
  git: GitAdapterLike;
  agent: CodexAgent;
  reviewer: CodexReviewer;
  logger?: FactoryLogger;
  signal?: AbortSignal;
}

export interface FactoryRunResult {
  action: string;
  runId?: string;
  issueKey?: string;
  status?: string;
  stage?: string;
  nextAttemptAt?: string;
  reason?: string;
}
