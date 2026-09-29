# Qwen3.8-27B INT4 (W4A16) in Docker vLLM on a single RTX 4090 (24 GB).
# Recipe: https://recipes.vllm.ai/Qwen/Qwen3.8-27B?variant=int4
#   model  RedHatAI/Qwen3.8-27B-INT4  (~19.5 GB weights)
#   image  vllm/vllm-openai:qwen38
# First run pulls the image and downloads the model into models\vllm-cache (~40 GB total).
# Serves an OpenAI-compatible API on port 8080 (matches Open WebUI / existing start.sh).
# Defaults are conservative for a tight 24 GB card: --enforce-eager on (no CUDA graph
# capture OOM), 32K context, capped batch/seq counts. If it starts clean and you want
# more speed/context, re-run with -CudaGraphs and/or a larger MaxModelLen.
# If it still OOMs while loading weights/KV, lower MaxModelLen or add -TextOnly.

param(
  [int]$Port = 8080,
  [int]$MaxModelLen = 32768,
  [switch]$TextOnly,
  [switch]$Mtp,
  [switch]$CudaGraphs
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$cacheDir = Join-Path $root 'models\vllm-cache'
$image = 'vllm/vllm-openai:qwen38'
$model = 'RedHatAI/Qwen3.8-27B-INT4'
$name = 'vllm-qwen38-int4'

function Invoke-DockerProbe {
  param([string[]]$DockerArgs)
  # Native stderr is redirected, so run with EAP Continue or PS 5.1 throws on it.
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & docker @DockerArgs *> $null
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  return $code
}

try {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "docker not found on PATH."
  }
  if ((Invoke-DockerProbe @('info')) -ne 0) {
    throw "Docker daemon is not running. Start Docker Desktop and retry."
  }
  if ((Invoke-DockerProbe @('image', 'inspect', $image)) -ne 0) {
    Write-Host "Pulling $image (large download)..." -ForegroundColor Cyan
    & docker pull $image
    if ($LASTEXITCODE -ne 0) { throw "docker pull failed." }
  }

  New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null
  Invoke-DockerProbe @('rm', '-f', $name) | Out-Null

  # One flat argument array, splatted once. Never splat a scalar string:
  # PS 5.1 enumerates it character-by-character.
  $runFlags = @('run', '--rm')
  if (-not [Console]::IsOutputRedirected) { $runFlags += '-it' }

  $dockerArgs = $runFlags + @(
    '--name', $name
    '--gpus', 'all'
    "-p${Port}:8000"
    "-v${cacheDir}:/root/.cache/huggingface"
    '-e', 'VLLM_USE_RUST_FRONTEND=1'
    $image, $model
    '--tensor-parallel-size', '1'
    '--max-model-len', "$MaxModelLen"
    '--kv-cache-dtype', 'fp8'
    '--gpu-memory-utilization', '0.92'
    '--max-num-seqs', '8'
    '--max-num-batched-tokens', '4096'
     '--speculative-config', '{\"method\":\"mtp\",\"num_speculative_tokens\":3}'
    '--reasoning-parser', 'qwen3'
    '--enable-auto-tool-choice'
    '--tool-call-parser', 'qwen3_xml'
    '--default-chat-template-kwargs', '{\"enable_thinking\": true}'
    # '--enforce-eager' 
  )
  # if ($TextOnly) { $dockerArgs += '--language-model-only' } else { $dockerArgs += @('--mm-encoder-tp-mode', 'data') }
  # if (-not $CudaGraphs) { $dockerArgs += '--enforce-eager' }

  ($dockerArgs | ForEach-Object { "[$_]" }) -join "`n" | Set-Content -Path (Join-Path $cacheDir 'last-args.txt') -Encoding ascii

  Write-Host "Serving $model on http://localhost:$Port/v1 (ctx $MaxModelLen)" -ForegroundColor Cyan

  & docker @dockerArgs
}
catch {
  Write-Host ""
  Write-Host "FAILED: $($_.Exception.Message)" -ForegroundColor Red
}
finally {
  pause
}
