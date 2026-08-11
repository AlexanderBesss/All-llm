param(
    [ValidateSet('default', 'e2b')]
    [string]$Mode = 'e2b'
)

$exe = Join-Path $PSScriptRoot 'llama\llama-server.exe'
$model = "..\..\..\models\lmstudio-community\gemma-4-E2B-it-GGUF\gemma-4-E2B-it-Q4_K_M.gguf"
$mmproj = "..\..\..\models\lmstudio-community\gemma-4-E2B-it-GGUF\mmproj-gemma-4-E2B-it-BF16.gguf"

switch ($Mode) {
    'default' {
        & $exe `
            -m $model `
            --mmproj $mmproj `
            --host 0.0.0.0 `
            --port 8080 `
            --gpu-layers all `
            --ctx-size 32768 `
            --batch-size 2048 `
            --ubatch-size 1024 `
            --cache-type-k q4_0 `
            --cache-type-v q4_0 `
            --flash-attn on `
            --no-mmap `
            --jinja `
            --top-p 0.95 `
            --min-p 0.05 `
            --repeat-penalty 1.0 `
            --reasoning off `
            --metrics `
            --slots `
            --perf `
            --temp 0.7
    }
    'e2b' {
        & $exe `
            -m $model `
            --mmproj $mmproj `
            --host 0.0.0.0 `
            --port 8082 `
            --gpu-layers 5 `
            --ctx-size 4096 `
            --batch-size 1024 `
            --ubatch-size 256 `
            --cache-type-k q4_0 `
            --cache-type-v q4_0 `
            --flash-attn on `
            --no-mmap `
            --jinja `
            --top-p 0.95 `
            --min-p 0.05 `
            --repeat-penalty 1.0 `
            --reasoning off `
            --metrics `
            --slots `
            --perf `
            --temp 0.1
    }
}
pause
