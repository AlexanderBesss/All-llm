# Local sub-agent task contract

Read this reference when constructing non-trivial batches, diagnosing bridge
errors, or changing local endpoint configuration.

## Batch input

Pass `--batch <path>` where the file contains either a task array or an object
with a `tasks` array.

Each task supports:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | No | Stable identifier echoed in output |
| `role` | Yes | Short specialist role |
| `task` | Yes | Self-contained assignment and requested deliverable |
| `context` | No | Inline evidence or background |
| `context_files` | No | Workspace-relative UTF-8 files to append as evidence |

The bridge rejects empty tasks, excess tasks, context files outside the current
working directory, and context exceeding `LOCAL_LLM_MAX_CONTEXT_BYTES` per task.

Tasks execute sequentially in array order. Exactly one `opencode run` process may
be active. Task `n + 1` starts only after task `n` succeeds or fails. Individual
failures are recorded and do not stop later tasks. Each task receives a fresh
OpenCode session in the same workspace, so later tasks can see earlier file changes.

## OpenCode invocation

The bridge invokes OpenCode with parameters supported by the installed CLI:

```text
opencode run \
  --model llamacpp/unsloth/Qwen3.6-27B-UD-Q4_K_XL \
  --agent build \
  --format json \
  --auto \
  --dir <workspace> \
  <generated-message>
```

On Windows, resolve the native `opencode.exe` behind the npm shim. Pass arguments
directly without a shell. `--format json` produces newline-delimited events;
the bridge extracts final `text` events and a compact `tool_use` trace.

The model is pinned to Qwen 3.6 27B. The bridge requires the exact
`llamacpp/unsloth/Qwen3.6-27B-UD-Q4_K_XL` entry under the `llamacpp` provider in
`opencode.json`; it fails closed instead of using another configured model.

`--auto` approves permission requests that are not denied. The child process also
defaults `OPENCODE_PERMISSION` to the JSON value `"allow"`, matching the user's
requirement that OpenCode have all permissions. These settings grant tool access;
they do not grant authority beyond the user's request or repository policy.

## Output

The command writes one JSON object to stdout:

```json
{
  "model": "local-model-id",
  "results": [
    {
      "id": "risks",
      "role": "critic",
      "status": "ok",
      "output": "...",
      "session_id": "ses_...",
      "tool_calls": [
        { "tool": "read", "title": "README.md", "status": "completed" }
      ]
    }
  ]
}
```

Configuration or input failures exit nonzero. Individual inference failures are
reported on their task with `status: "error"`; other tasks continue.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENCODE_COMMAND` | native installed executable | Override OpenCode executable path |
| `OPENCODE_LOCAL_AGENT` | `build` | OpenCode agent with all tools |
| `OPENCODE_LOCAL_BASE_URL` | `http://192.168.0.96:8080/v1` | Expected provider URL; must match `opencode.json` |
| `OPENCODE_LOCAL_TIMEOUT_MS` | `1200000` | Timeout for each OpenCode worker process |
| `MAX_LOCAL_AGENTS` | `4` | Maximum tasks accepted in one sequential batch |
| `LOCAL_LLM_MAX_CONTEXT_BYTES` | `100000` | File-context limit per task |

## Prompt boundary

The generated OpenCode worker prompt tells workers to:

- complete only the assigned task;
- use available OpenCode tools and work directly in the project when requested;
- follow `AGENTS.md` and the user's authorization boundaries;
- avoid commits and pushes unless explicitly authorized;
- verify work and report conclusions, changed files, validation, and blockers.

This prompt and OpenCode permissions are not sufficient security boundaries. The
frontier agent must still inspect tool traces, diffs, and validation results.
