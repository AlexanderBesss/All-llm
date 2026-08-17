import { abortError, isAbortError, runProcess } from "../git.js";
import type { ValidationCommand, ValidationSettings } from "../model/config.js";

export enum ValidationStatus {
  Passed = "passed",
  Failed = "failed",
}

export interface ValidationResult {
  name: string;
  command: string;
  status: ValidationStatus;
  durationMs: number;
  output: string;
}

export async function runRepositoryValidation({
  settings,
  cwd,
  signal,
  log,
}: {
  settings: ValidationSettings;
  cwd: string;
  signal?: AbortSignal;
  log(level: "info" | "warn", event: string, details?: Record<string, unknown>): void;
}): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  for (const command of settings.commands) {
    if (signal?.aborted) throw abortError("Factory shutdown requested.");
    const startedAt = Date.now();
    const display = formatCommand(command);
    log("info", "validation:start", { name: command.name, command: display });
    try {
      const result = await runProcess(command.command, command.args, {
        cwd,
        timeoutMs: settings.timeoutMs,
        signal,
      });
      const validation: ValidationResult = {
        name: command.name,
        command: display,
        status: ValidationStatus.Passed,
        durationMs: Date.now() - startedAt,
        output: trimOutput([result.stdout, result.stderr].filter(Boolean).join("\n")),
      };
      results.push(validation);
      log("info", "validation:passed", {
        name: command.name,
        command: display,
        durationMs: validation.durationMs,
      });
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw error;
      const validation: ValidationResult = {
        name: command.name,
        command: display,
        status: ValidationStatus.Failed,
        durationMs: Date.now() - startedAt,
        output: trimOutput(error instanceof Error ? error.message : String(error)),
      };
      results.push(validation);
      log("warn", "validation:failed", {
        name: command.name,
        command: display,
        durationMs: validation.durationMs,
        error: validation.output,
      });
      throw new Error(`Independent validation '${command.name}' failed: ${validation.output}`);
    }
  }
  if (!results.length) log("warn", "validation:skipped", { reason: "No validation commands configured." });
  return results;
}

function formatCommand(command: ValidationCommand): string {
  return [command.command, ...command.args].map(shellQuote).join(" ");
}

function shellQuote(value: string): string {
  return /[\s"']/u.test(value) ? JSON.stringify(value) : value;
}

function trimOutput(value: string): string {
  const normalized = value.trim();
  return normalized.length > 10_000 ? `${normalized.slice(0, 10_000)}\n...[truncated]` : normalized;
}
