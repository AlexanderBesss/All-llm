export interface PullRequest {
  number: number;
  html_url: string;
  state?: string;
  merged?: boolean;
  mergedAt?: string;
  head: { ref: string };
  base?: { ref: string };
  title?: string;
  body?: string;
  labels?: string[];
}

export interface PullRequestReviewComment {
  id: string;
  author: string;
  body: string;
  path?: string;
  line?: number | null;
  createdAt?: string;
}

export interface PullRequestReviewThread {
  id: string;
  isResolved: boolean;
  comments: PullRequestReviewComment[];
}

export interface PullRequestInput {
  title: string;
  taskNumber: string;
  taskName: string;
  taskType: string;
  body: string;
  head: string;
  base?: string;
}

export interface GitHubAdapter {
  enabled(): boolean;
  createPullRequest(input: PullRequestInput): Promise<PullRequest>;
  getPullRequest(prNumber: number): Promise<PullRequest | null>;
  listOpenPullRequestsByLabel?(label: string): Promise<PullRequest[]>;
  getUnresolvedReviewThreads?(prNumber: number): Promise<PullRequestReviewThread[]>;
  resolveReviewThread?(threadId: string): Promise<void>;
  replyToReviewThread?(prNumber: number, threadId: string, body: string): Promise<void>;
  getCommitStatus?(commitSha: string): Promise<unknown>;
}
