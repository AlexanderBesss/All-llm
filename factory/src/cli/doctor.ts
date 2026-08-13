import path from "node:path";
import { existsSync } from "node:fs";
import { readOpenCodeDoctorSettings, validateConfig } from "../config.js";
import { openStateDatabase } from "../db.js";
import { GitHubCliAdapter } from "../github.js";
import { runProcess } from "../git.js";
import { createAgentExecutors, createAgentStrategy } from "../agent-strategy.js";
import { AgentProvider, JiraAdapterKind } from "../model/config.js";
import type { CheckReport, DoctorReport, RepositoryCheck } from "../model/cli.js";
import type { FactoryConfig } from "../model/config.js";

function redactRemoteUrl(value: unknown): string {
  return String(value || "").replace(/(https?:\/\/)[^/@]+@/i, "$1[redacted]@");
}

async function checkGitTool(config: FactoryConfig): Promise<CheckReport> {
  try {
    const result = await runProcess("git", ["--version"], { cwd: config.repoPath, timeoutMs: 10_000 });
    return { ok: true, version: result.stdout.trim() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function checkRepository(config: FactoryConfig): Promise<RepositoryCheck> {
  const report: RepositoryCheck = {
    path: config.repoPath,
    remoteName: config.git.remote,
    baseBranch: config.git.baseBranch,
  };
  if (!existsSync(config.repoPath)) {
    return { ...report, ok: false, error: "Repository path does not exist." };
  }

  try {
    const root = await runProcess("git", ["rev-parse", "--show-toplevel"], { cwd: config.repoPath, timeoutMs: 10_000 });
    report.root = root.stdout.trim();
    report.rootMatchesConfiguredPath = path.resolve(report.root) === path.resolve(config.repoPath);
  } catch (error) {
    return { ...report, ok: false, error: `Not a Git repository: ${error.message}` };
  }

  try {
    const status = await runProcess("git", ["status", "--porcelain"], { cwd: config.repoPath, timeoutMs: 10_000 });
    const changedFiles = status.stdout.trim()
      ? status.stdout.trim().split(/\r?\n/).slice(0, 20)
      : [];
    report.clean = changedFiles.length === 0;
    if (changedFiles.length) report.changedFiles = changedFiles;
  } catch (error) {
    report.clean = false;
    report.statusError = error.message;
  }

  try {
    const remote = await runProcess("git", ["remote", "get-url", config.git.remote], { cwd: config.repoPath, timeoutMs: 10_000 });
    report.remote = { ok: true, url: redactRemoteUrl(remote.stdout.trim()) };
  } catch (error) {
    report.remote = { ok: false, error: error.message };
  }

  if (report.remote?.ok) {
    try {
      const branch = await runProcess("git", [
        "ls-remote", "--exit-code", "--heads", config.git.remote, config.git.baseBranch,
      ], { cwd: config.repoPath, timeoutMs: 30_000 });
      report.baseBranchReachable = Boolean(branch.stdout.trim());
    } catch (error) {
      report.baseBranchReachable = false;
      report.baseBranchError = error.message;
    }
  } else {
    report.baseBranchReachable = false;
  }

  report.ok = report.rootMatchesConfiguredPath === true
    && report.clean === true
    && report.remote?.ok === true
    && report.baseBranchReachable === true;
  if (!report.ok && !report.error) {
    if (report.rootMatchesConfiguredPath !== true) report.error = "Git root does not match the configured repository path.";
    else if (report.clean !== true) report.error = "Repository has tracked changes; the factory requires a clean root repository.";
    else if (report.remote?.ok !== true) report.error = `Git remote '${config.git.remote}' is not configured.`;
    else if (report.baseBranchReachable !== true) report.error = `Base branch '${config.git.baseBranch}' is not reachable on remote '${config.git.remote}'.`;
  }
  return report;
}

async function checkStateDatabase(config: FactoryConfig): Promise<CheckReport> {
  try {
    const db = await openStateDatabase(config.stateDir);
    db.close();
    return { ok: true, driver: "node:sqlite", file: path.join(config.stateDir, "factory.db") };
  } catch (error) {
    return { ok: false, file: path.join(config.stateDir, "factory.db"), error: error.message };
  }
}

async function checkAgent(config: FactoryConfig): Promise<CheckReport> {
  try {
    const { agent } = createAgentExecutors(config);
    return {
      ok: true,
      provider: config.provider,
      ...(await agent.health({ requireJiraMcp: config.jira.adapter !== JiraAdapterKind.Rest })),
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function checkGitHub(config: FactoryConfig): Promise<CheckReport> {
  const github = new GitHubCliAdapter({
    ...config.github,
    baseBranch: config.git.baseBranch,
  });
  const report = {
    configured: Boolean(config.github.repositoryFullName),
    command: github.command,
    host: github.host,
    repository: config.github.repositoryFullName,
  };
  if (!report.configured) return { ...report, ok: false, error: "github.repositoryFullName is required" };
  try {
    return { ...report, ok: true, authenticated: true, ...(await github.health()) };
  } catch (error) {
    return { ...report, ok: false, authenticated: false, error: error.message };
  }
}

export function checkJira(config: FactoryConfig, agentCheck: CheckReport): CheckReport {
  const expectedMcp = createAgentStrategy(config.provider).jiraMcpServer;
  if (config.jira.adapter === JiraAdapterKind.CodexMcp) {
    const mcpRegistered = config.provider === AgentProvider.Codex
      && agentCheck.ok === true
      && agentCheck.mcp === expectedMcp;
    const configured = Boolean(config.jira.projectKey);
    return {
      ok: Boolean(configured && mcpRegistered),
      configured: Boolean(config.jira.projectKey),
      adapter: config.jira.adapter,
      projectKey: config.jira.projectKey || "",
      mcpRegistered,
      ...(configured && mcpRegistered ? {} : {
        error: !configured
          ? "jira.projectKey is required."
          : config.provider !== AgentProvider.Codex
            ? "jira.adapter=codex-mcp requires provider=codex; use jira.adapter=rest with OpenCode."
            : `Configured Jira MCP server '${expectedMcp}' is not available.`,
      }),
    };
  }
  if (config.jira.adapter === JiraAdapterKind.OpenCodeMcp) {
    const mcpRegistered = config.provider === AgentProvider.OpenCode
      && agentCheck.ok === true
      && agentCheck.mcp === expectedMcp;
    const configured = Boolean(config.jira.projectKey);
    return {
      ok: Boolean(configured && mcpRegistered),
      configured,
      adapter: config.jira.adapter,
      projectKey: config.jira.projectKey || "",
      providerReady: mcpRegistered,
      mcpRegistered,
      ...(mcpRegistered ? { mcp: expectedMcp } : {}),
      ...(configured && mcpRegistered ? {} : {
        error: !configured
          ? "jira.projectKey is required."
          : `Configured Jira MCP server '${expectedMcp}' is not available through OpenCode.`,
      }),
    };
  }
  const configured = Boolean(config.jira.baseUrl && config.jira.projectKey && config.jira.email && config.jira.apiToken);
  return {
    ok: configured,
    configured,
    adapter: config.jira.adapter,
    projectKey: config.jira.projectKey || "",
    credentialsConfigured: configured,
    ...(configured ? {} : { error: "Jira REST configuration is incomplete." }),
  };
}

export async function commandDoctor(config: FactoryConfig): Promise<DoctorReport> {
  const liveErrors = validateConfig(config, { live: true });
  let providerDetails: Partial<DoctorReport> = {};
  let providerConfigError = "";
  if (config.provider === AgentProvider.OpenCode) {
    try {
      providerDetails = await readOpenCodeDoctorSettings(config);
    } catch (error) {
      providerConfigError = `OpenCode configuration could not be read: ${error.message}`;
    }
  }
  const configurationErrors = providerConfigError ? [...liveErrors, providerConfigError] : liveErrors;
  const report: DoctorReport = {
    repoPath: config.repoPath,
    stateDir: config.stateDir,
    provider: config.provider,
    ...(config.provider === AgentProvider.OpenCode
      ? providerDetails
      : {
          model: config.codex.model,
          reasoningEffort: config.codex.reasoningEffort,
          sandbox: config.codex.sandbox,
          approvalPolicy: config.codex.approvalPolicy,
          contextWindowTokens: config.codex.contextWindowTokens,
          autoCompactTokenLimit: config.codex.autoCompactTokenLimit,
        }),
    jiraAdapter: config.jira.adapter,
    configured: configurationErrors.length === 0,
    configurationErrors,
    checks: {},
  };
  report.checks.node = {
    ok: true,
    version: process.version,
    executable: process.execPath,
  };
  const [gitCheck, repositoryCheck, stateCheck, agentCheck, githubCheck] = await Promise.all([
    checkGitTool(config),
    checkRepository(config),
    checkStateDatabase(config),
    checkAgent(config),
    checkGitHub(config),
  ]);
  report.checks.git = gitCheck;
  report.checks.repository = repositoryCheck;
  report.checks.sqlite = stateCheck;
  report.checks.agent = agentCheck;
  report.checks[config.provider] = agentCheck;
  if (typeof agentCheck.mcp === "string") report.mcp = agentCheck.mcp;
  if (typeof agentCheck.mcpStatus === "string") report.mcpStatus = agentCheck.mcpStatus;
  report.checks.github = githubCheck;
  report.checks.jira = checkJira(config, agentCheck);
  report.checks.configuration = {
    ok: configurationErrors.length === 0,
    errors: configurationErrors,
    ...(configurationErrors.length ? { error: configurationErrors.join("; ") } : {}),
  };
  report.failures = Object.entries(report.checks)
    .filter(([, check]) => check && check.ok === false)
    .map(([name, check]) => ({ check: name, error: check.error || "Check failed" }));
  report.ok = report.failures.length === 0;
  return report;
}
