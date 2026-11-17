#!/bin/sh
# usage: pv.sh put <id> <file> [curl args...] | get <id> | updates <ids> | admin <path> [curl args...] | fw
# Token is read from server/.dev.vars (never printed).
cd "$(dirname "$0")/.."
TOKEN=${TOKEN:-$(grep '^DEVICE_TOKEN=' .dev.vars | cut -d= -f2)}  # dev Worker: TOKEN=<DEV_TOKEN from server/.secrets>
BASE=${BASE:-https://dev.paperbot.ca}
cmd=$1; shift
case "$cmd" in
  put) id=$1; f=$2; shift 2
       curl -sS -o /dev/stdout -w '\n%{http_code} %{time_total}\n' -X PUT -H "authorization: Bearer $TOKEN" -H 'content-type: audio/wav' \
         -H 'x-firmware-version: test-0.1' --data-binary @"test/wav/$f" "$@" "$BASE/v1/recordings/$id" ;;
  get) curl -sS -w '\n%{http_code}\n' -H "authorization: Bearer $TOKEN" "$BASE/v1/recordings/$1" ;;
  updates) curl -sS -w '\n%{http_code}\n' -H "authorization: Bearer $TOKEN" "$BASE/v1/updates?ids=$1" ;;
  admin) p=$1; shift; curl -sS -H "authorization: Bearer $TOKEN" "$@" "$BASE/admin/$p" ;;
  fw) curl -sS -o /dev/null -w '%{http_code}\n' -H "authorization: Bearer $TOKEN" "$BASE/v1/firmware" ;;
  raw) curl -sS -w '\n%{http_code}\n' -H "authorization: Bearer $TOKEN" "$@" ;;
esac
