import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { defaultConfig, loadConfig, readOpenCodeDoctorSettings, validateConfig } from "../config.js";
import { checkJira } from "../cli.js";
import { AgentProvider, JiraAdapterKind } from "../model/config.js";

test("Codex remains the default provider strategy", () => {
  const config = defaultConfig(".");
  assert.equal(config.provider, AgentProvider.Codex);
  assert.equal(config.repoPath, path.resolve("."));
  assert.equal(config.git.repoPath, path.resolve("."));
  assert.equal(config.jira.adapter, JiraAdapterKind.CodexMcp);
  assert.equal(config.opencode.model, "llamacpp/unsloth/Qwen3.6-27B-UD-Q4_K_XL");
});

test("the repository factory/config.json is loaded when no override is supplied", async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "all-llm-config-default-"));
  try {
    await mkdir(path.join(repoPath, "factory"), { recursive: true });
    await writeFile(path.join(repoPath, "factory", "config.json"), JSON.stringify({ provider: AgentProvider.OpenCode }));
    const config = await loadConfig(undefined, repoPath);
    assert.equal(config.provider, AgentProvider.OpenCode);
    assert.equal(config.jira.adapter, JiraAdapterKind.OpenCodeMcp);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("provider defaults select the matching Jira MCP adapter", () => {
  const originalProvider = process.env.FACTORY_AGENT_PROVIDER;
  const originalAdapter = process.env.FACTORY_JIRA_ADAPTER;
  try {
    process.env.FACTORY_AGENT_PROVIDER = AgentProvider.OpenCode;
    delete process.env.FACTORY_JIRA_ADAPTER;
    assert.equal(defaultConfig(".").jira.adapter, JiraAdapterKind.OpenCodeMcp);

    process.env.FACTORY_JIRA_ADAPTER = JiraAdapterKind.Rest;
    assert.equal(defaultConfig(".").jira.adapter, JiraAdapterKind.Rest);
  } finally {
    if (originalProvider === undefined) delete process.env.FACTORY_AGENT_PROVIDER;
    else process.env.FACTORY_AGENT_PROVIDER = originalProvider;
    if (originalAdapter === undefined) delete process.env.FACTORY_JIRA_ADAPTER;
    else process.env.FACTORY_JIRA_ADAPTER = originalAdapter;
  }
});

test("OpenCode and Codex require matching Jira adapters", () => {
  const codexConfig = defaultConfig(".");
  codexConfig.provider = AgentProvider.Codex;
  codexConfig.jira.adapter = JiraAdapterKind.OpenCodeMcp;
  assert.ok(validateConfig(codexConfig).some((error) => error.includes("requires provider=opencode")));

  const opencodeConfig = defaultConfig(".");
  opencodeConfig.provider = AgentProvider.OpenCode;
  opencodeConfig.jira.adapter = JiraAdapterKind.CodexMcp;
  assert.ok(validateConfig(opencodeConfig).some((error) => error.includes("requires provider=codex")));
});

test("doctor treats OpenCode MCP as a provider-backed adapter, not REST", () => {
  const config = defaultConfig(".");
  config.provider = AgentProvider.OpenCode;
  config.jira.adapter = JiraAdapterKind.OpenCodeMcp;
  const report = checkJira(config, { ok: true, mcp: "jira" });
  assert.equal(report.ok, true);
  assert.equal(report.providerReady, true);
  assert.equal(report.mcpRegistered, true);
  assert.equal(report.mcp, "jira");
  assert.equal(report.credentialsConfigured, undefined);
});

test("OpenCode doctor settings come from the selected model in opencode.json", async () => {
  const repoPath = path.resolve("..");
  const config = defaultConfig(repoPath);
  config.provider = AgentProvider.OpenCode;
  const details = await readOpenCodeDoctorSettings(config);
  assert.equal(details.model, "llamacpp/unsloth/Qwen3.6-27B-UD-Q4_K_XL");
  assert.equal(details.contextWindowTokens, 100000);
  assert.equal(details.outputTokens, 8192);
  assert.equal(details.compactionAuto, true);
  assert.equal(details.compactionPrune, true);
  assert.equal(details.compactionReservedTokens, 10000);
  assert.equal(details.reasoningEffort, undefined);
});

test("config resolves repository and state paths from the repository root", async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "all-llm-config-"));
  const configPath = path.join(repoPath, "config.json");
  try {
    await writeFile(configPath, JSON.stringify({ repoPath: ".", stateDir: "./state" }));
    const config = await loadConfig(configPath, repoPath);

    assert.equal(config.repoPath, repoPath);
    assert.equal(config.stateDir, path.join(repoPath, "state"));
    assert.equal(config.git.repoPath, repoPath);
    assert.equal(config.opencode.configPath, path.join(repoPath, "opencode.json"));
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("OpenCode config defaults to the configured repository root", async () => {
  const detectedRoot = await mkdtemp(path.join(os.tmpdir(), "all-llm-config-detected-"));
  const configuredRoot = await mkdtemp(path.join(os.tmpdir(), "all-llm-config-target-"));
  const configPath = path.join(detectedRoot, "config.json");
  try {
    await writeFile(configPath, JSON.stringify({ repoPath: configuredRoot }));
    const config = await loadConfig(configPath, detectedRoot);
    assert.equal(config.opencode.configPath, path.join(configuredRoot, "opencode.json"));
  } finally {
    await rm(detectedRoot, { recursive: true, force: true });
    await rm(configuredRoot, { recursive: true, force: true });
  }
});

test("OpenCode config without an explicit adapter selects OpenCode MCP", async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "all-llm-config-provider-"));
  const configPath = path.join(repoPath, "config.json");
  const originalProvider = process.env.FACTORY_AGENT_PROVIDER;
  const originalAdapter = process.env.FACTORY_JIRA_ADAPTER;
  try {
    delete process.env.FACTORY_AGENT_PROVIDER;
    delete process.env.FACTORY_JIRA_ADAPTER;
    await writeFile(configPath, JSON.stringify({ provider: AgentProvider.OpenCode }));
    const config = await loadConfig(configPath, repoPath);
    assert.equal(config.jira.adapter, JiraAdapterKind.OpenCodeMcp);
  } finally {
    if (originalProvider === undefined) delete process.env.FACTORY_AGENT_PROVIDER;
    else process.env.FACTORY_AGENT_PROVIDER = originalProvider;
    if (originalAdapter === undefined) delete process.env.FACTORY_JIRA_ADAPTER;
    else process.env.FACTORY_JIRA_ADAPTER = originalAdapter;
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("changing provider normalizes an existing MCP adapter while preserving REST", async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "all-llm-config-switch-"));
  const configPath = path.join(repoPath, "config.json");
  const originalProvider = process.env.FACTORY_AGENT_PROVIDER;
  const originalAdapter = process.env.FACTORY_JIRA_ADAPTER;
  try {
    delete process.env.FACTORY_AGENT_PROVIDER;
    delete process.env.FACTORY_JIRA_ADAPTER;
    await writeFile(configPath, JSON.stringify({ provider: AgentProvider.OpenCode, jira: { adapter: JiraAdapterKind.CodexMcp } }));
    const opencodeConfig = await loadConfig(configPath, repoPath);
    assert.equal(opencodeConfig.jira.adapter, JiraAdapterKind.OpenCodeMcp);

    await writeFile(configPath, JSON.stringify({ provider: AgentProvider.Codex, jira: { adapter: JiraAdapterKind.OpenCodeMcp } }));
    const codexConfig = await loadConfig(configPath, repoPath);
    assert.equal(codexConfig.jira.adapter, JiraAdapterKind.CodexMcp);

    await writeFile(configPath, JSON.stringify({ provider: AgentProvider.OpenCode, jira: { adapter: JiraAdapterKind.Rest } }));
    const restConfig = await loadConfig(configPath, repoPath);
    assert.equal(restConfig.jira.adapter, JiraAdapterKind.Rest);
  } finally {
    if (originalProvider === undefined) delete process.env.FACTORY_AGENT_PROVIDER;
    else process.env.FACTORY_AGENT_PROVIDER = originalProvider;
    if (originalAdapter === undefined) delete process.env.FACTORY_JIRA_ADAPTER;
    else process.env.FACTORY_JIRA_ADAPTER = originalAdapter;
    await rm(repoPath, { recursive: true, force: true });
  }
});
