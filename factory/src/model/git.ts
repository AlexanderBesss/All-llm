import type { ProcessRunner } from "./process.js";

export interface GitAdapterConfig {
  repoPath: string;
  remote?: string;
  baseBranch?: string;
  stateDir?: string;
  signal?: AbortSignal;
}

export interface GitAdapterLike {
  prepareWorktree(runId: string, branchName: string): Promise<string>;
  preparePullRequestWorktree(runId: string, branchName: string): Promise<string>;
  headSha(worktreePath: string): Promise<string>;
  hasChanges(worktreePath: string): Promise<boolean>;
  assertFileCommitted(worktreePath: string, relativePath: string): Promise<void>;
  assertBranchPublished(worktreePath: string, branchName: string): Promise<string>;
  changedFiles(worktreePath: string): Promise<string[]>;
}

export type GitProcessRunner = ProcessRunner;
