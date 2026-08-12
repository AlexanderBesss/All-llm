import path from "node:path";
import { runProcess } from "./git.js";
import { CodexAgentExecutor } from "./codex.js";
import type { ProcessRunner } from "./model/process.js";
import type { CodexAgentConfig, CodexJsonLinesResult, CodexRunInput } from "./model/codex.js";

function defaultOpenCodeEntry() {
  if (process.env.OPENCODE_COMMAND) return process.env.OPENCODE_COMMAND;
  if (process.platform === "win32" && process.env.APPDATA) {
    return path.join(process.env.APPDATA, "npm", "opencode.cmd");
  }
  return "opencode";
}

function opencodeInvocation(command = "") {
  return { command: command || defaultOpenCodeEntry(), prefix: [] as string[] };
}

/** Extract the final assistant text from OpenCode's JSON event stream. */
export function parseOpenCodeOutput(stdout: string): CodexJsonLinesResult {
  const events: Array<Record<string, unknown>> = [];
  const invalidLines: string[] = [];
  const textParts: string[] = [];
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      events.push(event);
      const type = String(event.type || "");
      const part = event.part && typeof event.part === "object" ? event.part as Record<string, unknown> : undefined;
      const text = part?.text ?? (type === "text" ? event.text : undefined);
      if (typeof text === "string") textParts.push(text);
    } catch {
      invalidLines.push(line);
    }
  }
  const output = textParts.join("").trim();
  if (!output) {
    const detail = invalidLines.length ? ` Invalid output: ${invalidLines.join(" ").slice(0, 1000)}` : "";
    throw new Error(`OpenCode returned no final agent message.${detail}`);
  }
  return { output, events: events as CodexJsonLinesResult["events"] };
}

/** OpenCode implementation of the same executor contract used by the worker. */
export class OpenCodeAgentExecutor extends CodexAgentExecutor {
  declare config: CodexAgentConfig;
  declare processRunner: ProcessRunner;

  constructor(config: CodexAgentConfig, processRunner: ProcessRunner = runProcess) {
    super(config, processRunner);
    this.config = config;
    this.processRunner = processRunner;
  }

  invocation() {
    return opencodeInvocation(this.config.opencode?.command);
  }

  runtimeEnv() {
    const configuredPath = this.config.opencode?.configPath || "opencode.json";
    const configPath = path.isAbsolute(configuredPath)
      ? path.normalize(configuredPath)
      : path.resolve(this.config.repoPath, configuredPath);
    const configHome = this.config.stateDir
      ? path.join(this.config.stateDir, "opencode-config")
      : undefined;
    return {
      ...process.env,
      CODEX_HOME: process.env.CODEX_HOME || "",
      OPENCODE_CONFIG: process.env.OPENCODE_CONFIG || configPath,
      // Keep OpenCode config discovery isolated from a stale global Windows
      // config directory while preserving the user's data/auth location.
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || configHome,
      // `--auto` handles prompts; this setting grants the build agent the
      // same unattended tool access as the Codex strategy.
      OPENCODE_PERMISSION: process.env.OPENCODE_PERMISSION || JSON.stringify("allow"),
    };
  }

  async run({ task, context = "", cwd, outputSchema }: CodexRunInput) {
    const settings = this.config.opencode || {};
    const prompt = `${task}\n\n${context}\n\nReturn only the requested structured result. Do not include commentary outside the result.`;
    const directory = settings.directory || cwd;
    const args = [
      "run",
      "--model", settings.model || "llamacpp/unsloth/Qwen3.6-27B-UD-Q4_K_XL",
      "--agent", settings.agent || "build",
      "--format", "json",
      "--auto",
      "--dir", directory,
      prompt,
    ];
    const result = await this.processRunner(this.invocation().command, args, {
      cwd: this.config.repoPath,
      timeoutMs: settings.timeoutMs || 1_200_000,
      signal: this.config.signal,
      env: this.runtimeEnv(),
    });
    return parseOpenCodeOutput(result.stdout);
  }

  async health({ requireJiraMcp = true }: { requireJiraMcp?: boolean } = {}): Promise<{
    command: string;
    version: string;
    model?: string;
    config?: string;
    mcp?: string;
    mcpStatus?: string;
  }> {
    const invocation = this.invocation();
    const version = await this.processRunner(invocation.command, ["--version"], {
      cwd: this.config.repoPath,
      timeoutMs: 30_000,
      signal: this.config.signal,
      env: this.runtimeEnv(),
    });
    const result = {
      command: invocation.command,
      version: version.stdout.trim(),
      model: this.config.opencode?.model,
      config: this.runtimeEnv().OPENCODE_CONFIG,
    };
    if (!requireJiraMcp) return result;
    const mcp = await this.processRunner(invocation.command, ["mcp", "list"], {
      cwd: this.config.repoPath,
      timeoutMs: 30_000,
      signal: this.config.signal,
      env: this.runtimeEnv(),
    });
    const mcpOutput = `${mcp.stdout || ""}\n${mcp.stderr || ""}`;
    const jiraLine = mcpOutput.split(/\r?\n/).find((line) => /(^|\s|[|])jira(\s|$|[|])/i.test(line));
    if (!jiraLine) {
      throw new Error("OpenCode MCP configuration does not contain the configured Jira server 'jira'.");
    }
    const mcpStatus = /needs authentication|needs auth/i.test(jiraLine)
      ? "needs-authentication"
      : /connected/i.test(jiraLine)
        ? "connected"
        : /failed|error/i.test(jiraLine)
          ? "failed"
          : "unknown";
    if (mcpStatus !== "connected") {
      throw new Error(`OpenCode Jira MCP server 'jira' is ${mcpStatus}.`);
    }
    return { ...result, mcp: "jira", mcpStatus };
  }
}
