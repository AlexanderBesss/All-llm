# Project Guidelines

## General
- WPF desktop app (.NET 8) built with MVVM pattern
- Single-file publish target: `F:\Projects\All-llm\whisper-note\publish`

## Workflow
- **Never commit or push without asking the user first**
- Publish: `.\build.ps1` (or `.\build.ps1 -Kill` to force-close before publishing)
- Debug: `.\debug.ps1` (hot reload loop)
- Close the running app before publishing (it locks the output files)

## Tech Stack
- WPF + MVVM (ViewModel base class with `SetProperty`)
- NAudio for audio capture
- llama.cpp server (`llama-server.exe`) for local inference
- Global keyboard hook (`WH_KEYBOARD_LL`) for hotkey trigger
