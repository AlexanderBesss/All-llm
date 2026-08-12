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
  headSha(worktreePath: string): Promise<string>;
  assertFileCommitted?(worktreePath: string, relativePath: string): Promise<void>;
}

export type GitProcessRunner = ProcessRunner;
