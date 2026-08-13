# AI Software Factory

This worker processes Jira tickets in the configured Ready status through a durable local
state machine:

```text
Ready -> In Progress -> Pre-PR Verification -> In Review -> Done (human)
          \-> Error after bounded failure
```

It uses one aggregate `factory/<JIRA-KEY>` branch and one pull request per
parent ticket. `Ready` means the ticket is waiting to be processed. `In Progress`
means one lead implementation agent is working on the complete parent issue in one
factory worktree. The lead may spawn several bounded sub-agents for read-only
investigation, repository exploration, test discovery, or independent analysis;
the lead owns all implementation edits and the final delivery. `Pre-PR Verification`
is an internal writable refinement stage: a fresh agent invocation explores the full
change, runs validation, and directly fixes, commits, and pushes any issues it finds.
`In Review` means the pull request has been created and is
waiting for human review; `Pull Request` is the factory's internal stage while
creating that pull request, not a Jira status. The worker never merges pull
requests or writes to the default branch. Every request uses exactly one parent
task, one lead implementation agent with an autonomous verification pass, one branch, and one
pull request. Investigation sub-agents are not child tasks: they must not edit the
worktree, create branches or pull requests, commit, push, or mutate Jira. The
factory never creates Jira subtasks or child implementation work.

New pull requests receive the `review` label and the factory explicitly applies
`ai-review` once the pull request exists. The repository AI Review workflow listens
only for that label event, so ordinary pull-request creation, updates, and commits
do not spend review tokens. It filters findings to high-relevance, high-impact
issues before publishing inline comments, removes the trigger label, and applies
`ai-fix` only when a qualifying finding was published.

A separate review-fix loop scans all open pull requests labeled `ai-fix`, gathers
their unresolved review threads, and sends every thread on a pull request to one
implementation-agent pass. After the agent commits and pushes its fixes, the
supervisor resolves addressed threads and re-applies `ai-review`, beginning the
next review cycle. Contradictory or incorrect feedback receives a technical reply
and stays unresolved for the next human review.

Pull-request titles follow the enforced format `[JIRA-KEY] exact Jira task name
(Task|feature|bug fix)`. The task name comes from the Jira summary, and the task
type is normalized to one of those three supported values. A pull request is
rejected if any required part is missing or if an existing open pull request has
an invalid title.

The factory root contains operational files and documentation. TypeScript runtime
modules, schemas, and tests live under `factory/src/`; TypeScript 7 emits runnable
JavaScript and declarations into `factory/dist/`.

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

The checked-in `factory/config.json` is the default runtime configuration.
Edit it directly, or set `FACTORY_CONFIG`/`--config` to a different user-owned
configuration file. Keep Jira and GitHub credentials out of the repository.
The worker also accepts `FACTORY_AGENT_PROVIDER`,
`FACTORY_JIRA_ADAPTER`,
`JIRA_PROJECT_KEY`, `GITHUB_REPOSITORY`, and `FACTORY_BASE_BRANCH` environment
variables. `FACTORY_GITHUB_PROVIDER` and `FACTORY_GH_COMMAND` are optional.
OpenCode accepts `OPENCODE_MODEL`, `OPENCODE_AGENT`, `OPENCODE_COMMAND`,
`OPENCODE_DIRECTORY`, and `OPENCODE_CONFIG` overrides.
`JIRA_BASE_URL`, `JIRA_EMAIL`,
and `JIRA_API_TOKEN` are only needed for the optional REST fallback.
Provider-backed Jira MCP operations are bounded by `jira.mcpTimeoutMs`
(240 seconds by default, or `FACTORY_JIRA_MCP_TIMEOUT_MS`).
Short Jira operations use dedicated `jira.mcpModel` and
`jira.mcpReasoningEffort` settings, independently of the implementation model.
The Codex provider always routes Jira MCP calls through `gpt-5.6-luna` with
`low` reasoning by default. `FACTORY_JIRA_MCP_MODEL` remains available for the
OpenCode provider; reasoning can be overridden with
`FACTORY_JIRA_MCP_REASONING_EFFORT`.
OpenCode uses the dedicated `factory-jira` agent for these calls; its agentic
steps are capped so a failed MCP mutation cannot spin indefinitely.
The adapter serializes MCP operations and gives queued mutations priority over
polling reads. Logs include queue, provider-request, validation, correction,
and total durations under `jira:mcp:*` events.

