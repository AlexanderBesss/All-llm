param(
    [ValidateSet('max', 'high', 'low')]
    [string]$Mode = 'max',

    [ValidateRange(1, 8)]
    [int]$SpecN = 2,

    [switch]$Ngram,

    # Force a speculator: -DFlash requires the draft file, -Mtp uses the built-in NextN layers.
    # Default: DFlash2 if its file exists, else MTP.
    [switch]$DFlash,

    [switch]$Mtp
)

# GLM-5.3-Flash (arch 'glm5next', 321B MoE / 18B active) - Unsloth UD-Q2_K_XL, vision + MTP.
#
# Binary: ..\glm5next (Unsloth build with GLM-5-Next support, installed by
#         llm-servers\llama\windows\update-glm5next.ps1). Official ggml-org builds reject
#         this file with "unknown model architecture: 'glm5next'".
#
# Measured weight split of this quant (108.71 GB total):
#   routed experts 101.66 GB | shared expert 0.80 | dense FFN 0.54 | attention+KDA+MLA+embeddings ~7 GB
# So --cpu-moe (all routed experts pinned in RAM) leaves only ~7 GB of weights for the GPU,
# which is why '--gpu-layers all' is correct here even though the file is 108 GB.
#
# RAM: 101.7 GB of experts + KV on 128 GB is tight. Keep mmap ON (no --no-mmap, no --mlock):
#   only ~8 of 288 experts are touched per token, so cold expert pages must stay evictable.
#   mlock would force all 108 GB resident and thrash.
# VRAM: MLA latents ~53 KB/token + the DSA lightning-indexer cache ~0.35 MB/token over the 43
#   sparse layers => 32k ctx costs ~12 GB of cache on top of the ~7 GB of weights. If CUDA
#   reports an allocation failure, drop --ctx-size to 16000 (halves the cache).
#
# --fit on is NOT usable with --cpu-moe in this build: fit aborts with
#   "model_params::tensor_buft_overrides already set by user". Set --gpu-layers explicitly.
# --flash-attn off is a correctness requirement for this port (the MLA path casts the fp32
#   latent to fp16 inside the flash-attention builder); quantized KV types need flash
#   attention, so the KV cache stays f16.
# NVIDIA_TF32_OVERRIDE=0 keeps fp32 GEMMs at full precision (PR #27754: top-1 agreement
#   0.896 -> 0.9995 on a fixture).

$exe      = Join-Path $PSScriptRoot '..\..\glm5next\llama-server.exe'
$modelDir = 'C:\models\unsloth\GLM-5.3-Flash-GGUF'
$model    = Join-Path $modelDir 'GLM-5.3-Flash-UD-Q2_K_XL-00001-of-00004.gguf'   # shards 2-4 load automatically
$mmproj   = Join-Path $modelDir 'mmproj-F16.gguf'
$draft    = 'C:\models\Anbeeld\GLM-5.3-Flash-DFlash2-GGUF\GLM-5.3-Flash-DFlash2-Q5_K_M.gguf'

if (-not (Test-Path $exe)) {
    Write-Host "Missing llama.cpp build: $exe" -ForegroundColor Red
    Write-Host 'Install the glm5next build with: llm-servers\llama\windows\update-glm5next.ps1' -ForegroundColor Yellow
    pause
    exit 1
}

if (-not (Test-Path $model)) {
    Write-Host "Missing model: $model" -ForegroundColor Red
    pause
    exit 1
}

$useDFlash = if ($PSBoundParameters.ContainsKey('Mtp')) { $false } `
    elseif ($PSBoundParameters.ContainsKey('DFlash')) { $true } `
    else { Test-Path $draft }

$specType = 'draft-mtp,ngram-mod'   # default: built-in MTP + ngram, no extra files needed
$draftArgs = @()
if (-not $PSBoundParameters.ContainsKey('SpecN')) { $SpecN = 2 }
if ($useDFlash) {
    if (-not (Test-Path $draft)) {
        Write-Host "Missing DFlash2 draft: $draft" -ForegroundColor Red
        Write-Host 'Download it from: https://huggingface.co/Anbeeld/GLM-5.3-Flash-DFlash2-GGUF (Q5_K_M)' -ForegroundColor Yellow
        Write-Host 'Falling back to built-in MTP.' -ForegroundColor Yellow
        $useDFlash = $false
    }
}
if ($useDFlash) {
    # DFlash2 is a separate draft model, not the built-in NextN layers: it replaces draft-mtp.
    # Measured on RTX 4090 + 5950X (300-token bench, temp 0.7): n=5 -> 9.25 t/s at 0.94
    # acceptance; n=7 collapses to 2.74 t/s (acceptance 0.14 past depth 5). Reference
    # default is 7 (inco.ai/blog/dflash2), but this box verifies slower than a B200 cluster.
    if (-not $PSBoundParameters.ContainsKey('SpecN')) { $SpecN = 5 }
    $specType = 'draft-dflash'
    $draftArgs = @('--spec-draft-model', $draft, '--spec-draft-ngl', 'all')
}
if ($Ngram -and $specType -notlike '*ngram*') { $specType += ',ngram-mod' }

$env:NVIDIA_TF32_OVERRIDE = '0'

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
    --cache-type-k f16 `
    --cache-type-v f16 `
    --flash-attn off `
    --spec-type $specType `
    --spec-draft-n-max $SpecN `
    @draftArgs `
    --batch-size 2048 `
    --ubatch-size 1024 `
    --threads 28 `
    --threads-batch 28 `
    --jinja `
    --reasoning on `
    --reasoning-effort $Mode `
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
