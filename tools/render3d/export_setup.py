# The web model for /setup: export_web.py's device + a USB-C cable on a rig with one animation, "plug" (comes up from
# below into the port). The rig's rest pose is hidden and tiny, so the viewer's
# framing and floor shadow are the device's alone.
# blender -b -P export_setup.py -- OUT.glb
import bpy, os, sys, math

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_GLB = sys.argv[sys.argv.index('--') + 1]
src = open(os.path.join(HERE, 'export_web.py')).read()
head = src.split('# mm -> m', 1)[0]
exec(compile(head, 'export_web.py', 'exec'))

# Crisp edges in a real-time viewer: build.py's smooth() marks every face smooth with no sharp edges, so around the
# boolean cuts (button slits, ports) the 90° edges get averaged normals and the shading smears into ragged dark bands.
# Mark edges sharper than 35° as sharp (the glTF export splits normals there), then weight vertex normals by face
# area: the big flat faces decide the shading, so the long thin triangles the booleans leave don't streak.
for ob in keep:
    if ob.type == 'MESH':
        ob.data.set_sharp_from_angle(angle=math.radians(35))
        wn = ob.modifiers.new('wn', 'WEIGHTED_NORMAL')
        wn.mode, wn.weight, wn.keep_sharp = 'FACE_AREA', 100, True

M_CABLE = flat_mat('Cable', (0.80, 0.80, 0.78), 0.5)
M_TIP = flat_mat('PlugTip', (0.78, 0.78, 0.78), 0.25, metal=1.0)

PZ = -HZ                                   # the port's face (bottom of the device), plug points up (+Z)
# USB Type-C plug: a stadium metal shell 8.25 x 2.40 mm (fully round ends, per the connector drawings), hollow with a
# dark slot inside.
M_SLOT = flat_mat('PlugSlot', (0.02, 0.02, 0.02), 0.6)
S0, S1 = PZ - 3.0, PZ + 5.5                # shell: from inside the overmold into the port
shell = prism_xy('PlugShell', stadium_xy(8.25, 2.40), S0, S1, mat=M_TIP)
boolean(shell, prism_xy('cut_plugin', stadium_xy(7.45, 1.60), S0 + 0.8, S1 + 1))
bevel(shell, 0.12, segs=2, angle=40); smooth(shell)
slot = prism_xy('PlugSlotFill', stadium_xy(7.5, 1.65), S0 + 0.6, S0 + 1.4, mat=M_SLOT)   # the dark inside
# the body: the marketing renders' plug (illus.py usb_cable): a clean pill 12.4 x 6.6 mm, 20.4 mm long, the cable
# straight out of its end
O1, O0 = PZ - 0.1, PZ - 20.5               # flush against the device when seated: no gap, no metal showing
body = prism_xy('Plug', rr(-6.2, 6.2, USB_Y - 3.3, USB_Y + 3.3, 3.2, 10), O0, O1, mat=M_CABLE)
bevel(body, 0.6, segs=3, angle=40); smooth(body)
tip = shell
CAB0 = O0 + 0.5                            # the cable starts inside the body's end
cu = bpy.data.curves.new('CableCurve', 'CURVE')
cu.dimensions = '3D'
cu.bevel_depth = 1.9
cu.bevel_resolution = 4
cu.resolution_u = 10
sp = cu.splines.new('BEZIER')
pts = [(0, USB_Y, CAB0), (0, USB_Y + 1, CAB0 - 12), (2, 10, CAB0 - 28), (8, 32, CAB0 - 38), (20, 70, CAB0 - 42), (34, 120, CAB0 - 42)]
sp.bezier_points.add(len(pts) - 1)
for bp, p in zip(sp.bezier_points, pts):
    bp.co = p
    bp.handle_left_type = bp.handle_right_type = 'AUTO'
cable = bpy.data.objects.new('Cable', cu)
cable.data.materials.append(M_CABLE)
scene.collection.objects.link(cable)
bpy.ops.object.select_all(action='DESELECT')
cable.select_set(True)
bpy.context.view_layer.objects.active = cable
bpy.ops.object.convert(target='MESH')
cable = bpy.context.active_object
smooth(cable)

rig = bpy.data.objects.new('USBCable', None)
scene.collection.objects.link(rig)
for ob in (body, shell, slot, cable):
    ob.parent = rig

# rest pose: hidden (tiny, tucked inside the device)
HIDDEN = dict(location=(0, 0, 0), scale=(0.001, 0.001, 0.001))
rig.location, rig.scale = HIDDEN['location'], HIDDEN['scale']

scene.render.fps = 30
DROP = -46.0                                # how far below it starts / ends (mm)

def keys(action_name, frames):
    """frames: [(frame, z, scale)] -> an action on the rig, pushed to its own NLA track (one glTF animation each)."""
    rig.animation_data_create()
    act = bpy.data.actions.new(action_name)
    rig.animation_data.action = act
    for f, z, s in frames:
        rig.location = (0, 0, z)
        rig.scale = (s, s, s)
        rig.keyframe_insert('location', frame=f)
        rig.keyframe_insert('scale', frame=f)
    track = rig.animation_data.nla_tracks.new()
    track.name = action_name
    track.strips.new(action_name, int(frames[0][0]), act)
    rig.animation_data.action = None
    return act

# plug: appears below, rises, slows down, a small push at the end (seated)
keys('plug', [(0, DROP, 1), (20, -2.2, 1), (26, 0.4, 1), (30, 0, 1)])
rig.location, rig.scale = HIDDEN['location'], HIDDEN['scale']
scene.frame_set(0)

keep.update({body, shell, slot, cable})
root = bpy.data.objects.new('paperbot', None)
scene.collection.objects.link(root)
for ob in keep:
    if ob.parent is None:
        ob.parent = root
rig.parent = root
root.scale = (0.001, 0.001, 0.001)

bpy.ops.export_scene.gltf(
    filepath=OUT_GLB, export_format='GLB', use_selection=False, export_apply=True,
    export_yup=True, export_texcoords=True, export_normals=True, export_tangents=False,
    export_materials='EXPORT', export_image_format='AUTO', export_cameras=False, export_lights=False,
    export_draco_mesh_compression_enable=False,
    export_animations=True, export_animation_mode='NLA_TRACKS', export_force_sampling=True, export_frame_range=False,
    export_optimize_animation_size=False, export_optimize_animation_keep_anim_object=True,
)
print('GLB', OUT_GLB, os.path.getsize(OUT_GLB))
