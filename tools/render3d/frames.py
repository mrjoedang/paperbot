# The setup page's own e-paper frames: `pvsim --setup-frames` (sim/src/main.cpp) -> server/public/setup/assets/bolt/<name>.png
# (200x200, 1-bit, like site/assets/bolt). From the repo root, after `make sim-build`:
#   build/sim/pvsim --setup-frames build/setup-frames.json && uv run --with pillow python tools/render3d/frames.py
import json, os
from PIL import Image
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'server', 'public', 'setup', 'assets', 'bolt')
frames = json.load(open('build/setup-frames.json'))
for name, bits in frames.items():
    im = Image.new('1', (200, 200), 1)
    im.putdata([0 if c == '1' else 1 for c in bits])
    im.save(os.path.join(OUT, f'{name}.png'))
print('frames:', ', '.join(frames))
