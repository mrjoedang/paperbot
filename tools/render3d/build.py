# Waveshare ESP32-C6-ePaper-1.54 — procedural model + studio renders (Blender 5.x, Cycles).
# Units: 1 BU = 1 mm. Origin = body centre. X = width (39.8), Z = height (53), Y = depth (16.9).
# Front face (screen) at Y = -8.45 faces -Y. Right side (BOOT/PWR, microSD) at +X.
# Bottom (USB-C, mic holes) at Z = -26.5. Back plate (label, 2x6 header, screws) at Y = +8.45.
# Dimensions from Waveshare's outline drawing + pixel measurements of their product photos.
#
# blender -b -P build.py -- --shots hero,back,duo,bottom,turntable --samples 256 --out DIR
import bpy, bmesh, math, os, sys, time
from mathutils import Vector, Euler

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
def arg(name, default):
    return argv[argv.index(name) + 1] if name in argv else default

HERE = os.path.dirname(os.path.abspath(__file__))
TEX = os.path.join(HERE, 'tex')
OUT = arg('--out', os.path.join(HERE, 'out'))
SHOTS = [s for s in arg('--shots', 'hero').split(',') if s]
SAMPLES = int(arg('--samples', '128'))
SCREEN = arg('--screen', 'screen_note')
RES = [int(v) for v in arg('--res', '1600x1200').split('x')]
os.makedirs(OUT, exist_ok=True)

W, H, D = 39.8, 53.0, 16.9
HX, HZ, HY = W / 2, H / 2, D / 2
YF, YB = -HY, HY
RC = 4.5                   # plan-view corner radius (drawing: R4.50)
RF, RB = 1.6, 0.8          # front / back edge fillets

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# ---------------------------------------------------------------- helpers
def rr(x0, x1, z0, z1, r, n=16):
    """Rounded rectangle, CCW, fixed point count so rings can be lofted."""
    r = max(min(r, (x1 - x0) / 2 - 1e-4, (z1 - z0) / 2 - 1e-4), 1e-3)
    cs = [(x1 - r, z1 - r, 0), (x0 + r, z1 - r, 90), (x0 + r, z0 + r, 180), (x1 - r, z0 + r, 270)]
    pts = []
    for cx, cz, a0 in cs:
        for i in range(n + 1):
            a = math.radians(a0 + 90 * i / n)
            pts.append((cx + r * math.cos(a), cz + r * math.sin(a)))
    return pts


def loft(name, rings, cap0=True, cap1=True, mat=None):
    bm = bmesh.new()
    vs = [[bm.verts.new(p) for p in ring] for ring in rings]
    n = len(rings[0])
    for a, b in zip(vs[:-1], vs[1:]):
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((a[i], a[j], b[j], b[i]))
    if cap0:
        bm.faces.new(list(reversed(vs[0])))
    if cap1:
        bm.faces.new(vs[-1])
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    scene.collection.objects.link(ob)
    if mat:
        me.materials.append(mat)
    return ob


def prism_xz(name, pts, y0, y1, mat=None):
    return loft(name, [[(x, y0, z) for x, z in pts], [(x, y1, z) for x, z in pts]], mat=mat)


def prism_xy(name, pts, z0, z1, mat=None):
    return loft(name, [[(x, y, z0) for x, y in pts], [(x, y, z1) for x, y in pts]], mat=mat)


def prism_yz(name, pts, x0, x1, mat=None):
    return loft(name, [[(x0, y, z) for y, z in pts], [(x1, y, z) for y, z in pts]], mat=mat)


def circle(cx, cz, r, n=32):
    return [(cx + r * math.cos(2 * math.pi * i / n), cz + r * math.sin(2 * math.pi * i / n)) for i in range(n)]


def boolean(target, cutter, op='DIFFERENCE'):
    m = target.modifiers.new('bool', 'BOOLEAN')
    m.operation = op
    m.object = cutter
    m.solver = 'EXACT'
    m.material_mode = 'TRANSFER'
    bpy.context.view_layer.objects.active = target
    bpy.ops.object.modifier_apply(modifier=m.name)
    bpy.data.objects.remove(cutter, do_unlink=True)


