#!/bin/sh
# Headless scenario run: all (or the named) scenarios against a private mock.
# Usage: sh sim/test.sh [scenario ...]      (ROOT defaults to the project root)
set -e
ROOT=${ROOT:-$(cd "$(dirname "$0")/.." && pwd)}
BIN=$ROOT/build/sim/pvsim
PORT=${TEST_MOCK_PORT:-18788}
python3 "$ROOT/sim/mock_server.py" --port "$PORT" --store "$ROOT/build/sim-test/mock_store" &
MOCK=$!
trap 'kill $MOCK 2>/dev/null' EXIT INT TERM
for i in $(seq 50); do curl -s "http://127.0.0.1:$PORT/__mock/state" >/dev/null && break; sleep 0.1; done
"$BIN" --test --server "http://127.0.0.1:$PORT" --report-dir "$ROOT/build/sim-test" "$@"
