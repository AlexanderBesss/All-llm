import path from "node:path";
import { ensureSpecFile } from "../../spec.js";
import { makeRunMarker, nowIso, RUN_STATUSES, STAGES, sanitizeBranchPart, StageRunStatus, ArtifactKind } from "../../types.js";
import type { FactoryRun } from "../../model/database.js";
import type { JiraIssue } from "../../model/jira.js";
import type { FactoryWorker } from "../../worker.js";
import type { CodexEvent } from "../../model/codex.js";
import { hashInput, normalizePlan, planDescription } from "../format.js";
import { runRepositoryValidation } from "../validation.js";

const AGENT_HEARTBEAT_MS = 30_000;

function agentActivity(event: CodexEvent) {
  const value = event as Record<string, unknown>;
  const item = value.item && typeof value.item === "object" ? value.item as Record<string, unknown> : undefined;
  const part = value.part && typeof value.part === "object" ? value.part as Record<string, unknown> : undefined;
  const eventType = typeof value.type === "string" ? value.type : "unknown";
  if (!/(start|complete|finish|tool)/i.test(eventType) && item?.type !== "command_execution" && part?.type !== "tool") return null;
  const activity = String(item?.type || part?.type || eventType);
  const tool = part?.tool || value.tool;
  const state = part?.state && typeof part.state === "object" ? part.state as Record<string, unknown> : undefined;
  const status = item?.status || state?.status || value.status;
  return {
    event: eventType,
    activity,
    ...(typeof tool === "string" ? { tool } : {}),
    ...(typeof status === "string" ? { status } : {}),
  };
}

function agentTokenUsage(event: CodexEvent) {
  const value = event as Record<string, unknown>;
  if (value.type !== "turn.completed" || !value.usage || typeof value.usage !== "object") return null;
  const usage = value.usage as Record<string, unknown>;
  const inputTokens = Number(usage.input_tokens);
  const cachedInputTokens = Number(usage.cached_input_tokens);
  const generatedTokens = Number(usage.output_tokens);
  if (![inputTokens, cachedInputTokens, generatedTokens].every(Number.isFinite)) return null;
  return { inputTokens, cachedInputTokens, generatedTokens };
}

