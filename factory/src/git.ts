import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ProcessOptions, ProcessResult, ProcessRunner } from "./model/process.js";
import type { GitAdapterConfig } from "./model/git.js";

export function abortError(message = "Operation aborted.") {
  const error = new Error(message);
  (error as Error & { code?: string }).code = "ABORT_ERR";
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

export function runProcess(command: string, args: string[], { cwd, env = process.env, input, timeoutMs = 120_000, signal }: ProcessOptions = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(`Operation aborted before starting: ${command}`));
      return;
    }
    // Keep stdin detached for ordinary commands. Codex prompts opt into a
    // pipe explicitly below because newer Codex CLIs read stdin when passed
    // the `-` prompt marker.
    // Windows cannot spawn npm-generated `.cmd`/`.bat` shims with shell=false.
    // Route only those scripts through cmd.exe; keeping ordinary executables
    // shell-free avoids interpreting task prompts as shell syntax.
    const useWindowsCommandShim = process.platform === "win32" && /\.(?:cmd|bat)$/i.test(command);
    const spawnCommand = useWindowsCommandShim
      ? (process.env.ComSpec || process.env.COMSPEC || "cmd.exe")
      : command;
    const spawnArgs = useWindowsCommandShim
      ? ["/d", "/s", "/c", command, ...args]
      : args;
    const child = spawn(spawnCommand, spawnArgs, {
      cwd,
      env,
      windowsHide: true,
      shell: false,
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
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
    if (input !== undefined) child.stdin?.end(input);
    child.on("error", (error) => {
      fail(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      cleanup();
      if (code !== 0) {
        settled = true;
        const details = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
        reject(new Error(`${command} ${args.join(" ")} failed (${code})${details ? `: ${details}` : "."}`));
        return;
      }
      settled = true;
      resolve({ stdout, stderr });
    });
  });
}

export class GitAdapter {
  config: GitAdapterConfig;
  runProcess: ProcessRunner;

  constructor(config: GitAdapterConfig, processRunner: ProcessRunner = runProcess) {
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

  async syncBaseBranch() {
    await this.assertRepositoryClean();
    const baseBranch = this.config.baseBranch;
    const remote = this.config.remote || "origin";
    const currentBranch = await this.output(["branch", "--show-current"]);
    const switched = currentBranch !== baseBranch;
    if (switched) await this.git(["checkout", baseBranch]);
    await this.git(["pull", "--ff-only", remote, baseBranch]);
    return { previousBranch: currentBranch, branch: baseBranch, switched };
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

  async assertFileCommitted(worktreePath, relativePath) {
    const root = path.resolve(worktreePath);
    const target = path.resolve(root, relativePath);
    const relative = path.relative(root, target);
    if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
      throw new Error(`Refusing to verify a path outside the worktree: ${relativePath}`);
    }
    const status = await this.output(["status", "--porcelain", "--", relative], worktreePath);
    if (status) throw new Error(`Required factory file has uncommitted changes: ${relativePath}`);
    await this.git(["ls-files", "--error-unmatch", "--", relative], worktreePath);
  }

  async removeWorktree(worktreePath) {
    try {
      await this.git(["worktree", "remove", "--force", worktreePath], this.config.repoPath);
    } catch {
      // Cleanup is best-effort; the persisted path remains for doctor/recovery.
    }
  }
}