def bevel(ob, width, segs=3, angle=35, harden=True):
    m = ob.modifiers.new('bevel', 'BEVEL')
    m.width = width
    m.segments = segs
    m.limit_method = 'ANGLE'
    m.angle_limit = math.radians(angle)
    m.harden_normals = harden
    m.miter_outer = 'MITER_ARC'
    m.use_clamp_overlap = True


def smooth(ob):
    for p in ob.data.polygons:
        p.use_smooth = True


# ---------------------------------------------------------------- materials
def set_in(node, name, val):
    if name in node.inputs:
        node.inputs[name].default_value = val


def principled(name, color, rough=0.5, metal=0.0, coat=0.0, sss=0.0, sss_r=(1, 1, 1), spec=0.5):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    b = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(b.outputs[0], out.inputs[0])
    set_in(b, 'Base Color', (*color, 1))
    set_in(b, 'Roughness', rough)
    set_in(b, 'Metallic', metal)
    set_in(b, 'Coat Weight', coat)
    set_in(b, 'Coat Roughness', 0.15)
    set_in(b, 'Specular IOR Level', spec)
    if sss:
        set_in(b, 'Subsurface Weight', sss)
        set_in(b, 'Subsurface Radius', sss_r)
        set_in(b, 'Subsurface Scale', 0.6)
    return mat, nt, b


def img(path, non_color=False):
    im = bpy.data.images.load(path, check_existing=True)
    if non_color:
        im.colorspace_settings.name = 'Non-Color'
    return im


def obj_uv(nt, u_axis, v_axis, u0, u1, v0, v1):
    """Vector socket: object-space coords remapped to an image's 0..1 UV."""
    tc = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    nt.links.new(tc.outputs['Object'], sep.inputs[0])
    cmb = nt.nodes.new('ShaderNodeCombineXYZ')
    for axis, lo, hi, dst in ((u_axis, u0, u1, 'X'), (v_axis, v0, v1, 'Y')):
        m = nt.nodes.new('ShaderNodeMapRange')
        m.clamp = False
        m.inputs['From Min'].default_value = lo
        m.inputs['From Max'].default_value = hi
        nt.links.new(sep.outputs[axis], m.inputs['Value'])
        nt.links.new(m.outputs[0], cmb.inputs[dst])
    return cmb.outputs[0]


# White ABS shell: satin, a touch of SSS, fine grain
M_SHELL, nt, b = principled('shell', (0.80, 0.80, 0.78), rough=0.38, sss=0.15, sss_r=(1.0, 0.9, 0.8))
noise = nt.nodes.new('ShaderNodeTexNoise')
noise.inputs['Scale'].default_value = 9.0
noise.inputs['Detail'].default_value = 8.0
bump = nt.nodes.new('ShaderNodeBump')
bump.inputs['Strength'].default_value = 0.025
bump.inputs['Distance'].default_value = 0.02
nt.links.new(noise.outputs['Fac'], bump.inputs['Height'])
nt.links.new(bump.outputs['Normal'], b.inputs['Normal'])

M_CAVITY, *_ = principled('cavity', (0.025, 0.025, 0.025), rough=0.8)
M_GROOVE, *_ = principled('groove', (0.30, 0.29, 0.27), rough=0.7)
M_METAL, *_ = principled('metal', (0.80, 0.80, 0.80), rough=0.22, metal=1.0)
M_SCREW, *_ = principled('screw', (0.75, 0.75, 0.74), rough=0.3, metal=1.0)
M_BLACKPL, *_ = principled('black_plastic', (0.018, 0.018, 0.018), rough=0.45)
M_GOLD, *_ = principled('gold', (1.0, 0.76, 0.35), rough=0.25, metal=1.0)

