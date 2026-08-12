export interface PullRequest {
  number: number;
  html_url: string;
  head: { ref: string };
  base?: { ref: string };
  title?: string;
  body?: string;
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
  getCommitStatus?(commitSha: string): Promise<unknown>;
}
