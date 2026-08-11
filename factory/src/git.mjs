import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

export function abortError(message = "Operation aborted.") {
  const error = new Error(message);
  error.code = "ABORT_ERR";
  return error;
}

export function isAbortError(error) {
  return error?.code === "ABORT_ERR" || error?.name === "AbortError";
}

function killProcessTree(child) {
  if (!child?.pid) return;
  try { child.kill(); } catch {}
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      shell: false,
      stdio: "ignore",
    });
    killer.on("error", () => {});
    return;
  }
}

export function runProcess(command, args, { cwd, env = process.env, timeoutMs = 120_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(`Operation aborted before starting: ${command}`));
      return;
    }
    const child = spawn(command, args, { cwd, env, windowsHide: true, shell: false });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      killProcessTree(child);
      fail(abortError(`Operation aborted while running: ${command} ${args.join(" ")}`));
    };
    const timer = setTimeout(() => {
      killProcessTree(child);
      fail(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.stdin.end();
    child.on("error", (error) => {
      fail(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      cleanup();
      if (code !== 0) {
        settled = true;
        reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`));
        return;
      }
      settled = true;
      resolve({ stdout, stderr });
    });
  });
}

export class GitAdapter {
  constructor(config, processRunner = runProcess) {
    this.config = config;
    this.runProcess = processRunner;
  }

  async git(args, cwd = this.config.repoPath) {
    return this.runProcess("git", args, { cwd, signal: this.config.signal });
  }

  async output(args, cwd = this.config.repoPath) {
    return (await this.git(args, cwd)).stdout.trim();
  }

  async assertRepositoryClean() {
    const status = await this.output(["status", "--porcelain"]);
    if (status) throw new Error(`Repository has tracked changes; refusing to start a factory worktree:\n${status}`);
  }

  async prepareWorktree(runId, branchName) {
    await this.assertRepositoryClean();
    const worktreePath = path.join(this.config.stateDir, "worktrees", runId);
    await mkdir(path.dirname(worktreePath), { recursive: true });
    const worktrees = await this.runProcess("git", ["worktree", "list", "--porcelain"], { cwd: this.config.repoPath, signal: this.config.signal });
    const normalize = (value) => path.resolve(value).replaceAll("\\", "/").toLowerCase();
    const registered = worktrees.stdout.split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => normalize(line.slice("worktree ".length)))
      .includes(normalize(worktreePath));
    if (!registered) {
      if (existsSync(worktreePath)) throw new Error(`Worktree path exists but is not registered with Git: ${worktreePath}`);
      try {
        await this.git(["fetch", this.config.remote, this.config.baseBranch], this.config.repoPath);
      } catch {
        // An offline local clone may still have a usable base ref.
      }
      const baseRef = `refs/remotes/${this.config.remote}/${this.config.baseBranch}`;
      let startPoint = baseRef;
      try {
        await this.git(["show-ref", "--verify", "--quiet", baseRef]);
      } catch {
        startPoint = this.config.baseBranch;
      }
      await this.git(["worktree", "add", "-B", branchName, worktreePath, startPoint], this.config.repoPath);
    }
    return worktreePath;
  }

  async headSha(worktreePath) {
    return this.output(["rev-parse", "HEAD"], worktreePath);
  }

  async hasChanges(worktreePath) {
    return Boolean(await this.output(["status", "--porcelain"], worktreePath));
  }

  async removeWorktree(worktreePath) {
    try {
      await this.git(["worktree", "remove", "--force", worktreePath], this.config.repoPath);
    } catch {
      // Cleanup is best-effort; the persisted path remains for doctor/recovery.
    }
  }
}
