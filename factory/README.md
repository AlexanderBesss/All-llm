# AI Software Factory

The factory turns verified Jira parent tickets into reviewed pull requests through independent planning, implementation, merge-check, and review-fix loops.

```text
Planning --AI refinement--> To Do --human verification--> Ready
                                                        |
                                                        v
                                      In Progress -> In Review -> Done (human)
                                           \-> Error after bounded failure
```

## Workflow

### Planning

The read-only planning agent adds the Jira key to the parent title, replaces its description with implementation-ready scope and acceptance criteria, and moves it to `To Do` for human verification. The supervisor alone edits Jira; planning creates no factory run, branch, commit, pull request, subtask, or child implementation task.

Planning runs independently from implementation and skips base-branch synchronization and GitHub health checks because it uses neither Git nor GitHub mutations.

### Implementation

Only tickets in the configured `Ready` status are eligible, whether they are on a board or in the backlog; no sprint is required. For each parent ticket, the factory creates one durable run, one `factory/<JIRA-KEY>` branch, one worktree, one lead implementation agent, and one pull request. Status meanings are:

- `Ready`: verified and waiting for implementation.
- `In Progress`: the lead agent is implementing the complete parent issue.
- `In Review`: the pull request exists and awaits human review.
- `Pull Request`: an internal factory stage, not a Jira status.
- `Done`: the merge-check loop verified that the pull request was merged.
- `Error`: bounded stage attempts were exhausted.

The lead owns all edits and delivery. It may use bounded sub-agents only for read-only investigation, repository exploration, test discovery, or independent analysis. Those sub-agents are not child tasks and must not edit, commit, push, create branches or pull requests, or mutate Jira. The factory never creates Jira subtasks or child implementation work, never merges pull requests, and never writes to the default branch.

Planning, implementation, and merge-check have independent bounded limits: `planningConcurrency`, `implementationConcurrency`, and `mergeCheckConcurrency`. All default to `2`. Item failures are isolated from siblings. While Ready work remains, the implementation pool keeps its lanes filled; with `implementationConcurrency: 2`, two agents can run concurrently and a freed lane claims the next ticket immediately.

### Specification

Before live implementation starts, the factory creates a Markdown specification under the worktree's root `specs/` directory. Branch separators are flattened for portability (`factory/KAN-20` becomes `specs/factory-KAN-20.md`), while exact branch metadata stays in the file.

The spec preserves the Jira request as untrusted data and records the problem, goals, non-goals, functional requirements, testable acceptance criteria, constraints, risks, validation plan, and decision log. The unattended agent reads it, documents useful implementation decisions and assumptions, and commits and pushes it with the change. Retries preserve existing notes; ambiguity never pauses for user input. Dry runs do not mutate worktrees.

### Pull requests and AI review

Titles must be `[JIRA-KEY] exact Jira task name (Task|feature|bug fix)`. The name comes from the Jira summary; type is normalized to one of the three supported values. Missing components or an invalid existing open-PR title reject the pull request.

New pull requests receive `review`, then `ai-review`. The repository AI Review workflow runs only on the `ai-review` label event, filters to high-relevance/high-impact findings, publishes inline comments, and removes the trigger label; ordinary PR creation, updates, and commits do not spend review tokens. A human applies `ai-fix` after reviewing findings.

The review-fix loop scans open `ai-fix` pull requests and sends unresolved AI threads with no follow-up to one implementation-agent pass per PR. It ignores resolved threads, non-AI threads, and threads with human replies. After a verified commit and push, the supervisor resolves addressed threads and re-applies `ai-review`. Incorrect, irrelevant, contradictory, or unsafe feedback receives a concise negative reply and remains unresolved for human review. No eligible thread leaves the PR and label unchanged and starts no new review cycle.

## Runtime and configuration

TypeScript runtime modules, schemas, and tests live in `factory/src/`; TypeScript 7 emits runnable JavaScript and declarations to `factory/dist/`. `factory/config.json` is the default configuration. Use `FACTORY_CONFIG` or `--config` for another file, and never commit credentials.

Relative `repoPath` values resolve from the detected repository root. Relative `stateDir` values resolve from `repoPath`; the checked-in `"stateDir": "./tmp/AllLlmFactory"` is also the default and contains SQLite state, worktrees, logs, and isolated provider state.

### Providers

Changing `provider` switches the complete implementation/review/Jira strategy and automatically aligns an omitted or existing MCP adapter. `jira.adapter: rest` remains an explicit fallback.

