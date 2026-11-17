#!/bin/sh
cd "$(dirname "$0")"
B=/Applications/Blender.app/Contents/MacOS/Blender
$B -b -P build.py -- --shots hero,back,duo,bottom --samples 512 --res 2400x1800 --out out 2>&1 | grep -E "Traceback|Error|WROTE"
$B -b -P build.py -- --shots turntable --frames 144 --samples 96 --res 1280x960 --out out 2>&1 | grep -E "Traceback|Error"
ffmpeg -y -loglevel error -framerate 30 -i out/tt/f_%04d.png -c:v libx264 -pix_fmt yuv420p -crf 16 out/turntable.mp4
echo FINISHED
