#!/bin/sh
# Build (and optionally flash) the paperbot firmware.  Usage: firmware/build.sh [port]
# The shared core is an Arduino library (firmware/core).
# Firmware version: $PV_FW_VERSION, else firmware/paperbot/fw_version.txt (-> pv_fw_version.h).
# PV_GENERIC=1: release image without secrets.h (no server / token / Wi-Fi compiled in; set up with
# `pocketbot setup`), built into build/paperbot-generic.
# Partition scheme app3M_fat9M_16MB = nvs, otadata, app0 (ota_0, 3 MB), app1 (ota_1, 3 MB), ffat,
# coredump: two OTA slots, so no partition change is needed for over-the-air updates.
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
FQBN=esp32:esp32:esp32c6:CDCOnBoot=cdc,FlashSize=16M,PartitionScheme=app3M_fat9M_16MB
VER=${PV_FW_VERSION:-$(cat "$ROOT/firmware/paperbot/fw_version.txt")}
echo "$VER" | grep -Eq '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$' || { echo "build.sh: bad version '$VER' (want MAJOR.MINOR.PATCH)" >&2; exit 1; }
[ -r "$ROOT/firmware/paperbot/ota_pubkey.h" ] || { echo "build.sh: missing ota_pubkey.h - run sh tools/ota/keygen.sh" >&2; exit 1; }
GEN=$ROOT/build/paperbot_gen
mkdir -p "$GEN"
NEW="#pragma once
#define PV_FW_VERSION \"$VER\""
[ "$(cat "$GEN/pv_fw_version.h" 2>/dev/null)" = "$NEW" ] || printf '%s\n' "$NEW" > "$GEN/pv_fw_version.h"
FLAGS="-DLV_CONF_INCLUDE_SIMPLE -I$ROOT/firmware/lvgl_conf -I$GEN"
OUT=$ROOT/build/paperbot
if [ "${PV_GENERIC:-0}" = 1 ]; then FLAGS="$FLAGS -DPV_GENERIC=1"; OUT=$ROOT/build/paperbot-generic; echo "build.sh: release image (no secrets.h)"; fi
echo "build.sh: firmware version $VER"
arduino-cli compile -b $FQBN "$ROOT/firmware/paperbot" --build-path "$OUT" \
  --library "$ROOT/vendor/waveshare/01_Arduino_Libraries/lvgl9/lvgl" --library "$ROOT/firmware/core" \
  --build-property "compiler.c.extra_flags=$FLAGS" --build-property "compiler.cpp.extra_flags=$FLAGS" --warnings default
if [ -n "$1" ]; then
  arduino-cli upload -b $FQBN -p "$1" --input-dir "$OUT"
fi
