#!/bin/sh
# Interactive simulator: mock server + pvsim + browser UI.  Extra pvsim args via SIM_ARGS,
# e.g. SIM_ARGS="--prod" (real Worker, ids prefixed sim-) or SIM_ARGS="--server http://127.0.0.1:8787".
ROOT=${ROOT:-$(cd "$(dirname "$0")/.." && pwd)}
PORT=${PORT:-8090}
MOCK_PORT=${MOCK_PORT:-8788}
python3 "$ROOT/sim/mock_server.py" --port "$MOCK_PORT" --store "$ROOT/build/sim/mock_store" &
MOCK=$!
trap 'kill $MOCK 2>/dev/null' EXIT INT TERM
for i in $(seq 50); do curl -s "http://127.0.0.1:$MOCK_PORT/__mock/state" >/dev/null && break; sleep 0.1; done
[ -n "$NO_OPEN" ] || (sleep 1; open "http://localhost:$PORT") &
"$ROOT/build/sim/pvsim" --serve --port "$PORT" --server "http://127.0.0.1:$MOCK_PORT" $SIM_ARGS
