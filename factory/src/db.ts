import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { nowIso, EventType } from "./types.js";
import type { FactoryMetrics, FactoryRun, RunPatch } from "./model/database.js";

export async function openStateDatabase(stateDir, { readOnly = false }: { readOnly?: boolean } = {}) {
  const databasePath = path.join(stateDir, "factory.db");
  if (!readOnly) await mkdir(stateDir, { recursive: true });
  if (readOnly && !existsSync(databasePath)) {
    throw new Error(`Factory state database does not exist: ${databasePath}`);
  }
  const db = new DatabaseSync(databasePath, { readOnly, timeout: 5000 });
  if (readOnly) {
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;");
    return new StateDatabase(db);
  }
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      issue_key TEXT NOT NULL,
      project_key TEXT NOT NULL,
      status TEXT NOT NULL,
      stage TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      continuations INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      lease_owner TEXT,
      lease_until TEXT,
      issue_json TEXT NOT NULL,
      plan_json TEXT,
      branch_name TEXT,
      worktree_path TEXT,
      commit_sha TEXT,
      pr_number INTEGER,
      pr_url TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_runs_queue ON runs(status, stage, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_runs_issue ON runs(issue_key, status);
    CREATE TABLE IF NOT EXISTS stage_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      status TEXT NOT NULL,
      input_hash TEXT,
      output_json TEXT,
      error TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(run_id, stage, attempt)
    );
    CREATE INDEX IF NOT EXISTS idx_stage_runs_run ON stage_runs(run_id, stage);
    CREATE TABLE IF NOT EXISTS artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      artifact_key TEXT NOT NULL,
      artifact_value TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(kind, artifact_key)
    );
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  try {
    db.exec("ALTER TABLE runs ADD COLUMN continuations INTEGER NOT NULL DEFAULT 0");
  } catch (error) {
    if (!String(error?.message || error).toLowerCase().includes("duplicate column name")) throw error;
  }
  return new StateDatabase(db);
}

export class StateDatabase {
  db: DatabaseSync;

  constructor(db) {
    this.db = db;
  }

  close() {
    this.db.close();
  }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  getRun(id: string): FactoryRun | null {
    return (this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as unknown as FactoryRun) || null;
  }

  getActiveRunForIssue(issueKey: string): FactoryRun | null {
    return this.db.prepare(`
      SELECT * FROM runs
      WHERE issue_key = ? AND status IN ('active', 'retry_wait', 'awaiting_review')
      ORDER BY created_at DESC LIMIT 1
    `).get(issueKey) as unknown as FactoryRun || null;
  }

  acquireLease(id, leaseOwner, leaseUntil) {
    const result = this.db.prepare(`
      UPDATE runs
      SET lease_owner = ?, lease_until = ?, updated_at = ?
      WHERE id = ? AND status IN ('active', 'retry_wait', 'blocked') AND (lease_owner IS NULL OR lease_owner = ? OR lease_until < ?)
    `).run(leaseOwner, leaseUntil, nowIso(), id, leaseOwner, nowIso());
    return Number(result.changes || 0) === 1;
  }

  listRuns(limit = 20): FactoryRun[] {
    return this.db.prepare("SELECT * FROM runs ORDER BY updated_at DESC LIMIT ?").all(limit) as unknown as FactoryRun[];
  }

  claimRun({ id, issueKey, projectKey, issue, stage, leaseOwner, leaseUntil }) {
    return this.transaction(() => {
      const existing = this.getActiveRunForIssue(issueKey);
      if (existing) return { run: existing, claimed: false };
      const timestamp = nowIso();
      this.db.prepare(`
        INSERT INTO runs
          (id, issue_key, project_key, status, stage, lease_owner, lease_until, issue_json, created_at, updated_at)
        VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)
      `).run(id, issueKey, projectKey, stage, leaseOwner, leaseUntil, JSON.stringify(issue), timestamp, timestamp);
      return { run: this.getRun(id), claimed: true };
    });
  }

