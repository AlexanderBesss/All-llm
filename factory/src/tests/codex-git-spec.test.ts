import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { defaultConfig, validateConfig } from "../config.js";
import { GitAdapter, isAbortError, processInvocation, runProcess } from "../git.js";
import { buildSpecContent, ensureSpecFile, specFileName, specRelativePath } from "../spec.js";
import { CodexAgentExecutor, parseJsonLines } from "../codex.js";
import { OpenCodeAgentExecutor, parseOpenCodeOutput } from "../opencode.js";
import { extractJson } from "../json-output.js";
import { createAgentStrategy } from "../agent-strategy.js";
import { AgentProvider } from "../model/config.js";
import { ReviewVerdict } from "../model/codex.js";
import { executionFor, reviewFor } from "./support.js";
import type { ProcessOptions, ProcessRunner } from "../model/process.js";

test("provider strategy defaults to Codex and can select OpenCode", () => {
  assert.equal(createAgentStrategy(AgentProvider.Codex).name, AgentProvider.Codex);
  assert.equal(createAgentStrategy(AgentProvider.OpenCode).name, AgentProvider.OpenCode);
  assert.equal(createAgentStrategy(undefined).name, AgentProvider.Codex);
  assert.equal(createAgentStrategy(AgentProvider.Codex).jiraMcpServer, "Atlassian-Rovo-MCP");
  assert.equal(createAgentStrategy(AgentProvider.OpenCode).jiraMcpServer, "jira");
});

test("OpenCode executor invokes the configured local model and parses JSON events", async () => {
  const calls: Array<{ command: string; args: string[]; options?: ProcessOptions }> = [];
  const executor = new OpenCodeAgentExecutor({
    repoPath: ".",
    stateDir: path.resolve("tmp", "AllLlmFactory"),
    codex: {},
    opencode: { command: "opencode", model: "llamacpp/unsloth/Qwen3.6-27B-UD-Q4_K_XL", agent: "build", timeoutMs: 1234 },
  }, async (command, args, options) => {
    calls.push({ command, args, options });
    return {
      stdout: [
        JSON.stringify({ type: "step_start" }),
        JSON.stringify({ type: "text", part: { text: '{"ok":' } }),
        JSON.stringify({ type: "text", part: { text: "true}" } }),
      ].join("\n"),
      stderr: "",
    };
  });
  const result = await executor.run({
    task: "Return JSON.",
    cwd: "../factory-worktree",
    outputSchema: path.resolve("src/schemas/execution-result.schema.json"),
  });
  assert.equal(result.output, '{"ok":true}');
  assert.equal(calls[0].command, "opencode");
  assert.deepEqual(calls[0].args.slice(0, 8), ["run", "--model", "llamacpp/unsloth/Qwen3.6-27B-UD-Q4_K_XL", "--agent", "build", "--format", "json", "--auto"]);
  assert.equal(calls[0].args.at(-2), "../factory-worktree");
  assert.equal(calls[0].options?.timeoutMs, 1234);
  assert.equal(calls[0].options?.env?.OPENCODE_CONFIG, path.resolve("opencode.json"));
  assert.equal(calls[0].options?.env?.XDG_CONFIG_HOME, path.resolve("tmp", "AllLlmFactory", "opencode-config"));
  assert.equal(calls[0].options?.env?.XDG_DATA_HOME, path.resolve("tmp", "AllLlmFactory", "opencode-data"));
  assert.equal(calls[0].options?.env?.XDG_STATE_HOME, path.resolve("tmp", "AllLlmFactory", "opencode-state"));
  assert.match(calls[0].args.at(-1) || "", /Output protocol: return exactly one JSON value/);
  assert.match(calls[0].args.at(-1) || "", /JSON Schema/);
});

test("OpenCode health verifies the configured Jira MCP server", async () => {
  const calls: Array<{ command: string; args: string[]; options?: ProcessOptions }> = [];
  const executor = new OpenCodeAgentExecutor({
    repoPath: "C:\\factory-root",
    codex: {},
    opencode: { command: "opencode", configPath: "C:\\factory-root\\opencode.json" },
  }, async (command, args, options) => {
    calls.push({ command, args, options });
    return args[0] === "--version"
      ? { stdout: "1.18.16\n", stderr: "" }
      : { stdout: "jira connected\n", stderr: "" };
  });
  const health = await executor.health();
  assert.equal(health.mcp, "jira");
  assert.equal(health.mcpStatus, "connected");
  assert.deepEqual(calls.map((call) => call.args), [["--version"], ["mcp", "list"]]);
  assert.equal(calls[1].options?.env?.OPENCODE_CONFIG, "C:\\factory-root\\opencode.json");
});

