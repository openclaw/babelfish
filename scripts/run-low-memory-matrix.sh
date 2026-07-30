#!/bin/sh
set -eu

runtime="${CONTAINER_RUNTIME:-}"
if [ -z "$runtime" ]; then
  if command -v docker >/dev/null 2>&1; then
    runtime="docker"
  elif command -v podman >/dev/null 2>&1; then
    runtime="podman"
  else
    echo "Docker or Podman is required for the low-memory matrix." >&2
    exit 1
  fi
fi

image="${BABELFISH_LOW_MEMORY_IMAGE:-babelfish-low-memory:dev}"
"$runtime" build --file test/low-memory/Dockerfile --tag "$image" .

run_tier() {
  name="$1"
  memory="$2"
  cpus="$3"
  mode="$4"
  echo
  echo "=== $name: memory=$memory cpus=$cpus mode=$mode ==="
  "$runtime" run --rm \
    --network=none \
    --memory="$memory" \
    --memory-swap="$memory" \
    --cpus="$cpus" \
    --pids-limit=256 \
    "$image" "$mode"
}

case "${1:-all}" in
  all)
    run_tier "pi-4-ish" "1024m" "2" "full"
    run_tier "potato" "512m" "1" "runtime"
    run_tier "pi-zero-ish" "256m" "1" "e2e"
    ;;
  full)
    run_tier "pi-4-ish" "1024m" "2" "full"
    ;;
  runtime)
    run_tier "potato" "512m" "1" "runtime"
    ;;
  e2e)
    run_tier "pi-zero-ish" "256m" "1" "e2e"
    ;;
  *)
    echo "usage: $0 [all|full|runtime|e2e]" >&2
    exit 2
    ;;
esac
