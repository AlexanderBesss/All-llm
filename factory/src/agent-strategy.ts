import { CodexAgentExecutor } from "./codex.js";
import { OpenCodeAgentExecutor } from "./opencode.js";
import { McpJiraAdapter } from "./mcp-jira.js";
import { AgentProvider } from "./model/config.js";
import type { CodexAgent, CodexReviewer } from "./model/codex.js";
import type { FactoryConfig, JiraConfig } from "./model/config.js";
import type { JiraAdapter, JiraExecutor } from "./model/jira.js";

export type AgentExecutor = CodexAgent & CodexReviewer & {
  health(options?: { requireJiraMcp?: boolean }): Promise<{ command: string; version: string; [key: string]: unknown }>;
};

export interface AgentStrategy {
  readonly name: AgentProvider;
  readonly jiraMcpServer: string;
  create(config: FactoryConfig, signal?: AbortSignal): AgentExecutor;
  createJiraAdapter(config: JiraConfig, executor: JiraExecutor): JiraAdapter;
}

class CodexStrategy implements AgentStrategy {
  readonly name = AgentProvider.Codex;
  readonly jiraMcpServer = "Atlassian-Rovo-MCP";
  create(config: FactoryConfig, signal?: AbortSignal) {
    return new CodexAgentExecutor({ ...config, signal });
  }

  createJiraAdapter(config: JiraConfig, executor: JiraExecutor) {
    return new McpJiraAdapter(config, executor);
  }
}

class OpenCodeStrategy implements AgentStrategy {
  readonly name = AgentProvider.OpenCode;
  readonly jiraMcpServer = "jira";
  create(config: FactoryConfig, signal?: AbortSignal) {
    return new OpenCodeAgentExecutor({ ...config, signal });
  }

  createJiraAdapter(config: JiraConfig, executor: JiraExecutor) {
    return new McpJiraAdapter(config, executor);
  }
}

const strategies: Record<AgentProvider, AgentStrategy> = {
  [AgentProvider.Codex]: new CodexStrategy(),
  [AgentProvider.OpenCode]: new OpenCodeStrategy(),
};

export function createAgentStrategy(provider: FactoryConfig["provider"] = AgentProvider.Codex) {
  return strategies[provider] || strategies[AgentProvider.Codex];
}

export function createAgentExecutors(config: FactoryConfig, signal?: AbortSignal) {
  const strategy = createAgentStrategy(config.provider);
  return {
    strategy,
    agent: strategy.create(config, signal),
    reviewer: strategy.create(config, signal),
  };
}
