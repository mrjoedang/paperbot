#!/bin/sh
# Release bundle for setup (/setup installs it): the generic firmware (no secrets.h) as separate flash images
# + manifest.json, in dist/setup/<version>/. With --publish [--env production], also uploads it to the
# Worker's R2 bucket under setup/ (served at /v1/setup/firmware/*).
#   sh tools/setup-bundle.sh [--publish] [--env production]
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PUBLISH=0; ENVARG=""
while [ $# -gt 0 ]; do case "$1" in --publish) PUBLISH=1;; --env) ENVARG="--env $2"; shift;; *) echo "unknown $1" >&2; exit 2;; esac; shift; done
VER=${PV_FW_VERSION:-$(cat "$ROOT/firmware/paperbot/fw_version.txt")}
PV_GENERIC=1 sh "$ROOT/firmware/build.sh"
B=$ROOT/build/paperbot-generic
BOOT_APP0=$(ls "$HOME"/Library/Arduino15/packages/esp32/hardware/esp32/*/tools/partitions/boot_app0.bin 2>/dev/null | tail -1)
[ -r "$BOOT_APP0" ] || { echo "boot_app0.bin not found (arduino-cli core install esp32:esp32)" >&2; exit 1; }
OUT=$ROOT/dist/setup/$VER
rm -rf "$OUT"; mkdir -p "$OUT"
cp "$B/paperbot.ino.bootloader.bin" "$OUT/bootloader.bin"
cp "$B/paperbot.ino.partitions.bin" "$OUT/partitions.bin"
cp "$BOOT_APP0" "$OUT/boot_app0.bin"   # otadata: boot from the first app slot (a previous OTA may have picked the other one)
cp "$B/paperbot.ino.bin" "$OUT/paperbot.bin"
python3 - "$OUT" "$VER" <<'PY'
import hashlib, json, os, sys
d, ver = sys.argv[1], sys.argv[2]
files = [("0x0", "bootloader.bin"), ("0x8000", "partitions.bin"), ("0xe000", "boot_app0.bin"), ("0x10000", "paperbot.bin")]
man = {"version": ver, "chip": "esp32c6", "files": [{"offset": o, "name": n, "size": os.path.getsize(f"{d}/{n}"),
       "sha256": hashlib.sha256(open(f"{d}/{n}", "rb").read()).hexdigest()} for o, n in files]}
json.dump(man, open(f"{d}/manifest.json", "w"), indent=1)
print(f"bundle {d}: " + ", ".join(f"{f['name']} {f['size']}" for f in man["files"]))
PY
if [ "$PUBLISH" = 1 ]; then
  BUCKET=$(cd "$ROOT/server" && node -e "const s=require('fs').readFileSync('wrangler.jsonc','utf8').replace(/^\s*\/\/.*$/mg,'');const c=JSON.parse(s);const e='$ENVARG'.split(' ')[1];console.log((e?c.env[e]:c).r2_buckets[0].bucket_name)")
  for f in bootloader.bin partitions.bin boot_app0.bin paperbot.bin manifest.json; do
    (cd "$ROOT/server" && npx wrangler r2 object put "$BUCKET/setup/$f" --file "$OUT/$f" --remote >/dev/null)
    echo "published setup/$f -> $BUCKET"
  done
fi