  updateRun(id: string, patch: RunPatch): FactoryRun | null {
    const allowed = new Set([
      "status", "stage", "attempts", "continuations", "next_attempt_at", "lease_owner", "lease_until",
      "issue_json", "plan_json", "branch_name", "worktree_path", "commit_sha",
      "pr_number", "pr_url", "last_error",
    ]);
    const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
    if (entries.length === 0) return this.getRun(id);
    const assignments = entries.map(([key]) => `${key} = ?`).join(", ");
    const values = entries.map(([, value]) => value);
    values.push(nowIso(), id);
    this.db.prepare(`UPDATE runs SET ${assignments}, updated_at = ? WHERE id = ?`).run(...values);
    return this.getRun(id);
  }

  startStage(runId, stage, inputHash = "") {
    const attempt = Number(this.db.prepare(
      "SELECT COALESCE(MAX(attempt), 0) + 1 AS next_attempt FROM stage_runs WHERE run_id = ? AND stage = ?",
    ).get(runId, stage).next_attempt);
    const startedAt = nowIso();
    this.db.prepare(`
      INSERT INTO stage_runs (run_id, stage, attempt, status, input_hash, started_at)
      VALUES (?, ?, ?, 'running', ?, ?)
    `).run(runId, stage, attempt, inputHash, startedAt);
    this.recordEvent(runId, EventType.StageStarted, { stage, attempt });
    return attempt;
  }

  finishStage(runId, stage, attempt, output, status = "completed", error = null) {
    this.db.prepare(`
      UPDATE stage_runs
      SET status = ?, output_json = ?, error = ?, completed_at = ?
      WHERE run_id = ? AND stage = ? AND attempt = ?
    `).run(status, output == null ? null : JSON.stringify(output), error, nowIso(), runId, stage, attempt);
    this.recordEvent(runId, EventType.StageFinished, { stage, attempt, status, error });
  }

  countStageAttempts(runId, stage) {
    return Number(this.db.prepare(
      "SELECT COUNT(*) AS count FROM stage_runs WHERE run_id = ? AND stage = ?",
    ).get(runId, stage).count);
  }

  getLastFailedStage(runId: string): string | null {
    return this.db.prepare(`
      SELECT stage FROM stage_runs
      WHERE run_id = ? AND status = 'failed'
      ORDER BY id DESC LIMIT 1
    `).get(runId)?.stage as string | undefined || null;
  }

  recordArtifact(runId, kind, artifactKey, artifactValue) {
    this.db.prepare(`
      INSERT INTO artifacts (run_id, kind, artifact_key, artifact_value, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(kind, artifact_key) DO UPDATE SET
        run_id = excluded.run_id,
        artifact_value = excluded.artifact_value
    `).run(runId, kind, artifactKey, String(artifactValue), nowIso());
  }

  findArtifact(kind: string, artifactKey: string): { artifact_value: string } | null {
    return this.db.prepare(
      "SELECT * FROM artifacts WHERE kind = ? AND artifact_key = ?",
    ).get(kind, artifactKey) as { artifact_value: string } | null;
  }

  recordEvent(runId, eventType, payload) {
    this.db.prepare(
      "INSERT INTO events (run_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)",
    ).run(runId, eventType, JSON.stringify(payload), nowIso());
  }

  reapExpiredLeases(now = nowIso()) {
    const result = this.db.prepare(`
      UPDATE runs
      SET lease_owner = NULL, lease_until = NULL, updated_at = ?
      WHERE status IN ('active', 'retry_wait') AND lease_until IS NOT NULL AND lease_until < ?
    `).run(now, now);
    return Number(result.changes || 0);
  }

  reapLeasesForOwners(owners: string[], now = nowIso()) {
    const candidates = [...new Set(owners.filter(Boolean))];
    if (!candidates.length) return 0;
    const placeholders = candidates.map(() => "?").join(", ");
    const result = this.db.prepare(`
      UPDATE runs
      SET lease_owner = NULL, lease_until = NULL, updated_at = ?
      WHERE status IN ('active', 'retry_wait') AND lease_owner IN (${placeholders})
    `).run(now, ...candidates);
    return Number(result.changes || 0);
  }

