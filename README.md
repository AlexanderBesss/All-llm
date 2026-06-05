# All-LLM

Local LLM tooling — optimized for **24 GB VRAM** with max quality.

All scripts use full GPU offload (`--gpu-layers all` + `--fit on`), quantized KV cache, flash attention, and speculative decoding (DFlash / MTP+N-gram) for fast, high-quality inference.

- **llm-servers/beellama/** — DFlash speculative decoding
- **llm-servers/llama/** — llama.cpp server scripts (Linux/Windows)
- **llm-servers/scripts/** — shared PowerShell modules
- **models/** — GGUF model files
- **pi/** — [pi](https://github.com/earendil-works/pi) coding agent extensions
