# Illustrations for the website's three benefit columns: small desk scenes with the real paperbot model.
# Transparent background + shadow catcher, so they sit on the page colour.
# blender -b -P illus.py -- OUTDIR [--res 1200x900] [--samples 128] [--only phone,mug,cable]
import bpy, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
_argv = sys.argv[sys.argv.index('--') + 1:]
OUTDIR = _argv[0]
def _arg(name, default):
    return _argv[_argv.index(name) + 1] if name in _argv else default
I_RES = [int(v) for v in _arg('--res', '1200x900').split('x')]
I_SAMPLES = int(_arg('--samples', '128'))
ONLY = _arg('--only', 'phone,mug,cable,open,front').split(',')
os.makedirs(OUTDIR, exist_ok=True)

sys.argv = [sys.argv[0], '--', '--shots', '', '--out', os.path.join(HERE, 'out', 'illus_tmp')]
exec(compile(open(os.path.join(HERE, 'build.py')).read(), 'build.py', 'exec'))

from mathutils import Euler, Vector

scene.render.resolution_x, scene.render.resolution_y = I_RES
scene.cycles.samples = I_SAMPLES
studio(False, True)                       # no sweep, transparent film

# shadow catcher floor
bpy.ops.mesh.primitive_plane_add(size=3000, location=(0, 0, 0))
floor = bpy.context.active_object
floor.name = 'ShadowCatcher'
floor.is_shadow_catcher = True

# screen image per scene
EPD = bpy.data.materials['epaper']
EPD_TEX = next(n for n in EPD.node_tree.nodes if n.type == 'TEX_IMAGE')
def set_screen(name):
    EPD_TEX.image = bpy.data.images.load(os.path.join(TEX, 'illus', name + '.png'), check_existing=True)
    EPD_TEX.image.colorspace_settings.name = 'Non-Color'

PROPS = []
def prop(ob):
    PROPS.append(ob)
    return ob
def clear_props():
    for ob in PROPS:
        bpy.data.objects.remove(ob, do_unlink=True)
    PROPS.clear()

def ring_xy(r, z, n=64):
    return [(r * math.cos(2 * math.pi * i / n), r * math.sin(2 * math.pi * i / n), z) for i in range(n)]

# ---------------------------------------------------------------- materials
M_PHONE, *_ = principled('phone_back', (0.018, 0.018, 0.020), rough=0.55, coat=0.12)
M_PHONE_EDGE, *_ = principled('phone_edge', (0.12, 0.12, 0.125), rough=0.35, metal=1.0)
M_LENS, *_ = principled('lens', (0.006, 0.006, 0.008), rough=0.05, coat=1.0)
M_MUG, *_ = principled('mug', (0.075, 0.070, 0.062), rough=0.4, coat=0.3)
M_COFFEE, *_ = principled('coffee', (0.035, 0.016, 0.007), rough=0.08)
M_CABLE, *_ = principled('cable', (0.80, 0.80, 0.78), rough=0.48)
M_TIP, *_ = principled('usb_tip', (0.8, 0.8, 0.8), rough=0.2, metal=1.0)
M_HANDLE, *_ = principled('driver_handle', (0.075, 0.070, 0.062), rough=0.45, coat=0.2)
M_STEEL, *_ = principled('driver_steel', (0.78, 0.78, 0.80), rough=0.18, metal=1.0)

# ---------------------------------------------------------------- props
def phone(loc, rz):
    """A phone lying face-down: you can see its back and camera bump."""
    W2, L2, T = 35.75, 73.5, 7.8
    body = prop(prism_xy('Phone', rr(-W2, W2, -L2, L2, 10.5, 12), 0, T, mat=M_PHONE))
    body.data.materials.append(M_PHONE_EDGE)
    bevel(body, 2.6, segs=6, angle=40)
    smooth(body)
    bump = prop(prism_xy('PhoneBump', rr(-W2 + 5, -W2 + 31, L2 - 31, L2 - 5, 7, 8), T - 0.2, T + 1.3, mat=M_PHONE))
    bevel(bump, 0.9, segs=4, angle=40); smooth(bump)
    lenses = [(-W2 + 12, L2 - 12), (-W2 + 12, L2 - 24), (-W2 + 24, L2 - 18)]
    for lx, ly in lenses:
        rim = prop(loft('LensRim', [[(lx + x, ly + y, T + 1.2) for x, y, _ in ring_xy(5.2, 0, 48)],
                                     [(lx + x, ly + y, T + 1.9) for x, y, _ in ring_xy(5.2, 0, 48)]], mat=M_PHONE_EDGE))
        glass = prop(loft('Lens', [[(lx + x, ly + y, T + 1.5) for x, y, _ in ring_xy(4.2, 0, 48)],
                                    [(lx + x, ly + y, T + 2.0) for x, y, _ in ring_xy(4.2, 0, 48)]], mat=M_LENS))
        smooth(rim); smooth(glass)
        rim.parent = body; glass.parent = body
    bump.parent = body
    body.location = loc
    body.rotation_euler = (0, 0, math.radians(rz))

