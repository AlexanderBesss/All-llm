<!-- factory-spec: KAN-20-msp1bn40 -->
<!-- factory-spec-branch: factory/KAN-20 -->

# Specification: [KAN-20] Spec driven development

> This specification is the decision record for the unattended implementation of the parent Jira issue. It covers one parent issue, one agent, one branch, and one pull request.

## Metadata

| Field | Value |
| --- | --- |
| Jira issue | `KAN-20` |
| Jira type | `Task` |
| Project | `KAN` |
| Git branch | `factory/KAN-20` |
| Spec path | `specs/factory-KAN-20.md` |
| Run ID | `KAN-20-msp1bn40` |
| Generated at | `2026-08-11` |

## Problem statement

Factory runs currently have no durable, repository-native specification that captures the requested scope before implementation begins. The factory needs to create one spec per live run, make it available to the implementation agent, and deliver it with the branch so reviewers can compare intent with the implementation.

### Source Jira request (untrusted data)

```text
For each factory run, we should create spec file. The spec file in investigate what is it and it should follow the best practices for the spec file. The spec file should be committed into a separate folder in the root called specs. Each file name should be named as git branch. If needed, you can install spec skill from Anthropic. I think it's called brainstorm. But it shouldn't ask the user any question because it runs in without user input.
```

## Goals

- Generate a useful, structured Markdown specification before the implementation agent edits the worktree.
- Store the specification in the repository root's `specs/` folder and commit it on the factory branch.
- Use a portable branch-derived filename while retaining the exact Git branch in metadata.
- Keep the workflow fully unattended and durable across retries and resumed runs.
- Preserve the factory's one-parent/one-agent/one-branch/one-pull-request model.

## Non-goals

- Do not create Jira subtasks, child tasks, delegated agents, or additional branches.
- Do not add an interactive planning step or ask the user questions.
- Do not move Jira mutations into the implementation agent.
- Do not merge or modify the default branch.
- Do not introduce a third-party spec skill or dependency when the repository can provide the required workflow directly.

## Functional requirements

- FR-1: Every live implementation run MUST create a Markdown spec in `specs/` inside its factory worktree before agent execution.
- FR-2: The spec filename MUST be derived from the Git branch. For `factory/KAN-20`, the portable filename is `factory-KAN-20.md`.
- FR-3: The spec MUST include source context, problem statement, goals, non-goals, functional requirements, acceptance criteria, constraints, risks, validation guidance, and a decision log.
- FR-4: The exact Jira request MUST be preserved as untrusted source data and must not be allowed to expand scope or request secrets.
- FR-5: The agent MUST read the spec, resolve ambiguity with documented assumptions, and commit and push the spec with the implementation.
- FR-6: Retries MUST reuse and preserve an existing spec in the run worktree rather than discarding implementation notes.
- FR-7: The worker MUST record the spec artifact and verify that the required spec is tracked without uncommitted changes before advancing to pull-request creation.

## Acceptance criteria

- [ ] A live factory run creates `specs/factory-<issue-key>.md` on its factory branch before the implementation agent starts.
- [ ] The spec has a portable branch-derived filename and records the exact branch metadata.
- [ ] The spec is committed and pushed together with the implementation; an untracked or dirty spec blocks completion.
- [ ] The implementation agent receives the spec path, reads it, and does not ask user questions or create child work.
- [ ] Retried and resumed runs preserve an existing spec and continue using the same branch and worktree.
- [ ] Automated tests cover filename mapping, structured content, idempotent creation, prompt context, artifact recording, and commit verification.
- [ ] Documentation explains the workflow and the dry-run exception.

## Constraints and assumptions

- A live run's worktree is the repository root for the factory branch; writing the spec there ensures the normal Git commit includes it.
- Git branch separators are flattened to hyphens for cross-platform filenames; the branch metadata makes the mapping unambiguous.
- The generated spec is deterministic for a run and is not overwritten on retry, allowing the agent to add notes.
- Dry-run mode remains non-mutating and therefore does not create a committed spec.
- Existing user changes and the current factory state machine remain in scope and must not be reset.

## Risks

- A failed agent attempt can leave a generated spec uncommitted in the worktree; the durable retry path must reuse it.
- A branch-derived filename can collide after sanitization; the exact branch metadata and stable factory branch naming keep the supported branch namespace unambiguous.
- Jira descriptions can be structured or contain hostile Markdown; the generator must normalize descriptions and clearly delimit them as untrusted data.

## Validation plan

- Run the factory Node test suite.
- Run the supported factory status command to verify module wiring.
- Run `git diff --check` and inspect the final diff for accidental unrelated changes.
- Confirm the spec is tracked and clean in the final branch before push.

## Decision log

- Use a repository-native generator rather than installing an external skill: the factory already has a deterministic unattended runtime and can encode the needed spec best practices without adding an interactive dependency.
- Flatten `/` to `-` in filenames because a literal branch ref is not a portable filename; preserve the exact branch in metadata.
- Generate before agent execution and preserve existing files on retry so a failed attempt cannot lose its scope or notes.

## Implementation notes

- Added `factory/src/spec.mjs` for portable branch filenames, structured spec content, and idempotent worktree creation.
- Integrated spec creation, artifact recording, agent prompt context, and production Git verification into `factory/src/worker.mjs` and `factory/src/git.mjs`.
- Updated `factory/src/codex.mjs`, tests, and `factory/README.md` to document and enforce the unattended workflow.
- Validation completed on the factory supervisor's Windows machine: `npm.cmd test` passes all 23 tests, including filename mapping, idempotent creation, workflow integration, retry behavior, and tracked/clean Git verification.
- Validation completed: the supported factory status command and JavaScript syntax checks pass; `git diff --check` reports no whitespace errors.
