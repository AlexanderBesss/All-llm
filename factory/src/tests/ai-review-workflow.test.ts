import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

test("AI review is label-gated and publishes only high-relevance findings", async () => {
  const workflow = await readFile(path.resolve("..", ".github", "workflows", "ai-review.yml"), "utf8");

  assert.match(workflow, /pull_request:\r?\n\s+types: \[labeled\]/);
  assert.match(workflow, /github\.event\.label\.name == ['"]ai-review['"]/);
  assert.match(workflow, /model: llamacpp\/unsloth\/Qwen3\.8-27B-UD-Q5_K_XL\r?\n\s+variant: medium/);
  assert.match(workflow, /timeout-minutes: 20/);
  assert.match(workflow, /OPENCODE_LOG_LEVEL: WARN/);
  assert.doesNotMatch(workflow, /types: \[opened, synchronize, reopened, ready_for_review\]/);
  assert.doesNotMatch(workflow, /First list every changed file/);
  assert.doesNotMatch(workflow, /Implementation areas/);
  assert.match(workflow, /relevance.*high/);
  assert.match(workflow, /confidence.*0\.85/s);
  assert.match(workflow, /Few-shot calibration examples/);
  assert.match(workflow, /SKIP: A variable could be renamed/);
  assert.match(workflow, /finding\.relevance !== "high"/);
  assert.match(workflow, /finding\.confidence < minimumConfidence/);
  assert.match(workflow, /includes\(finding\.severity\)/);
  assert.match(workflow, /core\.setOutput\("review_complete", "false"\)/);
  assert.match(workflow, /core\.setOutput\("review_complete", "true"\)/);
  assert.match(workflow, /steps\.publish\.outputs\.review_complete == ['"]true['"]/);
  assert.match(workflow, /\*\*Findings \(\$\{comments\.length\} high-severity\):\*\*/);
  assert.match(workflow, /const existingKeys = new Set/);
  assert.match(workflow, /diffLines\(file\.patch\)\[finding\.side\]\.has\(finding\.line\)/);
  assert.doesNotMatch(workflow, /addLabels/);
  assert.doesNotMatch(workflow, /labels: \["ai-fix"\]/);
});

test("AI review reviews the complete change set in one context", async () => {
  const workflow = await readFile(path.resolve("..", ".github", "workflows", "ai-review.yml"), "utf8");

  assert.match(workflow, /complete changed-file inventory.*existing changed-file order/s);
  assert.match(workflow, /complete contents at the pull-request revision/);
  assert.match(workflow, /Count AI review files/);
  assert.match(workflow, /AI review progress: 0\/\$\{files\.length\} files processed/);
  assert.match(workflow, /AI review progress: \$\{fileCount\}\/\$\{fileCount\} files processed/);
  assert.match(workflow, /REVIEW_STATUS: \$\{\{ steps\.opencode\.outcome \}\}/);
  assert.match(workflow, /Review the entire changed-file inventory as one coherent unit in this same context/);
  assert.match(workflow, /Inspect all and only the changed files together/);
  assert.match(workflow, /do not split the review into per-file, size-limited, or parallel subagent contexts/);
  assert.match(workflow, /Do not use the Task tool or invoke review subagents/);
  assert.match(workflow, /one review context queued/);
  assert.match(workflow, /single review context complete/);
  assert.match(workflow, /permission evaluation/);

  assert.doesNotMatch(workflow, /Review each changed file in a separate subagent/);
  assert.doesNotMatch(workflow, /Do not run file-review subagents in parallel or combine multiple files/);
  assert.doesNotMatch(workflow, /MAX_ROUND_LINES/);
  assert.doesNotMatch(workflow, /MAX_CONCURRENT_REVIEW_SUBAGENTS/);
  assert.doesNotMatch(workflow, /Use the Task tool/);
});