def mug(loc, rz):
    R, Hm, wall = 40, 92, 3.2
    outer = prop(loft('Mug', [ring_xy(R - 2, 0), ring_xy(R, 2.5), ring_xy(R, Hm - 1.5), ring_xy(R - 0.8, Hm)], mat=M_MUG))
    inner = loft('MugIn', [ring_xy(R - wall, 7), ring_xy(R - wall, Hm + 5)])
    boolean(outer, inner)
    bevel(outer, 0.8, segs=3, angle=30); smooth(outer)
    coffee = prop(loft('Coffee', [ring_xy(R - wall - 0.05, Hm - 16), ring_xy(R - wall - 0.05, Hm - 15.5)], mat=M_COFFEE))
    bpy.ops.mesh.primitive_torus_add(major_radius=22, minor_radius=5.5, major_segments=48, minor_segments=16,
                                     location=(R + 7, 0, Hm * 0.52), rotation=(math.radians(90), 0, 0))
    handle = prop(bpy.context.active_object)
    handle.name = 'MugHandle'
    handle.scale = (0.75, 1, 1)
    handle.data.materials.append(M_MUG)
    smooth(handle)
    coffee.parent = outer; handle.parent = outer
    outer.location = loc
    outer.rotation_euler = (0, 0, math.radians(rz))

def usb_cable(points):
    """USB-C plug pushed into the device's port (device lying on its back, port toward -Y), then a cable."""
    z = HY - USB_Y                      # port centre height when the device lies on its back
    body = prop(prism_xz('Plug', rr(-6.2, 6.2, z - 3.3, z + 3.3, 3.2, 10), -48.0, -27.6, mat=M_CABLE))
    bevel(body, 0.6, segs=3, angle=40); smooth(body)
    tip = prop(prism_xz('PlugTip', rr(-4.1, 4.1, z - 1.25, z + 1.25, 1.24, 8), -27.6, -21.0, mat=M_TIP))
    smooth(tip)
    cu = bpy.data.curves.new('Cable', 'CURVE')
    cu.dimensions = '3D'
    cu.bevel_depth = 1.9
    cu.bevel_resolution = 6
    sp = cu.splines.new('BEZIER')
    pts = [(0, -47.5, z)] + points
    sp.bezier_points.add(len(pts) - 1)
    for bp, p in zip(sp.bezier_points, pts):
        bp.co = p
        bp.handle_left_type = bp.handle_right_type = 'AUTO'
    cob = bpy.data.objects.new('Cable', cu)
    cob.data.materials.append(M_CABLE)
    scene.collection.objects.link(cob)
    prop(cob)
    return [body, tip, cob]

def screwdriver(loc, rz):
    """A small precision screwdriver lying on the desk (axis along +X before rotation)."""
    r_h, z = 5.5, 5.5
    def tube(name, x0, x1, r0, r1, mat, n=40):
        rings = [[(x, r * math.cos(2 * math.pi * i / n), z + r * math.sin(2 * math.pi * i / n)) for i in range(n)]
                 for x, r in ((x0, r0), (x1, r1))]
        ob = prop(loft(name, rings, mat=mat)); smooth(ob); return ob
    handle = tube('DriverHandle', -46, 22, r_h, r_h, M_HANDLE, 12)      # 12 sides: a faceted grip
    bevel(handle, 0.6, segs=2, angle=20)
    cap = tube('DriverCap', -50, -46, r_h - 1.2, r_h, M_STEEL)
    ferrule = tube('DriverFerrule', 22, 30, 3.2, 2.2, M_STEEL)
    shaft = tube('DriverShaft', 30, 76, 1.1, 1.1, M_STEEL, 24)
    tip = tube('DriverTip', 76, 80, 1.1, 0.5, M_STEEL, 24)
    for ob in (cap, ferrule, shaft, tip):
        ob.parent = handle
    handle.location = loc
    handle.rotation_euler = (0, 0, math.radians(rz))
    handle.scale = (0.82, 0.82, 0.82)

