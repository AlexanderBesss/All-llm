# TTS Reader

TTS Reader is a standalone Windows WPF document reader. It browses folders containing `.txt`, `.md`, `.markdown`, and text-based `.pdf` files. Markdown files are rendered in a caret-enabled preview with headings, emphasis, links, images, lists, blockquotes, code, tables, and common Mermaid flowcharts; speech follows the readable rendered content instead of the Markdown source syntax. Plain text and extracted PDF content remain available in the same editor, and speech starts from the current caret through the default audio device.

Use **Settings** to select either the built-in Windows speech processor or a real local Piper neural voice. Moving the caret while speech is active cancels the current utterance and immediately starts again from the new position. The selected backend, Piper paths, Windows voice, playback speed, and document state are persisted under `%LOCALAPPDATA%\TtsReader`.

## Set up local neural speech

Piper runs entirely on this computer after its one-time runtime and voice download. No account, cloud credential, or local server is required. In PowerShell:

```powershell
$piperRoot = Join-Path $env:LOCALAPPDATA 'TtsReader\piper'
py -3 -m venv $piperRoot
& (Join-Path $piperRoot 'Scripts\python.exe') -m pip install --upgrade piper-tts
New-Item -ItemType Directory -Force (Join-Path $piperRoot 'voices') | Out-Null
& (Join-Path $piperRoot 'Scripts\python.exe') -m piper.download_voices --data-dir (Join-Path $piperRoot 'voices') en_US-lessac-medium
```

Restart TTS Reader and choose **Piper local neural voice** in Settings. Those default locations are detected automatically. For another [Piper voice](https://github.com/OHF-Voice/piper1-gpl/blob/main/docs/VOICES.md), set the path to its `.onnx` file; the matching `.onnx.json` must be next to it. Review each voice's `MODEL_CARD` because model licenses vary.

Piper is invoked as a separate local process, receives bounded text chunks, writes temporary WAV audio, and never sends document text over the network. Temporary audio is deleted after playback. Playback speed maps to Piper's phoneme length scale. See [the backend comparison](docs/tts-backend-decision.md) for the selection rationale and tradeoffs.

Image-only PDFs require OCR and are intentionally not supported.

## Build and test

```powershell
dotnet build .\TtsReader.csproj
dotnet test .\tests\TtsReader.Tests.csproj
```