# e-paper: matte ink on paper-grey, faint glossy front film; image placed on the 27.8 mm active area
M_EPD, nt, b = principled('epaper', (0.6, 0.6, 0.58), rough=0.55, coat=0.35)
set_in(b, 'Coat Roughness', 0.08)
ti = nt.nodes.new('ShaderNodeTexImage')
ti.image = img(os.path.join(TEX, SCREEN + '.png'), True)
ti.extension = 'EXTEND'
nt.links.new(obj_uv(nt, 'X', 'Z', -13.9, 13.9, -12.2, 15.65), ti.inputs[0])
ramp = nt.nodes.new('ShaderNodeValToRGB')
ramp.color_ramp.elements[0].color = (0.035, 0.035, 0.038, 1)
ramp.color_ramp.elements[1].color = (0.56, 0.575, 0.565, 1)
nt.links.new(ti.outputs['Color'], ramp.inputs['Fac'])
pn = nt.nodes.new('ShaderNodeTexNoise')
pn.inputs['Scale'].default_value = 40.0
mixc = nt.nodes.new('ShaderNodeMix')
mixc.data_type = 'RGBA'
mixc.blend_type = 'MULTIPLY'
mixc.inputs['Factor'].default_value = 0.06
nt.links.new(ramp.outputs['Color'], mixc.inputs['A'])
nt.links.new(pn.outputs['Color'], mixc.inputs['B'])
nt.links.new(mixc.outputs['Result'], b.inputs['Base Color'])

# Label sticker
M_LABEL, nt, b = principled('label', (1, 1, 1), rough=0.32, coat=0.25)
tc = nt.nodes.new('ShaderNodeTexCoord')
ti = nt.nodes.new('ShaderNodeTexImage')
ti.image = img(os.path.join(TEX, 'label.png'))
ti.interpolation = 'Cubic'
nt.links.new(tc.outputs['UV'], ti.inputs[0])
nt.links.new(ti.outputs['Color'], b.inputs['Base Color'])


def icon_material(name, icon, u_axis, v_axis, u0, u1, v0, v1, base=(0.80, 0.80, 0.78), emboss=False):
    """Shell-like material with an icon height map. No SSS: these parts sit inside the solid shell."""
    mat, nt, b = principled(name, base, rough=0.38)
    ti = nt.nodes.new('ShaderNodeTexImage')
    ti.image = img(os.path.join(TEX, icon), True)
    ti.extension = 'CLIP'
    nt.links.new(obj_uv(nt, u_axis, v_axis, u0, u1, v0, v1), ti.inputs[0])
    mask = nt.nodes.new('ShaderNodeMath')
    mask.operation = 'MULTIPLY'
    if emboss:
        nt.links.new(ti.outputs['Color'], mask.inputs[0])
    else:
        inv = nt.nodes.new('ShaderNodeMath')
        inv.operation = 'SUBTRACT'
        inv.inputs[0].default_value = 1.0
        nt.links.new(ti.outputs['Color'], inv.inputs[1])
        nt.links.new(inv.outputs[0], mask.inputs[0])
    nt.links.new(ti.outputs['Alpha'], mask.inputs[1])
    bp = nt.nodes.new('ShaderNodeBump')
    bp.invert = not emboss
    bp.inputs['Strength'].default_value = 0.5 if emboss else 0.9
    bp.inputs['Distance'].default_value = 0.08
    nt.links.new(mask.outputs[0], bp.inputs['Height'])
    nt.links.new(bp.outputs['Normal'], b.inputs['Normal'])
    mx = nt.nodes.new('ShaderNodeMix')
    mx.data_type = 'RGBA'
    mx.inputs['A'].default_value = (*base, 1)
    mx.inputs['B'].default_value = (0.86, 0.86, 0.84, 1) if emboss else (base[0] * 0.8, base[1] * 0.8, base[2] * 0.78, 1)
    nt.links.new(mask.outputs[0], mx.inputs['Factor'])
    nt.links.new(mx.outputs['Result'], b.inputs['Base Color'])
    return mat


# ---------------------------------------------------------------- shell body (filleted rounded box)
def body_ring(d, y, n=24):
    return [(x, y, z) for x, z in rr(-HX + d, HX - d, -HZ + d, HZ - d, RC - d, n)]

rings = []
for i in range(7):
    t = math.radians(90 - 90 * i / 6)
    rings.append(body_ring(RB * (1 - math.cos(t)), YB - RB * (1 - math.sin(t))))