# ---------------------------------------------------------------- render helpers
# Two passes per scene, combined later by compose_illus.py:
#   NAME-obj.png    the objects, lit by the studio lights, no floor
#   NAME-shadow.png only the floor's shadow (objects hidden from the camera but still casting), lit by one soft
#                   overhead light + the dim world: a clean contact shadow instead of four big lights' smudges
STUDIO = [bpy.data.objects[n] for n in ('Key', 'Fill', 'Rim', 'Top')]
_sl = bpy.data.lights.new('ShadowLight', 'AREA')
_sl.energy = 1.6 * K
_sl.size = 200
SHADOW_LIGHT = bpy.data.objects.new('ShadowLight', _sl)
scene.collection.objects.link(SHADOW_LIGHT)
DEV_OBJECTS = list(bpy.data.collections['ESP32-C6-ePaper-1.54'].objects)

def shoot(name, cam_loc, target, lens=70, exposure=-0.75):
    cam = camera('Cam_' + name, cam_loc, target, lens=lens)
    scene.camera = cam
    scene.view_settings.exposure = exposure
    # pass 1: objects
    floor.hide_render = True
    SHADOW_LIGHT.hide_render = True
    for L in STUDIO: L.hide_render = False
    scene.render.filepath = os.path.join(OUTDIR, name + '-obj.png')
    bpy.ops.render.render(write_still=True)
    # pass 2: shadow only
    floor.hide_render = False
    for L in STUDIO: L.hide_render = True
    SHADOW_LIGHT.hide_render = False
    SHADOW_LIGHT.location = (target[0] - 40, target[1] + 80, 420)
    SHADOW_LIGHT.rotation_euler = (Vector((target[0], target[1], 0)) - SHADOW_LIGHT.location).to_track_quat('-Z', 'Y').to_euler()
    casters = DEV_OBJECTS + [o for o in PROPS if o.type in ('MESH', 'CURVE')]
    for o in casters: o.visible_camera = False
    world_strength = wlight.inputs['Strength'].default_value
    wlight.inputs['Strength'].default_value = 0.0      # no room light: only the one soft light's shadow
    scene.render.filepath = os.path.join(OUTDIR, name + '-shadow.png')
    bpy.ops.render.render(write_still=True)
    wlight.inputs['Strength'].default_value = world_strength
    for o in casters: o.visible_camera = True
    print('WROTE', name)

# 1) no distractions: paperbot at work, the phone face-down beside it
if 'phone' in ONLY:
    clear_inst(); clear_props()
    set_screen('work-gift')
    inst((-34, 4, HZ), (0, 0, -14))
    phone((52, 6, 0), -16)
    shoot('illus-phone', (24, -340, 230), (12, 0, 14), lens=60)

# 2) answers for later: a finished answer and a coffee
if 'mug' in ONLY:
    clear_inst(); clear_props()
    set_screen('done-dishwasher')
    inst((-30, -16, HZ), (0, 0, -12))
    mug((44, 42, 0), 35)
    shoot('illus-mug', (12, -360, 230), (8, 10, 30), lens=60)

# 3) two weeks on a charge: lying on its back, USB-C plugged in
if 'cable' in ONLY:
    clear_inst(); clear_props()
    set_screen('ready')
    pivot = bpy.data.objects.new('Pivot', None)
    scene.collection.objects.link(pivot)
    PROPS.append(pivot)
    dev = inst((0, 0, HY), (-90, 0, 0))
    parts = usb_cable([(0, -70, 4.5), (8, -92, 1.9), (40, -112, 1.9), (88, -104, 1.9), (128, -70, 1.9), (190, -58, 1.9)])
    for ob in [dev] + parts:
        ob.parent = pivot
    pivot.rotation_euler = (0, 0, math.radians(28))
    pivot.location = (-24, 30, 0)
    shoot('illus-cable', (-2, -250, 235), (-8, 2, 0), lens=60)

# 4) open source: face-down so you see the back (pin map, header, screws), a screwdriver beside it
if 'open' in ONLY:
    clear_inst(); clear_props()
    set_screen('ready')
    inst((-18, 4, HY), (90, 0, 196))
    screwdriver((86, 10, 0), 168)
    shoot('illus-open', (24, -260, 250), (28, 2, 4), lens=58)

# 5) a lone paperbot facing straight on, in front of the app screenshots, showing the answer from the list
if 'front' in ONLY:
    clear_inst(); clear_props()
    set_screen('done-walk2')
    inst((0, 0, HZ), (0, 0, 0))
    shoot('illus-front', (0, -260, 64), (0, 0, HZ - 1), lens=70)
