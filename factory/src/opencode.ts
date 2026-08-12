import path from "node:path";
import { readFile } from "node:fs/promises";
import { runProcess } from "./git.js";
import { CodexAgentExecutor } from "./codex.js";
import type { ProcessRunner } from "./model/process.js";
import type { CodexAgentConfig, CodexJsonLinesResult, CodexRunInput } from "./model/codex.js";

function defaultOpenCodeEntry() {
  if (process.env.OPENCODE_COMMAND) return process.env.OPENCODE_COMMAND;
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
    const dataHome = this.config.stateDir
      ? path.join(this.config.stateDir, "opencode-data")
      : undefined;
    const stateHome = this.config.stateDir
      ? path.join(this.config.stateDir, "opencode-state")
      : undefined;
    return {
      ...process.env,
      CODEX_HOME: process.env.CODEX_HOME || "",
      OPENCODE_CONFIG: process.env.OPENCODE_CONFIG || configPath,
      // Keep all OpenCode writable state in the factory state directory. The
      // Windows CLI may otherwise resolve ~/.local/share/opencode and fail
      // before it can even list or invoke the configured MCP servers.
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || configHome,
      XDG_DATA_HOME: process.env.XDG_DATA_HOME || dataHome,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME || stateHome,
      // `--auto` handles prompts; this setting grants the build agent the
      // same unattended tool access as the Codex strategy.
      OPENCODE_PERMISSION: process.env.OPENCODE_PERMISSION || JSON.stringify("allow"),
    };
  }

  async run({ task, context = "", cwd, outputSchema, timeoutMs, agent }: CodexRunInput) {
    const settings = this.config.opencode || {};
    let schemaInstruction = "";
    if (outputSchema) {
      try {
        const schema = await readFile(outputSchema, "utf8");
        schemaInstruction = `\n\nThe response must validate against this JSON Schema:\n${schema}`;
      } catch {
        schemaInstruction = `\n\nThe response must validate against the JSON Schema file at ${outputSchema}.`;
      }
    }
    const prompt = `${task}\n\n${context}${schemaInstruction}\n\nOutput protocol: return exactly one JSON value satisfying the requested schema. The first character must be { or [, and the last character must be } or ]. Do not use Markdown fences. Do not add explanations, labels, or any text before or after the JSON. Do not continue after emitting the JSON result.`;
    const directory = settings.directory || cwd;
    const args = [
      "run",
      "--model", settings.model || "llamacpp/unsloth/Qwen3.6-27B-UD-Q4_K_XL",
      "--agent", agent || settings.agent || "build",
      "--format", "json",
      "--auto",
      "--dir", directory,
      prompt,
    ];
    const result = await this.processRunner(this.invocation().command, args, {
      cwd: this.config.repoPath,
      timeoutMs: timeoutMs || settings.timeoutMs || 1_200_000,
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
