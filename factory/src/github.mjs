import { existsSync } from "node:fs";
import path from "node:path";
import { runProcess } from "./git.mjs";
import { assertPullRequestTitle } from "./pull-request-title.mjs";

function parseJson(stdout, operation) {
  try {
    return JSON.parse(String(stdout || ""));
  } catch (error) {
    throw new Error(`GitHub CLI returned invalid JSON while ${operation}: ${error.message}`);
  }
}

function repositoryHost(repositoryFullName) {
  const parts = String(repositoryFullName || "").split("/");
  return parts.length >= 3 ? parts[0] : "github.com";
}

function normalizePullRequest(value, fallbackHead) {
  if (!value?.url || !value?.number) throw new Error("GitHub CLI did not return a complete pull-request record.");
  return {
    number: value.number,
    html_url: value.url,
    head: { ref: value.headRefName || fallbackHead },
    base: value.baseRefName ? { ref: value.baseRefName } : undefined,
    title: value.title,
    body: value.body,
  };
}

export function resolveGhCommand(explicitCommand = process.env.FACTORY_GH_COMMAND) {
  if (explicitCommand) return explicitCommand;
  if (process.platform !== "win32") return "gh";

  const candidates = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "GitHub CLI", "gh.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "GitHub CLI", "gh.exe"),
    "C:\\Program Files\\GitHub CLI\\gh.exe",
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || "gh.exe";
}

export class GitHubCliAdapter {
  constructor(config, processRunner = runProcess) {
    this.config = config;
    this.processRunner = processRunner;
    this.command = resolveGhCommand(config.cliCommand);
    this.repository = config.repositoryFullName;
    this.baseBranch = config.baseBranch || "main";
    this.host = repositoryHost(this.repository);
  }

  enabled() {
    return Boolean(this.repository);
  }

  async run(args, options = {}) {
    return this.processRunner(this.command, args, {
      ...options,
      cwd: options.cwd || this.config.repoPath || process.cwd(),
      timeoutMs: options.timeoutMs || this.config.timeoutMs || 120_000,
      signal: options.signal || this.config.signal,
      env: { ...process.env, ...(options.env || {}) },
    });
  }

  async health() {
    await this.run(["auth", "status", "--active", "--hostname", this.host], { timeoutMs: 30_000 });
    const repository = await this.run([
      "repo", "view", this.repository,
      "--json", "nameWithOwner,defaultBranchRef",
    ], { timeoutMs: 30_000 });
    const details = parseJson(repository.stdout, "checking repository access");
    return {
      command: this.command,
      host: this.host,
      repository: this.repository,
      repositoryName: details.nameWithOwner,
      defaultBranch: details.defaultBranchRef?.name || "",
    };
  }

  async findOpenPullRequest(branchName) {
    const result = await this.run([
      "pr", "list",
      "--repo", this.repository,
      "--state", "open",
      "--base", this.baseBranch,
      "--head", branchName,
      "--limit", "100",
      "--json", "number,url,headRefName,baseRefName,title,body",
    ]);
    const pullRequests = parseJson(result.stdout, "listing pull requests");
    const existing = Array.isArray(pullRequests) ? pullRequests[0] : null;
    return existing ? normalizePullRequest(existing, branchName) : null;
  }

  async createPullRequest({ title, taskNumber, taskName, taskType, body, head, base }) {
    const validatedTitle = assertPullRequestTitle(title, { taskNumber, taskName, taskType });
    const targetBase = base || this.baseBranch;
    const existing = await this.findOpenPullRequest(head);
    if (existing) {
      assertPullRequestTitle(existing.title, { taskNumber, taskName, taskType });
      return existing;
    }

    const created = await this.run([
      "pr", "create",
      "--repo", this.repository,
      "--head", head,
      "--base", targetBase,
      "--title", validatedTitle,
      "--body", body,
    ]);
    const url = String(created.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => /^https?:\/\//i.test(line));
    if (!url) throw new Error("GitHub CLI did not return a pull-request URL.");

    const details = await this.run([
      "pr", "view", url,
      "--json", "number,url,headRefName,baseRefName,title,body",
    ]);
    const pullRequest = normalizePullRequest(parseJson(details.stdout, "reading the created pull request"), head);
    assertPullRequestTitle(pullRequest.title, { taskNumber, taskName, taskType });
    return pullRequest;
  }

  async getCommitStatus(commitSha) {
    const result = await this.run(["api", `repos/${this.repository}/commits/${commitSha}/status`]);
    return parseJson(result.stdout, "reading commit status");
  }
}

export class InMemoryGitHubAdapter {
  constructor() {
    this.pullRequests = [];
  }

  enabled() { return true; }

  async createPullRequest(input) {
    const validatedTitle = assertPullRequestTitle(input.title, input);
    const existing = this.pullRequests.find((pr) => pr.head.ref === input.head);
    if (existing) {
      assertPullRequestTitle(existing.title, input);
      return existing;
    }
    const pr = {
      number: this.pullRequests.length + 1,
      html_url: `https://github.test/pr/${this.pullRequests.length + 1}`,
      head: { ref: input.head },
      base: { ref: input.base || "main" },
      title: validatedTitle,
      body: input.body,
    };
    this.pullRequests.push(pr);
    return pr;
  }

  async getCommitStatus() {
    return { state: "success", statuses: [] };
  }
}