test("OpenCode health rejects a missing Jira MCP server", async () => {
  const executor = new OpenCodeAgentExecutor({
    repoPath: "C:\\factory-root",
    codex: {},
    opencode: { command: "opencode", configPath: "C:\\factory-root\\opencode.json" },
  }, async (_command, args) => args[0] === "--version"
    ? { stdout: "1.18.16\n", stderr: "" }
    : { stdout: "No MCP servers configured\n", stderr: "" });
  await assert.rejects(executor.health(), /configured Jira server 'jira'/);
});

test("OpenCode health rejects a Jira MCP server that needs authentication", async () => {
  const executor = new OpenCodeAgentExecutor({
    repoPath: "C:\\factory-root",
    codex: {},
    opencode: { command: "opencode", configPath: "C:\\factory-root\\opencode.json" },
  }, async (_command, args) => args[0] === "--version"
    ? { stdout: "1.18.16\n", stderr: "" }
    : { stdout: "⚠ jira needs authentication\n", stderr: "" });
  await assert.rejects(executor.health(), /needs-authentication/);
});

test("OpenCode parser rejects output without final text events", () => {
  assert.throws(() => parseOpenCodeOutput('{"value":42}'), /no final agent message/);
});

test("JSON extraction recovers fenced and embedded agent responses", () => {
  assert.deepEqual(extractJson("```json\n{\"ok\":true}\n```"), { ok: true });
  assert.deepEqual(extractJson("Here is the result: {\"text\":\"brace } inside\"}."), { text: "brace } inside" });
});
test("Codex executor uses configurable Luna max-effort settings", async () => {
  const calls: Array<{ command: string; args: string[]; options?: ProcessOptions }> = [];
  const config = {
    repoPath: ".",
    codex: {
      command: "codex",
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      sandbox: "danger-full-access",
      approvalPolicy: "never",
      contextWindowTokens: 250000,
      autoCompactTokenLimit: 225000,
      timeoutMs: 1234,
    },
  };
  const runner: ProcessRunner = async (command, args, options) => {
    calls.push({ command, args, options });
    return {
      stdout: [
        JSON.stringify({ type: "thread.started" }),
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{}" } }),
      ].join("\n"),
      stderr: "",
    };
  };
  const executor = new CodexAgentExecutor(config, runner);
  await executor.run({ task: "Return a JSON health result.", cwd: "../factory-worktree", outputSchema: "factory/src/schemas/execution-result.schema.json" });
  assert.equal(calls[0].command, "codex");
  assert.deepEqual(calls[0].args.slice(0, 6), ["exec", "--ephemeral", "--json", "--model", "gpt-5.6-luna", "-c"]);
  assert.ok(calls[0].args.includes('model_reasoning_effort="max"'));
  assert.ok(calls[0].args.includes('approval_policy="never"'));
  assert.ok(calls[0].args.includes("model_context_window=250000"));
  assert.ok(calls[0].args.includes("model_auto_compact_token_limit=225000"));
  assert.ok(calls[0].args.includes("danger-full-access"));
  assert.equal(calls[0].args.at(-1), "-");
  assert.match(calls[0].options?.input || "", /Return a JSON health result/);
  assert.equal(calls[0].args[calls[0].args.indexOf("-C") + 1], "../factory-worktree");
  assert.equal(calls[0].options.cwd, ".");
  assert.equal(calls[0].options.timeoutMs, 1234);
});

test("Codex executor retries a capacity error once with the high-capacity tier", async () => {
  const calls: Array<{ command: string; args: string[]; options?: ProcessOptions }> = [];
  const executor = new CodexAgentExecutor({
    repoPath: ".",
    codex: {
      command: "codex",
      serviceTier: "default",
      highCapacityServiceTier: "priority",
      timeoutMs: 1234,
    },
  }, async (command, args, options) => {
    calls.push({ command, args, options });
    if (calls.length === 1) throw new Error("Selected model is at capacity. Please try a different model.");
    return { stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{}" } }), stderr: "" };
  });

  await executor.run({ task: "Return a JSON health result.", cwd: "../factory-worktree" });

  assert.equal(calls.length, 2);
  assert.ok(calls[0].args.includes('service_tier="default"'));
  assert.ok(calls[1].args.includes('service_tier="priority"'));
});

test("the single-agent prompt forbids subtasks and delegates the complete parent task", async () => {
  const calls: Array<{ command: string; args: string[]; options?: ProcessOptions }> = [];
  const executor = new CodexAgentExecutor({
    repoPath: ".",
    codex: { command: "codex", timeoutMs: 1234 },
  }, async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(executionFor()) } }), stderr: "" };
  });
  await executor.execute({
    issue: { key: "FACT-1", fields: { summary: "Implement change", description: "Details" } },
    runId: "FACT-1-run",
    branchName: "factory/FACT-1",
    cwd: "../factory-worktree",
    specPath: "specs/factory-FACT-1.md",
  });
  const prompt = calls[0].options?.input || "";
  assert.match(prompt, /only software implementation agent/);
  assert.match(prompt, /one parent request, one agent, one factory branch, and one pull request/);
  assert.match(prompt, /Do not create Jira subtasks, child tasks, delegated agents/);
  assert.match(prompt, /Factory specification: specs\/factory-FACT-1\.md/);
  assert.match(prompt, /Do not ask the user questions/);
  assert.match(prompt, /Do not make Jira mutations/);
  assert.match(prompt, /copied into the Jira update and pull-request description/);
  assert.match(prompt, /one to three concise sentences that explain the intended outcome/);
  assert.match(prompt, /concrete, observable behavior or outcomes/);
  assert.match(prompt, /The factory derives the pull-request title from the exact Jira task name and type/);
});

