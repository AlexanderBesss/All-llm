import { existsSync } from "node:fs";
import path from "node:path";
import { runProcess } from "./git.js";
import { assertPullRequestTitle } from "./pull-request-title.js";
import type { ProcessRunner, ProcessOptions } from "./model/process.js";
import type { GitHubConfig } from "./model/config.js";
import type { PullRequest, PullRequestInput, PullRequestReviewThread } from "./model/github.js";
import { nowIso } from "./types.js";

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
    labels: Array.isArray(value.labels) ? value.labels.map((label) => label?.name || label).filter(Boolean) : [],
  };
}

function graphQlRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function reviewThreadIdsFromGraphQl(value: unknown): { ids: string[]; cursor: string | null; hasNextPage: boolean } {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const data = graphQlRecord(record.data);
  const repository = graphQlRecord(data.repository);
  const pullRequest = graphQlRecord(repository.pullRequest);
  const connection = graphQlRecord(pullRequest.reviewThreads);
  const nodes = Array.isArray(connection.nodes) ? connection.nodes : [];
  const pageInfo = graphQlRecord(connection.pageInfo);
  return {
    ids: nodes.map((node) => graphQlRecord(node)).filter((thread) => thread.isResolved !== true).map((thread) => String(thread.id || "")).filter(Boolean),
    cursor: typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : null,
    hasNextPage: pageInfo.hasNextPage === true,
  };
}

function reviewCommentsFromGraphQl(value: unknown): { comments: PullRequestReviewThread["comments"]; cursor: string | null; hasNextPage: boolean } {
  const data = graphQlRecord(graphQlRecord(value).data);
  const connection = graphQlRecord(graphQlRecord(data.node).comments);
  const nodes = Array.isArray(connection.nodes) ? connection.nodes : [];
  const pageInfo = graphQlRecord(connection.pageInfo);
  return {
    comments: nodes.map((comment) => {
      const item = graphQlRecord(comment);
      const author = graphQlRecord(item.author);
      return {
        id: String(item.id || ""),
        author: String(author.login || "unknown"),
        body: String(item.body || ""),
        ...(typeof item.path === "string" ? { path: item.path } : {}),
        ...(typeof item.line === "number" || item.line === null ? { line: item.line as number | null } : {}),
        ...(typeof item.createdAt === "string" ? { createdAt: item.createdAt } : {}),
      };
    }),
    cursor: typeof pageInfo.endCursor === "string" ? pageInfo.endCursor : null,
    hasNextPage: pageInfo.hasNextPage === true,
  };
}

export function resolveGhCommand(explicitCommand = process.env.FACTORY_GH_COMMAND) {
  if (explicitCommand) return explicitCommand;
  if (process.platform !== "win32") return "gh";

  const candidates = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "GitHub CLI", "gh.exe"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "GitHub CLI", "gh.exe"),
  ].filter(Boolean);
  return candidates.find((candidate) => existsSync(candidate)) || "gh.exe";
}

export class GitHubCliAdapter {
  config: GitHubConfig;
  processRunner: ProcessRunner;
  command: string;
  repository: string;
  baseBranch: string;
  host: string;

  constructor(config: GitHubConfig, processRunner?: ProcessRunner) {
    this.config = config;
    this.processRunner = processRunner || runProcess;
    this.command = resolveGhCommand(config.cliCommand);
    this.repository = config.repositoryFullName;
    this.baseBranch = config.baseBranch || "main";
    this.host = repositoryHost(this.repository);
  }

  enabled() {
    return Boolean(this.repository);
  }

