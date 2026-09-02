# All-LLM

Local LLM tooling — optimized for **24 GB VRAM** with max quality.

All scripts use full GPU offload (`--gpu-layers all` + `--fit on`), quantized KV cache, flash attention, and speculative decoding (DFlash / MTP+N-gram) for fast, high-quality inference.

- **llm-servers/beellama/** — beellama.cpp (llama.cpp fork) binaries; start scripts in `scripts/`
- **llm-server-manager/** — WPF app to browse and start the Windows LLM server scripts
- **llm-servers/llama/** — llama.cpp server scripts (Linux/Windows); Windows start scripts in `llama/windows/scripts/`
- **llm-servers/scripts/** — shared PowerShell modules
- **models/** — GGUF model files
- **pi/** — [pi](https://github.com/earendil-works/pi) coding agent extensions