`repoPath` may be relative; it is resolved from the detected repository root.
`stateDir` may also be relative and is resolved from the configured repository
path. The checked-in configuration uses `"stateDir": "./tmp/AllLlmFactory"`,
keeping the factory database, worktrees, logs, and provider state inside the
project. If `stateDir` is omitted, the same project-local `./tmp/AllLlmFactory`
default is used.

Changing `provider` is sufficient to switch between Codex and OpenCode. The
factory automatically aligns an existing MCP Jira adapter with the selected
provider; omit `jira.adapter` for the simplest configuration. The `rest`
adapter remains an explicit opt-in fallback. The configured Jira MCP identity
needs permission to search, edit, comment, and transition issues. The
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

Before the worker starts processing runs, it verifies that the configured
repository is clean, checks out the configured base branch (`main` by default),
and runs `git pull --ff-only <remote> <baseBranch>`. A local change or Git
failure stops startup so existing work is not overwritten and runs do not use
an out-of-date base branch.

Complete the configured MCP OAuth login once for the same Windows user account
that will run the scheduled task. Codex uses the existing
`.codex/config.toml` registration for `Atlassian-Rovo-MCP`. OpenCode uses the
`jira` server from the repository-root `opencode.json`; authenticate it with
OpenCode before running unattended work. The factory supervisor performs Jira
reads and mutations through the selected provider's MCP server. The single
implementation agent only changes the repository and returns plan metadata.

Both providers are launched with the repository configuration available even
when file and Git tools operate in an external factory worktree. OpenCode gets
the absolute repository-root config through `OPENCODE_CONFIG`; leave
`opencode.configPath` unset to use `<repoPath>\opencode.json`. Its
`directory` setting controls the worktree execution directory, not config
discovery. The factory routes Windows npm command shims through Git Bash and
uses isolated OpenCode config, data, and state directories under `stateDir`
unless the corresponding `XDG_*` variables are already set. Authenticate the
`jira` MCP server using the same environment before unattended processing, for
example by setting `XDG_CONFIG_HOME`, `XDG_DATA_HOME`, and `XDG_STATE_HOME` to
the factory paths and running `opencode mcp auth jira`. This keeps logs,
database files, and MCP OAuth credentials writable and consistent for the
scheduled worker.

For the checked-in project-local configuration, authenticate once from Git Bash
at the repository root with:

```bash
state="$PWD/tmp/AllLlmFactory"
export XDG_CONFIG_HOME="$state/opencode-config"
export XDG_DATA_HOME="$state/opencode-data"
export XDG_STATE_HOME="$state/opencode-state"
export OPENCODE_CONFIG="$PWD/opencode.json"
opencode mcp auth jira
```

Codex is launched with the repository as its process directory so its MCP
registration remains visible, while `-C` points its file and Git tools at the
run’s external worktree.

Set `jira.adapter` to `rest` only if a separate Jira REST credential is desired;
that fallback then requires `baseUrl`, `email`, and `apiToken` in the Jira
section.

