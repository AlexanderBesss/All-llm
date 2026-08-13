import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

test("AI review is label-gated and publishes only high-relevance findings", async () => {
  const workflow = await readFile(path.resolve("..", ".github", "workflows", "ai-review.yml"), "utf8");

  assert.match(workflow, /pull_request:\r?\n\s+types: \[labeled\]/);
  assert.match(workflow, /github\.event\.label\.name == ['"]ai-review['"]/);
  assert.doesNotMatch(workflow, /types: \[opened, synchronize, reopened, ready_for_review\]/);
  assert.match(workflow, /relevance.*high/);
  assert.match(workflow, /confidence.*0\.85/s);
  assert.match(workflow, /Few-shot calibration examples/);
  assert.match(workflow, /SKIP: A variable could be renamed/);
  assert.match(workflow, /finding\.relevance !== "high"/);
  assert.match(workflow, /finding\.confidence < minimumConfidence/);
  assert.match(workflow, /includes\(finding\.severity\)/);
  assert.match(workflow, /labels: \["ai-fix"\]/);
});
