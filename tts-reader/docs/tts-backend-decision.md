# Local neural TTS backend decision

Decision date: 2026-08-17. The comparison uses the upstream project documentation available on that date. Figures are upstream claims or artifact sizes, not benchmarks on this application.

| Option | License | Language and voice support | Hardware/runtime, size, and latency | Windows installation and offline behavior |
| --- | --- | --- | --- | --- |
| [Piper](https://github.com/OHF-Voice/piper1-gpl) | Current engine is GPL-3.0-or-later. Voice licenses vary and must be checked in each `MODEL_CARD`; the sample Lessac voice repository is MIT. | More than 30 language/locale families are published, including English, Ukrainian, German, French, Spanish, and Chinese. Each downloaded ONNX file is a fixed voice. | ONNX Runtime supports CPU inference without PyTorch or a discrete GPU. The medium Lessac ONNX model is about 63 MB. Piper describes the engine as fast/local; CLI startup reloads the model for each invocation, so first audio is slower than a resident server. | `piper-tts` provides Windows Python wheels and a CLI. A venv plus two voice files is enough. Inference is fully offline after setup. The application does not redistribute Piper and invokes the separately installed CLI. |
| [Chatterbox](https://github.com/resemble-ai/chatterbox) | MIT for engine/model project. | Turbo and Nano are English; Multilingual V3 is 500M parameters and covers 23+ languages with cloning/style features. | Python, PyTorch, Transformers, and model weights. Upstream lists Nano at 110M (CPU, claimed 3x realtime on 8 cores), Turbo at 350M, and multilingual at 500M. The richer voice-cloning path has materially more dependencies and memory than Piper. | `pip install chatterbox-tts`; upstream development/testing guidance targets Python 3.11 on Debian, so a Windows WPF deployment needs a separately maintained Python bridge and model cache. It can run offline once all weights are cached. |
| [Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS) | Apache-2.0. | 0.6B and 1.7B variants support ten languages, nine supplied timbres, voice design, and short-sample cloning depending on model. | Python/PyTorch with 0.6B or 1.7B weights; upstream recommends CUDA, bfloat16, and FlashAttention 2. It reports streaming first-packet latency as low as 97 ms on its benchmark configuration, not typical CPU/CLI latency. Model and tokenizer downloads are multiple large weight artifacts. | Install `qwen-tts` in an isolated Python 3.12 environment and download Hugging Face/ModelScope weights. Local/offline inference is supported after all artifacts are present, but Windows GPU dependencies and a durable worker process add substantial packaging complexity. |

## Decision

Piper is selected because it is the smallest dependable fit for a Windows/.NET desktop reader: an ordinary local executable, a compact ONNX voice, CPU operation, deterministic WAV output, and no resident service or cloud credential. Chatterbox and Qwen3-TTS offer more expressive generation, but their PyTorch environments, much larger models, and GPU-oriented fast paths would make installation and lifecycle management disproportionate for this standalone reader.

The application keeps `System.Speech` as the default. Piper becomes available only when its executable, `.onnx` model, and adjacent `.onnx.json` are present. Settings expose the executable/model paths and persist them. Piper is launched without a shell, document text is passed as bounded command arguments, output is played locally, and cancellation terminates active synthesis/playback. The implementation deliberately does not start an HTTP service or download anything during reading.

## Addendum: optional LLM backends (2026-08-17)

User feedback requested the more expressive options. Chatterbox and Qwen3-TTS were added as opt-in backends alongside Piper rather than replacing it: they remain disabled until the user creates a venv and points Settings at its `python.exe` plus a model (Hugging Face repo id or local folder). Each upstream package exposes a Python API without a text-to-WAV CLI, so TTS Reader writes a small bridge script and runs it via the venv interpreter as a separate local process with bounded text arguments, the same lifecycle, cancellation, and temporary-WAV behavior as Piper. First run downloads weights from Hugging Face; afterwards the engines run offline. GPU (CUDA `bfloat16`) is recommended but CPU (`float32`) is supported via device auto-detection.

## Addendum: resident Qwen3-TTS worker (2026-08-19)

The per-chunk CLI approach made Qwen3-TTS unusable on CPU-only installs (plain PyPI `torch` on Windows is CPU-only) and added an 8–20 s model load to every ~500-character chunk. Two changes: the downloader/README now install the CUDA PyTorch build when `nvidia-smi` is present, and Qwen3-TTS runs in a resident worker process (JSON lines over stdin/stdout, one per app session, restarted on crash, killed on Stop/timeout). The model loads once; cancellation abandons the worker so a fresh Read resumes immediately. Chatterbox keeps the per-invocation bridge.

## Known tradeoffs

- Qwen3-TTS keeps one Python worker alive per app session (a few GB of VRAM/CPU memory while running); Chatterbox still starts one process per chunk, which adds model-load latency but keeps its setup simple.
- Caret highlighting advances per completed Piper chunk; Windows speech retains its word-level progress events.
- The user chooses a voice suitable for the document language and is responsible for that voice's model license.
- Initial `pip` and voice installation require internet access. Normal document playback does not.
