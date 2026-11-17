#!/bin/sh
# /setup's 3D model: device + animated USB-C cable -> server/public/setup/assets/paperbot.glb (meshopt, like the site's).
# Needs Blender 5 on PATH (blender) and npx. Intermediate files in build/render3d/.
set -e
cd "$(dirname "$0")"
OUT=../../build/render3d
mkdir -p "$OUT"
blender -b -P export_setup.py -- "$OUT/setup_raw.glb" 2>&1 | grep -E "Error|Traceback|GLB" || true
python3 rest_hidden.py "$OUT/setup_raw.glb" "$OUT/setup_rest.glb"
npx -y @gltf-transform/cli@4.1.1 optimize "$OUT/setup_rest.glb" ../../server/public/setup/assets/paperbot.glb --compress meshopt --texture-compress webp --simplify false --instance false | tail -1