| Provider | Implementation defaults | Jira MCP |
|---|---|---|
| `codex` | `gpt-5.6-luna`/maximum reasoning for `Task` and `bug fix`; `gpt-5.6-sol`/medium for `feature` | `Atlassian-Rovo-MCP`; short operations always use Luna/low reasoning by default |
| `opencode` | model from `opencode.json`; default `llamacpp/unsloth/Qwen3.8-27B-UD-Q5_K_XL` | `jira` through the bounded `factory-jira` agent |

Override Codex routing with `codex.model`, `codex.reasoningEffort`, `codex.featureModel`, and `codex.featureReasoningEffort`, or the matching environment variables below. Non-Luna models default to a 250,000-token context window with auto-compaction at 225,000; Luna uses Codex-provided limits. A Codex capacity error gets one immediate attempt on the `priority` service tier configured by `highCapacityServiceTier`; other failures use normal stage retries.

The unattended Codex defaults (`danger-full-access`, `never` approval) are intentionally high trust because the agent must use local Git. Repository branch restrictions and human PR review must remain enabled. Implementation and review agents have Jira MCP disabled; only the supervisor's dedicated adapter may read or mutate Jira. Codex starts from the repository so `.codex/config.toml` remains visible, while `-C` points file and Git tools to the external run worktree.

The implementation agent is repository-only: it changes source and returns structured plan metadata; Jira mutations stay with the supervisor.

OpenCode uses the same contract. Its `--format json` event output is constrained by an embedded JSON Schema, must end in exactly one JSON value, and is validated by the supervisor. Invalid read-only Jira output may be retried once. An explicit mutation-tool failure may receive one separate, error-specific correction; mutations never loop, and timeouts have unknown outcomes and are never blindly retried.

### Jira access

The configured MCP identity needs search, edit, comment, and transition permissions. Authenticate once as the same Windows user that runs the factory. Codex uses the existing `Atlassian-Rovo-MCP` registration; OpenCode uses the repository-root `opencode.json` server.

Provider-backed operations time out after `jira.mcpTimeoutMs` (default 240 seconds). Short operations use independent `jira.mcpModel` and `jira.mcpReasoningEffort` settings. The adapter serializes requests, prioritizes queued mutations over polling reads, and bounds the OpenCode `factory-jira` agent so a failed mutation cannot spin.

OpenCode receives the absolute repository configuration through `OPENCODE_CONFIG`; leave `opencode.configPath` unset to use `<repoPath>\opencode.json`. Its `directory` setting controls worktree execution, not config discovery. On Windows, npm shims run through Git Bash. Unless already defined, isolated `XDG_*` paths live under `stateDir`. For the checked-in paths, authenticate from Git Bash at the repository root:

```bash
state="$PWD/tmp/AllLlmFactory"
export XDG_CONFIG_HOME="$state/opencode-config"
export XDG_DATA_HOME="$state/opencode-data"
export XDG_STATE_HOME="$state/opencode-state"
export OPENCODE_CONFIG="$PWD/opencode.json"
opencode mcp auth jira
```

Use `jira.adapter: rest` only for a separate REST credential; it requires Jira `baseUrl`, `email`, and `apiToken`.

### GitHub and startup

Authenticate GitHub CLI once as the worker's Windows user:

```powershell
gh auth login --web --git-protocol https
gh auth setup-git
gh auth status
```

The factory uses authenticated `gh` for hosted PR operations and its credential helper for local fetch, branch, commit, and push; it stores no GitHub token in factory config.

Before processing, startup requires a clean repository, checks out the configured base branch (`main` by default), and runs `git pull --ff-only <remote> <baseBranch>`. Dirty state or Git failure stops startup. `doctor` and live startup also verify the selected executable/MCP server; normal live commands verify authenticated GitHub access. A failed preflight keeps the worker disabled. Planning omits checks it does not need.

### Environment overrides

- Factory: `FACTORY_CONFIG`, `FACTORY_AGENT_PROVIDER`, `FACTORY_JIRA_ADAPTER`, `FACTORY_MAX_ATTEMPTS`.
- Jira: `JIRA_PROJECT_KEY`, `FACTORY_JIRA_MCP_TIMEOUT_MS`, `FACTORY_JIRA_MCP_MODEL` (OpenCode), `FACTORY_JIRA_MCP_REASONING_EFFORT`; REST only: `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`.
- Git/GitHub: `GITHUB_REPOSITORY`, `FACTORY_BASE_BRANCH`, and optional `FACTORY_GITHUB_PROVIDER`, `FACTORY_GH_COMMAND`.
- Codex: `CODEX_MODEL`, `CODEX_REASONING_EFFORT`, `CODEX_FEATURE_MODEL`, `CODEX_FEATURE_REASONING_EFFORT`, `CODEX_SERVICE_TIER`, `CODEX_HIGH_CAPACITY_SERVICE_TIER`, `CODEX_SANDBOX`, `CODEX_APPROVAL_POLICY`, `CODEX_CONTEXT_WINDOW_TOKENS`, `CODEX_AUTO_COMPACT_TOKEN_LIMIT`, `CODEX_COMMAND`.
- OpenCode: `OPENCODE_MODEL`, `OPENCODE_AGENT`, `OPENCODE_COMMAND`, `OPENCODE_DIRECTORY`, `OPENCODE_CONFIG`.

