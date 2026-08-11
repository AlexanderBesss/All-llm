# Project Guidelines

## Workflow
- The factory runtime is Codex CLI. Its implementation agent uses local Git tools in a factory worktree; the factory uses authenticated GitHub CLI for pull-request creation and metadata.
- Publish: `.\build.ps1` (or `.\build.ps1 -Kill` to force-close before publishing)
- Debug: `.\debug.ps1` (hot reload loop)
