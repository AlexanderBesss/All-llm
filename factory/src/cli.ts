import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, validateConfig } from "./config.js";
import { openStateDatabase } from "./db.js";
import { JiraRestAdapter } from "./jira.js";
import { GitHubCliAdapter } from "./github.js";
import { GitAdapter, isAbortError } from "./git.js";
import { createAgentExecutors } from "./agent-strategy.js";
import { formatFactoryLog } from "./types.js";
import { FactoryWorker, runLoop, runMergeCheckLoop } from "./worker.js";
import { commandDoctor } from "./cli/doctor.js";
import { CliCommand } from "./model/cli.js";
import { JiraAdapterKind } from "./model/config.js";
import type { CliArgs } from "./model/cli.js";
import type { FactoryConfig, GitConfig, GitHubConfig, JiraConfig } from "./model/config.js";

export { checkJira } from "./cli/doctor.js";

function defaultRepoPath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function parseArgs(argv: string[]): CliArgs {
  const result: CliArgs = { command: argv[0] || CliCommand.Help };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--config") result.config = argv[++i];
    else if (arg === "--dry-run") result.dryRun = true;
    else if (arg === "--json") result.json = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

function normalizedJiraConfig(config: FactoryConfig, signal?: AbortSignal): JiraConfig {
  return {
    ...config.jira,
    repoPath: config.repoPath,
    readyStatus: config.jira.statuses.ready,
    signal,
  };
}

function normalizedGitConfig(config: FactoryConfig, signal?: AbortSignal): GitConfig {
  return {
    ...config.git,
    repoPath: config.repoPath,
    stateDir: config.stateDir,
    signal,
  };
}

function normalizedGitHubConfig(config: FactoryConfig, signal?: AbortSignal): GitHubConfig {
  return {
    ...config.github,
    baseBranch: config.git.baseBranch,
    signal,
  };
}

async function makeWorker(config: FactoryConfig, signal?: AbortSignal, { syncBaseBranch = true } = {}) {
  const git = new GitAdapter(normalizedGitConfig(config, signal));
  if (syncBaseBranch) await git.syncBaseBranch();
  const db = await openStateDatabase(config.stateDir);
  try {
    const github = new GitHubCliAdapter(normalizedGitHubConfig(config, signal));
    await github.health();
    const { strategy, agent, reviewer } = createAgentExecutors(config, signal);
    await agent.health({ requireJiraMcp: config.jira.adapter !== JiraAdapterKind.Rest });
    const jira = config.jira.adapter === JiraAdapterKind.Rest
      ? new JiraRestAdapter(normalizedJiraConfig(config, signal))
      : strategy.createJiraAdapter(normalizedJiraConfig(config, signal), agent);
    return { db, worker: new FactoryWorker({ config, db, jira, github, git, agent, reviewer, signal }) };
  } catch (error) {
    db.close();
    throw error;
  }
}

async function commandStatus(config: FactoryConfig, asJson = false) {
  const db = await openStateDatabase(config.stateDir);
  const rows = db.listRuns(50);
  db.close();
  if (asJson) console.log(JSON.stringify(rows, null, 2));
  else if (!rows.length) console.log("No factory runs recorded.");
  else console.table(rows.map((row) => ({ id: row.id, issue: row.issue_key, status: row.status, stage: row.stage, pr: row.pr_url || "", error: row.last_error || "" })));
}

async function commandInstall(config: FactoryConfig) {
  const scriptPath = path.join(config.repoPath, "factory", "install-task.ps1");
  console.log(`Run this command from an elevated PowerShell prompt to install the restartable worker:\n\n  & '${scriptPath}' -RepoPath '${config.repoPath}' -ConfigPath '${process.env.FACTORY_CONFIG || ""}'`);
}

export async function main(argv: string[] = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const config = await loadConfig(args.config, defaultRepoPath());
  if (args.command === CliCommand.Help) {
    console.log("Usage: node factory/dist/cli.js <doctor|run-once|start|start-jira-tasks|start-pull-request-check|status|install> [--config path] [--dry-run] [--json]");
    return 0;
  }
  if (args.command === CliCommand.Doctor) {
    const report = await commandDoctor(config);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    return report.ok ? 0 : 1;
  }
  if (args.command === CliCommand.Status) {
    await commandStatus(config, args.json);
    return 0;
  }
  if (args.command === CliCommand.Install) {
    await commandInstall(config);
    return 0;
  }
  const loopCommands = [
    CliCommand.Start,
    CliCommand.StartJiraTasks,
    CliCommand.StartPullRequestCheck,
  ];
  if (![CliCommand.RunOnce, ...loopCommands].includes(args.command as CliCommand)) throw new Error(`Unknown command: ${args.command}`);
  const errors = validateConfig(config, { live: true });
  if (errors.length) throw new Error(`Factory is not configured:\n- ${errors.join("\n- ")}`);
  const controller = new AbortController();
  const onShutdown = () => {
    if (controller.signal.aborted) return;
    console.warn(formatFactoryLog("shutdown requested; cancelling active operations..."));
    controller.abort();
  };
  const shutdownSignals = ["SIGINT", "SIGTERM"];
  if (process.platform === "win32") shutdownSignals.push("SIGBREAK");
  shutdownSignals.forEach((name) => process.once(name, onShutdown));
  let db;
  let runtimeWorker;
  try {
    ({ db, worker: runtimeWorker } = await makeWorker(config, controller.signal, {
      // The pull-request checker only reads GitHub and updates Jira. Avoid
      // making two independently started loops synchronize the repository at
      // the same time.
      syncBaseBranch: args.command !== CliCommand.StartPullRequestCheck,
    }));
    if (args.command === CliCommand.RunOnce) console.log(JSON.stringify(await runtimeWorker.runOnce({ dryRun: args.dryRun }), null, 2));
    else if (args.command === CliCommand.StartJiraTasks) {
      await runLoop(runtimeWorker, { signal: controller.signal, pollIntervalMs: config.pollIntervalMs });
    } else if (args.command === CliCommand.StartPullRequestCheck) {
      await runMergeCheckLoop(runtimeWorker, { signal: controller.signal, intervalMs: config.mergeCheckIntervalMs });
    } else {
      await Promise.all([
        runLoop(runtimeWorker, { signal: controller.signal, pollIntervalMs: config.pollIntervalMs }),
        runMergeCheckLoop(runtimeWorker, { signal: controller.signal, intervalMs: config.mergeCheckIntervalMs }),
      ]);
    }
  } finally {
    shutdownSignals.forEach((name) => process.removeListener(name, onShutdown));
    db?.close();
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    if (isAbortError(error)) {
      console.log(formatFactoryLog("shutdown complete."));
      process.exitCode = 0;
      return;
    }
    console.error(formatFactoryLog(`fatal: ${error.stack || error.message || error}`));
    process.exitCode = 1;
  });
}
