#!/bin/sh
# Builds a signed firmware release artefact. Does NOT publish anything.
#
#   sh tools/ota/release.sh 1.1.0            # build + sign
#   sh tools/ota/release.sh 1.1.0 --no-build # sign the existing build/paperbot image
#
# Output: dist/fw/<version>/
#   paperbot-<version>.bin   the app image (what goes into an OTA slot)
#   manifest.txt                      exactly the signed bytes: "pocket-voice-fw/1\n<ver>\n<size>\n<sha256>\n"
#   manifest.json                     {version,size,sha256,sig,url,key,built_at} = the GET /v1/firmware reply
#   SHA256SUMS
# Signing key: $PV_OTA_KEY or .secrets/ota_signing_key.pem (tools/ota/keygen.sh). The public half
# must equal firmware/paperbot/ota_pubkey.h, else devices running this build could not
# verify the NEXT release - checked below.
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
VER=$1
KEY=${PV_OTA_KEY:-$ROOT/.secrets/ota_signing_key.pem}
echo "$VER" | grep -Eq '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$' || { echo "usage: release.sh MAJOR.MINOR.PATCH [--no-build]" >&2; exit 1; }
[ -r "$KEY" ] || { echo "release: no signing key at $KEY (sh tools/ota/keygen.sh)" >&2; exit 1; }
HDR=$ROOT/firmware/paperbot/ota_pubkey.h
# 1. the firmware must trust the key we sign with
WANT=$(openssl ec -in "$KEY" -pubout -outform DER 2>/dev/null | xxd -p | tr -d '\n')
HAVE=$(sed -n '/PV_OTA_PUBKEY_DER/,/};/p' "$HDR" | grep -oE '0x[0-9a-f]{2}' | sed 's/0x//' | tr -d '\n')
[ "$WANT" = "$HAVE" ] || { echo "release: ota_pubkey.h does not match $KEY (sh tools/ota/keygen.sh --header, rebuild)" >&2; exit 1; }
# 2. build with the version baked in
if [ "$2" != "--no-build" ]; then PV_FW_VERSION=$VER sh "$ROOT/firmware/build.sh"; fi
BIN=$ROOT/build/paperbot/paperbot.ino.bin
[ -r "$BIN" ] || { echo "release: no image at $BIN" >&2; exit 1; }
# 3. sanity: ESP image magic, fits the 3 MB slot, carries the version marker
MAGIC=$(xxd -p -l 1 "$BIN")
[ "$MAGIC" = "e9" ] || { echo "release: $BIN is not an ESP app image (magic $MAGIC)" >&2; exit 1; }
SIZE=$(wc -c < "$BIN" | tr -d ' ')
[ "$SIZE" -le 3145728 ] || { echo "release: image $SIZE B > 3 MB OTA slot" >&2; exit 1; }
grep -aq "PVFW-VERSION:$VER;" "$BIN" || { echo "release: image is not version $VER (build with PV_FW_VERSION=$VER)" >&2; exit 1; }
# 4. hash + sign the manifest (ECDSA P-256 / SHA-256, DER) and self-check the signature
OUT=$ROOT/dist/fw/$VER
mkdir -p "$OUT"
cp "$BIN" "$OUT/paperbot-$VER.bin"
SHA=$(shasum -a 256 "$BIN" | cut -d' ' -f1)
printf 'pocket-voice-fw/1\n%s\n%s\n%s\n' "$VER" "$SIZE" "$SHA" > "$OUT/manifest.txt"
openssl dgst -sha256 -sign "$KEY" -out "$OUT/manifest.sig" "$OUT/manifest.txt"
openssl ec -in "$KEY" -pubout -out "$OUT/pub.pem" 2>/dev/null
openssl dgst -sha256 -verify "$OUT/pub.pem" -signature "$OUT/manifest.sig" "$OUT/manifest.txt" >/dev/null
SIG=$(xxd -p "$OUT/manifest.sig" | tr -d '\n')
FP=$(sed -n 's/.*PV_OTA_KEY_FINGERPRINT "\(.*\)".*/\1/p' "$HDR")
cat > "$OUT/manifest.json" <<JSON
{"version":"$VER","size":$SIZE,"sha256":"$SHA","sig":"$SIG","url":"/v1/firmware/$VER.bin","key":"$FP","built_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
JSON
(cd "$OUT" && shasum -a 256 "paperbot-$VER.bin" manifest.json manifest.txt > SHA256SUMS)
rm -f "$OUT/pub.pem"
echo "release: $OUT"
echo "  version $VER  size $SIZE  sha256 $SHA  key $FP"
cat <<TXT
Publish (not done by this script; see docs/device-api.md section 6.5):
  1. upload the image:    wrangler r2 object put <bucket>/firmware/$VER.bin --file "$OUT/paperbot-$VER.bin" --content-type application/octet-stream
  2. upload the manifest: wrangler r2 object put <bucket>/firmware/$VER.json --file "$OUT/manifest.json" --content-type application/json
  3. point the channel:   set firmware/latest.json (or the Worker's FW_LATEST) to "$VER" - optionally for a few device ids first
TXT
