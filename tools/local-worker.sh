#!/bin/sh
# The server Worker locally (http://127.0.0.1:${PORT:-8787}) for setup, accounts, Wi-Fi and MCP work.
# Without the AI binding: Workers AI can't be reached from local dev here, so transcription fails.
# State (D1, Durable Objects, R2) lives in build/wrangler-state; delete it to start fresh.
# Secrets: server/.dev.vars if present, else throwaway local ones in build/local-worker.dev.vars
# (the owner device token for /admin and /v1 is the DEVICE_TOKEN line there; it is never printed).
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$ROOT/build"
python3 - "$ROOT" <<'PY'
import json, os, re, sys
root = sys.argv[1]
s = open(f"{root}/server/wrangler.jsonc").read()
s = re.sub(r"(?m)^\s*//.*$", "", s)
s = re.sub(r'(?m)\s//[^\n"]*$', "", s)
c = json.loads(s)
for k in ("env", "$schema", "routes"):
    c.pop(k, None)
c["vars"].pop("APP_ORIGIN", None)  # serve every page on 127.0.0.1, no redirect to the dev address
# Workers AI runs remotely (billed to the account, through the dev AI Gateway) only with AI=remote; else no binding.
if os.environ.get("AI") == "remote": c["ai"] = {"binding": "AI", "remote": True}
else: c.pop("ai", None)
c["name"] = "paperbot-local"
c["main"] = "../server/src/index.ts"
c["assets"]["directory"] = "../server/public"
json.dump(c, open(f"{root}/build/wrangler.local.json", "w"), indent=1)
PY
VARS=$ROOT/build/local-worker.dev.vars
if [ -f "$ROOT/server/.dev.vars" ]; then cp "$ROOT/server/.dev.vars" "$VARS"
elif [ ! -f "$VARS" ] || ! grep -q '^DEVICE_TOKEN=' "$VARS"; then
  ( umask 077; printf 'DEVICE_TOKEN=local-%s\nWIFI_KEY=%s\n' "$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')" "$(head -c 32 /dev/urandom | base64)" > "$VARS" )
fi
# Sign-in needs a BETTER_AUTH_SECRET: a throwaway one, kept with the local state.
[ -f "$ROOT/build/local-auth.secret" ] || ( umask 077; head -c 32 /dev/urandom | base64 > "$ROOT/build/local-auth.secret" )
grep -q '^BETTER_AUTH_SECRET=' "$VARS" || ( umask 077; printf 'BETTER_AUTH_SECRET=%s\n' "$(cat "$ROOT/build/local-auth.secret")" >> "$VARS" )
cp "$VARS" "$ROOT/build/.dev.vars"
[ -d "$ROOT/server/node_modules" ] || (cd "$ROOT/server" && npm ci --silent)
cd "$ROOT/build"
exec npx --prefix "$ROOT/server" wrangler dev -c wrangler.local.json --port "${PORT:-8787}" --ip "${IP:-127.0.0.1}" --persist-to wrangler-state "$@"