  async run(args: string[], options: ProcessOptions = {}) {
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

  async createPullRequest({ title, taskNumber, taskName, taskType, body, head, base }: PullRequestInput): Promise<PullRequest> {
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
      "--label", "review",
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

  async getPullRequest(prNumber: number): Promise<PullRequest | null> {
    const result = await this.run([
      "pr", "view", String(prNumber),
      "--repo", this.repository,
      "--json", "number,url,headRefName,baseRefName,title,body,state,mergedAt",
    ]);
    const data = parseJson(result.stdout, "reading pull request");
    return {
      number: data.number,
      html_url: data.url,
      head: { ref: data.headRefName },
      base: data.baseRefName ? { ref: data.baseRefName } : undefined,
      title: data.title,
      body: data.body,
      state: data.state,
      merged: Boolean(data.mergedAt),
      mergedAt: data.mergedAt,
    };
  }

  async listOpenPullRequestsByLabel(label: string): Promise<PullRequest[]> {
    const result = await this.run([
      "pr", "list", "--repo", this.repository, "--state", "open", "--label", label,
      "--limit", "1000", "--json", "number,url,headRefName,baseRefName,title,body,labels",
    ]);
    const values = parseJson(result.stdout, `listing open pull requests labeled ${label}`);
    if (!Array.isArray(values)) throw new Error("GitHub CLI did not return a pull-request list.");
    return values.map((value) => normalizePullRequest(value, value?.headRefName));
  }

  async getUnresolvedReviewThreads(prNumber: number): Promise<PullRequestReviewThread[]> {
    const query = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{id isResolved}pageInfo{hasNextPage endCursor}}}}}`;
    const commentsQuery = `query($threadId:ID!,$cursor:String){node(id:$threadId){... on PullRequestReviewThread{comments(first:100,after:$cursor){nodes{id author{login} body path line createdAt}pageInfo{hasNextPage endCursor}}}}}`;
    const [owner, name] = this.repository.split("/").slice(-2);
    const threadIds: string[] = [];
    let cursor: string | null = null;
    do {
      const args = ["api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${prNumber}`];
      if (cursor) args.push("-F", `cursor=${cursor}`);
      const result = await this.run(args);
      const page = reviewThreadIdsFromGraphQl(parseJson(result.stdout, `reading review threads for pull request #${prNumber}`));
      threadIds.push(...page.ids);
      cursor = page.hasNextPage ? page.cursor : null;
      if (page.hasNextPage && !cursor) throw new Error("GitHub review-thread pagination did not return a cursor.");
    } while (cursor);
    const threads: PullRequestReviewThread[] = [];
    for (const threadId of threadIds) {
      const comments: PullRequestReviewThread["comments"] = [];
      cursor = null;
      do {
        const args = ["api", "graphql", "-f", `query=${commentsQuery}`, "-F", `threadId=${threadId}`];
        if (cursor) args.push("-F", `cursor=${cursor}`);
        const result = await this.run(args);
        const page = reviewCommentsFromGraphQl(parseJson(result.stdout, `reading comments for review thread ${threadId}`));
        comments.push(...page.comments);
        cursor = page.hasNextPage ? page.cursor : null;
        if (page.hasNextPage && !cursor) throw new Error("GitHub review-comment pagination did not return a cursor.");
      } while (cursor);
      threads.push({ id: threadId, isResolved: false, comments });
    }
    return threads;
  }

  async resolveReviewThread(threadId: string): Promise<void> {
    const query = `mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}`;
    await this.run(["api", "graphql", "-f", `query=${query}`, "-F", `threadId=${threadId}`]);
  }

  async replyToReviewThread(_prNumber: number, threadId: string, body: string): Promise<void> {
    const query = `mutation($threadId:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){comment{id}}}`;
    await this.run(["api", "graphql", "-f", `query=${query}`, "-F", `threadId=${threadId}`, "-f", `body=${body}`]);
  }

  async getCommitStatus(commitSha) {
    const result = await this.run(["api", `repos/${this.repository}/commits/${commitSha}/status`]);
    return parseJson(result.stdout, "reading commit status");
  }
}

export class InMemoryGitHubAdapter {
  pullRequests: PullRequest[];
  reviewThreads = new Map<number, PullRequestReviewThread[]>();
  reviewReplies: Array<{ prNumber: number; threadId: string; body: string }> = [];

  constructor() {
    this.pullRequests = [];
  }

  enabled() { return true; }

  async createPullRequest(input: PullRequestInput): Promise<PullRequest> {
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
      labels: ["review"],
    };
    this.pullRequests.push(pr);
    return pr;
  }

  async listOpenPullRequestsByLabel(label: string): Promise<PullRequest[]> {
    return this.pullRequests.filter((pr) => pr.state !== "closed" && pr.labels?.includes(label)).map((pr) => ({ ...pr }));
  }

  async getUnresolvedReviewThreads(prNumber: number): Promise<PullRequestReviewThread[]> {
    return (this.reviewThreads.get(prNumber) || []).filter((thread) => !thread.isResolved).map((thread) => ({ ...thread, comments: [...thread.comments] }));
  }

  async resolveReviewThread(threadId: string): Promise<void> {
    for (const threads of this.reviewThreads.values()) {
      const thread = threads.find((candidate) => candidate.id === threadId);
      if (thread) thread.isResolved = true;
    }
  }

  async replyToReviewThread(prNumber: number, threadId: string, body: string): Promise<void> {
    this.reviewReplies.push({ prNumber, threadId, body });
  }

  async getPullRequest(prNumber: number): Promise<PullRequest | null> {
    const pr = this.pullRequests.find((p) => p.number === prNumber);
    return pr ? { ...pr } : null;
  }

  async mergePullRequest(prNumber: number): Promise<PullRequest> {
    const pr = this.pullRequests.find((p) => p.number === prNumber);
    if (!pr) throw new Error(`PR #${prNumber} not found`);
    pr.merged = true;
    pr.mergedAt = nowIso();
    pr.state = "closed";
    return { ...pr };
  }

  async getCommitStatus() {
    return { state: "success", statuses: [] };
  }
}
