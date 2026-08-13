import { buildReviewFixTask } from "../agent/codex-prompts.js";
import { parseJsonResult } from "../json-output.js";
import { ReviewThreadDisposition, type ReviewFixResult } from "../model/codex.js";
import type { PullRequest, PullRequestReviewThread } from "../model/github.js";
import { assertSchema, factorySchemaPath } from "../schema-validation.js";
import type { FactoryWorker } from "../worker.js";

function assertReviewResult(value: unknown, threads: PullRequestReviewThread[]): ReviewFixResult {
  const result = value as ReviewFixResult;
  const expected = new Set(threads.map((thread) => thread.id));
  const actual = new Set(result.threads.map((thread) => thread.threadId));
  if (actual.size !== result.threads.length) throw new Error("Review-fix agent returned duplicate thread outcomes.");
  if (expected.size !== actual.size || [...expected].some((id) => !actual.has(id))) {
    throw new Error("Review-fix agent must return exactly one outcome for every supplied thread.");
  }
  for (const outcome of result.threads) {
    if (outcome.disposition === ReviewThreadDisposition.Addressed && outcome.reply) {
      throw new Error(`Addressed review thread ${outcome.threadId} must not include a reply.`);
    }
    if (outcome.disposition === ReviewThreadDisposition.Disputed && !outcome.reply.trim()) {
      throw new Error(`Disputed review thread ${outcome.threadId} requires a reply.`);
    }
  }
  return result;
}

async function processPullRequest(worker: FactoryWorker, pullRequest: PullRequest): Promise<{ addressed: number; disputed: number }> {
  const getThreads = worker.github.getUnresolvedReviewThreads;
  if (!getThreads) throw new Error("GitHub adapter does not support review threads.");
  const threads = await getThreads.call(worker.github, pullRequest.number);
  if (!threads.length) {
    worker.log("info", "review-fix:no-unresolved-threads", { prNumber: pullRequest.number });
    return { addressed: 0, disputed: 0 };
  }
  const worktree = await worker.git.preparePullRequestWorktree(`ai-fix-pr-${pullRequest.number}`, pullRequest.head.ref);
  const beforeSha = await worker.git.assertBranchPublished(worktree, pullRequest.head.ref);
  worker.log("info", "review-fix:agent-start", { prNumber: pullRequest.number, threadCount: threads.length, worktree, beforeSha });
  const schemaPath = factorySchemaPath(worker.config.repoPath, "review-fix-result.schema.json");
  const response = await worker.agent.run({
    task: buildReviewFixTask({ pullRequest, threads }),
    cwd: worktree,
    outputSchema: schemaPath,
  });
  worker.throwIfStopping();
  const parsed = parseJsonResult(response.output);
  await assertSchema(parsed, schemaPath);
  const result = assertReviewResult(parsed, threads);
  if (result.blockers.length) throw new Error(`Review-fix agent reported blockers: ${result.blockers.join("; ")}`);
  const afterSha = await worker.git.assertBranchPublished(worktree, pullRequest.head.ref);
  const hasAddressedThreads = result.threads.some((outcome) => outcome.disposition === ReviewThreadDisposition.Addressed);
  if (hasAddressedThreads && (!result.committed || !result.pushed || afterSha === beforeSha)) {
    throw new Error("Review-fix agent must publish a new commit before addressed threads can be resolved.");
  }

  let addressed = 0;
  let disputed = 0;
  for (const outcome of result.threads) {
    worker.throwIfStopping();
    if (outcome.disposition === ReviewThreadDisposition.Addressed) {
      if (!worker.github.resolveReviewThread) throw new Error("GitHub adapter cannot resolve review threads.");
      await worker.github.resolveReviewThread(outcome.threadId);
      addressed += 1;
    } else {
      if (!worker.github.replyToReviewThread) throw new Error("GitHub adapter cannot reply to review threads.");
      await worker.github.replyToReviewThread(pullRequest.number, outcome.threadId, outcome.reply);
      disputed += 1;
    }
  }
  worker.log("info", "review-fix:pr-complete", { prNumber: pullRequest.number, beforeSha, afterSha, addressed, disputed });
  return { addressed, disputed };
}

export async function fixPullRequestReviews(worker: FactoryWorker): Promise<{ pullRequests: number; addressed: number; disputed: number; failed: number }> {
  worker.throwIfStopping();
  const list = worker.github.listOpenPullRequestsByLabel;
  if (!list) throw new Error("GitHub adapter does not support labeled pull-request discovery.");
  const pullRequests = await list.call(worker.github, "ai-fix");
  worker.log("info", "review-fix:pending", { count: pullRequests.length });
  let addressed = 0;
  let disputed = 0;
  let failed = 0;
  for (const pullRequest of pullRequests) {
    worker.throwIfStopping();
    try {
      const result = await processPullRequest(worker, pullRequest);
      addressed += result.addressed;
      disputed += result.disputed;
    } catch (error) {
      failed += 1;
      worker.log("error", "review-fix:error", { prNumber: pullRequest.number, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { pullRequests: pullRequests.length, addressed, disputed, failed };
}
