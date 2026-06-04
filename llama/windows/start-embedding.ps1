& (Join-Path $PSScriptRoot 'llama\llama-server.exe') `
  -m "F:\LLM\Qwen\Qwen3-Embedding-8B-GGUF\Qwen3-Embedding-8B-Q4_K_M.gguf" `
  --host 127.0.0.1 `
  --port 8081 `
  --gpu-layers 99 `
  --ctx-size 8192 `
  --batch-size 512  `
  --ubatch-size 512  `
  --flash-attn on `
  --no-mmap `
  --embedding `
  --pooling last *>&1 | Tee-Object llama-embedding.log
pause 
