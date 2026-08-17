import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

test("AI review is label-gated and publishes only high-relevance findings", async () => {
  const workflow = await readFile(path.resolve("..", ".github", "workflows", "ai-review.yml"), "utf8");

  assert.match(workflow, /pull_request:\r?\n\s+types: \[labeled\]/);
  assert.match(workflow, /github\.event\.label\.name == ['"]ai-review['"]/);
  assert.match(workflow, /model: llamacpp\/unsloth\/Qwen3\.8-27B-UD-Q5_K_XL\r?\n\s+variant: medium/);
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

test("AI review schedules deterministic size-aware review rounds", async () => {
  const workflow = await readFile(path.resolve("..", ".github", "workflows", "ai-review.yml"), "utf8");

  assert.match(workflow, /complete changed-file inventory.*existing changed-file order/s);
  assert.match(workflow, /complete contents at the pull-request revision/);
  assert.match(workflow, /total physical lines, including blank lines/);
  assert.match(workflow, /never only diff, hunk, or changed-line counts/);
  assert.match(workflow, /LARGE_FILE_LINES = 250/);
  assert.match(workflow, /MAX_ROUND_LINES = 300/);
  assert.match(workflow, /rounds = \[\].*currentSmallRound = \[\].*currentLines = 0/s);
  assert.match(workflow, /file\.lines >= LARGE_FILE_LINES/);
  assert.match(workflow, /currentLines \+ file\.lines > MAX_ROUND_LINES/);
  assert.match(workflow, /flattened round paths must equal the original inventory paths exactly/);
  assert.match(workflow, /250 or more physical lines.*singleton round/s);
  assert.match(workflow, /fewer than 250 physical lines.*300 lines or less/s);
  assert.match(workflow, /301 or more/);
  assert.match(workflow, /120, 100, 80, 1 produce rounds 300 and 1/);
  assert.match(workflow, /249 and 51 share a round/);
  assert.match(workflow, /249 and 52 use separate rounds/);
  assert.match(workflow, /250-line file is always a singleton/);
  assert.match(workflow, /each review round as one batch/);
  assert.match(workflow, /exactly one review subagent for each batch/);
  assert.match(workflow, /all and only the files in that batch/);
  assert.match(workflow, /never invoke one subagent per file/);
  assert.match(workflow, /After all batch reviews are complete, synthesize/);
  assert.match(workflow, /synthesis must combine batch findings and must not schedule another per-file review/);

  assert.doesNotMatch(workflow, /Review each changed file in a separate subagent/);
  assert.doesNotMatch(workflow, /Do not run file-review subagents in parallel or combine multiple files/);
});