for i in range(11):
    t = math.radians(90 * i / 10)
    rings.append(body_ring(RF * (1 - math.cos(t)), YF + RF * (1 - math.sin(t))))
shell = loft('Shell', rings, mat=M_SHELL)
shell.data.materials.append(M_CAVITY)
shell.data.materials.append(M_GROOVE)

# ---------------------------------------------------------------- front window: sloped bezel, filleted into the face
OUT_W = (-15.8, 15.8, -14.5, 17.5, 2.3)
IN_W = (-13.9, 13.9, -12.2, 15.65, 0.6)      # = e-paper active area (27.8 x 27.85)
DEPTH_W = float(arg('--wdepth', '1.6'))
Y_PANEL = YF + DEPTH_W + 0.1


def lerp_rect(a, b, t):
    return tuple(a[i] + (b[i] - a[i]) * t for i in range(5))


def bevel_f(t, u0=0.45):
    u = 1 - t
    f = u - u0 / 2 if u >= u0 else u * u / (2 * u0)
    return f / (1 - u0 / 2)

wr = [[(x, YF - 2, z) for x, z in rr(*OUT_W[:4], OUT_W[4], 16)]]
for i in range(13):
    t = 1 - i / 12
    rct = lerp_rect(IN_W, OUT_W, t)
    y = YF + DEPTH_W * bevel_f(t)
    wr.append([(x, y, z) for x, z in rr(*rct[:4], rct[4], 16)])
wr.append([(x, Y_PANEL + 0.3, z) for x, z in rr(*IN_W[:4], IN_W[4], 16)])
boolean(shell, loft('cut_window', wr, mat=M_SHELL))

# ---------------------------------------------------------------- back plate groove + pry notch
GI = 0.85
gout = rr(-HX + GI, HX - GI, -HZ + GI, HZ - GI, RC - GI, 16)
gin = rr(-HX + GI + 0.16, HX - GI - 0.16, -HZ + GI + 0.16, HZ - GI - 0.16, RC - GI - 0.16, 16)
g = loft('cut_groove', [[(x, YB + 1, z) for x, z in gout], [(x, YB - 0.6, z) for x, z in gout]], mat=M_GROOVE)
boolean(g, loft('cut_groove_in', [[(x, YB + 2, z) for x, z in gin], [(x, YB - 1, z) for x, z in gin]]))
boolean(shell, g)
boolean(shell, prism_xz('cut_notch', rr(-16.8, 8.4, -HZ + GI - 0.4, -HZ + GI + 0.1, 0.2, 4), YB - 0.45, YB + 1, mat=M_SHELL))

# ---------------------------------------------------------------- header window, screw pockets (back)
HDR = (-15.9, -9.9, -10.4, 6.1)
boolean(shell, prism_xz('cut_hdr', rr(*HDR, 0.45, 6), YB - 9.5, YB + 1, mat=M_SHELL))
for sx in (-14.2, 14.2):
    boolean(shell, prism_xz('cut_screw', circle(sx, 21.65, 1.85, 48), YB - 0.45, YB + 1, mat=M_SHELL))

# ---------------------------------------------------------------- right side: LED hole, microSD slot, flex buttons
def cut_side(name, pts_yz, depth, mat):
    boolean(shell, prism_yz(name, pts_yz, HX - depth, HX + 1, mat=mat))

cut_side('cut_led', circle(-0.3, 18.4, 0.72, 32), 3, M_CAVITY)
cut_side('cut_sd', rr(-1.35, 0.8, 2.9, 15.5, 0.35, 6), 4, M_CAVITY)

GAP = 0.40
BTN = []
for dz in (0.0, -10.52):
    cap_o = (-2.49, 2.62, -7.80 + dz, -1.38 + dz)
    arm_o = (-5.77, -2.0, -5.98 + dz, -3.44 + dz)
    BTN.append((cap_o, arm_o))
    k1 = prism_yz('k_cap', rr(*cap_o, 1.05, 8), HX - 1.4, HX + 1, mat=M_CAVITY)
    boolean(k1, prism_yz('k_arm', rr(*arm_o, 0.25, 4), HX - 1.4, HX + 1, mat=M_CAVITY), 'UNION')
    boolean(k1, prism_yz('ki_cap', rr(cap_o[0] + GAP, cap_o[1] - GAP, cap_o[2] + GAP, cap_o[3] - GAP, 0.7, 8), HX - 2, HX + 2))
    boolean(shell, k1)

