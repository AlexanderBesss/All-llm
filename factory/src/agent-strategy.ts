import { CodexAgentExecutor } from "./codex.js";
import { OpenCodeAgentExecutor } from "./opencode.js";
import type { CodexAgent, CodexReviewer } from "./model/codex.js";
import type { FactoryConfig } from "./model/config.js";

export type AgentExecutor = CodexAgent & CodexReviewer & {
  health(): Promise<{ command: string; version: string; [key: string]: unknown }>;
};

export interface AgentStrategy {
  readonly name: "codex" | "opencode";
  create(config: FactoryConfig, signal?: AbortSignal): AgentExecutor;
}

class CodexStrategy implements AgentStrategy {
  readonly name = "codex" as const;
  create(config: FactoryConfig, signal?: AbortSignal) {
    return new CodexAgentExecutor({ ...config, signal });
  }
}

class OpenCodeStrategy implements AgentStrategy {
  readonly name = "opencode" as const;
  create(config: FactoryConfig, signal?: AbortSignal) {
    return new OpenCodeAgentExecutor({ ...config, signal });
  }
}

const strategies: Record<AgentStrategy["name"], AgentStrategy> = {
  codex: new CodexStrategy(),
  opencode: new OpenCodeStrategy(),
};

export function createAgentStrategy(provider: FactoryConfig["provider"] = "codex") {
  return strategies[provider] || strategies.codex;
}

export function createAgentExecutors(config: FactoryConfig, signal?: AbortSignal) {
  const strategy = createAgentStrategy(config.provider);
  return {
    strategy,
    agent: strategy.create(config, signal),
    reviewer: strategy.create(config, signal),
  };
}