  getAwaitingReviewRuns(limit = 50): FactoryRun[] {
    return this.db.prepare(`
      SELECT * FROM runs
      WHERE status = 'awaiting_review' AND pr_number IS NOT NULL
      ORDER BY created_at ASC LIMIT ?
    `).all(limit) as unknown as FactoryRun[];
  }

  getMetrics(): FactoryMetrics {
    const runRows = this.db.prepare(`
      SELECT status, pr_number, created_at, updated_at
      FROM runs
    `).all() as unknown as Array<{
      status: string;
      pr_number: number | null;
      created_at: string;
      updated_at: string;
    }>;
    const byStatus: Record<string, number> = {};
    const completedCycleDurations: number[] = [];
    for (const run of runRows) {
      byStatus[run.status] = (byStatus[run.status] || 0) + 1;
      if (run.status === "completed") {
        const duration = durationMs(run.created_at, run.updated_at);
        if (duration !== null) completedCycleDurations.push(duration);
      }
    }

    const stageRows = this.db.prepare(`
      SELECT stage, status, started_at, completed_at, output_json
      FROM stage_runs
    `).all() as unknown as Array<{
      stage: string;
      status: string;
      started_at: string;
      completed_at: string | null;
      output_json: string | null;
    }>;
    const stages: Record<string, {
      attempts: number;
      completed: number;
      failed: number;
      durations: number[];
    }> = {};
    let validationChecks = 0;
    let validationPassed = 0;
    let validationFailed = 0;
    let inputTokens = 0;
    let cachedInputTokens = 0;
    let generatedTokens = 0;

    for (const stage of stageRows) {
      const summary = stages[stage.stage] || { attempts: 0, completed: 0, failed: 0, durations: [] };
      summary.attempts += 1;
      if (stage.status === "completed") summary.completed += 1;
      if (stage.status === "failed") summary.failed += 1;
      if (stage.status === "completed" && stage.completed_at) {
        const duration = durationMs(stage.started_at, stage.completed_at);
        if (duration !== null) summary.durations.push(duration);
      }
      const output = parseJsonRecord(stage.output_json);
      const telemetry = output?.telemetry;
      if (telemetry && typeof telemetry === "object") {
        const usage = telemetry as Record<string, unknown>;
        inputTokens += finiteNonNegativeNumber(usage.inputTokens);
        cachedInputTokens += finiteNonNegativeNumber(usage.cachedInputTokens);
        generatedTokens += finiteNonNegativeNumber(usage.generatedTokens);
      }
      if (Array.isArray(output?.validation)) {
        for (const check of output.validation) {
          if (!check || typeof check !== "object") continue;
          const record = check as Record<string, unknown>;
          validationChecks += 1;
          if (record.status === "passed") validationPassed += 1;
          if (record.status === "failed") validationFailed += 1;
        }
      }
      stages[stage.stage] = summary;
    }

    const normalizedStages = Object.fromEntries(Object.entries(stages).map(([stage, summary]) => [stage, {
      attempts: summary.attempts,
      completed: summary.completed,
      failed: summary.failed,
      averageDurationMs: average(summary.durations),
    }]));
    return {
      generatedAt: nowIso(),
      runs: {
        total: runRows.length,
        byStatus,
        pullRequests: runRows.filter((run) => run.pr_number !== null).length,
        averageCompletedCycleMs: average(completedCycleDurations),
      },
      stages: normalizedStages,
      validation: {
        checks: validationChecks,
        passed: validationPassed,
        failed: validationFailed,
      },
      tokenUsage: {
        inputTokens,
        cachedInputTokens,
        generatedTokens,
      },
    };
  }
}

function durationMs(start: string | null | undefined, end: string | null | undefined): number | null {
  if (!start || !end) return null;
  const duration = Date.parse(end) - Date.parse(start);
  return Number.isFinite(duration) && duration >= 0 ? duration : null;
}

function average(values: number[]): number | null {
  return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function finiteNonNegativeNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
