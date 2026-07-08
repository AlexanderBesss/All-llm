param(
    [ValidateSet('Q4_K_XL', 'Q5_K_S')]
    [string]$MainQuant = 'Q4_K_XL'
)

$mainModel = "..\..\..\models\unsloth\Qwen3.6-27B-GGUF\Qwen3.6-27B-UD-$MainQuant.gguf"
$mmproj = "..\..\..\models\unsloth\Qwen3.6-27B-GGUF\mmproj-F32.gguf"
$draftModel = "..\..\..\models\Alittlehammmer\Qwen3.6-27B-DFlash-GGUF-llama.cpp\Qwen3.6-27B-DFlash-Q5_K.gguf"

& (Join-Path $PSScriptRoot 'llama\llama-server.exe') `
    -m $mainModel `
    --spec-draft-model $draftModel `
    --no-mmproj-offload `
    --kv-unified `
    --host 0.0.0.0 `
    --port 8080 `
    --gpu-layers all `
    --fit on `
    --spec-draft-ngl all `
    --spec-type draft-dflash,ngram-mod `
    --spec-draft-n-max 6 `
    --spec-ngram-mod-n-max 4 `
    --spec-ngram-mod-n-match 24 `
    --parallel 1 `
    --cache-ram 0 `
    --ctx-size 80000 `
    --cache-type-k q4_0 `
    --cache-type-v q4_0 `
    --flash-attn on `
    --batch-size 1024 `
    --ubatch-size 512 `
    --no-mmap `
    --mlock `
    --jinja `
    --temp 0.6 `
    --min-p 0.0 `
    --repeat-penalty 1.0 `
    --presence-penalty 0.0 `
    --chat-template-kwargs '{\"preserve_thinking\":true}' `
    --metrics `
    --slots `
    --perf `
    --reasoning on
pause
