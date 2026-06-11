# Project Guidelines

## Workflow
- **Never commit or push without asking the user first**
- Publish: `.\build.ps1` (or `.\build.ps1 -Kill` to force-close before publishing)
- Debug: `.\debug.ps1` (hot reload loop)
- Close the running app before publishing (it locks the output files)
