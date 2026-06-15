#!/usr/bin/env bash
set -euo pipefail

# SGLang server for local AWQ Qwen3.6-27B on a 24GB 4090.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Hardcoded 4090-safe defaults.
MODEL_PATH="$PROJECT_DIR/models/Qwen3.6-27B-AWQ-INT4"
HOST="0.0.0.0"
PORT="8080"
CONTEXT_LENGTH="12048"
MEM_FRACTION_STATIC="0.96"
CHUNKED_PREFILL_SIZE="512"
TP_SIZE="1"
KV_CACHE_DTYPE="fp8_e5m2"
PYTHON="$SCRIPT_DIR/.venv/bin/python"
EXTRA_ARGS="${EXTRA_ARGS:-}"

if [[ ! -x "$PYTHON" ]]; then
  echo "Python venv not found at: $PYTHON" >&2
  exit 1
fi

export PATH="$SCRIPT_DIR/.venv/bin:$PATH"

args=(
  -m sglang.launch_server
  --model-path "$MODEL_PATH"
  --host "$HOST"
  --port "$PORT"
  --context-length "$CONTEXT_LENGTH"
  --dtype bfloat16
  --mamba-ssm-dtype bfloat16
  --mem-fraction-static "$MEM_FRACTION_STATIC"
  --chunked-prefill-size "$CHUNKED_PREFILL_SIZE"
  --tp-size "$TP_SIZE"
  --kv-cache-dtype "$KV_CACHE_DTYPE"
  --max-running-requests 1
  --max-total-tokens 2048
  --max-prefill-tokens 2048
  --max-mamba-cache-size 3
  --mamba-full-memory-ratio 0.15
  --quantization compressed-tensors
  --language-only
  --skip-server-warmup
  --trust-remote-code
)

if [[ -n "$EXTRA_ARGS" ]]; then
  # shellcheck disable=SC2206
  extra_args_array=($EXTRA_ARGS)
  args+=("${extra_args_array[@]}")
fi

"$PYTHON" "${args[@]}"
