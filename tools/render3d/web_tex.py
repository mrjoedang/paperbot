# Textures for the web (glTF) model: coloured e-paper screens, icon base-colour + normal maps.
# venv/bin/python web_tex.py SIM_TEST_DIR TEX_DIR SITE_SCREENS_DIR
import sys, os
from PIL import Image, ImageFilter, ImageChops

SIM, TEX, OUT = sys.argv[1:4]
WEB = os.path.join(TEX, 'web')
os.makedirs(WEB, exist_ok=True)
os.makedirs(OUT, exist_ok=True)

INK, PAPER = (44, 44, 46), (206, 208, 203)  # sRGB of the Cycles ramp (0.035 / 0.56 linear), lifted a touch

SCREENS = {
    'ready': 'record_upload/01-ready.png', 'rec': 'record_upload/02-rec.png',
    'sending': 'record_upload/03-sending.png', 'note': 'record_upload/04-result.png',
    'work': 'work_lifecycle/01-researching.png', 'done': 'work_lifecycle/02-done.png',
}
for name, src in SCREENS.items():
    im = Image.open(os.path.join(SIM, src)).convert('L').resize((200, 200), Image.NEAREST)
    bw = im.point(lambda v: 255 if v > 128 else 0)
    # crisp 1-bit for the page (image-rendering: pixelated)
    bw.convert('1').save(os.path.join(OUT, f'{name}.png'), optimize=True)
    # texture: 5x nearest, slight ink spread like real e-paper
    t = bw.resize((1000, 1000), Image.NEAREST).filter(ImageFilter.GaussianBlur(1.1))
    t = Image.merge('RGB', [t.point(lambda v, a=a, b=b: int(a + (b - a) * v / 255)) for a, b in zip(INK, PAPER)])
    t.resize((1024, 1024), Image.LANCZOS).save(os.path.join(WEB, f'screen_{name}.png'), optimize=True)


def normal_map(h, strength):
    """h: L image, 255 = high. Returns OpenGL-convention (+Y up) normal map."""
    w, ht = h.size
    px = h.load()
    out = Image.new('RGB', (w, ht))
    po = out.load()
    for y in range(ht):
        for x in range(w):
            dx = (px[min(x + 1, w - 1), y] - px[max(x - 1, 0), y]) / 255 * strength
            dy = (px[x, max(y - 1, 0)] - px[x, min(y + 1, ht - 1)]) / 255 * strength  # +v is up
            n = (-dx, -dy, 1.0)
            l = (n[0] ** 2 + n[1] ** 2 + 1) ** 0.5
            po[x, y] = tuple(int((c / l * 0.5 + 0.5) * 255) for c in n)
    return out


BASE, DARK, LIGHT = (231, 231, 228), (210, 210, 205), (240, 240, 237)
for icon, emboss in (('icon_gear', False), ('icon_power', False), ('icon_sd', True)):
    im = Image.open(os.path.join(TEX, icon + '.png')).convert('L')
    im = im.resize((256, round(256 * im.size[1] / im.size[0])), Image.LANCZOS)
    mask = im if emboss else ImageChops.invert(im)        # 255 where the icon is
    # pad with an empty margin so CLAMP_TO_EDGE shows plain plastic outside the icon
    pad = Image.new('L', (mask.size[0] + 16, mask.size[1] + 16), 0)
    pad.paste(mask, (8, 8))
    mask = pad
    tint = LIGHT if emboss else DARK
    base = Image.composite(Image.new('RGB', mask.size, tint), Image.new('RGB', mask.size, BASE), mask)
    base.save(os.path.join(WEB, icon + '_base.png'), optimize=True)
    h = mask if emboss else ImageChops.invert(mask)       # engraved icons are low
    normal_map(h.filter(ImageFilter.GaussianBlur(1.5)), 6.0).save(os.path.join(WEB, icon + '_nrm.png'), optimize=True)
print('ok')
