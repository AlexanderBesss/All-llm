$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$exe = Join-Path $PSScriptRoot '..\llama\llama-server.exe'
$model = Join-Path $root 'models\Qwen\Qwen3-Embedding-8B-GGUF\Qwen3-Embedding-8B-Q4_K_M.gguf'
$log = Join-Path $PSScriptRoot 'llama-embedding.log'

& $exe `
  -m $model `
  --host 127.0.0.1 `
  --port 8081 `
  --gpu-layers 0 `
  --ctx-size 8192 `
  --batch-size 512  `
  --ubatch-size 512  `
  --flash-attn on `
  --embedding `
  --pooling last *>&1 | Tee-Object $log
pause 
