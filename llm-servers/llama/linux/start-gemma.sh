#!/usr/bin/env bash
set -euo pipefail

usage() {
    printf 'Usage: %s [default|e2b] [llama-server options...]\n' "$0" >&2
}

if (($# > 0)); then
    MODE="$1"
    shift
else
    MODE='e2b'
fi

if [[ "$MODE" == '-h' || "$MODE" == '--help' ]]; then
    usage
    exit 0
fi

if [[ "$MODE" != 'default' && "$MODE" != 'e2b' ]]; then
    usage
    exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
EXE="$SCRIPT_DIR/llama/llama-server"
MODEL="$SCRIPT_DIR/../../../models/lmstudio-community/gemma-4-E2B-it-GGUF/gemma-4-E2B-it-Q4_K_M.gguf"
MMPROJ="$SCRIPT_DIR/../../../models/lmstudio-community/gemma-4-E2B-it-GGUF/mmproj-gemma-4-E2B-it-BF16.gguf"

if [[ ! -x "$EXE" ]]; then
    printf 'Error: llama-server is missing or not executable: %s\n' "$EXE" >&2
    exit 1
fi

if [[ ! -f "$MODEL" ]]; then
    printf 'Error: model not found: %s\n' "$MODEL" >&2
    exit 1
fi

if [[ ! -f "$MMPROJ" ]]; then
    printf 'Error: multimodal projector not found: %s\n' "$MMPROJ" >&2
    exit 1
fi

COMMON=(
    -m "$MODEL"
    --mmproj "$MMPROJ"
    --host 0.0.0.0
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
)

case "$MODE" in
    default)
        MODE_ARGS=(
            --port 8080
            --gpu-layers all
            --ctx-size 32768
            --batch-size 2048
            --ubatch-size 1024
            --temp 0.7
        )
        ;;
    e2b)
        MODE_ARGS=(
            --port 8082
            --gpu-layers 5
            --ctx-size 4096
            --batch-size 1024
            --ubatch-size 256
            --temp 0.1
        )
        ;;
esac

exec "$EXE" "${COMMON[@]}" "${MODE_ARGS[@]}" "$@"
