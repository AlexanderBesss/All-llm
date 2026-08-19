# TTS Reader

TTS Reader is a standalone Windows WPF document reader. It browses folders containing `.txt`, `.md`, `.markdown`, and text-based `.pdf` files. Markdown files are rendered in a caret-enabled preview with headings, emphasis, links, images, lists, blockquotes, code, tables, and common Mermaid flowcharts; speech follows the readable rendered content instead of the Markdown source syntax. Plain text and extracted PDF content remain available in the same editor, and speech starts from the current caret through the default audio device.

Use **Settings** to select the built-in Windows speech processor, a real local Piper neural voice, or an LLM speech engine (Chatterbox or Qwen3-TTS) for higher-quality local voices. Moving the caret while speech is active cancels the current utterance and immediately starts again from the new position. The selected backend, Piper paths, Windows voice, playback speed, and document state are persisted under `%LOCALAPPDATA%\TtsReader`.

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

## Set up LLM speech (Chatterbox or Qwen3-TTS)

The LLM backends run the upstream Python packages in a dedicated virtual environment. They are optional and heavier than Piper (Hugging Face model download on first run, GPU recommended, higher RAM); TTS Reader writes a small bridge script under `%LOCALAPPDATA%\TtsReader\scripts` and invokes the venv's `python.exe` as a separate local process. Text still never leaves the machine. Qwen3-TTS uses a resident worker: one Python process loads the model once per app session and synthesizes each chunk in it, so the multi-second model load does not repeat for every ~500-character chunk. The LLM engine still generates slower than real time, so expect a noticeable wait after clicking Read before the first words arrive; the engine logs its activity under `%LOCALAPPDATA%\TtsReader\logs` if playback fails.

When an LLM backend is unavailable, click its download arrow in Settings. The app downloads the model and dependencies, and if Python is not installed it also installs a private per-user Python runtime under `%LOCALAPPDATA%\TtsReader\python-runtime` without changing PATH or requiring the Microsoft Store alias. On Windows, Qwen3-TTS also gets a private SoX audio dependency under `%LOCALAPPDATA%\TtsReader\sox`. Manual setup is still supported using the commands below.

**Chatterbox** ([ResembleAI/chatterbox](https://huggingface.co/ResembleAI/chatterbox)) in PowerShell:

```powershell
$cbRoot = Join-Path $env:LOCALAPPDATA 'TtsReader\chatterbox'
py -3 -m venv $cbRoot
& (Join-Path $cbRoot 'Scripts\python.exe') -m pip install --upgrade chatterbox-tts
```

**Qwen3-TTS** ([Qwen/Qwen3-TTS](https://huggingface.co/Qwen/Qwen3-TTS)) in PowerShell:

```powershell
$qwRoot = Join-Path $env:LOCALAPPDATA 'TtsReader\qwen3-tts'
py -3 -m venv $qwRoot
& (Join-Path $qwRoot 'Scripts\python.exe') -m pip install -U transformers accelerate torch soundfile qwen-tts
```

On an NVIDIA GPU, install the CUDA build of PyTorch so the model runs on the GPU (plain PyPI `torch` is CPU-only on Windows):

```powershell
& (Join-Path $qwRoot 'Scripts\python.exe') -m pip install --upgrade "torch" --extra-index-url https://download.pytorch.org/whl/cu130
```

The in-app downloader does this automatically when `nvidia-smi` is present.

Those default venv locations are detected automatically; otherwise set the Python executable and model path in Settings (a Hugging Face repo id or a local model folder, downloaded on first run). Voice control per engine:

- **Chatterbox**: model `ResembleAI/chatterbox` supports `base` and `multilingual`; use `ResembleAI/chatterbox-turbo` for `turbo` or `ResembleAI/chatterbox-nano` for `nano`. Base/multilingual can optionally use a reference `.wav`; Turbo/Nano require one.
- **Qwen3-TTS**: variant `custom-voice` (speaker name like `Ryan`, optional control **Instruction**), `voice-design` (the Voice field holds a spoken-style description), or `voice-clone` (Voice is an existing reference `.wav`; Instruction must contain its transcript).

Playback speed is applied as a pitch-preserving time stretch to the generated audio.

## Build and test

```powershell
dotnet build .\TtsReader.csproj
dotnet test .\tests\TtsReader.Tests.csproj
```
