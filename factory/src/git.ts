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

function killProcessTree(child): Promise<void> {
  if (!child?.pid) return Promise.resolve();
  if (process.platform === "win32") {
    // Kill the tree before terminating the shell parent. Calling child.kill()
    // first can orphan OpenCode when the child is Git Bash or a .cmd shim.
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        shell: false,
        stdio: "ignore",
      });
      const fallback = () => {
        try { child.kill(); } catch {}
        finish();
      };
      killer.once("error", fallback);
      killer.once("close", (code) => code === 0 ? finish() : fallback());
      setTimeout(fallback, 5_000).unref();
    });
  }

  // Non-Windows children are started in their own process group below, so a
  // negative PID terminates the child and all descendants together.
  try { process.kill(-child.pid, "SIGTERM"); } catch {
    try { child.kill(); } catch {}
  }
  return Promise.resolve();
}

function defaultGitBashEntry() {
  if (process.env.GIT_BASH_COMMAND) return process.env.GIT_BASH_COMMAND;
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    return path.join(programFiles, "Git", "bin", "bash.exe");
  }
  return "bash";
}

export function processInvocation(command: string, args: string[]) {
  const useWindowsCommandShim = process.platform === "win32"
    && (/\.(?:cmd|bat)$/i.test(command) || command.toLowerCase() === "opencode");
  if (!useWindowsCommandShim) return { command, args };
  // Pass the command and arguments as bash positional parameters. This keeps
  // OpenCode prompts and JSON payloads intact without interpolating them into
  // a shell command string.
  return {
    command: defaultGitBashEntry(),
    args: ["-lc", 'exec "$0" "$@"', command, ...args],
  };
}

export function runProcess(command: string, args: string[], { cwd, env = process.env, input, timeoutMs = 120_000, signal, onStdoutLine }: ProcessOptions = {}): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(`Operation aborted before starting: ${command}`));
      return;
    }
    // Keep stdin detached for ordinary commands. Codex prompts opt into a
    // pipe explicitly below because newer Codex CLIs read stdin when passed
    // the `-` prompt marker.
    // Keep ordinary executables shell-free. Windows npm `.cmd`/`.bat` shims
    // are routed through Git Bash with positional arguments.
    const invocation = processInvocation(command, args);
    const spawnCommand = invocation.command;
    const spawnArgs = invocation.args;
    const child = spawn(spawnCommand, spawnArgs, {
      cwd,
      env,
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stdoutLineBuffer = "";
    let stderr = "";
    let settled = false;
    let terminating = false;
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
    const terminate = (error) => {
      if (settled || terminating) return;
      terminating = true;
      killProcessTree(child).finally(() => fail(error));
    };
    const onAbort = () => {
      terminate(abortError(`Operation aborted while running: ${command} ${args.join(" ")}`));
    };
    const timer = setTimeout(() => {
      terminate(new Error(`${command} ${args.join(" ")} timed out after ${timeoutMs} ms.`));
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      if (!onStdoutLine) return;
      stdoutLineBuffer += text;
      const lines = stdoutLineBuffer.split(/\r?\n/);
      stdoutLineBuffer = lines.pop() || "";
      for (const line of lines) {
        try { onStdoutLine(line); } catch {}
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    if (input !== undefined) child.stdin?.end(input);
    child.on("error", (error) => {
      fail(error);
    });
    child.on("close", (code) => {
      if (terminating) return;
      if (settled) return;
      cleanup();
      if (onStdoutLine && stdoutLineBuffer) {
        try { onStdoutLine(stdoutLineBuffer); } catch {}
        stdoutLineBuffer = "";
      }
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

  async preparePullRequestWorktree(runId: string, branchName: string) {
    await this.assertRepositoryClean();
    const listing = await this.runProcess("git", ["worktree", "list", "--porcelain"], { cwd: this.config.repoPath, signal: this.config.signal });
    const blocks = listing.stdout.split(/\r?\n\r?\n/).map((block) => block.split(/\r?\n/));
    const branchRef = `branch refs/heads/${branchName}`;
    const existing = blocks.find((block) => block.includes(branchRef));
    const existingPath = existing?.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    if (existingPath) return existingPath;

    const worktreePath = path.join(this.config.stateDir, "worktrees", runId);
    await mkdir(path.dirname(worktreePath), { recursive: true });
    if (existsSync(worktreePath)) throw new Error(`Worktree path exists but is not registered with Git: ${worktreePath}`);
    await this.git(["fetch", this.config.remote, `refs/heads/${branchName}:refs/remotes/${this.config.remote}/${branchName}`], this.config.repoPath);
    await this.git(["worktree", "add", "-B", branchName, worktreePath, `${this.config.remote}/${branchName}`], this.config.repoPath);
    return worktreePath;
  }

  async headSha(worktreePath) {
    return this.output(["rev-parse", "HEAD"], worktreePath);
  }

  async hasChanges(worktreePath) {
    return Boolean(await this.output(["status", "--porcelain"], worktreePath));
  }

  async assertBranchPublished(worktreePath: string, branchName: string) {
    const currentBranch = await this.output(["branch", "--show-current"], worktreePath);
    if (currentBranch !== branchName) {
      throw new Error(`Factory worktree is on '${currentBranch || "detached HEAD"}', expected '${branchName}'.`);
    }
    if (await this.hasChanges(worktreePath)) {
      throw new Error("Factory agent completed with uncommitted worktree changes.");
    }

    const head = await this.headSha(worktreePath);
    const remote = this.config.remote || "origin";
    const output = await this.output(["ls-remote", "--exit-code", "--heads", remote, branchName], worktreePath);
    const remoteHead = output.split(/\s+/)[0] || "";
    if (remoteHead !== head) {
      throw new Error(`Remote branch ${remote}/${branchName} is at ${remoteHead || "no commit"}, expected local HEAD ${head}.`);
    }
    return head;
  }

  async changedFiles(worktreePath: string) {
    const remote = this.config.remote || "origin";
    const baseBranch = this.config.baseBranch || "main";
    const remoteBase = `refs/remotes/${remote}/${baseBranch}`;
    let baseRef = remoteBase;
    try {
      await this.git(["show-ref", "--verify", "--quiet", remoteBase], worktreePath);
    } catch {
      baseRef = baseBranch;
    }
    const output = await this.output(["diff", "--name-only", `${baseRef}...HEAD`], worktreePath);
    return output ? output.split(/\r?\n/).filter(Boolean) : [];
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