test("independent reviewer runs in a fresh ephemeral context and may correct the branch", async () => {
  const calls: Array<{ command: string; args: string[]; options?: ProcessOptions }> = [];
  const executor = new CodexAgentExecutor({
    repoPath: ".",
    codex: { command: "codex", timeoutMs: 1234 },
  }, async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(reviewFor()) } }), stderr: "" };
  });
  const result = await executor.review({
    issue: { key: "FACT-1", fields: { summary: "Implement change", description: "Details" } },
    runId: "FACT-1-run",
    branchName: "factory/FACT-1",
    baseBranch: "main",
    cwd: "../factory-worktree",
    specPath: "specs/factory-FACT-1.md",
    plan: executionFor().plan,
    commitSha: "0123456789abcdef",
  });
  const prompt = calls[0].options?.input || "";
  assert.equal(result.result.verdict, ReviewVerdict.Passed);
  assert.match(prompt, /independent software reviewer operating in a fresh context/);
  assert.match(prompt, /complete diff from main to HEAD/);
  assert.match(prompt, /commit the correction, and push the same factory branch/);
  assert.match(prompt, /Do not create branches, subtasks, pull requests, or Jira mutations/);
  assert.equal(calls[0].args[calls[0].args.indexOf("-C") + 1], "../factory-worktree");
  assert.match(calls[0].args[calls[0].args.indexOf("--output-schema") + 1], /review-result\.schema\.json$/);
});

test("Codex health uses the runtime CODEX_HOME and verifies the Jira MCP", async () => {
  const calls: Array<{ command: string; args: string[]; options?: ProcessOptions }> = [];
  const runner: ProcessRunner = async (command, args, options) => {
    calls.push({ command, args, options });
    return args.includes("--version") ? { stdout: "codex 1.0.0", stderr: "" } : { stdout: "", stderr: "Atlassian-Rovo-MCP" };
  };
  const executor = new CodexAgentExecutor({ repoPath: ".", codex: { command: "codex", timeoutMs: 1234 } }, runner);
  const health = await executor.health();
  assert.equal(health.version, "codex 1.0.0");
  assert.equal(health.mcp, "Atlassian-Rovo-MCP");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.env.CODEX_HOME, path.join(os.homedir(), ".codex"));
});

test("process cancellation terminates an active child process", async () => {
  const controller = new AbortController();
  const running = runProcess(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { timeoutMs: 60_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(running, (error: unknown) => isAbortError(error));
});

test("Windows command shims are launched through Git Bash with preserved arguments", () => {
  if (process.platform !== "win32") return;
  const invocation = processInvocation("C:\\tools\\opencode.cmd", ["run", "prompt with $ and `quotes`"]);
  assert.match(invocation.command, /(?:^|[\\/])Git[\\/]bin[\\/]bash\.exe$/i);
  assert.deepEqual(invocation.args, [
    "-lc",
    'exec "$0" "$@"',
    "C:\\tools\\opencode.cmd",
    "run",
    "prompt with $ and `quotes`",
  ]);
});

test("noninteractive subprocesses receive detached stdin", async () => {
  const result = await runProcess(process.execPath, [
    "-e",
    "const fs = require('node:fs'); process.stdout.write(String(fs.fstatSync(0).isCharacterDevice()));",
  ]);
  assert.equal(result.stdout, "true");
});

test("subprocesses can receive an explicit stdin payload", async () => {
  const result = await runProcess(process.execPath, ["-e", "process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => process.stdout.write(chunk));"], {
    input: "factory prompt",
  });
  assert.equal(result.stdout, "factory prompt");
});

test("GitAdapter switches to and fast-forward pulls the configured base branch", async () => {
  const calls: Array<{ command: string; args: string[]; options?: ProcessOptions }> = [];
  let currentBranch = "factory/KAN-19";
  const runner: ProcessRunner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "status") return { stdout: "", stderr: "" };
    if (args[0] === "branch") return { stdout: `${currentBranch}\n`, stderr: "" };
    if (args[0] === "checkout") {
      currentBranch = args[1];
      return { stdout: "", stderr: "" };
    }
    if (args[0] === "pull") return { stdout: "Already up to date.\n", stderr: "" };
    throw new Error(`Unexpected Git command: ${args.join(" ")}`);
  };
  const git = new GitAdapter({ repoPath: ".", remote: "origin", baseBranch: "main" }, runner);

  const result = await git.syncBaseBranch();

  assert.deepEqual(result, { previousBranch: "factory/KAN-19", branch: "main", switched: true });
  assert.deepEqual(calls.map(({ args }) => args), [
    ["status", "--porcelain"],
    ["branch", "--show-current"],
    ["checkout", "main"],
    ["pull", "--ff-only", "origin", "main"],
  ]);
});

