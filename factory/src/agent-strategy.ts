import { CodexAgentExecutor } from "./codex.js";
import { OpenCodeAgentExecutor } from "./opencode.js";
import { AgentProvider } from "./model/config.js";
import type { CodexAgent, CodexReviewer } from "./model/codex.js";
import type { FactoryConfig } from "./model/config.js";

export type AgentExecutor = CodexAgent & CodexReviewer & {
  health(): Promise<{ command: string; version: string; [key: string]: unknown }>;
};

export interface AgentStrategy {
  readonly name: AgentProvider;
  create(config: FactoryConfig, signal?: AbortSignal): AgentExecutor;
}

class CodexStrategy implements AgentStrategy {
  readonly name = AgentProvider.Codex;
  create(config: FactoryConfig, signal?: AbortSignal) {
    return new CodexAgentExecutor({ ...config, signal });
  }
}

class OpenCodeStrategy implements AgentStrategy {
  readonly name = AgentProvider.OpenCode;
  create(config: FactoryConfig, signal?: AbortSignal) {
    return new OpenCodeAgentExecutor({ ...config, signal });
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
