$mainModel = "..\..\..\models\prism-ml\Ternary-Bonsai-27B-gguf\Ternary-Bonsai-27B-Q2_g64.gguf"
$mmproj = "..\..\..\models\prism-ml\Ternary-Bonsai-27B-gguf\Ternary-Bonsai-27B-mmproj-BF16.gguf"
$draftModel = "..\..\..\models\prism-ml\Ternary-Bonsai-27B-gguf\Ternary-Bonsai-27B-dspark-Q4_1.gguf"

& (Join-Path $PSScriptRoot 'llama\llama-server.exe') `
    -m $mainModel `
    --mmproj $mmproj `
    --no-mmproj-offload `
    --spec-draft-model $draftModel `
    --kv-unified `
    --host 0.0.0.0 `
    --port 8080 `
    --gpu-layers all `
    --fit on `
    --spec-draft-ngl all `
    --spec-type draft-simple,ngram-mod `
    --spec-draft-n-max 6 `
    --spec-ngram-mod-n-max 4 `
    --spec-ngram-mod-n-match 24 `
    --parallel 1 `
    --cache-ram 0 `
    --ctx-size 100000 `
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