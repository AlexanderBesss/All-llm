import os from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";

function localAppData() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
}

export function defaultConfig(repoPath = process.cwd()) {
  const stateDir = path.join(localAppData(), "AllLlmFactory");
  return {
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
      adapter: process.env.FACTORY_JIRA_ADAPTER || "codex-mcp",
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
    },
    codex: {
      model: process.env.CODEX_MODEL || "gpt-5.6-luna",
      reasoningEffort: process.env.CODEX_REASONING_EFFORT || "max",
      sandbox: process.env.CODEX_SANDBOX || "danger-full-access",
      approvalPolicy: process.env.CODEX_APPROVAL_POLICY || "never",
      contextWindowTokens: Number(process.env.CODEX_CONTEXT_WINDOW_TOKENS || 250_000),
      autoCompactTokenLimit: Number(process.env.CODEX_AUTO_COMPACT_TOKEN_LIMIT || 225_000),
      timeoutMs: 1_200_000,
      command: process.env.CODEX_COMMAND || "",
    },
  };
}

function merge(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) return base;
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value && typeof value === "object" && !Array.isArray(value) && result[key] && typeof result[key] === "object") {
      result[key] = merge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

export async function loadConfig(configPath = process.env.FACTORY_CONFIG, repoPath = process.cwd()) {
  const base = defaultConfig(repoPath);
  if (!configPath) return base;
  const raw = JSON.parse(await readFile(configPath, "utf8"));
  const result = merge(base, raw);
  result.repoPath = path.resolve(result.repoPath || repoPath);
  result.stateDir = path.resolve(result.stateDir || base.stateDir);
  return result;
}

export function validateConfig(config, { live = true } = {}) {
  const errors = [];
  if (!config.repoPath) errors.push("repoPath is required");
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
  if (live) {
    if (!config.jira?.projectKey) errors.push("jira.projectKey is required");
    if (!config.jira?.adapter || !["codex-mcp", "rest"].includes(config.jira.adapter)) {
      errors.push("jira.adapter must be codex-mcp or rest");
    }
    if (config.jira?.adapter === "rest") {
      if (!config.jira?.baseUrl) errors.push("jira.baseUrl is required when jira.adapter=rest");
      if (!config.jira?.email) errors.push("jira.email is required when jira.adapter=rest");
      if (!config.jira?.apiToken) errors.push("jira.apiToken is required when jira.adapter=rest");
    }
    for (const statusName of ["ready", "implementation", "review", "done", "error"]) {
      if (!config.jira?.statuses?.[statusName]) errors.push(`jira.statuses.${statusName} is required`);
    }
    if (!config.github?.repositoryFullName) errors.push("github.repositoryFullName is required");
    if (config.github?.provider !== "gh") errors.push("github.provider must be gh");
  }
  return errors;
}
