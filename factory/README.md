# AI Software Factory

This worker processes Jira tickets in the configured Ready status through a durable local
state machine:

```text
Ready -> In Progress -> In Review -> Done (human)
          \-> Error after bounded failure
```

It uses one aggregate `factory/<JIRA-KEY>` branch and one pull request per
parent ticket. `Ready` means the ticket is waiting to be processed. `In Progress`
means one implementation agent is working on the complete parent issue in one
factory worktree. `In Review` means the pull request has been created and is
waiting for human review; `Pull Request` is the factory's internal stage while
creating that pull request, not a Jira status. The worker never merges pull
requests or writes to the default branch. Every request uses exactly one parent
task, one agent, one branch, and one pull request. The factory never creates Jira
subtasks or delegates child work.

Pull-request titles follow the enforced format `[JIRA-KEY] exact Jira task name
(Task|feature|bug fix)`. The task name comes from the Jira summary, and the task
type is normalized to one of those three supported values. A pull request is
rejected if any required part is missing or if an existing open pull request has
an invalid title.

The factory root contains operational files and documentation. Runtime modules,
schemas, and tests live under `factory/src/`.

## Specification-driven runs

Every live implementation run creates a Markdown specification in the root
`specs/` directory inside its factory worktree before the implementation agent
starts. The filename is derived from the Git branch: branch separators are
flattened for portability, so `factory/KAN-20` becomes
`specs/factory-KAN-20.md`; the exact branch remains in the file metadata.

The generated spec records the Jira request as untrusted source data, then
sets out the problem, goals, non-goals, functional requirements, testable
acceptance criteria, constraints, risks, validation plan, and decision log.
The unattended agent reads it, records useful implementation decisions, and
must commit and push it with the rest of the parent change. A retry preserves
an existing spec in the worktree so an earlier attempt's notes are not lost.
The agent resolves ambiguity with documented assumptions and never pauses for
user questions. Dry runs retain their existing no-worktree-mutation behavior.

Factory log lines begin with an ISO-8601 UTC timestamp, for example
`[2026-08-11T16:00:42.689Z] [factory] poll:start`.

## Configure

Copy `config.example.json` to a user-owned location outside the repository and
set `FACTORY_CONFIG` to that path. Keep Jira and GitHub credentials out of the
repository. The worker also accepts `FACTORY_JIRA_ADAPTER`,
`JIRA_PROJECT_KEY`, `GITHUB_REPOSITORY`, and `FACTORY_BASE_BRANCH` environment
variables. `FACTORY_GITHUB_PROVIDER` and `FACTORY_GH_COMMAND` are optional.
`JIRA_BASE_URL`, `JIRA_EMAIL`,
and `JIRA_API_TOKEN` are only needed for the optional REST fallback.

In the default `codex-mcp` mode, the connected Atlassian MCP identity needs
permission to search, edit, comment, and transition issues. The
Authenticate GitHub CLI once for the same Windows user account that will run
the scheduled task:

```powershell
gh auth login --web --git-protocol https
gh auth setup-git
gh auth status
```

The factory uses the authenticated `gh` CLI for pull-request creation and
inspection. Local Git uses the `gh` credential helper for fetch, branch,
commit, and push operations on this PC; no GitHub token is stored in the
factory configuration.

Complete the Atlassian MCP OAuth login once for the same Windows user account
that will run the scheduled task. Codex uses the existing
`.codex/config.toml` registration for `Atlassian-Rovo-MCP`; the factory supervisor
performs Jira reads and mutations through that connected MCP server. The single
implementation agent only changes the repository and returns plan metadata.

Codex is launched with the repository as its process directory so this MCP
registration remains visible, while `-C` points its file and Git tools at the
run’s external worktree.

Set `jira.adapter` to `rest` only if a separate Jira REST credential is desired;
that fallback then requires `baseUrl`, `email`, and `apiToken` in the Jira
section.

