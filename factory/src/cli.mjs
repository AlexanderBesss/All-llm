import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, validateConfig } from "./config.mjs";
import { openStateDatabase } from "./db.mjs";
import { JiraRestAdapter } from "./jira.mjs";
import { CodexJiraAdapter } from "./codex-jira.mjs";
import { GitHubCliAdapter } from "./github.mjs";
import { GitAdapter, isAbortError, runProcess } from "./git.mjs";
import { CodexAgentExecutor } from "./codex.mjs";
import { FactoryWorker, runLoop } from "./worker.mjs";

function defaultRepoPath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function parseArgs(argv) {
  const result = { command: argv[0] || "help" };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") result.config = argv[++i];
    else if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--json") result.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function normalizedJiraConfig(config, signal) {
  return {
    ...config.jira,
    repoPath: config.repoPath,
    readyStatus: config.jira.statuses.ready,
    signal,
  };
}

function normalizedGitConfig(config, signal) {
  return {
    ...config.git,
    repoPath: config.repoPath,
    stateDir: config.stateDir,
    signal,
  };
}

function normalizedGitHubConfig(config, signal) {
  return {
    ...config.github,
    baseBranch: config.git.baseBranch,
    signal,
  };
}

async function makeWorker(config, signal) {
  const db = await openStateDatabase(config.stateDir);
  try {
    const github = new GitHubCliAdapter(normalizedGitHubConfig(config, signal));
    await github.health();
    const git = new GitAdapter(normalizedGitConfig(config, signal));
    const agent = new CodexAgentExecutor({ ...config, signal });
    const jira = config.jira.adapter === "rest"
      ? new JiraRestAdapter(normalizedJiraConfig(config, signal))
      : new CodexJiraAdapter(normalizedJiraConfig(config, signal), agent);
    return { db, worker: new FactoryWorker({ config, db, jira, github, git, agent }) };
  } catch (error) {
    db.close();
    throw error;
  }
}

function redactRemoteUrl(value) {
  return String(value || "").replace(/(https?:\/\/)[^/@]+@/i, "$1[redacted]@");
}

