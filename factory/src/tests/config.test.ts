import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { defaultConfig, loadConfig, validateConfig } from "../config.js";

test("Codex remains the default provider strategy", () => {
  const config = defaultConfig(".");
  assert.equal(config.provider, "codex");
  assert.equal(config.opencode.model, "llamacpp/unsloth/Qwen3.6-27B-UD-Q4_K_XL");
});

test("OpenCode requires a Jira adapter available outside Codex MCP", () => {
  const config = defaultConfig(".");
  config.provider = "opencode";
  assert.ok(validateConfig(config).some((error) => error.includes("requires provider=codex")));
});

test("config resolves relative repository and state paths portably", async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "all-llm-config-"));
  const configPath = path.join(repoPath, "config.json");
  try {
    await writeFile(configPath, JSON.stringify({ repoPath: ".", stateDir: "./state" }));
    const config = await loadConfig(configPath, repoPath);

    assert.equal(config.repoPath, repoPath);
    assert.equal(config.stateDir, path.join(repoPath, "state"));
    assert.equal(config.git.repoPath, repoPath);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});