The factory invokes the installed Codex CLI, not OpenCode or the local Qwen
bridge. Defaults are `gpt-5.6-luna` with maximum reasoning effort. Override
them in the JSON config or with `CODEX_MODEL`, `CODEX_REASONING_EFFORT`,
`CODEX_SANDBOX`, `CODEX_APPROVAL_POLICY`, `CODEX_CONTEXT_WINDOW_TOKENS`,
`CODEX_AUTO_COMPACT_TOKEN_LIMIT`, and `CODEX_COMMAND`. The factory defaults to
a 250,000-token context ceiling and starts automatic compaction at 225,000
tokens. The `danger-full-access` sandbox and `never` approval policy are
intentionally high trust because an unattended worker must use local Git and
the configured MCP server; keep the repository branch restrictions and human
PR review in place.

## Commands

From the repository root, use the existing `npm run factory:*` scripts. To run
the factory as a standalone npm project, change into this directory first:

```powershell
cd factory
npm run doctor
npm start
npm test
```

```powershell
npm run factory:doctor
npm run factory:status
npm run factory:run-once
npm start
npm run factory:install
```

Useful additional commands are `npm run factory:dry-run`,
`npm run factory:status:json`, `npm test`, and `npm run factory:test`. The generic
`npm run factory -- <command>` form also forwards any supported CLI command or
option.

`factory:doctor` is a preflight check for the Node runtime, Git executable and
clean repository state, configured remote and base branch, writable SQLite
state, Codex and `Atlassian-Rovo-MCP`, authenticated GitHub CLI repository
access, and Jira configuration.

`npm start` emits progress logs for polling, issue discovery and claiming,
Jira status changes, worktree creation, the single Codex implementation agent,
commit and push confirmation, pull-request creation,
Jira comments, retries, and blocked runs.

`factory:run-once` performs one poll and reports `retry_scheduled` when a stage
fails before the retry limit. It does not wait for the retry; use `npm start`
for continuous polling and automatic continuation.

To continue tasks that already reached the configured Jira `Error` status, set
`continueFailedTasks` to `true` in the config (this is enabled by default). The worker finds the durable
blocked run, resumes at its last failed stage, changes the Jira task back to
the configured implementation status (normally `In Progress`), and continues
using the existing branch and worktree. Set it to `false` when blocked tasks
should remain terminal.

Press `Ctrl+C` to request a graceful shutdown. The worker aborts active Codex,
Git, GitHub CLI, Jira HTTP, and retry-wait operations, terminates their child
processes, and closes the state database after cancellation completes.

On PowerShell installations that block the `npm.ps1` shim, use the equivalent
`npm.cmd` form, for example `npm.cmd start`.

`factory install` prints the elevated PowerShell command needed to register a
restartable Windows Scheduled Task. State and logs belong under
`%LOCALAPPDATA%\AllLlmFactory`, not in the repository.

## Safety behavior

- Only tickets in the configured Ready status are claimed.
- Runs use stable IDs, branch names, and Jira markers to reconcile retries.
- Each request has one implementation agent and one durable parent run. A retry
  reuses the same branch/worktree and asks that agent to inspect existing changes
  and continue; it never creates child tasks.
- Before resuming a persisted run, the worker verifies that the Jira parent still
  exists; if it was deleted, the run is marked cancelled and no agent, Git, or
  pull-request work is started.
- The worker refuses to start a worktree when the tracked repository is dirty.
- A failed stage makes one attempt by default, then comments diagnostics and
  transitions the Jira issue to the configured `Error` status. Set
  `maxAttempts` in the config (or `FACTORY_MAX_ATTEMPTS`) to allow additional
  attempts. The durable SQLite run remains marked blocked after the limit. The
  Jira workflow must expose that exact Error status and the configured review
  status (the default is `In Review`).
- When `continueFailedTasks` is enabled (the default), blocked runs are eligible for a new
  continuation. The worker uses `stage_runs` to restart the implementation or
  pull-request stage that failed, moves the Jira issue from `Error` to the
  configured implementation status, and returns to `Error` if the continuation
  fails again.
- Codex health, including the `Atlassian-Rovo-MCP` registration, and GitHub CLI
  authentication are checked by `doctor` before live processing. If either
  fails, the worker remains disabled.
- Codex performs source changes through local Git in the factory worktree. The
  worker uses GitHub CLI only for the hosting-platform pull-request object;
  local Git remains responsible for source mutations and branch publication.
