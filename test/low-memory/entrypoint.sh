#!/bin/sh
set -eu

tier="${1:-e2e}"

case "$tier" in
  full)
    export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=256}"
    command="npm run check && npm run pack:check && npm run test:low-memory:e2e"
    ;;
  runtime)
    export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=128}"
    command="npm test && npm run test:low-memory:e2e"
    ;;
  e2e)
    export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=64}"
    command="npm run test:low-memory:e2e"
    ;;
  *)
    echo "unknown low-memory tier: $tier" >&2
    exit 2
    ;;
esac

echo "tier=$tier"
echo "node_options=$NODE_OPTIONS"
echo "command=$command"

set +e
/usr/bin/time -v sh -lc "$command"
status=$?
set -e

for metric in memory.max memory.current memory.peak memory.events; do
  path="/sys/fs/cgroup/$metric"
  if [ -r "$path" ]; then
    echo "$metric:"
    cat "$path"
  fi
done

exit "$status"
