#!/usr/bin/env python3
"""Pre-deploy checks for site/ (paperbot.ca). Stdlib only. Exit 1 on any failure.

  python3 tools/site/check.py            # checks the files on disk
  python3 tools/site/check.py --live URL # checks a deployed site (status codes, tags, key assets)
"""
import json, os, re, struct, sys, urllib.request

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'site')
ROOT = os.path.normpath(ROOT)
errors, notes = [], []
def fail(msg): errors.append(msg)

REQUIRED_META = ['og:title', 'og:description', 'og:image', 'og:image:width', 'og:image:height', 'og:image:alt',
                 'og:url', 'twitter:card', 'twitter:image']

def meta(html):
    out = {}
    for m in re.finditer(r'<meta\s+(?:property|name)="([^"]+)"\s+content="([^"]*)"', html):
        out[m.group(1)] = m.group(2)
    return out

def jpeg_size(data):
    i = 2
    while i < len(data):
        if data[i] != 0xFF: i += 1; continue
        marker = data[i + 1]
        if marker in (0xC0, 0xC1, 0xC2):
            h, w = struct.unpack('>HH', data[i + 5:i + 9]); return w, h
        i += 2 + struct.unpack('>H', data[i + 2:i + 4])[0]
    return None

def ignored():
    pats = [l.strip() for l in open(os.path.join(ROOT, '.assetsignore')) if l.strip() and not l.startswith('#')]
    return pats

def check_local():
    html = open(os.path.join(ROOT, 'index.html')).read()
    css = open(os.path.join(ROOT, 'style.css')).read()
    js = open(os.path.join(ROOT, 'main.js')).read() + open(os.path.join(ROOT, 'screen.js')).read()
    # every local file the page references must exist and must not be excluded from the upload
    refs = set(re.findall(r'(?:src|href|poster)="([^"#:]+)"', html))
    refs |= set(re.findall(r'url\("?([^")#:]+)"?\)', css))
    refs |= {f'assets/bolt/{n}.png' for n in re.findall(r"'((?:work|done)-[a-z0-9]+|rec|sending|tooshort|ready)'", js)}
    refs |= {'vendor/meshopt_decoder.js', 'screen.js'}
    for r in sorted(refs):
        p = os.path.normpath(os.path.join(ROOT, r.lstrip('/')))
        if r.startswith('/') and not os.path.splitext(r)[1]: p += '.html'  # /privacy -> privacy.html (how Cloudflare serves pages)
        if not os.path.isfile(p): fail(f'missing file referenced by the page: {r}')
        if any(r.startswith(x.rstrip('*/')) for x in ignored()): fail(f'{r} is referenced but excluded by .assetsignore')
    # memos in main.js need both screens
    for f in re.findall(r"frame: '([a-z0-9]+)'", js):
        for k in ('work', 'done'):
            if not os.path.isfile(os.path.join(ROOT, f'assets/bolt/{k}-{f}.png')): fail(f'missing demo screen assets/bolt/{k}-{f}.png')
    # link preview tags + image
    m = meta(html)
    for k in REQUIRED_META:
        if not m.get(k): fail(f'missing <meta> {k}')
    img = m.get('og:image', '')
    if img and not img.startswith('https://'): fail('og:image must be an absolute https:// URL')
    local = os.path.join(ROOT, img.split('paperbot.ca/', 1)[-1]) if img else ''
    if img and not os.path.isfile(local): fail(f'og:image file not found: {local}')
    elif img:
        data = open(local, 'rb').read()
        if len(data) > 300 * 1024: fail(f'og:image is {len(data)//1024} KB; WhatsApp drops images over ~300 KB')
        size = jpeg_size(data) if data[:2] == b'\xff\xd8' else None
        if size and size != (int(m.get('og:image:width', 0)), int(m.get('og:image:height', 0))):
            fail(f'og:image is {size[0]}x{size[1]} but the tags say {m.get("og:image:width")}x{m.get("og:image:height")}')
    # upload size (Workers static assets: 25 MiB per file)
    total = 0
    for d, _, files in os.walk(ROOT):
        rel = os.path.relpath(d, ROOT)
        if rel.split(os.sep)[0] in ('concepts',): continue
        for f in files:
            s = os.path.getsize(os.path.join(d, f)); total += s
            if s > 25 * 1024 * 1024: fail(f'{os.path.join(rel, f)} is over 25 MiB')
    notes.append(f'upload ≈ {total / 1024 / 1024:.1f} MB')

def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'paperbot-site-check'})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.status, r.headers, r.read()

def check_live(base):
    base = base.rstrip('/')
    try:
        st, h, body = get(base + '/')
    except Exception as e:
        fail(f'{base}/ unreachable: {e}'); return
    if st != 200: fail(f'{base}/ returned {st}')
    html = body.decode('utf-8', 'replace'); m = meta(html)
    for k in REQUIRED_META:
        if not m.get(k): fail(f'live page missing <meta> {k}')
    paths = ['assets/paperbot.glb', 'vendor/model-viewer.min.js', 'vendor/meshopt_decoder.js', 'main.js', 'style.css']
    if m.get('og:image'): paths.append(m['og:image'].split('paperbot.ca/', 1)[-1])
    for p in paths:
        try:
            st, h, _ = get(f'{base}/{p}')
            if st != 200: fail(f'{p} returned {st}')
        except Exception as e:
            fail(f'{p}: {e}')
    try:
        st, _, _ = get(base + '/concepts/index.html'); fail('concepts/ is publicly reachable (should be excluded)')
    except Exception:
        pass
    notes.append(f'live: {base}/ ok, title "{m.get("og:title", "")}"')

if __name__ == '__main__':
    if '--live' in sys.argv: check_live(sys.argv[sys.argv.index('--live') + 1])
    else: check_local()
    for n in notes: print('·', n)
    for e in errors: print('✗', e)
    print('✓ site check passed' if not errors else f'{len(errors)} problem(s)')
    sys.exit(1 if errors else 0)