## Commands

The factory is the repository's only npm project:

```powershell
cd factory
npm install
npm run doctor
npm start
```

| Command | Behavior |
|---|---|
| `npm run build` | Compile TypeScript into `dist/`. |
| `npm test` | Build and run the factory tests. |
| `npm run doctor` | Check Node, Git, clean repository/base/remote, writable SQLite state, agent/MCP, GitHub authentication/access, and Jira configuration. |
| `npm run status` / `npm run status:json` | Show durable run state. |
| `npm run run-once` / `npm run dry-run` | Perform one poll; `retry_scheduled` does not wait for its retry. Dry-run avoids worktree mutations. |
| `npm run start:planning` | Run only Planning -> To Do refinement. |
| `npm run start:jira-tasks` | Run only Ready-ticket implementation. |
| `npm run start:pull-request-check` | Run only merge detection and Jira completion. |
| `npm run start:review-fix` | Run only the `ai-fix` repair loop. |
| `npm start` / `npm run start:all` | Run all four loops concurrently. |
| `npm run install-task` | Print the elevated command that installs the restartable Windows Scheduled Task. |
| `npm run factory -- <command>` | Forward any supported CLI command or option. |

Individual loops may run in separate consoles or process managers because they share durable SQLite state. On systems that block `npm.ps1`, use `npm.cmd` (for example, `npm.cmd start`).

`start:jira-tasks` logs polling, discovery/claiming, Jira transitions, worktree and agent activity, commit/push, PR creation, comments, retries, and blocks. Heartbeats are compact; Codex completion reports exact input, cached-input, and generated-token usage instead of every item event.

The merge checker transitions merged PRs directly to `Done` without a preliminary Jira read or redundant merge comment; an ambiguous transition is reconciled with one status read.

## Observability, recovery, and guarantees

Logs use ISO-8601 UTC, for example `[2026-08-11T16:00:42.689Z] [task] task:start`. Interactive loop colors are `planning` blue, task cyan, `merge-check` yellow, and `review-fix` magenta; `FORCE_COLOR=1` enables redirected colors and `NO_COLOR=1` disables them. Structured results retain `loop`. Idle discovery/queue noise collapses to `[loop] <loop>:idle`; work, warnings, and failures remain. `jira:mcp:*` telemetry covers queueing, provider requests, validation, correction, and total duration; each logical operation ends with one `jira:mcp:complete` or `jira:mcp:failed` summary instead of separate internal-step logs.

- Runs use stable IDs, branch names, Jira markers, and durable SQLite records. Claims and leases prevent duplicate active work when processes share `stateDir`.
- Startup releases leases owned by dead factory processes; live owners remain protected. Expired leases are reclaimable.
- Before resuming, the factory confirms the Jira parent still exists; deleted parents are cancelled before agent, Git, or PR work starts.
- Retries reuse the branch/worktree and existing spec. One attempt is allowed by default; `maxAttempts`/`FACTORY_MAX_ATTEMPTS` raises the bound. Exhaustion comments diagnostics, moves Jira to the configured `Error`, and leaves the SQLite run blocked. Jira must expose that exact Error status and the configured review status (`In Review` by default).
- `continueFailedTasks` defaults to `true`: a later poll uses `stage_runs` to resume the failed implementation or PR stage, moves Jira back to the implementation status, and returns it to `Error` if continuation fails. Set it to `false` for terminal blocks.
- `Ctrl+C` gracefully aborts active agent, Git, GitHub CLI, Jira HTTP, and retry waits; descendants settle before SQLite closes. Windows uses `taskkill /T /F` before terminating Git Bash/command-shim parents so OpenCode descendants cannot survive shutdown.
- The selected agent changes source through local Git in its worktree; GitHub CLI creates and inspects hosted PR objects. After implementation and its reported tests, but before Jira reporting or PR creation, the supervisor requires the expected branch, a clean worktree, a committed spec, and local HEAD exactly matching the remote branch SHA. Implementation areas come from the actual Git diff.
- The PR URL is checkpointed before Jira comment/status reporting, so restart resumes reporting without recreating the PR. Any implementation failure follows bounded retry/Error handling without waiting for user input.

State and logs remain under `tmp\AllLlmFactory` with the checked-in configuration.
