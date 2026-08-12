import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { AgentProvider, JiraAdapterKind, JiraStatusKey } from "./model/config.js";
import type { FactoryConfig } from "./model/config.js";
import type { UnknownRecord } from "./model/common.js";

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
}

function resolveConfiguredPath(value: string, baseDir: string) {
  return path.isAbsolute(value) ? path.normalize(value) : path.resolve(baseDir, value);
}

export function defaultConfig(repoPath = process.cwd()): FactoryConfig {
  const provider = (process.env.FACTORY_AGENT_PROVIDER || AgentProvider.Codex) as AgentProvider;
  const jiraAdapter = (process.env.FACTORY_JIRA_ADAPTER || (
    provider === AgentProvider.OpenCode ? JiraAdapterKind.OpenCodeMcp : JiraAdapterKind.CodexMcp
  )) as JiraAdapterKind;
  const stateDir = path.join(localAppData(), "AllLlmFactory");
  return {
    provider,
    repoPath: path.resolve(repoPath),
    stateDir,
    pollIntervalMs: 60_000,
    leaseMs: 15 * 60_000,
    maxAttempts: Number(process.env.FACTORY_MAX_ATTEMPTS || 1),
    continueFailedTasks: process.env.FACTORY_CONTINUE_FAILED_TASKS !== "false",
    retryBackoffMs: 30_000,
    factory: {
      branchPrefix: "factory",
    },
    jira: {
      adapter: jiraAdapter,
      baseUrl: process.env.JIRA_BASE_URL || "",
      projectKey: process.env.JIRA_PROJECT_KEY || "KAN",
      email: process.env.JIRA_EMAIL || "",
      apiToken: process.env.JIRA_API_TOKEN || "",
      statuses: {
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
      repoPath: path.resolve(repoPath),
    },
    codex: {
      model: process.env.CODEX_MODEL || "gpt-5.6-luna",
      reasoningEffort: process.env.CODEX_REASONING_EFFORT || "max",
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
      model: process.env.OPENCODE_MODEL || "llamacpp/unsloth/Qwen3.6-27B-UD-Q4_K_XL",
      agent: process.env.OPENCODE_AGENT || "build",
      timeoutMs: 1_200_000,
      command: process.env.OPENCODE_COMMAND || "",
      directory: process.env.OPENCODE_DIRECTORY || "",
    },
  };
}

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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

export async function loadConfig(configPath = process.env.FACTORY_CONFIG, repoPath = process.cwd()): Promise<FactoryConfig> {
  const base = defaultConfig(repoPath);
  if (!configPath) return base;
  const raw: unknown = JSON.parse(await readFile(path.resolve(configPath), "utf8"));
  const result = merge(base, raw);
  if (isRecord(raw) && typeof raw.agentProvider === "string" && raw.provider === undefined) {
    result.provider = raw.agentProvider as AgentProvider;
  }
  result.repoPath = resolveConfiguredPath(result.repoPath || repoPath, base.repoPath);
  result.stateDir = resolveConfiguredPath(result.stateDir || base.stateDir, result.repoPath);
  result.git.repoPath = result.repoPath;
  const rawJira = isRecord(raw) && isRecord(raw.jira) ? raw.jira : undefined;
  if (!rawJira?.adapter && !process.env.FACTORY_JIRA_ADAPTER) {
    result.jira.adapter = result.provider === AgentProvider.OpenCode ? JiraAdapterKind.OpenCodeMcp : JiraAdapterKind.CodexMcp;
  }
  return result;
}

export function validateConfig(config: FactoryConfig, { live = true }: { live?: boolean } = {}): string[] {
  const errors = [];
  if (!config.repoPath) errors.push("repoPath is required");
  if (!config.provider || ![AgentProvider.Codex, AgentProvider.OpenCode].includes(config.provider)) {
    errors.push("provider must be codex or opencode");
  }
  if (!config.stateDir) errors.push("stateDir is required");
  if (!Number.isInteger(config.maxAttempts) || config.maxAttempts <= 0) {
    errors.push("maxAttempts must be a positive integer");
  }
  if (typeof config.continueFailedTasks !== "boolean") {
    errors.push("continueFailedTasks must be a boolean");
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
    if (!config.github?.repositoryFullName) errors.push("github.repositoryFullName is required");
    if (config.github?.provider !== "gh") errors.push("github.provider must be gh");
  }
  return errors;
}
