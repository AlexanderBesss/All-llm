$env:LLAMA_ARG_CHAT_TEMPLATE_KWARGS = '{"reasoning_effort":"medium"}'

& (Join-Path $PSScriptRoot 'llama\llama-server.exe') `
  -m "..\..\..\models\unsloth\Qwen3.8-27B-GGUF\Qwen3.8-27B-UD-Q5_K_XL.gguf" `
  --port 8080 `
  --host 0.0.0.0 `
  --gpu-layers all `
  --kv-unified `
  --spec-type draft-mtp,ngram-mod `
  --spec-ngram-mod-n-max 3 `
  --gpu-layers-draft all `
  --parallel 2 `
  --cache-ram 0 `
  --ctx-size 130000 `
  --cache-type-k q4_0 `
  --cache-type-v q4_0 `
  --flash-attn on `
  --batch-size 2048 `
  --ubatch-size 1024 `
  --load-mode none `
  --jinja `
  --reasoning on `
  --temp 1.0 `
  --top-p 0.95 `
  --top-k 20 `
  --min-p 0.0 `
  --repeat-penalty 1.0 `
  --metrics `
  --slots `
  --perf `
  --presence-penalty 0.0
pause
