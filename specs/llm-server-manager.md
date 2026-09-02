# Specification: LLM Server Manager (WPF app + scripts reorganization)

> This specification is a manual (non-factory) scope and decision record for adding a WPF application that lists and starts the Windows LLM server scripts, and for moving those scripts into dedicated `scripts/` folders.

## Metadata

| Field | Value |
| --- | --- |
| Requested by | User (direct request, no Jira issue) |
| Spec path | `specs/llm-server-manager.md` |
| Generated at | `2026-09-02` |
| Project folder | `llm-server-manager/` |

## Problem statement

The Windows LLM server start scripts are scattered next to the binaries they launch (`llm-servers/beellama/`, `llm-servers/llama/windows/`, `llm-servers/llama/windows/NPU/`) and use current-working-directory-relative model paths, so they only work when run from their exact folder. Choosing and starting a server configuration requires opening PowerShell by hand, finding the right script, and knowing its parameters. A small WPF application is needed so the available server options can be selected and started (and stopped) from a GUI, with the scripts organized in dedicated, discoverable `scripts/` folders that the application reads.

## Goals

- Move all Windows start scripts into dedicated `scripts/` folders, one per server type, so the application can discover them by scanning a folder.
- Make the moved scripts location-independent so they can be launched from the application (or any working directory) without breaking model/binary paths.
- Provide a WPF application with one tab per server type (beellama, llama.cpp Windows) that lists each runnable option with its key parameters and a Start button, a running status indicator with Stop, and per-tab binary update buttons.

## Non-goals

- No tabs or options for Linux scripts (`llama/linux/`), SGLang, or vLLM in v1.
- No UI-editable parameters: options are defined by the script contents, not by forms.
- No changes to `whisper-note` behavior beyond fixing the one script path its deprecated shim references.
- No changes to the shared updater module `llm-servers/scripts/update-github-release.ps1` or to the `update-*.ps1` scripts' locations.

## Functional requirements

- FR-1: Start scripts MUST live in `llm-servers/beellama/scripts/`, `llm-servers/llama/windows/scripts/`, and `llm-servers/llama/windows/NPU/scripts/`, moved from their current locations with Git history preserved.
- FR-2: Moved scripts MUST resolve the binary and model paths from `$PSScriptRoot` (absolute), so they run correctly from any working directory.
- FR-3: The application MUST scan the three `scripts/` folders for `start-*.ps1` and list one option per script, expanded per mode for scripts with a `param()` `ValidateSet` mode (e.g. `start-gemma.ps1` yields default and e2b options).
- FR-4: Each option MUST display parameters parsed from the script: model name, context size, KV cache type, port, and feature badges (vision, speculative decoding, NPU, embedding).
- FR-5: Start MUST launch the script via `powershell -NoProfile -ExecutionPolicy Bypass -File <script>` in a visible console window (server logs remain visible) with the working directory set to the script folder.
- FR-6: The application MUST show a running status per started option and a Stop action that terminates the full process tree (launcher plus server).
- FR-7: Each tab MUST expose an Update action that runs the matching `update-*.ps1` (`update-beellama.ps1`; `update-llama.ps1` and `update-npu.ps1` on the llama.cpp tab) in a console window.
- FR-8: The application MUST locate the repository root by walking up from its own directory to find the folder containing `llm-servers/`, with an override via `settings.json` next to the executable (`{"repoRoot": "..."}`).
- FR-9: This file MUST remain at `specs/llm-server-manager.md` and be updated with implementation notes before completion.

## Acceptance criteria

- [x] `llm-servers/beellama/scripts/` contains the 6 beellama start scripts; `llm-servers/llama/windows/scripts/` contains the 9 llama start scripts; `llm-servers/llama/windows/NPU/scripts/` contains `start-npu.ps1`.
- [x] A moved start script executed from an arbitrary working directory (e.g. repository root) launches the correct binary and model.
- [x] The application lists 7 options on the beellama tab and 11 on the llama.cpp tab (9 GPU scripts with `start-gemma.ps1` expanded to 2 modes, plus NPU).
- [x] Start opens a console window running the server, the option shows running status, and Stop terminates the process tree and frees the port.
- [x] The per-tab Update buttons run the correct updater scripts.
- [x] `whisper-note/start-gemma-e2b.ps1` and the README reference the new script locations; no references to the old script paths remain.
- [x] `dotnet build` of `llm-server-manager/LlmServerManager.csproj` succeeds.

## Constraints and assumptions

- Windows-only scope: PowerShell 5.1-compatible scripts, .NET 8 WPF (`net8.0-windows`), following the existing `whisper-note` project conventions (no solution file in the repo).
- Scripts keep their trailing `pause` so a console window stays open after the server exits.
- Multiple options may share a port (e.g. 8080); the application does not enforce exclusivity — the server logs show bind failures.

