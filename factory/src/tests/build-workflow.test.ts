import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

test("WhisperNote tag releases publish the ZIP and standalone executable", async () => {
  const workflow = await readFile(path.resolve("..", ".github", "workflows", "build.yml"), "utf8");

  assert.match(workflow, /push:\r?\n\s+branches: \[main, master\]\r?\n\s+tags:\r?\n\s+- ['"]v\*['"]/);
  assert.match(workflow, /pull_request:\r?\n\s+branches: \[main, master\]/);
  assert.match(workflow, /dotnet restore whisper-note\/tests\/WhisperNote\.Tests\.csproj/);
  assert.match(workflow, /dotnet build whisper-note\/WhisperNote\.csproj -c Release --no-restore/);
  assert.match(workflow, /dotnet test whisper-note\/tests\/WhisperNote\.Tests\.csproj -c Release --no-restore/);
  assert.match(workflow, /dotnet publish whisper-note\/WhisperNote\.csproj `[\s\S]*?-c Release `[\s\S]*?-r win-x64 `[\s\S]*?-o whisper-note\/publish `[\s\S]*?\/p:PublishSingleFile=true `[\s\S]*?\/p:SelfContained=false/);

  const packageStep = /- name: Package release assets[\s\S]*?(?=\r?\n\s+- name: Upload release assets)/.exec(workflow)?.[0];
  assert.ok(packageStep, "release packaging step should exist");
  assert.match(packageStep, /if: github\.ref_type == 'tag' && startsWith\(github\.ref_name, 'v'\)/);
  assert.match(packageStep, /Compress-Archive/);
  assert.match(packageStep, /WhisperNote-win-x64\.zip/);
  assert.match(packageStep, /WhisperNote\.exe/);
  assert.match(packageStep, /Expand-Archive/);
  assert.match(packageStep, /Get-FileHash[\s\S]*?Get-FileHash[\s\S]*?Get-FileHash/);
  assert.match(packageStep, /checksums differ/);
  assert.match(packageStep, /does not contain WhisperNote\.exe/);

  assert.match(workflow, /- name: Upload release assets[\s\S]*?name: WhisperNote-release-assets[\s\S]*?path: artifacts\/\*/);
  assert.match(workflow, /release:\r?\n\s+if: github\.ref_type == 'tag' && startsWith\(github\.ref_name, 'v'\)/);
  assert.match(workflow, /gh release create[\s\S]*?artifacts\/WhisperNote-win-x64\.zip[\s\S]*?artifacts\/WhisperNote\.exe[\s\S]*?--verify-tag[\s\S]*?--title "WhisperNote \$GITHUB_REF_NAME"[\s\S]*?--generate-notes/);
});