# ---------------------------------------------------------------- bottom: USB-C + mic/LED holes
USB_Y = 0.8
boolean(shell, prism_xy('cut_usb', rr(-4.65, 4.65, USB_Y - 1.85, USB_Y + 1.85, 1.84, 12), -HZ - 1, -HZ + 1.0, mat=M_SHELL))
boolean(shell, prism_xy('cut_usb2', rr(-4.6, 4.6, USB_Y - 1.75, USB_Y + 1.75, 1.7, 12), -HZ + 0.9, -HZ + 9, mat=M_CAVITY))
for hx, hy in ((-9.4, -1.0), (-9.4, 0.7), (9.4, 0.9)):
    boolean(shell, prism_xy('cut_hole', circle(hx, hy, 0.42, 24), -HZ - 1, -HZ + 3, mat=M_CAVITY))

bevel(shell, 0.12, segs=3, angle=40)
smooth(shell)

# ---------------------------------------------------------------- button caps + hinge arms
mats_btn = [
    icon_material('btn_boot', 'icon_gear.png', 'Y', 'Z', -2.15, 2.25, -6.79, -2.39),
    icon_material('btn_pwr', 'icon_power.png', 'Y', 'Z', -2.15, 2.25, -17.31, -12.91),
]
for (cap_o, arm_o), mb in zip(BTN, mats_btn):
    capr = rr(cap_o[0] + GAP, cap_o[1] - GAP, cap_o[2] + GAP, cap_o[3] - GAP, 0.7, 8)
    cap = prism_yz('BtnCap', capr, HX - 1.2, HX + 0.38, mat=mb)
    bevel(cap, 0.22, segs=4, angle=60)
    smooth(cap)
    arm = prism_yz('BtnArm', rr(-6.6, cap_o[0] + GAP + 0.3, arm_o[2] + GAP, arm_o[3] - GAP, 0.05, 2), HX - 1.2, HX - 0.12, mat=M_SHELL)
    bevel(arm, 0.06, segs=2, angle=60)
    smooth(arm)

# microSD card icon: micro-embossed plate beside the slot
sdm = icon_material('sd_icon', 'icon_sd.png', 'Y', 'Z', 1.65, 6.39, 7.35, 11.25, emboss=True)
prism_yz('SDIcon', rr(1.4, 6.6, 7.1, 11.5, 0.2, 4), HX - 0.2, HX + 0.004, mat=sdm)

# ---------------------------------------------------------------- e-paper panel
prism_xz('EPaper', rr(-16, 16, -14.6, 17.6, 0.5, 4), Y_PANEL, Y_PANEL + 1.2, mat=M_EPD)

# ---------------------------------------------------------------- back label sticker (22 x 34 mm)
LX0, LX1, LZ0, LZ1 = -7.3, 14.7, -17.0, 17.0
lab = prism_xz('Label', rr(LX0, LX1, LZ0, LZ1, 0.6, 6), YB - 0.05, YB + 0.07, mat=M_LABEL)
bevel(lab, 0.03, segs=1, angle=60, harden=False)
me = lab.data
uv = me.uv_layers.new(name='UV')
for poly in me.polygons:
    for li in poly.loop_indices:
        v = me.vertices[me.loops[li].vertex_index].co
        uv.data[li].uv = ((LX1 - v.x) / (LX1 - LX0), (v.z - LZ0) / (LZ1 - LZ0))

