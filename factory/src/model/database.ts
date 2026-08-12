import type { JiraIssue } from "./jira.js";

export interface FactoryRun {
  id: string;
  issue_key: string;
  project_key: string;
  status: string;
  stage: string;
  attempts: number;
  next_attempt_at: string | null;
  lease_owner: string | null;
  lease_until: string | null;
  issue_json: string;
  plan_json: string | null;
  branch_name: string | null;
  worktree_path: string | null;
  commit_sha: string | null;
  pr_number: number | null;
  pr_url: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface RunPatch {
  status?: string | null;
  stage?: string | null;
  attempts?: number | null;
  next_attempt_at?: string | null;
  lease_owner?: string | null;
  lease_until?: string | null;
  issue_json?: string | null;
  plan_json?: string | null;
  branch_name?: string | null;
  worktree_path?: string | null;
  commit_sha?: string | null;
  pr_number?: number | null;
  pr_url?: string | null;
  last_error?: string | null;
}

export interface StateDatabaseLike {
  close(): void;
  reapExpiredLeases(now?: string): number;
  reapLeasesForOwners(owners: string[], now?: string): number;
  listRuns(limit?: number): FactoryRun[];
  getRun(id: string): FactoryRun | null;
  getActiveRunForIssue(issueKey: string): FactoryRun | null;
  getLastFailedStage(runId: string): string | null;
  acquireLease(id: string, leaseOwner: string, leaseUntil: string): boolean;
  claimRun(input: {
    id: string;
    issueKey: string;
    projectKey: string;
    issue: JiraIssue;
    stage: string;
    leaseOwner: string;
    leaseUntil: string;
  }): { run: FactoryRun | null; claimed: boolean };
  updateRun(id: string, patch: RunPatch): FactoryRun | null;
  startStage(runId: string, stage: string, inputHash?: string): number;
  finishStage(runId: string, stage: string, attempt: number, output: unknown, status?: string, error?: string | null): void;
  countStageAttempts(runId: string, stage: string): number;
  recordArtifact(runId: string, kind: string, artifactKey: string, artifactValue: string): void;
  findArtifact(kind: string, artifactKey: string): { artifact_value: string } | null;
  recordEvent(runId: string, eventType: string, payload: unknown): void;
}
