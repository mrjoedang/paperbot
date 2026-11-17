#!/bin/sh
# Pixel-compares the C++ Bolt layout (pvsim --bolt-dump) with design/bolt-variations.html's own
# drawV1() for the design's 10 states. Needs node. Usage: sh sim/tools/bolt_compare.sh
set -e
ROOT=${ROOT:-$(cd "$(dirname "$0")/../.." && pwd)}
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
{
  echo 'global.document={createElement:()=>({getContext:()=>({measureText:()=>({width:1}),getImageData:()=>({data:[]}),clearRect(){},fillText(){}})})};'
  awk '/^<script>/{f=1;next} /PAGE$/{exit} f' "$ROOT/design/bolt-variations.html" | sed '$d'
  echo 'const o={};for(const S of STATES){const b=new B();drawV1(b,S,{f:0,sec:7,bat:67});o[S.id]=Array.from(b.d).join("");}'
  echo 'require("fs").writeFileSync(process.argv[2],JSON.stringify(o));'
} > "$T/d.js"
node "$T/d.js" "$T/design.json"
"$ROOT/build/sim/pvsim" --bolt-dump "$T/cpp.json"
python3 - "$T/design.json" "$T/cpp.json" <<'PY'
import json, sys
d, c = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
bad = 0
for k in d:
    head = sum(1 for i in range(200 * 114) if d[k][i] != c[k][i])   # head + status bar
    full = sum(1 for i in range(40000) if d[k][i] != c[k][i])
    note = " (text differs by design)" if k == "send" else ""
    print(f"{k:9s} head/status diff {head:4d} px, full screen {full:4d} px{note}")
    bad += head + (0 if k == "send" else full)
sys.exit(1 if bad else 0)
PY
