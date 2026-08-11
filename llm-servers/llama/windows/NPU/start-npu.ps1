param(
    [ValidateSet('Q4_K_M', 'Q4_0')]
    [string]$MainQuant = 'Q4_K_M'
)

# --- Prerequisites (one-time setup) ---
# 1. Install Intel NPU driver:
#    https://www.intel.com/content/www/us/en/download/770895/intel-npu-driver-for-windows.html
# 2. Run .\update-npu.ps1 to download OpenVINO binaries (includes bundled OpenVINO runtime)

# --- OpenVINO environment ---
# Source system OpenVINO if installed (optional; prebuilt binaries bundle runtime)
$OpenVinoSetup = "C:\Intel\openvino\setupvars.ps1"
if (Test-Path $OpenVinoSetup) {
    & $OpenVinoSetup
}

$env:GGML_OPENVINO_DEVICE = "NPU"
# Prefill chunk size for NPU (default 256; increase for faster prompt processing)
$env:GGML_OPENVINO_PREFILL_CHUNK_SIZE = "512"
# NPU does not support stateful execution
$env:GGML_OPENVINO_STATEFUL_EXECUTION = "0"

# --- Model paths ---
$mainModel = "..\..\..\..\models\unsloth\Qwen3.6-27B-GGUF\Qwen3.6-27B-UD-$MainQuant.gguf"
$draftModel = "..\..\..\..\models\Alittlehammmer\Qwen3.6-27B-DFlash-GGUF-llama.cpp\Qwen3.6-27B-DFlash-Q5_K.gguf"

# --- Binary ---
$Binary = Join-Path $PSScriptRoot 'llama-ov\llama-server.exe'
if (-not (Test-Path $Binary)) {
    Write-Error "llama-server.exe not found in llama-ov\. Run .\update-npu.ps1 first."
    pause
    exit 1
}

# --- NPU constraints ---
# - No --gpu-layers (OpenVINO handles all offloading internally)
# - Context size kept modest (NPU has limited memory)
# - parallel must be 1 (NPU does not support multiple sequences)
# - Q4_K_M / Q4_0 are the primary supported quantizations

& $Binary `
    -m $mainModel `
    --spec-draft-model $draftModel `
    --kv-unified `
    --host 0.0.0.0 `
    --port 8080 `
    --device NPU `
    --parallel 1 `
    --cache-ram 0 `
    --ctx-size 8192 `
    --cache-type-k q4_0 `
    --cache-type-v q4_0 `
    --batch-size 1024 `
    --ubatch-size 512 `
    --no-mmap `
    --mlock `
    --jinja `
    --temp 0.6 `
    --min-p 0.0 `
    --repeat-penalty 1.0 `
    --presence-penalty 0.0 `
    --chat-template-kwargs '{"preserve_thinking":true}' `
    --metrics `
    --slots `
    --perf `
    --reasoning on

pause
