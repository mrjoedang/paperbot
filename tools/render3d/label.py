# Redraw the back sticker of the ESP32-C6-ePaper-1.54 at 40 px/mm (22 x 34 mm).
# Tile boxes are in "crop" coordinates measured from a 3.5x crop of the product photo
# (label spans x22..658, y18..1000 in that crop).
import sys, math
from PIL import Image, ImageDraw, ImageFont

SS = 2  # supersample
W, H = 880 * SS, 1360 * SS
OX, OY, SX, SY = 22, 18, 880 / 636 * SS, 1360 / 982 * SS


def M(x, y):
    return ((x - OX) * SX, (y - OY) * SY)


def box(x0, y0, x1, y1):
    a, b = M(x0, y0)
    c, d = M(x1, y1)
    return [a, b, c, d]


AV = '/System/Library/Fonts/Avenir Next.ttc'
FB = FBOLD = 0
for i in range(12):
    try:
        n = ImageFont.truetype(AV, 20, index=i).getname()
    except Exception:
        break
    if n[1] == 'Demi Bold':
        FB = i
    if n[1] == 'Bold':
        FBOLD = i


def font(px, idx=None):
    return ImageFont.truetype(AV, int(px * SS * 1.384 * 0.97), index=FB if idx is None else idx)


img = Image.new('RGB', (W, H), (238, 238, 236))
d = ImageDraw.Draw(img)
R = 9 * SS
C = dict(
    green=(31, 158, 74), red=(210, 38, 36), magenta=(196, 26, 128), purple=(109, 83, 150),
    red2=(200, 30, 42), blue=(72, 110, 182), dgreen=(28, 152, 72), pink=(196, 84, 180),
    orange=(240, 104, 30), sky=(38, 152, 220), amber=(238, 160, 44), gray=(70, 70, 72),
    black=(30, 30, 30), lime=(104, 168, 58), white=(255, 255, 255), logo=(102, 176, 50),
)


def tile(b, col, r=R):
    d.rounded_rectangle(box(*b), radius=r, fill=col)


def text(cx, cy, s, size, col=(255, 255, 255), f=None, anchor='mm'):
    d.text(M(cx, cy), s, fill=col, font=f or font(size), anchor=anchor)


def vtext(b, s, size, col=(255, 255, 255)):
    x0, y0, x1, y1 = [int(v) for v in box(*b)]
    w, h = x1 - x0, y1 - y0
    t = Image.new('RGBA', (h, w), (0, 0, 0, 0))
    ImageDraw.Draw(t).text((h / 2, w / 2), s, fill=col, font=font(size), anchor='mm')
    t = t.rotate(90, expand=True)
    img.paste(t, (x0, y0), t)


def seg(p, q, w, col):
    d.line([M(*p), M(*q)], fill=col, width=int(w * SS))


# --- header row: leaf logo (TL small radius, TR/BL large, BR sharp) ---
def leaf(x0, y0, x1, y1):
    a, b = M(x0, y0); c, e = M(x1, y1)
    w = c - a
    def arc(cx, cy, r, a0, a1, n=24):
        return [(cx + r * math.cos(math.radians(a0 + (a1 - a0) * k / n)),
                 cy + r * math.sin(math.radians(a0 + (a1 - a0) * k / n))) for k in range(n + 1)]
    rtl, rtr, rbl = 0.18 * w, 0.62 * w, 0.40 * w
    pts = arc(a + rtl, b + rtl, rtl, 180, 270) + arc(c - rtr, b + rtr, rtr, 270, 360) + [(c, e)] + arc(a + rbl, e - rbl, rbl, 90, 180)
    d.polygon(pts, fill=C['logo'])

leaf(28, 25, 152, 150)
d.line([M(46, 70), M(64, 124), M(84, 82), M(102, 124), M(116, 88)], fill=C['white'], width=int(13 * SS), joint='curve')
seg((116, 88), (124, 70), 9, C['white'])
d.polygon([M(113, 72), M(134, 58), M(132, 84)], fill=C['white'])
seg((122, 98), (134, 120), 7, C['white'])
d.polygon([M(126, 122), M(141, 112), M(138, 134)], fill=C['white'])
text(165, 68, 'ESP32-C6-', 44, C['black'], anchor='lm')
text(165, 125, 'ePaper-1.54', 44, C['black'], anchor='lm')

tile((478, 38, 652, 150), C['magenta'])
d.polygon([M(536, 62), M(548, 62), M(562, 50), M(562, 92), M(548, 80), M(536, 80)], fill=C['white'])
for rr_ in (10, 20):
    d.arc(box(560 - rr_, 71 - rr_, 560 + rr_, 71 + rr_), start=-55, end=55, fill=C['white'], width=int(5 * SS))
text(565, 124, '+SPK-', 40)

# --- row 2 ---
tile((28, 170, 242, 310), C['green'])
d.rounded_rectangle(box(92, 192, 172, 248), radius=4 * SS, fill=C['white'])
for k in range(5):
    d.rectangle(box(160, 198 + k * 9, 178, 203 + k * 9), fill=C['white'])
