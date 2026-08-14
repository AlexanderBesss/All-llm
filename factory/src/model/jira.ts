import type { JsonValue } from "./common.js";
import type { AgentToolScope, AgentWorkspaceAccess } from "./codex.js";

export enum JiraErrorCode {
  IssueNotFound = "JIRA_ISSUE_NOT_FOUND",
}

export interface JiraStatus {
  name: string;
}

export type JiraDescription = string | JsonValue;

export interface JiraIssueFields {
  summary?: string;
  description?: JiraDescription;
  status?: JiraStatus;
  issuetype?: JiraStatus;
  labels?: string[];
  project?: { key?: string };
  parent?: { key?: string };
  sprint?: JsonValue;
  customfield_10020?: JsonValue;
}

export interface JiraIssue {
  key: string;
  fields: JiraIssueFields;
}

export interface JiraIssueLike {
  fields?: JiraIssueFields;
  sprint?: JsonValue;
}

export interface JiraTransition {
  id: string;
  name: string;
}

export interface JiraApiResponse {
  issues?: JiraIssue[];
  transitions?: JiraTransition[];
  [key: string]: unknown;
}

export interface JiraSearchItem {
  key: string;
  summary?: string;
  description?: JiraDescription;
  status?: string | JiraStatus | null;
  issuetype?: string | JiraStatus | null;
  labels?: string[];
  projectKey?: string | { key: string } | null;
  parentKey?: string | { key: string } | null;
  sprint?: JsonValue;
}

export interface JiraAdapter {
  enabled(): boolean;
  searchPlanning(): Promise<JiraIssue[]>;
  searchReady(): Promise<JiraIssue[]>;
  getIssue(issueKey: string): Promise<JiraIssue>;
  transition(issueKey: string, statusName: string): Promise<unknown>;
  updateDescription(issueKey: string, description: string): Promise<unknown>;
  updateSummaryAndDescription(issueKey: string, summary: string, description: string): Promise<unknown>;
  addComment(issueKey: string, body: string): Promise<unknown>;
  commentExists(issueKey: string, body: string): Promise<boolean>;
}

export interface JiraMutationResult {
  ok: boolean;
  details?: string;
}

export interface JiraStructuredResponse {
  issues?: JiraSearchItem[];
  ok?: boolean;
  issueKey?: string;
  key?: string;
  details?: string;
  exists?: boolean;
}

export interface JiraExecutor {
  run(input: { task: string; context?: string; cwd: string; outputSchema: string; timeoutMs?: number; agent?: string; model?: string; reasoningEffort?: string; toolScope?: AgentToolScope; workspaceAccess?: AgentWorkspaceAccess }): Promise<{
    output: string;
    events?: Array<Record<string, unknown>>;
  }>;
}

export interface JiraFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface JiraFetch {
  (input: URL | string, init?: RequestInit): Promise<JiraFetchResponse>;
}