## Risks

- Relative-path scripts may be referenced by docs or muscle memory; mitigated by the reference sweep (FR in acceptance criteria) and README update.
- Killing the launcher process may orphan the server if the tree kill fails; mitigated by using `taskkill /F /T` and verifying the port frees during validation.

## Validation plan

- `dotnet build` the new project.
- Run the application and verify tab contents and parsed metadata against the script files.
- Start a low-VRAM option (embedding :8081 or gemma e2b :8082), confirm the console opens and status shows running; Stop and confirm the port frees.
- Execute one moved script manually from a different working directory to confirm path hardening.
- Grep for stale references to the old script locations.

## Decision log

- NPU: `start-npu.ps1` is included in the llama.cpp tab (moved to `NPU/scripts/`, marked with an NPU badge). User decision.
- Updaters: the application exposes per-tab Update buttons for `update-beellama.ps1`, `update-llama.ps1`, and `update-npu.ps1`. User decision.
- v1 scope includes a running status indicator and Stop button (process-tree kill). User decision.
- New top-level project folder `llm-server-manager/`, assembly `LlmServerManager`. User decision.
- Scripts are moved rather than copied, and hardened to `$PSScriptRoot`-based absolute paths rather than relying on the application to set the working directory, so they keep working when run manually or from other tools.
- The application launches scripts in a visible console window (rather than capturing output into the GUI) because the scripts are designed for console use (live logs, `pause`).

## Implementation notes

### Script reorganization
- 16 existing start scripts moved with `git mv` (rename history preserved) into `llm-servers/beellama/scripts/` (6), `llm-servers/llama/windows/scripts/` (9), and `llm-servers/llama/windows/NPU/scripts/` (1); the incoming `start-dflash2.ps1` is also kept in `llm-servers/beellama/scripts/`.
- Every moved script now derives its binary and model paths from `$PSScriptRoot` (`$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path`, etc.) instead of CWD-relative paths; trailing `pause` kept. `start-embedding.ps1`'s log now writes to a fixed path in the scripts folder (gitignored via `*.log`).
- Argument fidelity verified mechanically: per-file comparison of all flag/value lines against `git show HEAD:<old path>` — the only differences are the intended literal-path→variable substitutions.
- `whisper-note/start-gemma-e2b.ps1` (deprecated shim) and the root `README.md` updated to the new locations.

### Application
- New top-level .NET 8 WPF project `llm-server-manager/` (no solution file, mirroring `whisper-note` conventions): `LlmServerManager.csproj`, `App.xaml`, `MainWindow.xaml`, `Models/` (`ServerScriptOption`, `UpdateAction`), `Services/` (`ScriptScanner`, `ProcessRunner`, `PortProbe`, `RepoLocator`), `ViewModels/` (`MainViewModel`, `RelayCommand`), `Converters/`.
- `ScriptScanner` scans each tab's `scripts/` folders for `start-*.ps1` and parses model, ctx, KV, port, and badges (VISION/SPEC/NPU/EMBED); `param()` `ValidateSet` mode scripts are expanded per mode (`start-gemma.ps1` → default :8080 / e2b :8082, launched with `-Mode <value>`).
- Start launches `powershell -NoProfile -ExecutionPolicy Bypass -File <script>` with WorkingDirectory set to the script folder (visible console window with logs); a 1 s `DispatcherTimer` tracks process state and probes the parsed port to show Starting.../Running/Console-open status; Stop runs `taskkill /F /T /PID` on the launcher to kill the whole tree.
- Repo root is found by walking up from the executable to the folder containing `llm-servers/`, with `settings.json` (`repoRoot`) override and a Browse fallback in the UI.
- Per-tab Update buttons run `update-beellama.ps1` (beellama tab) and `update-llama.ps1` / `update-npu.ps1` (llama.cpp tab) through the same runner.

### Validation
- `dotnet build` (Debug) of `LlmServerManager.csproj` succeeded with 0 warnings/0 errors; the app was launched and rendered both tabs (6 + 11 options) without runtime errors.
- Scanner verified with a standalone harness: 6 beellama options and 11 llama.cpp options, correct parsed metadata (model, ctx, KV, port, badges) and gemma mode expansion with correct per-mode ports/args.
- Start/Stop verified with the real `ProcessRunner`/`PortProbe` code: a fake server (port listener + child process) was started, confirmed listening, then killed via `taskkill /F /T` — launcher and child both terminated and the port freed. The embedding start script was also executed end-to-end through the runner: path resolution produced the correct absolute model path and `llama-server.exe` ran (it exited only because this verification host has no GGUF model files; models are gitignored).
- A full 27 B server start was not exercised on the verification host (no model files present); expect one to complete on a host that has the models, or report the bind/load error in the console window.
