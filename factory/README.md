# AI Software Factory

This worker processes Jira tickets in the configured Ready status through a durable local
state machine:

```text
Ready -> Planning -> In Progress -> In Review -> Done (human)
                  \-> Error after bounded failure
```

It uses one aggregate `factory/<JIRA-KEY>` branch and one pull request per
parent ticket. `Ready` means the ticket is waiting to be processed. `Planning`
means the factory is updating the parent description and creating or validating
subtasks. `In Progress` means the parent and its planned subtasks are being
implemented. `In Review` means the pull request has been created and is waiting
for human review; `Pull Request` is the factory's internal stage while creating
that pull request, not a Jira status. The worker never merges pull requests or
writes to the default branch. A ticket may use zero subtasks when direct
implementation is appropriate. Planning prefers one to three cohesive
vertical subtasks and normally stays within the configurable preferred maximum
of five; tightly coupled work is kept together rather than split by file or
technical layer.

The factory root contains operational files and documentation. Runtime modules,
schemas, and tests live under `factory/src/`.

## Configure

Copy `config.example.json` to a user-owned location outside the repository and
set `FACTORY_CONFIG` to that path. Keep Jira and GitHub credentials out of the
repository. The worker also accepts `FACTORY_JIRA_ADAPTER`,
`JIRA_PROJECT_KEY`, `GITHUB_REPOSITORY`, and `FACTORY_BASE_BRANCH` environment
variables. `FACTORY_GITHUB_PROVIDER` and `FACTORY_GH_COMMAND` are optional.
`JIRA_BASE_URL`, `JIRA_EMAIL`,
and `JIRA_API_TOKEN` are only needed for the optional REST fallback.

In the default `codex-mcp` mode, the connected Atlassian MCP identity needs
permission to search, edit, comment, transition, and create subtasks. The
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
`.codex/config.toml` registration for `Atlassian-Rovo-MCP`; the planning agent
performs Jira reads and mutations through that connected MCP server. The
supervisor uses the same Codex-backed adapter for polling and reconciliation.

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
Jira status changes, planning and subtask reconciliation, worktree creation,
Codex implementation, commit and push confirmation, pull-request creation,
Jira comments, retries, and blocked runs.

`factory:run-once` performs one poll and reports `retry_scheduled` when a stage
fails before the retry limit. It does not wait for the retry; use `npm start`
for continuous polling and automatic continuation.

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
- Subtask reconciliation treats the Jira key/summary plus the run marker as the
  durable identity. Jira/MCP may render or enrich descriptions, so retries do
  not fail solely because the stored description differs from the planner's
  returned wording.
- The planner result is persisted before subtask reconciliation. If Jira reads
  or reconciliation fail, the next attempt reuses the same plan instead of
  asking the agent to plan and mutate the issue again.
- Before resuming a persisted run, the worker verifies that the Jira parent still
  exists; if it was deleted, the run is marked cancelled and no agent, Git, or
  pull-request work is started.
- The worker refuses to start a worktree when the tracked repository is dirty.
- A failed stage retries three times by default, then comments diagnostics and
  transitions the Jira issue to the configured `Error` status; the durable
  SQLite run remains marked blocked until it is manually investigated. The Jira
  workflow must expose that exact Error status and the configured review status
  (the default is `In Review`).
- Codex health, including the `Atlassian-Rovo-MCP` registration, and GitHub CLI
  authentication are checked by `doctor` before live processing. If either
  fails, the worker remains disabled.
- Codex performs source changes through local Git in the factory worktree. The
  worker uses GitHub CLI only for the hosting-platform pull-request object;
  local Git remains responsible for source mutations and branch publication.