d.rectangle(box(172, 192, 182, 210), fill=C['green'])
text(135, 284, 'Micro  SD', 30)
tile((252, 170, 468, 310), C['red'])
text(360, 218, 'Audio', 44)
text(360, 272, 'ES8311', 44)
tile((478, 170, 652, 310), C['green'])
d.rectangle(box(538, 200, 600, 240), outline=C['white'], width=int(7 * SS))
d.rectangle(box(600, 210, 610, 230), fill=C['white'])
d.polygon([M(574, 202), M(558, 224), M(570, 224), M(564, 240), M(582, 216), M(570, 216)], fill=C['white'])
d.rectangle(box(530, 206, 548, 234), fill=C['green'])
d.rectangle(box(590, 206, 604, 234), fill=C['green'])
seg((538, 200), (546, 200), 7, C['white'])
text(565, 280, '+ BAT-', 40)

# --- row 3 ---
tile((28, 330, 264, 432), C['purple'])
text(146, 354, 'RTC', 36)
text(146, 402, 'PCF85063', 36)
tile((276, 330, 488, 432), C['red2'])
text(382, 354, 'PMIC', 36)
text(382, 402, 'ETA6098', 36)

cols = [(497, 572), (575, 650)]
rows = [
    ((330, 412), ('RXD', C['purple']), ('TXD', C['purple'])),
    ((412, 494), ('SDA', C['sky']), ('GP13', C['gray'])),
    ((494, 576), ('SCL', C['sky']), ('GP12', C['gray'])),
    ((576, 652), ('GND', C['black']), ('GP9', C['lime'])),
    ((652, 730), ('3V3', C['red2']), ('GP4', C['lime'])),
    ((730, 812), ('VSYS', C['red2']), ('GP3', C['lime'])),
]
for (ya, yb), a, b in rows:
    for (xa, xb), (lab, col) in zip(cols, (a, b)):
        d.rectangle(box(xa, ya, xb, yb), fill=col)
        sz = 24 if len(lab) < 4 else 22
        text((xa + xb) / 2, (ya + yb) / 2, lab, sz, f=font(sz, FBOLD))
d.rectangle(box(572, 330, 575, 812), fill=(238, 238, 236))

# --- left column + middle ---
tile((28, 446, 112, 632), C['amber']); vtext((28, 446, 112, 632), 'BOOT', 34)
tile((28, 646, 112, 816), C['red2']); vtext((28, 646, 112, 816), 'PWR', 34)
tile((122, 442, 488, 546), C['blue'])
text(305, 468, 'e-Paper', 44)
text(305, 522, '200×200 Pixels', 34)
d.rounded_rectangle(box(124, 557, 268, 686), radius=R, fill=C['white'], outline=C['dgreen'], width=int(3 * SS))
text(196, 604, '16MB', 42, C['dgreen'], font(42, FBOLD))
text(196, 648, 'FLASH', 26, C['dgreen'], font(26, FBOLD))
tile((276, 556, 488, 686), C['dgreen']); text(382, 621, 'ESP32-C6', 40)
tile((122, 696, 302, 816), C['pink']); text(212, 730, 'LED', 40); text(212, 782, 'EXIO4', 40)
tile((312, 696, 488, 816), C['orange']); text(400, 730, 'ADC', 40); text(400, 782, 'GP0', 40)

# --- bottom row ---
tile((28, 830, 250, 988), C['sky'])
seg((112, 902), (160, 852), 20, C['white']); seg((112, 902), (160, 852), 10, C['sky'])
d.ellipse(box(150, 842, 170, 862), fill=C['white']); d.ellipse(box(155, 847, 165, 857), fill=C['sky'])
d.ellipse(box(98, 888, 128, 918), fill=C['white']); d.ellipse(box(105, 895, 121, 911), fill=C['sky'])
seg((114, 900), (140, 873), 5, C['white'])
d.ellipse(box(106, 896, 120, 910), fill=C['white'])
d.ellipse(box(140, 902, 160, 922), fill=C['white'])
d.polygon([M(141, 909), M(150, 890), M(159, 909)], fill=C['white'])
text(140, 955, 'SHTC3', 42)
tile((260, 830, 410, 988), C['red'])
d.rounded_rectangle(box(288, 858, 382, 900), radius=21 * SS, outline=C['white'], width=int(8 * SS))
text(335, 955, 'USB', 42)
tile((420, 830, 558, 988), C['sky'])
d.rounded_rectangle(box(478, 846, 500, 892), radius=11 * SS, fill=C['white'])
d.arc(box(466, 862, 512, 906), start=0, end=180, fill=C['white'], width=int(5 * SS))
seg((489, 906), (489, 916), 5, C['white'])
text(489, 955, 'MIC', 42)
k = C['black']
d.rectangle(box(588, 880, 628, 930), outline=k, width=int(4 * SS))
seg((582, 876), (634, 876), 4, k)
d.ellipse(box(592, 930, 604, 942), outline=k, width=int(3 * SS))
seg((570, 858), (648, 948), 4, k); seg((648, 858), (570, 948), 4, k)
d.rectangle(box(576, 958, 642, 972), fill=k)

img.resize((W // SS, H // SS), Image.LANCZOS).save(sys.argv[1])
