#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-e2b}"

if [[ "$MODE" != "default" && "$MODE" != "e2b" ]]; then
    echo "Usage: $0 [default|e2b]"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXE="$SCRIPT_DIR/llama/llama-server"
MODEL="../../../models/lmstudio-community/gemma-4-E2B-it-GGUF/gemma-4-E2B-it-Q4_K_M.gguf"
MMPROJ="../../../models/lmstudio-community/gemma-4-E2B-it-GGUF/mmproj-gemma-4-E2B-it-BF16.gguf"

COMMON=(
    "$EXE"
    -m "$MODEL"
    --mmproj "$MMPROJ"
    --host 0.0.0.0
    --gpu-layers all
    --ctx-size 32768
    --batch-size 2048
    --ubatch-size 1024
    --cache-type-k q4_0
    --cache-type-v q4_0
    --flash-attn on
    --no-mmap
    --jinja
    --top-p 0.95
    --min-p 0.05
    --repeat-penalty 1.0
    --reasoning off
    --metrics
    --slots
    --perf
    --temp 0.7
)

E2B=(
    "$EXE"
    -m "$MODEL"
    --mmproj "$MMPROJ"
    --host 0.0.0.0
    --port 8082
    --gpu-layers 5
    --ctx-size 4096
    --batch-size 1024
    --ubatch-size 256
    --cache-type-k q4_0
    --cache-type-v q4_0
    --flash-attn on
    --no-mmap
    --jinja
    --top-p 0.95
    --min-p 0.05
    --repeat-penalty 1.0
    --reasoning off
    --metrics
    --slots
    --perf
    --temp 0.1
)

case "$MODE" in
    default)
        "${COMMON[@]}"
        ;;
    e2b)
        "${E2B[@]}"
        ;;
esac