The factory uses a provider strategy. `provider` defaults to `codex`, which
invokes the installed Codex CLI with `gpt-5.6-luna` and maximum reasoning
effort for Jira `Task` and `bug fix` issues. Jira `feature` issues use
`gpt-5.6-sol` with medium reasoning effort for implementation and pre-PR
verification. These routes can be overridden with `codex.model`,
`codex.reasoningEffort`, `codex.featureModel`, and
`codex.featureReasoningEffort`. Set `provider` to `opencode` to invoke the
installed OpenCode CLI and
the local model configured in `opencode.json`; the default is
`llamacpp/unsloth/Qwen3.6-27B-UD-Q4_K_XL`. Override Codex settings in the JSON
config or with `CODEX_MODEL`, `CODEX_REASONING_EFFORT`,
`CODEX_FEATURE_MODEL`, `CODEX_FEATURE_REASONING_EFFORT`,
`CODEX_SERVICE_TIER`, `CODEX_HIGH_CAPACITY_SERVICE_TIER`, `CODEX_SANDBOX`, `CODEX_APPROVAL_POLICY`, `CODEX_CONTEXT_WINDOW_TOKENS`,
`CODEX_AUTO_COMPACT_TOKEN_LIMIT`, and `CODEX_COMMAND`. The factory defaults to
a 250,000-token context ceiling and starts automatic compaction at 225,000
tokens. The `danger-full-access` sandbox and `never` approval policy are
intentionally high trust because an unattended worker must use local Git and
repository tools. Implementation and review invocations disable the Jira MCP
server explicitly; only the dedicated Jira adapter may use it. Keep the
repository branch restrictions and human PR review in place. When Codex reports that the selected model is at capacity,
the factory immediately makes one additional attempt using the `priority`
service tier (configurable through `highCapacityServiceTier`); other failures
continue through the normal bounded stage-retry policy.

OpenCode uses the same implementation, review, and structured-Jira strategy
contract as Codex. The Jira prompts are provider-neutral; each strategy checks
its own MCP server during `doctor` and before live processing. OpenCode's
`--format json` mode supplies raw JSON events, so the factory also embeds each
requested JSON Schema in the prompt, requires the final response to be exactly
one JSON value, validates it against the schema in the supervisor, and retries read-only Jira
lookups once after an invalid response. A failed Jira description mutation may
receive one separate correction request containing the MCP error; no mutation
can loop beyond that single correction. An explicit tool failure may be
corrected once, but a timeout has an unknown outcome and is never blindly
retried. It is reported as a failed factory stage instead.

## Commands

The factory is the repository's only npm project. Change into this directory
before installing dependencies or running commands:

```powershell
cd factory
npm install
npm run build
npm run doctor
npm start
npm test
```

```powershell
npm run status
npm run run-once
npm start
npm run start:jira-tasks
npm run start:pull-request-check
npm run start:review-fix
npm run start:all
npm run install-task
```

Useful additional commands are `npm run dry-run`,
`npm run status:json`, and `npm test`. Use `npm run start:jira-tasks` to run
only the Jira Ready-ticket polling and implementation loop. Use
`npm run start:pull-request-check` to run only the GitHub pull-request merge
checker that closes the Jira ticket after a merge. `npm start` and
`npm run start:all` run all three loops together. The generic
`npm run factory -- <command>` form also forwards any supported CLI command or
option.

`npm run doctor` is a preflight check for the Node runtime, Git executable and
clean repository state, configured remote and base branch, writable SQLite
state, the selected agent and its configured Jira MCP server, authenticated
GitHub CLI repository access, and Jira configuration. Live startup repeats the
agent/MCP health check before polling.

`npm run start:jira-tasks` emits progress logs for polling, issue discovery and claiming,
Jira status changes, worktree creation, the selected implementation agent, the
fresh-context pre-PR verification agent, commit and push confirmation, pull-request creation,
Jira comments, retries, and blocked runs. Implementation-agent heartbeats remain compact;
instead of logging every Codex item event, the factory reports exact input, cached-input,
and generated-token usage when Codex completes the turn.

`npm run start:pull-request-check` emits progress logs while checking open
factory pull requests and transitions their Jira issues to `Done` after a
successful merge. The successful path transitions directly without a
preliminary Jira read and does not add a redundant merge comment; ambiguous
transition results are reconciled with one status read. The individual loop commands can run in separate consoles or
process managers because they share the same durable SQLite state directory.

`npm run start:review-fix` runs only the `ai-fix` review loop. `npm start` and
`npm run start:all` run the Jira task, review-fix, and merge-check loops together.