async function checkGitTool(config) {
  try {
    const result = await runProcess("git", ["--version"], { cwd: config.repoPath, timeoutMs: 10_000 });
    return { ok: true, version: result.stdout.trim() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function checkRepository(config) {
  const report = {
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

async function checkStateDatabase(config) {
  try {
    const db = await openStateDatabase(config.stateDir);
    db.close();
    return { ok: true, driver: "node:sqlite", file: path.join(config.stateDir, "factory.db") };
  } catch (error) {
    return { ok: false, file: path.join(config.stateDir, "factory.db"), error: error.message };
  }
}

async function checkCodex(config) {
  try {
    const codex = new CodexAgentExecutor(config);
    return { ok: true, ...(await codex.health()) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function checkGitHub(config) {
  const github = new GitHubCliAdapter(normalizedGitHubConfig(config));
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

function checkJira(config, codexCheck) {
  if (config.jira.adapter === "codex-mcp") {
    const mcpRegistered = codexCheck.ok === true && codexCheck.mcp === "Atlassian-Rovo-MCP";
    const configured = Boolean(config.jira.projectKey);
    return {
      ok: Boolean(configured && mcpRegistered),
      configured: Boolean(config.jira.projectKey),
      adapter: config.jira.adapter,
      projectKey: config.jira.projectKey || "",
      mcpRegistered,
      ...(configured && mcpRegistered ? {} : {
        error: !configured ? "jira.projectKey is required." : "Atlassian-Rovo-MCP is not available through Codex.",
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

async function commandDoctor(config) {
  const liveErrors = validateConfig(config, { live: true });
  const report = {
    repoPath: config.repoPath,
    stateDir: config.stateDir,
    model: config.codex.model,
    reasoningEffort: config.codex.reasoningEffort,
    sandbox: config.codex.sandbox,
    approvalPolicy: config.codex.approvalPolicy,
    contextWindowTokens: config.codex.contextWindowTokens,
    autoCompactTokenLimit: config.codex.autoCompactTokenLimit,
    jiraAdapter: config.jira.adapter,
    configured: liveErrors.length === 0,
    configurationErrors: liveErrors,
    checks: {},
  };
  report.checks.node = {
    ok: true,
    version: process.version,
    executable: process.execPath,
  };
  const [gitCheck, repositoryCheck, stateCheck, codexCheck, githubCheck] = await Promise.all([
    checkGitTool(config),
    checkRepository(config),
    checkStateDatabase(config),
    checkCodex(config),
    checkGitHub(config),
  ]);
  report.checks.git = gitCheck;
  report.checks.repository = repositoryCheck;
  report.checks.sqlite = stateCheck;
  report.checks.codex = codexCheck;
  report.checks.github = githubCheck;
  report.checks.jira = checkJira(config, codexCheck);
  report.checks.configuration = {
    ok: liveErrors.length === 0,
    errors: liveErrors,
    ...(liveErrors.length ? { error: liveErrors.join("; ") } : {}),
  };
  report.failures = Object.entries(report.checks)
    .filter(([, check]) => check && check.ok === false)
    .map(([name, check]) => ({ check: name, error: check.error || "Check failed" }));
  report.ok = report.failures.length === 0;
  return report;
}

async function commandStatus(config, asJson) {
  const db = await openStateDatabase(config.stateDir);
  const rows = db.listRuns(50);
  db.close();
  if (asJson) console.log(JSON.stringify(rows, null, 2));
  else if (!rows.length) console.log("No factory runs recorded.");
  else console.table(rows.map((row) => ({ id: row.id, issue: row.issue_key, status: row.status, stage: row.stage, pr: row.pr_url || "", error: row.last_error || "" })));
}

async function commandInstall(config) {
  const scriptPath = path.join(config.repoPath, "factory", "install-task.ps1");
  console.log(`Run this command from an elevated PowerShell prompt to install the restartable worker:\n\n  & '${scriptPath}' -RepoPath '${config.repoPath}' -ConfigPath '${process.env.FACTORY_CONFIG || ""}'`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const config = await loadConfig(args.config, defaultRepoPath());
  if (args.command === "help") {
    console.log("Usage: node factory/src/cli.mjs <doctor|run-once|start|status|install> [--config path] [--dry-run] [--json]");
    return 0;
  }
  if (args.command === "doctor") {
    const report = await commandDoctor(config);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    return report.ok ? 0 : 1;
  }
  if (args.command === "status") {
    await commandStatus(config, args.json);
    return 0;
  }
  if (args.command === "install") {
    await commandInstall(config);
    return 0;
  }
  if (!["run-once", "start"].includes(args.command)) throw new Error(`Unknown command: ${args.command}`);
  const errors = validateConfig(config, { live: true });
  if (errors.length) throw new Error(`Factory is not configured:\n- ${errors.join("\n- ")}`);
  const controller = new AbortController();
  const onShutdown = () => {
    if (controller.signal.aborted) return;
    console.warn("[factory] shutdown requested; cancelling active operations...");
    controller.abort();
  };
  const shutdownSignals = ["SIGINT", "SIGTERM"];
  if (process.platform === "win32") shutdownSignals.push("SIGBREAK");
  shutdownSignals.forEach((name) => process.once(name, onShutdown));
  let db;
  let runtimeWorker;
  try {
    ({ db, worker: runtimeWorker } = await makeWorker(config, controller.signal));
    if (args.command === "run-once") console.log(JSON.stringify(await runtimeWorker.runOnce({ dryRun: args.dryRun }), null, 2));
    else await runLoop(runtimeWorker, { signal: controller.signal, pollIntervalMs: config.pollIntervalMs });
  } finally {
    shutdownSignals.forEach((name) => process.removeListener(name, onShutdown));
    db?.close();
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    if (isAbortError(error)) {
      console.log("[factory] shutdown complete.");
      process.exitCode = 0;
      return;
    }
    console.error(error.stack || error.message || error);
    process.exitCode = 1;
  });
}
