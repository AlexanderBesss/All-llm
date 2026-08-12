import type { JsonValue } from "./common.js";

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
  status?: string;
  issuetype?: string;
  labels?: string[];
  projectKey?: string;
  parentKey?: string;
  sprint?: JsonValue;
}

export interface JiraAdapter {
  enabled(): boolean;
  searchReady(): Promise<JiraIssue[]>;
  getIssue(issueKey: string): Promise<JiraIssue>;
  transition(issueKey: string, statusName: string): Promise<unknown>;
  updateDescription(issueKey: string, description: string): Promise<unknown>;
  addComment(issueKey: string, body: string): Promise<unknown>;
}

export interface JiraMutationResult {
  ok: boolean;
  details?: string;
}

export interface JiraStructuredResponse {
  issues?: JiraSearchItem[];
  ok?: boolean;
  details?: string;
}

export interface JiraExecutor {
  run(input: { task: string; context?: string; cwd: string; outputSchema: string }): Promise<{ output: string }>;
}

export interface JiraFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface JiraFetch {
  (input: URL | string, init?: RequestInit): Promise<JiraFetchResponse>;
}
