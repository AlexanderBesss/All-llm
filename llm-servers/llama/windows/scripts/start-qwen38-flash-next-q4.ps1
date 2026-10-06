# Qwen3.8 Flash Next (arch 'qwen4exp', 512 routed experts / 10 active, 48 layers,
# native ctx 262144) - Unsloth UD-Q4_K_XL, vision + external MTP draft.
#
# Files live in the Hugging Face hub cache (downloaded with HF_HUB_CACHE=C:\models\huggingface):
#   C:\models\huggingface\hub\models--unsloth--Qwen3.8-Flash-Next-GGUF\snapshots\<hash>\
#     UD-Q4_K_XL\...-00001-of-00004.gguf  ~111 GB total, shards 2-4 load automatically
#     mmproj-F16.gguf                     vision projector (~0.9 GB)
#     MTP\mtp-...-Q8_0.gguf               MTP draft (~4.1 GB), passed via --spec-draft-model
#
# Binary: ..\llama (stock ggml-org CUDA 13 build, update with update-llama.ps1).
#   The stock build already ships qwen4exp support - no special fork needed.
#
# Speculative decoding: ngram-mod ONLY. The external MTP sidecar (MTP\*.gguf) can NOT
#   be used as --spec-draft-model with stock builds: upstream llama.cpp runs qwen4exp
#   but has not wired its NextN/MTP head into speculative decoding (prototype PR
#   ggml-org/llama.cpp#28610 was closed unmerged). Passing the MTP file aborts load
#   with "ggml-backend.cpp: GGML_ASSERT(buffer) failed" - verified by bisect on b11435:
#   4k/32k ctx + q4_0 KV + FA on all init fine, adding the MTP draft crashes even on
#   CPU (--spec-draft-ngl 0) and with otherwise-default flags. Revisit if upstream
#   merges qwen4exp MTP support; the sidecar stays in the HF cache meanwhile.
#
# RAM: ~111 GB of weights on 128 GB is tight. Keep mmap ON (no --no-mmap, no --mlock):
#   only 10 of 512 experts are touched per token, so cold expert pages must stay evictable.
#   mlock would force all 111 GB resident and thrash.
# VRAM: --cpu-moe pins the routed experts in RAM; embeddings + attention + shared expert
#   (~7 GB) plus KV on top. q4_0 KV is ~4x smaller than f16, so 32k ctx costs ~1 GB of
#   cache on a 24 GB card. If CUDA reports an allocation failure, lower --ctx-size.
# Quantized KV cache requires --flash-attn on. If the server aborts on the DSA indexer
#   path with FA enabled, switch to f16 KV and --flash-attn auto.
# --fit is not usable with --cpu-moe ("model_params::tensor_buft_overrides already set").

$exe = Join-Path $PSScriptRoot '..\llama\llama-server.exe'

$snapRoot = 'C:\models\huggingface\hub\models--unsloth--Qwen3.8-Flash-Next-GGUF\snapshots'
$snap = Get-ChildItem $snapRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { Test-Path (Join-Path $_.FullName 'UD-Q4_K_XL') } |
    Select-Object -First 1

if (-not (Test-Path $exe)) {
    Write-Host "Missing llama.cpp build: $exe" -ForegroundColor Red
    Write-Host 'Install it with: llm-servers\llama\windows\update-llama.ps1' -ForegroundColor Yellow
    pause
    exit 1
}

if (-not $snap) {
    Write-Host "Missing model snapshot under: $snapRoot" -ForegroundColor Red
    Write-Host 'Download unsloth/Qwen3.8-Flash-Next-GGUF (UD-Q4_K_XL + mmproj-F16 + MTP) into the cache first.' -ForegroundColor Yellow
    pause
    exit 1
}

$model  = Join-Path $snap.FullName 'UD-Q4_K_XL\Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004.gguf'
$mmproj = Join-Path $snap.FullName 'mmproj-F16.gguf'

if (-not (Test-Path $model)) {
    Write-Host "Missing model: $model" -ForegroundColor Red
    pause
    exit 1
}

& $exe `
    -m $model `
    --mmproj $mmproj `
    --host 0.0.0.0 `
    --port 8080 `
    --ctx-size 32000 `
    --gpu-layers all `
    --cpu-moe `
    --parallel 1 `
    --cache-ram 0 `
    --cache-type-k q4_0 `
    --cache-type-v q4_0 `
    --flash-attn on `
    --spec-type ngram-mod `
    --spec-draft-n-max 3 `
    --batch-size 2048 `
    --ubatch-size 1024 `
    --threads 28 `
    --threads-batch 28 `
    --jinja `
    --temp 1.0 `
    --top-p 0.95 `
    --top-k 20 `
    --min-p 0.0 `
    --repeat-penalty 1.0 `
    --presence-penalty 0.0 `
    --metrics `
    --slots `
    --perf
pause
