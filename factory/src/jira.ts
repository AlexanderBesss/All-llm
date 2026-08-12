import { assertNonEmpty } from "./types.js";
import type { JiraApiResponse, JiraFetch, JiraIssue, JiraIssueLike, JiraTransition } from "./model/jira.js";
import type { JiraConfig } from "./model/config.js";
import type { JsonValue } from "./model/common.js";

export const BOARD_TRIGGER_JQL = "sprint IS NOT EMPTY";

export function isIssueOnBoard(issue: JiraIssueLike) {
  const sprint = issue?.fields?.sprint ?? issue?.fields?.customfield_10020 ?? issue?.sprint;
  if (Array.isArray(sprint)) return sprint.length > 0;
  if (sprint && typeof sprint === "object") return Object.keys(sprint).length > 0;
  return typeof sprint === "string" ? sprint.trim().length > 0 : Boolean(sprint);
}

export class JiraApiError extends Error {
  status: number;
  body: unknown;

  constructor(message, status, body) {
    super(message);
    this.name = "JiraApiError";
    this.status = status;
    this.body = body;
  }
}

export class JiraIssueNotFoundError extends Error {
  code: string;
  issueKey: string;

  constructor(issueKey, cause = undefined) {
    super(`Jira issue ${issueKey} no longer exists.`, { cause });
    this.name = "JiraIssueNotFoundError";
    this.code = "JIRA_ISSUE_NOT_FOUND";
    this.issueKey = issueKey;
  }
}

export function textToAdf(value: unknown) {
  const text = String(value ?? "");
  const lines = text.split(/\r?\n/);
  return {
    type: "doc",
    version: 1,
    content: lines.length === 0
      ? [{ type: "paragraph", content: [] }]
      : lines.map((line) => ({
        type: "paragraph",
        content: line ? [{ type: "text", text: line }] : [],
      })),
  };
}

export function adfToText(value: unknown) {
  if (!value) return "";
  if (typeof value === "string") return value;
  const result = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "text") result.push(node.text || "");
    if (node.type === "paragraph" || node.type === "heading" || node.type === "listItem") result.push("\n");
    for (const child of node.content || []) visit(child);
  };
  visit(value);
  return result.join("").replace(/^\n+|\n+$/g, "").replace(/\n{3,}/g, "\n\n");
}

export class JiraRestAdapter {
  config: JiraConfig;
  fetch: JiraFetch;
  baseUrl: string;
  auth: string;

  constructor(config: JiraConfig, fetchImpl: JiraFetch = globalThis.fetch as JiraFetch) {
    this.config = config;
    this.fetch = fetchImpl;
    this.baseUrl = String(config.baseUrl || "").replace(/\/+$/, "");
    this.auth = config.email && config.apiToken
      ? `Basic ${Buffer.from(`${config.email}:${config.apiToken}`).toString("base64")}`
      : "";
  }

  enabled() {
    return Boolean(this.baseUrl && this.auth && this.config.projectKey);
  }

  async request(method: string, endpoint: string, body: unknown = undefined, { searchParams }: { searchParams?: Record<string, unknown> } = {}): Promise<JiraApiResponse> {
    assertNonEmpty(this.baseUrl, "Jira base URL");
    const url = new URL(`${this.baseUrl}${endpoint}`);
    for (const [key, value] of Object.entries(searchParams || {})) {
      if (value != null) url.searchParams.set(key, String(value));
    }
    const response = await this.fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: this.auth,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      signal: this.config.signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
    if (!response.ok) {
      throw new JiraApiError(`Jira ${method} ${endpoint} failed (${response.status})`, response.status, parsed);
    }
    return (parsed && typeof parsed === "object" ? parsed : {}) as JiraApiResponse;
  }

  async search(jql: string, fields = ["summary", "description", "status", "issuetype", "labels", "parent", "project"]): Promise<JiraIssue[]> {
    const result = await this.request("POST", "/rest/api/3/search/jql", {
      jql,
      maxResults: 50,
      fields,
    });
    return result?.issues || [];
  }

  async searchReady() {
    const project = this.config.projectKey;
    const status = this.config.readyStatus || "Ready";
    const jql = `project = ${project} AND status = "${status.replace(/"/g, "\\\"")}" AND ${BOARD_TRIGGER_JQL} ORDER BY priority DESC, updated ASC`;
    return this.search(jql);
  }

  async getIssue(issueKey: string): Promise<JiraIssue> {
    try {
      return await this.request("GET", `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, undefined, {
        searchParams: { fields: "summary,description,status,issuetype,labels,parent,project,comment" },
      }) as unknown as JiraIssue;
    } catch (error) {
      if (error?.status === 404) throw new JiraIssueNotFoundError(issueKey, error);
      throw error;
    }
  }

  async getTransitions(issueKey: string): Promise<JiraTransition[]> {
    const result = await this.request("GET", `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`);
    return result?.transitions || [];
  }

  async transition(issueKey, statusName) {
    const wanted = String(statusName).trim().toLowerCase();
    const transitions = await this.getTransitions(issueKey);
    const match = transitions.find((item) => String(item.name).trim().toLowerCase() === wanted);
    if (!match) {
      throw new JiraApiError(
        `No Jira transition named '${statusName}' is available for ${issueKey}.`,
        409,
        { transitions: transitions.map((item) => ({ id: item.id, name: item.name })) },
      );
    }
    return this.request("POST", `/rest/api/3/issue/${encodeURIComponent(issueKey)}/transitions`, {
      transition: { id: match.id },
    });
  }

  async updateIssue(issueKey: string, fields: Record<string, unknown>) {
    return this.request("PUT", `/rest/api/3/issue/${encodeURIComponent(issueKey)}`, { fields });
  }

  async updateDescription(issueKey, description) {
    return this.updateIssue(issueKey, { description: textToAdf(description) });
  }

  async addComment(issueKey, body) {
    return this.request("POST", `/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment`, {
      body: textToAdf(body),
    });
  }

}

export class InMemoryJiraAdapter {
  issues: Map<string, JiraIssue>;
  comments: Array<{ issueKey: string; body: string }>;
  transitions: Array<{ key: string; statusName: string }>;

  constructor(issues: JiraIssue[] = []) {
    this.issues = new Map(issues.map((issue) => [issue.key, structuredClone(issue)]));
    this.comments = [];
    this.transitions = [];
  }

  enabled() { return true; }

  async searchReady(): Promise<JiraIssue[]> {
    return [...this.issues.values()].filter((issue) =>
      issue.fields?.status?.name === "Ready" && isIssueOnBoard(issue));
  }

  async getIssue(key) {
    const issue = this.issues.get(key);
    if (!issue) throw new JiraIssueNotFoundError(key);
    return structuredClone(issue);
  }

  async transition(key, statusName) {
    const issue = await this.getIssue(key);
    issue.fields.status = { name: statusName };
    this.issues.set(key, issue);
    this.transitions.push({ key, statusName });
  }

  async updateDescription(key, description) {
    const issue = await this.getIssue(key);
    issue.fields.description = description;
    this.issues.set(key, issue);
  }

  async addComment(issueKey, body) {
    this.comments.push({ issueKey, body });
  }

}