# ---------------------------------------------------------------- 2x6 female header, 2.54 mm pitch
hdr = prism_xz('Header', rr(HDR[0] + 0.06, HDR[1] - 0.06, HDR[2] + 0.06, HDR[3] - 0.06, 0.35, 4), YB - 0.35, YB - 9, mat=M_BLACKPL)
cx, cz = (HDR[0] + HDR[1]) / 2, (HDR[2] + HDR[3]) / 2
pins = [(cx + ix * 2.54, cz + (iz - 2.5) * 2.54) for ix in (-0.5, 0.5) for iz in range(6)]
for px, pz in pins:
    sq = lambda h: [(px + h, pz + h), (px - h, pz + h), (px - h, pz - h), (px + h, pz - h)]
    boolean(hdr, loft('cut_pin', [[(x, YB - 0.1, z) for x, z in sq(0.66)], [(x, YB - 0.35, z) for x, z in sq(0.66)],
                                  [(x, YB - 0.8, z) for x, z in sq(0.38)], [(x, YB - 4, z) for x, z in sq(0.38)]], mat=M_CAVITY))
bevel(hdr, 0.05, segs=1, angle=50)
for px, pz in pins:
    prism_xz('PinSpring', rr(px - 0.3, px + 0.3, pz - 0.36, pz - 0.2, 0.05, 1), YB - 1.6, YB - 3.0, mat=M_GOLD)

# ---------------------------------------------------------------- Phillips pan-head screws
for sx in (-14.2, 14.2):
    rs = [[(x, YB - 1.2, z) for x, z in circle(sx, 21.65, 1.65, 48)]]
    for i in range(8):
        a = math.radians(90 * i / 8)
        rs.append([(x, YB - 0.42 + 0.34 * math.sin(a) ** 0.6, z) for x, z in circle(sx, 21.65, 1.65 * math.cos(a), 48)])
    scr = loft('Screw', rs, mat=M_SCREW)
    for ang in (45, 135):
        rot = math.radians(ang)
        bx = [(sx + 1.05 * math.cos(rot) * s + 0.24 * math.cos(rot + math.pi / 2) * t,
               21.65 + 1.05 * math.sin(rot) * s + 0.24 * math.sin(rot + math.pi / 2) * t)
              for s, t in ((1, 1), (-1, 1), (-1, -1), (1, -1))]
        inner = [(sx + (px - sx) * 0.45, 21.65 + (pz - 21.65) * 0.45) for px, pz in bx]
        boolean(scr, loft('cut_x', [[(x, YB + 1, z) for x, z in bx], [(x, YB - 0.35, z) for x, z in inner]], mat=M_SCREW))
    bevel(scr, 0.04, segs=1, angle=40)
    smooth(scr)

# ---------------------------------------------------------------- USB-C receptacle
def stadium_xy(w, h, n=12):
    return rr(-w / 2, w / 2, USB_Y - h / 2, USB_Y + h / 2, h / 2 - 0.001, n)

zf = -HZ + 1.05
usb_shell = prism_xy('USBShell', stadium_xy(8.94, 3.26), zf, zf + 6, mat=M_METAL)
boolean(usb_shell, prism_xy('cut_usbin', stadium_xy(8.54, 2.86), zf - 1, zf + 5))
bevel(usb_shell, 0.06, segs=2, angle=40)
smooth(usb_shell)
prism_xy('USBBack', stadium_xy(8.6, 2.9), zf + 4.6, zf + 5.2, mat=M_BLACKPL)
prism_xy('USBTongue', rr(-3.3, 3.3, USB_Y - 0.35, USB_Y + 0.35, 0.15, 3), zf + 0.9, zf + 5, mat=M_BLACKPL)
for i in range(12):
    x = -2.75 + i * 0.5
    for sgn in (-1, 1):
        prism_xy('USBPin', [(x - 0.12, USB_Y + sgn * 0.351), (x + 0.12, USB_Y + sgn * 0.351),
                            (x + 0.12, USB_Y + sgn * 0.36), (x - 0.12, USB_Y + sgn * 0.36)], zf + 1.4, zf + 4.6, mat=M_GOLD)

# ---------------------------------------------------------------- device collection (instanced per shot)
DEV = bpy.data.collections.new('ESP32-C6-ePaper-1.54')
scene.collection.children.link(DEV)
for ob in list(scene.collection.objects):
    if ob.type == 'MESH':
        DEV.objects.link(ob)
        scene.collection.objects.unlink(ob)
bpy.context.view_layer.layer_collection.children[DEV.name].exclude = True

