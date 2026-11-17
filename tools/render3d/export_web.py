# Build the model with build.py (no renders), swap in glTF-friendly materials + UVs, export a GLB in metres.
# blender -b -P export_web.py -- OUT.glb
import bpy, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_GLB = sys.argv[sys.argv.index('--') + 1]
WEB = os.path.join(HERE, 'tex', 'web')
SCRATCH = os.path.join(HERE, 'out', 'web_tmp')

sys.argv = [sys.argv[0], '--', '--shots', '', '--out', SCRATCH]
exec(compile(open(os.path.join(HERE, 'build.py')).read(), 'build.py', 'exec'))

# keep only the device meshes, linked straight into the scene
DEVC = bpy.data.collections['ESP32-C6-ePaper-1.54']
keep = set(DEVC.objects)
for ob in list(bpy.data.objects):
    if ob not in keep:
        bpy.data.objects.remove(ob, do_unlink=True)
for ob in keep:
    scene.collection.objects.link(ob)
bpy.data.collections.remove(DEVC)


def flat_mat(name, color, rough, metal=0.0, coat=0.0, base_tex=None, nrm_tex=None, nrm_strength=1.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    b = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(b.outputs[0], out.inputs[0])
    b.inputs['Base Color'].default_value = (*color, 1)
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    if coat:
        b.inputs['Coat Weight'].default_value = coat
        b.inputs['Coat Roughness'].default_value = 0.1
    if base_tex:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = bpy.data.images.load(os.path.join(WEB, base_tex))
        t.extension = 'EXTEND'
        nt.links.new(t.outputs['Color'], b.inputs['Base Color'])
    if nrm_tex:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = bpy.data.images.load(os.path.join(WEB, nrm_tex))
        t.image.colorspace_settings.name = 'Non-Color'
        t.extension = 'EXTEND'
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nm.inputs['Strength'].default_value = nrm_strength
        nt.links.new(t.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], b.inputs['Normal'])
    return mat


def planar_uv(ob, u_axis, v_axis, u0, u1, v0, v1, img_wh=None, pad=0):
    me = ob.data
    uv = me.uv_layers.new(name='UV')
    ai = {'X': 0, 'Y': 1, 'Z': 2}
    for poly in me.polygons:
        for li in poly.loop_indices:
            co = me.vertices[me.loops[li].vertex_index].co
            u = (co[ai[u_axis]] - u0) / (u1 - u0)
            v = (co[ai[v_axis]] - v0) / (v1 - v0)
            if img_wh:
                w, h = img_wh
                u = (u * w + pad) / (w + 2 * pad)
                v = (v * h + pad) / (h + 2 * pad)
            uv.data[li].uv = (u, v)


# apply modifiers so UVs land on the final geometry
bpy.ops.object.select_all(action='DESELECT')
for ob in keep:
    ob.select_set(True)
bpy.context.view_layer.objects.active = next(iter(keep))
bpy.ops.object.convert(target='MESH')

repl = {
    'shell': flat_mat('Shell', (0.80, 0.80, 0.78), 0.42),
    'epaper': flat_mat('EPaper', (1, 1, 1), 0.6, coat=0.35, base_tex='screen_note.png'),
    'btn_boot': flat_mat('BtnRecord', (1, 1, 1), 0.42, base_tex='icon_gear_base.png', nrm_tex='icon_gear_nrm.png'),
    'btn_pwr': flat_mat('BtnPower', (1, 1, 1), 0.42, base_tex='icon_power_base.png', nrm_tex='icon_power_nrm.png'),
    'sd_icon': flat_mat('SDIcon', (1, 1, 1), 0.42, base_tex='icon_sd_base.png', nrm_tex='icon_sd_nrm.png', nrm_strength=0.6),
}
ICON_UV = {
    'btn_boot': ('Y', 'Z', -2.15, 2.25, -6.79, -2.39, (256, 256)),
    'btn_pwr': ('Y', 'Z', -2.15, 2.25, -17.31, -12.91, (256, 256)),
    'sd_icon': ('Y', 'Z', 1.65, 6.39, 7.35, 11.25, (256, 212)),
}
for ob in keep:
    names = [m.name.split('.')[0] for m in ob.data.materials if m]
    for key in names:
        if key == 'epaper':
            planar_uv(ob, 'X', 'Z', -13.9, 13.9, -12.2, 15.65)
        elif key in ICON_UV:
            *rng, wh = ICON_UV[key]
            planar_uv(ob, *rng, img_wh=wh, pad=8)
    for i, m in enumerate(ob.data.materials):
        if m and m.name.split('.')[0] in repl:
            ob.data.materials[i] = repl[m.name.split('.')[0]]
    # drop SSS / specular-level quirks on the remaining simple materials
    for m in ob.data.materials:
        if m and m.use_nodes:
            for n in m.node_tree.nodes:
                if n.type == 'BSDF_PRINCIPLED':
                    n.inputs['Subsurface Weight'].default_value = 0.0

# mm -> m, all into one parent so the viewer sees a single model
root = bpy.data.objects.new('paperbot', None)
scene.collection.objects.link(root)
for ob in keep:
    ob.parent = root
root.scale = (0.001, 0.001, 0.001)

tris = sum(len(p.vertices) - 2 for ob in keep for p in ob.data.polygons)
print('OBJECTS', len(keep), 'TRIS', tris)

bpy.ops.export_scene.gltf(
    filepath=OUT_GLB, export_format='GLB', use_selection=False, export_apply=True,
    export_yup=True, export_texcoords=True, export_normals=True, export_tangents=False,
    export_materials='EXPORT', export_image_format='AUTO', export_cameras=False, export_lights=False,
    export_draco_mesh_compression_enable=False,
)
print('GLB', OUT_GLB, os.path.getsize(OUT_GLB))