export async function processImplementation(worker: FactoryWorker, run: FactoryRun, { dryRun }: { dryRun: boolean }) {
  worker.throwIfStopping();
  const issue = JSON.parse(run.issue_json) as JiraIssue;
  const branchName = run.branch_name || `${worker.config.factory.branchPrefix}/${sanitizeBranchPart(run.issue_key)}`;
  const worktreePath = run.worktree_path || path.join(worker.config.stateDir, "worktrees", run.id);
  worker.log("info", "implementation:start", {
    runId: run.id,
    issueKey: run.issue_key,
    branchName,
    worktreePath,
    dryRun,
  });
  const previousPlan = run.plan_json ? normalizePlan(JSON.parse(run.plan_json)) : null;
  const attempt = worker.db.startStage(run.id, STAGES.IMPLEMENTATION, hashInput({ issue, previousPlan, branchName }));
  worker.log("info", "implementation:attempt", { runId: run.id, attempt });
  try {
    if (dryRun) {
      worker.log("info", "implementation:dry-run", { runId: run.id, branchName });
      const plan = previousPlan || normalizePlan({
        summary: "Dry-run factory execution",
        acceptanceCriteria: ["The factory can execute one parent task without creating subtasks."],
        risks: [],
        files: [],
        tests: [],
      });
      worker.db.updateRun(run.id, { plan_json: JSON.stringify(plan), issue_json: JSON.stringify(issue) });
      worker.db.finishStage(run.id, STAGES.IMPLEMENTATION, attempt, { dryRun: true, branchName }, StageRunStatus.Completed);
      worker.db.updateRun(run.id, { stage: STAGES.PULL_REQUEST, branch_name: branchName, worktree_path: worktreePath });
      return { stage: STAGES.IMPLEMENTATION, dryRun: true };
    }
    await worker.transitionIfNeeded(run.issue_key, worker.config.jira.statuses.implementation);
    worker.log("info", "implementation:status-ready", {
      runId: run.id,
      issueKey: run.issue_key,
      status: worker.config.jira.statuses.implementation,
    });
    worker.log("info", "implementation:worktree-preparing", { runId: run.id, branchName });
    const worktree = await worker.git.prepareWorktree(run.id, branchName);
    worker.log("info", "implementation:worktree-ready", { runId: run.id, worktree });
    worker.db.updateRun(run.id, { branch_name: branchName, worktree_path: worktree });
    const spec = await ensureSpecFile({
      cwd: worktree,
      issue,
      runId: run.id,
      branchName,
      generatedAt: run.created_at || nowIso(),
    });
    worker.db.recordArtifact(run.id, ArtifactKind.Spec, branchName, spec.relativePath);
    worker.log("info", "implementation:spec-ready", {
      runId: run.id,
      branchName,
      specPath: spec.relativePath,
      created: spec.created,
    });
    worker.log("info", "implementation:agent-start", { runId: run.id, branchName, worktree });
    const agentStartedAt = Date.now();
    let agentEvents = 0;
    let lastActivity = "starting";
    let tokenUsage: ReturnType<typeof agentTokenUsage> = null;
    const elapsedSeconds = () => Math.max(0, Math.round((Date.now() - agentStartedAt) / 1000));
    const heartbeat = setInterval(() => {
      worker.db.updateRun(run.id, { lease_until: new Date(Date.now() + worker.config.leaseMs).toISOString() });
      worker.log("info", "implementation:agent-heartbeat", {
        runId: run.id,
        elapsedSeconds: elapsedSeconds(),
        events: agentEvents,
        lastActivity,
        ...(tokenUsage ? { generatedTokens: tokenUsage.generatedTokens } : {}),
      });
    }, AGENT_HEARTBEAT_MS);
    heartbeat.unref();
    let result;
    try {
      result = await worker.agent.execute({
        issue,
        runId: run.id,
        branchName,
        cwd: worktree,
        previousPlan,
        specPath: spec.relativePath,
        onProgress: (event) => {
          agentEvents += 1;
          const usage = agentTokenUsage(event);
          if (usage) {
            tokenUsage = usage;
            worker.log("info", "implementation:agent-token-usage", {
              runId: run.id,
              elapsedSeconds: elapsedSeconds(),
              ...usage,
            });
            return;
          }
          const activity = agentActivity(event);
          if (!activity) return;
          lastActivity = activity.activity;
        },
      });
    } finally {
      clearInterval(heartbeat);
    }
    worker.throwIfStopping();
    let plan = normalizePlan(result.result?.plan);
    const agentDurationMs = Date.now() - agentStartedAt;
    worker.log("info", "implementation:agent-complete", {
      runId: run.id,
      committed: result.result?.committed === true,
      pushed: result.result?.pushed === true,
      tests: result.result?.tests?.length || 0,
      blockers: result.result?.blockers?.length || 0,
      elapsedSeconds: elapsedSeconds(),
      events: agentEvents,
      ...(tokenUsage || {}),
    });
    const commitSha = await worker.git.assertBranchPublished(worktree, branchName);
    worker.log("info", "implementation:head", { runId: run.id, commitSha });
    await worker.git.assertFileCommitted(worktree, spec.relativePath);
    const validation = await runRepositoryValidation({
      settings: worker.config.validation,
      cwd: worktree,
      signal: worker.signal,
      log: (level, event, details) => worker.log(level, event, { runId: run.id, ...details }),
    });
    plan = {
      ...plan,
      files: await worker.git.changedFiles(worktree),
      tests: [
        ...plan.tests,
        ...validation.map((check) => `${check.command} — ${check.status}`),
      ],
    };
    const telemetry = {
      durationMs: agentDurationMs,
      ...(tokenUsage || {}),
    };
    worker.log("info", "implementation:plan-persisting", { runId: run.id });
    worker.db.updateRun(run.id, {
      plan_json: JSON.stringify(plan),
      issue_json: JSON.stringify(issue),
      lease_until: new Date(Date.now() + worker.config.leaseMs).toISOString(),
    });
    worker.log("info", "implementation:parent-description", { runId: run.id, issueKey: run.issue_key });
    await worker.jira.updateDescription(run.issue_key, planDescription(
      issue.fields?.description,
      plan,
      makeRunMarker(run.id),
      spec.relativePath,
    ));
    worker.db.finishStage(run.id, STAGES.IMPLEMENTATION, attempt, {
      ...result.result,
      commitSha,
      validation,
      telemetry,
    }, StageRunStatus.Completed);
    worker.db.updateRun(run.id, {
      stage: STAGES.PULL_REQUEST,
      status: RUN_STATUSES.ACTIVE,
      branch_name: branchName,
      worktree_path: worktree,
      commit_sha: commitSha,
      last_error: null,
      next_attempt_at: null,
    });
    worker.log("info", "implementation:complete", {
      runId: run.id,
      issueKey: run.issue_key,
      commitSha,
      branchName,
      nextStage: STAGES.PULL_REQUEST,
    });
    return { stage: STAGES.IMPLEMENTATION, commitSha };
  } catch (error) {
    return worker.failStage(run, STAGES.IMPLEMENTATION, attempt, error);
  }
}
