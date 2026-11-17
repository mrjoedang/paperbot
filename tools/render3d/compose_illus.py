# Combine illus.py's two passes: a soft, warm contact shadow under the lit objects. Transparent output.
# venv/bin/python compose_illus.py INDIR NAME OUT.webp [--width 900] [--shadow 0.55] [--blur 3]
import sys
import numpy as np
from PIL import Image, ImageFilter
indir, name, out = sys.argv[1:4]
def arg(k, d): return type(d)(sys.argv[sys.argv.index(k) + 1]) if k in sys.argv else d
W, STRENGTH, BLUR, FADE = arg('--width', 900), arg('--shadow', 0.55), arg('--blur', 3.0), arg('--fade', 0.08)
obj = Image.open(f'{indir}/{name}-obj.png').convert('RGBA')
sh = Image.open(f'{indir}/{name}-shadow.png').convert('RGBA')
s = np.asarray(sh.getchannel('A').filter(ImageFilter.GaussianBlur(BLUR))).astype(np.float32) / 255
h, w = s.shape
# keep the shadow close to the objects: fade it out within REACH of their silhouettes, so it never runs to the edge
REACH = arg('--reach', 0.07) * w
sil = obj.getchannel('A').point(lambda t: 255 if t > 128 else 0)
near = np.asarray(sil.filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.GaussianBlur(REACH))).astype(np.float32) / 255
near = np.clip(near / 0.18, 0, 1); near = near * near * (3 - 2 * near)
s = s * near
y, x = np.mgrid[0:h, 0:w]
m = np.minimum(np.minimum(x, w - 1 - x) / (w * FADE), np.minimum(y, h - 1 - y) / (h * FADE))
m = np.clip(m, 0, 1); m = m * m * (3 - 2 * m)
shadow = np.zeros((h, w, 4), np.float32)
shadow[..., :3] = np.array([52, 46, 36], np.float32) / 255           # warm dark, not grey
shadow[..., 3] = np.clip(s * STRENGTH, 0, 1) * m
base = Image.fromarray((shadow * 255 + 0.5).astype(np.uint8), 'RGBA')
o = np.asarray(obj).astype(np.float32) / 255
o[..., 3] *= m                                                        # anything reaching the border fades out
base.alpha_composite(Image.fromarray((o * 255 + 0.5).astype(np.uint8), 'RGBA'))
base = base.resize((W, round(h * W / w)), Image.LANCZOS)
base.save(out, quality=86, method=6)
print(out, base.size)
