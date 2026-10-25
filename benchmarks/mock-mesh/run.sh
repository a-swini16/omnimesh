#!/usr/bin/env bash
# Usage: benchmarks/mock-mesh/run.sh <flash-sale|primary-dies|all-down|quota-429|bad-input|cross-user-cache>
set -euo pipefail
SCENARIO="$1"
DIR="$(cd "$(dirname "$0")" && pwd)"
TSX="$DIR/../node_modules/.bin/tsx"
export GATEWAY_SECRET="${GATEWAY_SECRET:-$(openssl rand -hex 32)}"
KOYEB_DAILY_QUOTA=""
[ "$SCENARIO" = "quota-429" ] && KOYEB_DAILY_QUOTA=1000

# A previous run's servers must be gone, or the readiness check below would talk to them
for _ in $(seq 1 50); do
  ss -ltn 2>/dev/null | grep -qE ':(8788|410[1-5]) ' || break
  sleep 0.2
done
if ss -ltn 2>/dev/null | grep -qE ':(8788|410[1-5]) '; then
  echo "ports 8788/4101-4105 are still in use; stop the other mesh first" >&2
  exit 1
fi

"$TSX" "$DIR/mesh.ts" > "$DIR/results/$SCENARIO.mesh.log" 2>&1 & MESH=$!
KOYEB_DAILY_QUOTA="$KOYEB_DAILY_QUOTA" "$TSX" "$DIR/router.ts" > "$DIR/results/$SCENARIO.router.log" 2>&1 & ROUTER=$!
trap 'kill $MESH $ROUTER 2>/dev/null; wait $MESH $ROUTER 2>/dev/null || true' EXIT
ready=""
for _ in $(seq 1 150); do
  if curl -s -o /dev/null localhost:8788/ && curl -s -o /dev/null localhost:4105/; then ready=1; break; fi
  sleep 0.2
done
[ -n "$ready" ] || { echo "mock mesh or router did not start within 30 s; see results/$SCENARIO.*.log" >&2; exit 1; }

docker run --rm --network host --user "$(id -u):$(id -g)" -e SCENARIO="$SCENARIO" -e GATEWAY_SECRET \
  -v "$DIR":/scripts grafana/k6:1.0.0 run --quiet \
  --summary-export "/scripts/results/$SCENARIO.json" /scripts/scenarios.js
