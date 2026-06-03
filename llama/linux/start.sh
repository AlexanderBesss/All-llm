#!/usr/bin/env bash
set -euo pipefail

MODEL="/home/user/models/Qwen3.6-27B-MTP-GGUF/Qwen3.6-27B-UD-Q4_K_XL.gguf"
# Use the CUDA build so the NVIDIA GPU is available.
LLAMA_SERVER="./build-cuda/bin/llama-server"

if [[ ! -x "$LLAMA_SERVER" ]]; then
  echo "Error: $LLAMA_SERVER not found or not executable. Build llama.cpp first." >&2
  exit 1
fi

if [[ ! -f "$MODEL" ]]; then
  echo "Error: model not found: $MODEL" >&2
  exit 1
fi

exec "$LLAMA_SERVER" \
  --model "$MODEL" \
  --port 8080 \
  --host 0.0.0.0 \
  --gpu-layers all \
  --fit on \
  --spec-type draft-mtp,ngram-mod \
  --spec-draft-n-max 3 \
  --spec-ngram-mod-n-max 4 \
  --gpu-layers-draft all \
  --parallel 1 \
  --cache-ram 0 \
  --ctx-size 120000 \
  --cache-type-k q4_0 \
  --cache-type-v q4_0 \
  --flash-attn on \
  --batch-size 2048 \
  --ubatch-size 1024 \
  --no-mmap \
  --jinja \
  --temp 0.6 \
  --top-p 0.95 \
  --min-p 0.0 \
  --repeat-penalty 1.0 \
  --metrics \
  --slots \
  --perf \
  --presence-penalty 0.0 \
  "$@"