INST = []
def inst(loc, rot):
    e = bpy.data.objects.new('Device', None)
    e.instance_type = 'COLLECTION'
    e.instance_collection = DEV
    e.location = loc
    e.rotation_euler = Euler([math.radians(a) for a in rot], 'XYZ')
    scene.collection.objects.link(e)
    INST.append(e)
    return e

def clear_inst():
    for e in INST:
        bpy.data.objects.remove(e, do_unlink=True)
    INST.clear()

# ---------------------------------------------------------------- render settings
scene.render.engine = 'CYCLES'
cy = scene.cycles
cy.samples = SAMPLES
cy.use_denoising = True
cy.denoiser = 'OPENIMAGEDENOISE'
prefs = bpy.context.preferences.addons['cycles'].preferences
prefs.compute_device_type = 'METAL'
prefs.get_devices()
for dv in prefs.devices:
    dv.use = dv.type == 'METAL'
cy.device = 'GPU'
cy.max_bounces = 12
cy.diffuse_bounces = 6
cy.glossy_bounces = 6
scene.render.resolution_x, scene.render.resolution_y = RES
scene.view_settings.view_transform = 'Standard'
scene.view_settings.exposure = -1.1
scene.render.image_settings.file_format = 'PNG'

# world: soft neutral fill light; camera rays see a vertical gradient
world = bpy.data.worlds.new('World')
scene.world = world
world.use_nodes = True
wn = world.node_tree
for n in list(wn.nodes):
    wn.nodes.remove(n)
wout = wn.nodes.new('ShaderNodeOutputWorld')
wlight = wn.nodes.new('ShaderNodeBackground')
wlight.inputs['Color'].default_value = (0.92, 0.94, 1.0, 1)
wlight.inputs['Strength'].default_value = 0.35
wcam = wn.nodes.new('ShaderNodeBackground')
tcw = wn.nodes.new('ShaderNodeTexCoord')
sepw = wn.nodes.new('ShaderNodeSeparateXYZ')
wn.links.new(tcw.outputs['Window'], sepw.inputs[0])
grad = wn.nodes.new('ShaderNodeValToRGB')
GRAD = grad.color_ramp
wn.links.new(sepw.outputs['Y'], grad.inputs['Fac'])
wn.links.new(grad.outputs['Color'], wcam.inputs['Color'])
lp = wn.nodes.new('ShaderNodeLightPath')
mixw = wn.nodes.new('ShaderNodeMixShader')
wn.links.new(lp.outputs['Is Camera Ray'], mixw.inputs['Fac'])
wn.links.new(wlight.outputs[0], mixw.inputs[1])
wn.links.new(wcam.outputs[0], mixw.inputs[2])
wn.links.new(mixw.outputs[0], wout.inputs[0])

def set_grad(top, bottom):
    GRAD.elements[0].color = (*bottom, 1)
    GRAD.elements[1].color = (*top, 1)

# ---------------------------------------------------------------- studio sweep + lights
def make_sweep(color):
    bm = bmesh.new()
    R = 250
    prof = [(-900.0, 0.0)] + [(150 + R * math.sin(math.radians(90 * i / 24)), R - R * math.cos(math.radians(90 * i / 24))) for i in range(25)] + [(150 + R, 900.0)]
    vl = [bm.verts.new((-1500, y, z)) for y, z in prof]
    vr = [bm.verts.new((1500, y, z)) for y, z in prof]
    for i in range(len(prof) - 1):
        bm.faces.new((vl[i], vr[i], vr[i + 1], vl[i + 1]))
    me = bpy.data.meshes.new('Sweep')
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new('Sweep', me)
    scene.collection.objects.link(ob)
    m, _, _ = principled('sweep', color, rough=0.8, spec=0.2)
    me.materials.append(m)
    smooth(ob)
    return ob

SW = make_sweep((0.80, 0.82, 0.85))

def area(name, loc, target, size, power):
    ld = bpy.data.lights.new(name, 'AREA')
    ld.energy = power
    ld.size = size
    lo = bpy.data.objects.new(name, ld)
    scene.collection.objects.link(lo)
    lo.location = loc
    lo.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()

