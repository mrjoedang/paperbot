# Sets the USBCable node's rest pose to hidden (scale ~0) in a GLB, so the viewer frames and shadows the device alone.
# python3 rest_hidden.py IN.glb OUT.glb
import json, struct, sys
b = open(sys.argv[1], 'rb').read()
n = struct.unpack('<I', b[12:16])[0]
j = json.loads(b[20:20 + n])
rest = b[20 + n:]
for nd in j['nodes']:
    if nd.get('name') == 'USBCable':
        nd['scale'] = [0.001, 0.001, 0.001]
s = json.dumps(j, separators=(',', ':')).encode()
s += b' ' * ((4 - len(s) % 4) % 4)
out = struct.pack('<I', len(s)) + b'JSON' + s + rest
open(sys.argv[2], 'wb').write(b[:8] + struct.pack('<I', 12 + len(out)) + out)
