import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { AgentProvider, JiraAdapterKind, JiraStatusKey } from "./model/config.js";
import type { FactoryConfig } from "./model/config.js";
import type { UnknownRecord } from "./model/common.js";

function resolveConfiguredPath(value: string, baseDir: string) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(baseDir, value);
}

export function defaultConfig(repoPath = process.cwd()): FactoryConfig {
  const resolvedRepoPath = path.resolve(repoPath);
  const provider = (process.env.FACTORY_AGENT_PROVIDER || AgentProvider.Codex) as AgentProvider;
  const jiraAdapter = (process.env.FACTORY_JIRA_ADAPTER || (
    provider === AgentProvider.OpenCode ? JiraAdapterKind.OpenCodeMcp : JiraAdapterKind.CodexMcp
  )) as JiraAdapterKind;
  const stateDir = path.join(resolvedRepoPath, "tmp", "AllLlmFactory");
  return {
    provider,
    repoPath: resolvedRepoPath,
    stateDir,
    planningIntervalMs: 60_000,
    planningConcurrency: Number(process.env.FACTORY_PLANNING_CONCURRENCY || 2),
    pollIntervalMs: 60_000,
    implementationConcurrency: Number(process.env.FACTORY_IMPLEMENTATION_CONCURRENCY || 2),
    mergeCheckIntervalMs: 5 * 60_000,
    mergeCheckConcurrency: Number(process.env.FACTORY_MERGE_CHECK_CONCURRENCY || 2),
    reviewFixIntervalMs: 5 * 60_000,
    leaseMs: 15 * 60_000,
    maxAttempts: Number(process.env.FACTORY_MAX_ATTEMPTS || 1),
    maxContinuations: Number(process.env.FACTORY_MAX_CONTINUATIONS || 1),
    continueFailedTasks: process.env.FACTORY_CONTINUE_FAILED_TASKS !== "false",
    retryBackoffMs: 30_000,
    factory: {
      branchPrefix: "factory",
    },
    validation: {
      timeoutMs: Number(process.env.FACTORY_VALIDATION_TIMEOUT_MS || 15 * 60_000),
      commands: [
        {
          name: "factory-dependencies",
          command: "npm",
          args: ["ci", "--prefix", "factory"],
        },
        {
          name: "factory-tests",
          command: "npm",
          args: ["--prefix", "factory", "test"],
        },
        {
          name: "dotnet-build",
          command: "dotnet",
          args: ["build", "whisper-note/WhisperNote.csproj", "--configuration", "Release"],
        },
        {
          name: "dotnet-tests",
          command: "dotnet",
          args: ["test", "whisper-note/tests/WhisperNote.Tests.csproj", "--configuration", "Release"],
        },
      ],
    },
    jira: {
      adapter: jiraAdapter,
      baseUrl: process.env.JIRA_BASE_URL || "",
      projectKey: process.env.JIRA_PROJECT_KEY || "KAN",
      mcpTimeoutMs: Number(process.env.FACTORY_JIRA_MCP_TIMEOUT_MS || 240_000),
      mcpAgent: process.env.FACTORY_JIRA_MCP_AGENT || "factory-jira",
      mcpModel: provider === AgentProvider.Codex ? "gpt-5.6-luna" : process.env.FACTORY_JIRA_MCP_MODEL || undefined,
      mcpReasoningEffort: process.env.FACTORY_JIRA_MCP_REASONING_EFFORT || (provider === AgentProvider.Codex ? "low" : undefined),
      email: process.env.JIRA_EMAIL || "",
      apiToken: process.env.JIRA_API_TOKEN || "",
      statuses: {
        planning: "Planning",
        todo: "To Do",
        ready: "Ready",
        implementation: "In Progress",
        review: "In Review",
        done: "Done",
        error: "Error",
      },
    },
    github: {
      provider: process.env.FACTORY_GITHUB_PROVIDER || "gh",
      repositoryFullName: process.env.GITHUB_REPOSITORY || "AlexanderBesss/All-llm",
      cliCommand: process.env.FACTORY_GH_COMMAND || "",
    },
    git: {
      remote: "origin",
      baseBranch: process.env.FACTORY_BASE_BRANCH || "main",
      repoPath: resolvedRepoPath,
    },
    codex: {
      model: process.env.CODEX_MODEL || "gpt-5.6-luna",
      reasoningEffort: process.env.CODEX_REASONING_EFFORT || "max",
      featureModel: process.env.CODEX_FEATURE_MODEL || "gpt-5.6-sol",
      featureReasoningEffort: process.env.CODEX_FEATURE_REASONING_EFFORT || "medium",
      serviceTier: process.env.CODEX_SERVICE_TIER || "default",
      highCapacityServiceTier: process.env.CODEX_HIGH_CAPACITY_SERVICE_TIER || "priority",
      sandbox: process.env.CODEX_SANDBOX || "danger-full-access",
      approvalPolicy: process.env.CODEX_APPROVAL_POLICY || "never",
      contextWindowTokens: Number(process.env.CODEX_CONTEXT_WINDOW_TOKENS || 250_000),
      autoCompactTokenLimit: Number(process.env.CODEX_AUTO_COMPACT_TOKEN_LIMIT || 225_000),
      timeoutMs: 1_200_000,
      command: process.env.CODEX_COMMAND || "",
    },
    opencode: {
      model: process.env.OPENCODE_MODEL || "llamacpp/unsloth/Qwen3.8-27B-UD-Q5_K_XL",
      agent: process.env.OPENCODE_AGENT || "build",
      timeoutMs: 1_200_000,
      command: process.env.OPENCODE_COMMAND || "",
      directory: process.env.OPENCODE_DIRECTORY || "",
      configPath: process.env.OPENCODE_CONFIG || path.join(resolvedRepoPath, "opencode.json"),
    },
  };
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export interface OpenCodeDoctorSettings {
  configPath: string;
  model?: string;
  contextWindowTokens?: number;
  outputTokens?: number;
  reasoningEffort?: string;
  compactionAuto?: boolean;
  compactionPrune?: boolean;
  compactionReservedTokens?: number;
}

function merge<T extends object>(base: T, override: unknown): T {
  if (!isRecord(override)) return base;
  const result = { ...base } as unknown as UnknownRecord;
  for (const [key, value] of Object.entries(override)) {
    const existing = result[key];
    if (isRecord(value) && isRecord(existing)) {
      result[key] = merge(existing, value) as UnknownRecord;
    } else {
      result[key] = value;
    }
  }
  return result as T;
}

export async function loadConfig(configPath: string | undefined = undefined, repoPath = process.cwd()): Promise<FactoryConfig> {
  const base = defaultConfig(repoPath);
  const defaultPath = path.join(path.resolve(repoPath), "factory", "config.json");
  const selectedPath = configPath || process.env.FACTORY_CONFIG || defaultPath;
  if (!configPath && !process.env.FACTORY_CONFIG && !existsSync(defaultPath)) return base;
  const raw: unknown = JSON.parse(await readFile(path.resolve(selectedPath), "utf8"));
  const result = merge(base, raw);
  if (isRecord(raw) && typeof raw.agentProvider === "string" && raw.provider === undefined) {
    result.provider = raw.agentProvider as AgentProvider;
  }
  // Environment overrides are applied after the file merge so an operator can
  // switch a long-running/scheduled installation without editing its config.
  // Previously FACTORY_AGENT_PROVIDER only affected defaults and was silently
  // overwritten by factory/config.json.
  if (process.env.FACTORY_AGENT_PROVIDER) {
    result.provider = process.env.FACTORY_AGENT_PROVIDER as AgentProvider;
  }
  result.repoPath = resolveConfiguredPath(result.repoPath || repoPath, base.repoPath);
  result.stateDir = resolveConfiguredPath(result.stateDir || base.stateDir, result.repoPath);
  result.git.repoPath = result.repoPath;
  const rawOpenCode = isRecord(raw) && isRecord(raw.opencode) ? raw.opencode : undefined;
  result.opencode.configPath = rawOpenCode?.configPath || process.env.OPENCODE_CONFIG
    ? resolveConfiguredPath(result.opencode.configPath, result.repoPath)
    : path.join(result.repoPath, "opencode.json");
  const rawJira = isRecord(raw) && isRecord(raw.jira) ? raw.jira : undefined;
  if (result.provider === AgentProvider.Codex) {
    // Jira MCP work is intentionally fixed to Luna: these are short,
    // high-volume tool-routing calls and must not inherit a heavier model.
    result.jira.mcpModel = "gpt-5.6-luna";
  } else if (rawJira?.mcpModel === undefined && !process.env.FACTORY_JIRA_MCP_MODEL) {
    result.jira.mcpModel = undefined;
  }
  if (rawJira?.mcpReasoningEffort === undefined && !process.env.FACTORY_JIRA_MCP_REASONING_EFFORT) {
    result.jira.mcpReasoningEffort = result.provider === AgentProvider.Codex ? "low" : undefined;
  }
  const configuredJiraAdapter = rawJira?.adapter;
  const isProviderMcpAdapter = configuredJiraAdapter === undefined
    || configuredJiraAdapter === JiraAdapterKind.CodexMcp
    || configuredJiraAdapter === JiraAdapterKind.OpenCodeMcp;
  if (isProviderMcpAdapter && !process.env.FACTORY_JIRA_ADAPTER) {
    result.jira.adapter = result.provider === AgentProvider.OpenCode ? JiraAdapterKind.OpenCodeMcp : JiraAdapterKind.CodexMcp;
  }
  return result;
}

export async function readOpenCodeDoctorSettings(config: FactoryConfig): Promise<OpenCodeDoctorSettings> {
  const configPath = config.opencode.configPath || path.join(config.repoPath, "opencode.json");
  const raw = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  if (!isRecord(raw)) throw new Error("OpenCode configuration must be a JSON object.");

  const model = typeof raw.model === "string" ? raw.model : config.opencode.model;
  const separator = model?.indexOf("/") ?? -1;
  const providerId = separator > 0 ? model.slice(0, separator) : "";
  const modelId = separator > 0 ? model.slice(separator + 1) : model || "";
  const providers = isRecord(raw.provider) ? raw.provider : undefined;
  const provider = providerId && providers && isRecord(providers[providerId]) ? providers[providerId] : undefined;
  const models = provider && isRecord(provider.models) ? provider.models : undefined;
  const selectedModel = models && isRecord(models[modelId]) ? models[modelId] : undefined;
  const limit = selectedModel && isRecord(selectedModel.limit) ? selectedModel.limit : undefined;
  const options = selectedModel && isRecord(selectedModel.options) ? selectedModel.options : undefined;
  const agents = isRecord(raw.agent) ? raw.agent : undefined;
  const agent = agents && isRecord(agents[config.opencode.agent || "build"]) ? agents[config.opencode.agent || "build"] : undefined;
  const compaction = isRecord(raw.compaction) ? raw.compaction : undefined;

  return {
    configPath,
    model,
    contextWindowTokens: typeof limit?.context === "number" ? limit.context : undefined,
    outputTokens: typeof limit?.output === "number" ? limit.output : undefined,
    reasoningEffort: typeof agent?.["reasoningEffort"] === "string"
      ? agent["reasoningEffort"] as string
      : typeof options?.reasoningEffort === "string" ? options.reasoningEffort : undefined,
    compactionAuto: typeof compaction?.auto === "boolean" ? compaction.auto : undefined,
    compactionPrune: typeof compaction?.prune === "boolean" ? compaction.prune : undefined,
    compactionReservedTokens: typeof compaction?.reserved === "number" ? compaction.reserved : undefined,
  };
}

export function validateConfig(config: FactoryConfig, {
  live = true,
  requireGitHub = true,
}: { live?: boolean; requireGitHub?: boolean } = {}): string[] {
  const errors = [];
  if (!config.repoPath) errors.push("repoPath is required");
  if (!config.provider || ![AgentProvider.Codex, AgentProvider.OpenCode].includes(config.provider)) {
    errors.push("provider must be codex or opencode");
  }
  if (!config.stateDir) errors.push("stateDir is required");
  if (!Number.isInteger(config.jira?.mcpTimeoutMs) || config.jira.mcpTimeoutMs <= 0) {
    errors.push("jira.mcpTimeoutMs must be a positive integer");
  }
  if (config.jira?.mcpModel !== undefined && !String(config.jira.mcpModel).trim()) {
    errors.push("jira.mcpModel must be a non-empty string when configured");
  }
  if (config.jira?.mcpReasoningEffort !== undefined && !String(config.jira.mcpReasoningEffort).trim()) {
    errors.push("jira.mcpReasoningEffort must be a non-empty string when configured");
  }
  if (!Number.isInteger(config.maxAttempts) || config.maxAttempts <= 0) {
    errors.push("maxAttempts must be a positive integer");
  }
  if (!Number.isInteger(config.maxContinuations) || config.maxContinuations < 0) {
    errors.push("maxContinuations must be a non-negative integer");
  }
  if (!Number.isInteger(config.reviewFixIntervalMs) || config.reviewFixIntervalMs <= 0) {
    errors.push("reviewFixIntervalMs must be a positive integer");
  }
  if (!Number.isInteger(config.planningIntervalMs) || config.planningIntervalMs <= 0) {
    errors.push("planningIntervalMs must be a positive integer");
  }
  if (!Number.isInteger(config.planningConcurrency) || config.planningConcurrency <= 0) {
    errors.push("planningConcurrency must be a positive integer");
  }
  if (!Number.isInteger(config.implementationConcurrency) || config.implementationConcurrency <= 0) {
    errors.push("implementationConcurrency must be a positive integer");
  }
  if (!Number.isInteger(config.mergeCheckConcurrency) || config.mergeCheckConcurrency <= 0) {
    errors.push("mergeCheckConcurrency must be a positive integer");
  }
  if (typeof config.continueFailedTasks !== "boolean") {
    errors.push("continueFailedTasks must be a boolean");
  }
  if (!Number.isInteger(config.validation?.timeoutMs) || config.validation.timeoutMs <= 0) {
    errors.push("validation.timeoutMs must be a positive integer");
  }
  if (!Array.isArray(config.validation?.commands)) {
    errors.push("validation.commands must be an array");
  } else {
    config.validation.commands.forEach((command, index) => {
      if (!command?.name?.trim()) errors.push(`validation.commands[${index}].name is required`);
      if (!command?.command?.trim()) errors.push(`validation.commands[${index}].command is required`);
      if (!Array.isArray(command?.args) || command.args.some((arg) => typeof arg !== "string")) {
        errors.push(`validation.commands[${index}].args must be an array of strings`);
      }
    });
  }
  if (!config.git?.baseBranch) errors.push("git.baseBranch is required");
  if (!Number.isInteger(config.codex?.contextWindowTokens) || config.codex.contextWindowTokens <= 0) {
    errors.push("codex.contextWindowTokens must be a positive integer");
  }
  if (!Number.isInteger(config.codex?.autoCompactTokenLimit) || config.codex.autoCompactTokenLimit <= 0) {
    errors.push("codex.autoCompactTokenLimit must be a positive integer");
  } else if (config.codex.autoCompactTokenLimit >= config.codex.contextWindowTokens) {
    errors.push("codex.autoCompactTokenLimit must be lower than codex.contextWindowTokens");
  }
  if (!config.opencode?.model) errors.push("opencode.model is required");
  if (!config.opencode?.agent) errors.push("opencode.agent is required");
  if (live) {
    if (!config.jira?.projectKey) errors.push("jira.projectKey is required");
    if (!config.jira?.adapter || ![JiraAdapterKind.CodexMcp, JiraAdapterKind.OpenCodeMcp, JiraAdapterKind.Rest].includes(config.jira.adapter)) {
      errors.push("jira.adapter must be codex-mcp, opencode-mcp, or rest");
    }
    if (config.provider === AgentProvider.Codex && config.jira?.adapter === JiraAdapterKind.OpenCodeMcp) {
      errors.push("jira.adapter=opencode-mcp requires provider=opencode; use jira.adapter=codex-mcp with Codex");
    }
    if (config.provider === AgentProvider.OpenCode && config.jira?.adapter === JiraAdapterKind.CodexMcp) {
      errors.push("jira.adapter=codex-mcp requires provider=codex; use jira.adapter=opencode-mcp with OpenCode");
    }
    if (config.jira?.adapter === JiraAdapterKind.Rest) {
      if (!config.jira?.baseUrl) errors.push("jira.baseUrl is required when jira.adapter=rest");
      if (!config.jira?.email) errors.push("jira.email is required when jira.adapter=rest");
      if (!config.jira?.apiToken) errors.push("jira.apiToken is required when jira.adapter=rest");
    }
    for (const statusName of Object.values(JiraStatusKey)) {
      if (!config.jira?.statuses?.[statusName]) errors.push(`jira.statuses.${statusName} is required`);
    }
    if (requireGitHub) {
      if (!config.github?.repositoryFullName) errors.push("github.repositoryFullName is required");
      if (config.github?.provider !== "gh") errors.push("github.provider must be gh");
    }
  }
  return errors;
}