`npm run run-once` performs one poll and reports `retry_scheduled` when a stage
fails before the retry limit. It does not wait for the retry; use `npm start`
for continuous polling and automatic continuation.

To continue tasks that already reached the configured Jira `Error` status, set
`continueFailedTasks` to `true` in the config (this is enabled by default). The worker finds the durable
blocked run, resumes at its last failed stage, changes the Jira task back to
the configured implementation status (normally `In Progress`), and continues
using the existing branch and worktree. Set it to `false` when blocked tasks
should remain terminal.

Press `Ctrl+C` to request a graceful shutdown. The worker aborts active agent,
Git, GitHub CLI, Jira HTTP, and retry-wait operations, terminates their child
process trees, waits for descendant cleanup to complete, and closes the state
database after cancellation completes. On Windows this uses `taskkill /T /F`
before terminating the Git Bash or command-shim parent, preventing OpenCode
descendants from continuing after the console stops.

On PowerShell installations that block the `npm.ps1` shim, use the equivalent
`npm.cmd` form, for example `npm.cmd start`.

`npm run install-task` prints the elevated PowerShell command needed to register a
restartable Windows Scheduled Task. State and logs belong under the project-local
`tmp\AllLlmFactory` directory.

## Safety behavior

- Tickets in the configured Ready status are claimed from the configured Jira project whether they are on a board or in the backlog; sprint assignment is not required.
- Runs use stable IDs, branch names, and Jira markers to reconcile retries.
- On startup, a worker immediately releases active leases owned by a no-longer-running factory process, so an interrupted run does not wait for the normal lease timeout before resuming. Leases owned by live processes remain protected.
- Each request has one lead implementation agent and one durable parent run. The
  lead may use bounded read-only investigation sub-agents, while a retry reuses the
  same branch/worktree and asks the lead to inspect existing changes and continue;
  it never creates Jira subtasks or child implementation work.
- Before resuming a persisted run, the worker verifies that the Jira parent still
  exists; if it was deleted, the run is marked cancelled and no agent, Git, or
  pull-request work is started.
- The worker refuses to start a worktree when the tracked repository is dirty.
- Each factory startup synchronizes the clean tracked repository to the latest
  configured base branch before polling Jira.
- A failed stage makes one attempt by default, then comments diagnostics and
  transitions the Jira issue to the configured `Error` status. Set
  `maxAttempts` in the config (or `FACTORY_MAX_ATTEMPTS`) to allow additional
  attempts. The durable SQLite run remains marked blocked after the limit. The
  Jira workflow must expose that exact Error status and the configured review
  status (the default is `In Review`).
- When `continueFailedTasks` is enabled (the default), blocked runs are eligible for a new
  continuation. The worker uses `stage_runs` to restart the implementation,
  pre-PR verification, or pull-request stage that failed, moves the Jira issue from `Error` to the
  configured implementation status, and returns to `Error` if the continuation
  fails again.
- The selected agent's executable and configured Jira MCP registration, and
  GitHub CLI authentication are checked by `doctor` and at live startup. If
  either fails, the worker remains disabled.
- The selected agent performs source changes through local Git in the factory worktree. The
  worker uses GitHub CLI only for the hosting-platform pull-request object;
  local Git remains responsible for source mutations and branch publication.
  Before Jira reporting or pre-PR verification, the supervisor requires a clean worktree,
  the expected branch, and an exact match between local HEAD and the remote
  branch SHA. Pull-request implementation areas come from the actual Git diff.
- The pull-request URL is checkpointed before Jira comment and status reporting,
  allowing a restart after GitHub creation to resume the remaining reporting work.
- After implementation and its reported tests, a separate writable invocation of
  the selected provider performs autonomous pre-PR verification against the Jira
  request, specification, and complete branch diff. It runs relevant validation and
  directly fixes, commits, and pushes issues it can resolve. The supervisor then
  verifies the clean worktree, committed specification, and exact remote branch SHA
  before creating the pull request. A genuine unresolved blocker uses the normal
  bounded retry and Error handling without waiting for user input.