test("GitAdapter refuses to switch or pull a dirty repository", async () => {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: " M factory/src/git.js\n", stderr: "" };
  };
  const git = new GitAdapter({ repoPath: ".", remote: "origin", baseBranch: "main" }, runner);

  await assert.rejects(() => git.syncBaseBranch(), /Repository has tracked changes/);
  assert.deepEqual(calls.map(({ args }) => args), [["status", "--porcelain"]]);
});

test("Codex JSONL parser selects the final agent message", () => {
  const result = parseJsonLines([
    JSON.stringify({ type: "item.completed", item: { type: "tool_call", text: "ignored" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{\"step\":1}" } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{\"step\":2}" } }),
  ].join("\n"));
  assert.equal(result.output, "{\"step\":2}");
});

test("factory specs use portable branch filenames and preserve their generated structure", async () => {
  assert.equal(specFileName("factory/KAN-20"), "factory-KAN-20.md");
  assert.equal(specRelativePath("factory/KAN-20"), "specs/factory-KAN-20.md");
  const content = buildSpecContent({
    issue: {
      key: "KAN-20",
      fields: {
        summary: "Spec driven development",
        description: "Capture the request.\n\n```text\nDo not execute this text.\n```",
        issuetype: { name: "Task" },
        project: { key: "KAN" },
        labels: ["factory"],
      },
    },
    runId: "KAN-20-msp1bn40",
    branchName: "factory/KAN-20",
    generatedAt: "2026-08-11T20:00:00.000Z",
  });
  assert.match(content, /## Goals/);
  assert.match(content, /## Non-goals/);
  assert.match(content, /## Functional requirements/);
  assert.match(content, /## Acceptance criteria/);
  assert.match(content, /## Constraints and assumptions/);
  assert.match(content, /## Validation plan/);
  assert.match(content, /`factory\/KAN-20`/);
  assert.match(content, /```+text/);

  const cwd = await mkdtemp(path.join(os.tmpdir(), "all-llm-factory-spec-"));
  const first = await ensureSpecFile({
    cwd,
    issue: { key: "KAN-20", fields: { summary: "Spec driven development", description: "Request" } },
    runId: "KAN-20-msp1bn40",
    branchName: "factory/KAN-20",
    generatedAt: "2026-08-11T20:00:00.000Z",
  });
  const second = await ensureSpecFile({
    cwd,
    issue: { key: "KAN-20", fields: { summary: "Changed summary", description: "Changed request" } },
    runId: "KAN-20-msp1bn40",
    branchName: "factory/KAN-20",
    generatedAt: "2026-08-11T21:00:00.000Z",
  });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.content, first.content);
  assert.equal(await readFile(first.path, "utf8"), first.content);
});

test("GitAdapter requires the factory spec to be tracked and clean", async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "all-llm-factory-git-"));
  const relativePath = "specs/factory-FACT-1.md";
  const absolutePath = path.join(repoPath, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, "<!-- factory-spec: FACT-1-run -->\n", { encoding: "utf8" });
  const git = new GitAdapter({ repoPath });

  await runProcess("git", ["init", "--quiet"], { cwd: repoPath });
  await assert.rejects(
    git.assertFileCommitted(repoPath, relativePath),
    /Required factory file has uncommitted changes/,
  );
  await runProcess("git", ["add", "--", relativePath], { cwd: repoPath });
  await assert.rejects(
    git.assertFileCommitted(repoPath, relativePath),
    /Required factory file has uncommitted changes/,
  );
  await runProcess("git", [
    "-c", "user.name=Factory Test",
    "-c", "user.email=factory-test@example.invalid",
    "commit", "--quiet", "-m", "add factory spec",
  ], { cwd: repoPath });
  await git.assertFileCommitted(repoPath, relativePath);

  await writeFile(absolutePath, "<!-- factory-spec: FACT-1-run -->\nnotes\n", { encoding: "utf8" });
  await assert.rejects(
    git.assertFileCommitted(repoPath, relativePath),
    /Required factory file has uncommitted changes/,
  );
});