def camera(name, loc, target, lens=85, ortho=None):
    cd = bpy.data.cameras.new(name)
    cd.lens = lens
    cd.clip_start = 1
    cd.clip_end = 10000
    if ortho:
        cd.type = 'ORTHO'
        cd.ortho_scale = ortho
    co = bpy.data.objects.new(name, cd)
    scene.collection.objects.link(co)
    co.location = loc
    co.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
    return co

K = 1e6  # mm-scale scene: light power x 1000^2
area('Key', (-260, -330, 330), (0, 0, 25), 300, 3.2 * K)
area('Fill', (380, -240, 90), (0, 0, 25), 320, 1.3 * K)
area('Rim', (150, 380, 260), (0, 0, 25), 220, 1.6 * K)
area('Top', (0, -60, 560), (0, 0, 25), 420, 1.4 * K)

EXPO = {'duo': -0.3}
def render(name, cam):
    scene.camera = cam
    scene.view_settings.exposure = float(arg('--exposure', EXPO.get(name, -0.9)))
    scene.render.filepath = os.path.join(OUT, name + '.png')
    t = time.time()
    bpy.ops.render.render(write_still=True)
    print('WROTE', scene.render.filepath, round(time.time() - t, 1), 's')

def studio(on=True, transparent=False):
    SW.hide_render = not on
    scene.render.film_transparent = transparent

# ---------------------------------------------------------------- shots
HERO_CAM = ((95, -235, 118), (3, 0, HZ - 1))

def shot_hero():
    clear_inst(); studio(True)
    inst((0, 0, HZ), (0, 0, -28))
    render('hero', camera('CamHero', *HERO_CAM, lens=100))

def shot_back():
    clear_inst(); studio(True)
    inst((0, 0, HZ), (0, 0, 230))
    render('back', camera('CamBack', *HERO_CAM, lens=100))

def shot_bottom():
    clear_inst(); studio(True)
    inst((0, 0, HY), (-90, 0, 0))          # lying on its back, USB-C edge toward camera
    render('bottom', camera('CamBottom', (85, -175, 80), (1, -18, 6), lens=90))

def shot_duo():
    clear_inst(); studio(False)
    set_grad((0.50, 0.68, 0.86), (0.76, 0.85, 0.93))
    inst((-34, 10, 0), (12, -20, 205))
    inst((32, -4, 6), (-8, 14, -36))
    render('duo', camera('CamDuo', (0, -330, 40), (0, 0, 2), lens=85))
    set_grad((1, 1, 1), (1, 1, 1))

def shot_front():
    clear_inst(); studio(False, True)
    inst((0, 0, 0), (0, 0, 0))
    render('front', camera('CamFront', (0, -400, 0), (0, 0, 0), ortho=RES[0] / 16.93))

def shot_turntable():
    clear_inst(); studio(True)
    e = inst((0, 0, HZ), (0, 0, -28))
    scene.camera = camera('CamTT', *HERO_CAM, lens=100)
    n = int(arg('--frames', '144'))
    scene.frame_start, scene.frame_end = 1, n
    e.keyframe_insert('rotation_euler', index=2, frame=1)
    e.rotation_euler[2] += 2 * math.pi
    e.keyframe_insert('rotation_euler', index=2, frame=n + 1)
    act = e.animation_data.action
    fcs = list(getattr(act, 'fcurves', []) or [])
    if not fcs:
        for layer in act.layers:
            for strip in layer.strips:
                for cb in strip.channelbags:
                    fcs += list(cb.fcurves)
    for fc in fcs:
        for kp in fc.keyframe_points:
            kp.interpolation = 'LINEAR'
    scene.view_settings.exposure = -0.9
    scene.render.filepath = os.path.join(OUT, 'tt', 'f_')
    bpy.ops.render.render(animation=True)

for s in SHOTS:
    globals()['shot_' + s]()

clear_inst()
inst((0, 0, HZ), (0, 0, -28))
scene.camera = bpy.data.objects.get('CamHero') or scene.camera
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(OUT, 'esp32-c6-epaper-1.54.blend'))
