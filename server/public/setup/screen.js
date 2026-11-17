// Shared by the concept pages: put a real Bolt frame (1-bit, from the simulator) on the 3D device's e-paper.
const INK = '#2c2c2e', PAPER = '#ced0cb';
const GLYPHS = {
  0: '01110100011001110101110011000101110', 1: '00100011000010000100001000010001110',
  2: '01110100010000100010001000100011111', 3: '11111000100010000010000011000101110',
  4: '00010001100101010010111110001000010', 5: '11111100001111000001000011000101110',
  6: '00110010001000011110100011000101110', 7: '11111000010001000100010000100001000',
  8: '01110100011000101110100011000101110', 9: '01110100011000101111000010001001100',
  s: '00000000000111010000011100000111110',
};

export function screen(mv, base = new URL('./assets/bolt/', import.meta.url).href) {
  const frames = {}, cache = {};
  const small = Object.assign(document.createElement('canvas'), { width: 200, height: 200 });
  const big = Object.assign(document.createElement('canvas'), { width: 1000, height: 1000 });
  let mat = null, req = 0, pending = ['note'];
  const load = (n) => frames[n] ??= new Promise((res, rej) => {
    const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = base + n + '.png';
  });
  function timer(ctx, secs) {
    const text = `${Math.min(secs, 99)}s`;
    ctx.fillStyle = '#fff'; ctx.fillRect(66, 140, 70, 34); ctx.fillStyle = '#000';
    let x = Math.round(100 - (text.length * 24 - 4) / 2);
    for (const ch of text) {
      const g = GLYPHS[ch];
      for (let i = 0; i < 35; i++) if (g[i] === '1') ctx.fillRect(x + (i % 5) * 4, 144 + Math.floor(i / 5) * 4, 4, 4);
      x += 24;
    }
  }
  async function render(name, secs, invert) {
    const key = secs == null ? name + (invert ? ':inv' : '') : null;
    if (key && cache[key]) return cache[key];
    const im = await load(name);
    const s = small.getContext('2d');
    s.globalCompositeOperation = 'source-over';
    s.drawImage(im, 0, 0, 200, 200);
    if (secs != null) timer(s, secs);
    if (invert) { s.globalCompositeOperation = 'difference'; s.fillStyle = '#fff'; s.fillRect(0, 0, 200, 200); s.globalCompositeOperation = 'source-over'; }
    const b = big.getContext('2d');
    b.save();
    b.imageSmoothingEnabled = false;
    b.filter = 'blur(1.1px)';
    b.drawImage(small, 0, 0, 1000, 1000);
    b.filter = 'none';
    b.globalCompositeOperation = 'multiply'; b.fillStyle = PAPER; b.fillRect(0, 0, 1000, 1000);
    b.globalCompositeOperation = 'lighten'; b.fillStyle = INK; b.fillRect(0, 0, 1000, 1000);
    b.restore();
    const tex = mv.createTexture(big.toDataURL('image/png'));
    if (key) cache[key] = tex;
    return tex;
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // show(name) | show(name, seconds) for the REC timer | show(name, { flash: true }) for an e-paper style refresh
  async function show(name, opt) {
    const r = ++req;
    const secs = typeof opt === 'number' ? opt : null;
    const flash = opt && opt.flash && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!mat) { pending = [name, opt]; return; }
    if (flash) {
      const inv = await render(name, null, true);
      if (r !== req) return;
      mat.pbrMetallicRoughness.baseColorTexture.setTexture(inv);
      await wait(140);
      if (r !== req) return;
    }
    const t = await render(name, secs, false);
    if (r === req) mat.pbrMetallicRoughness.baseColorTexture.setTexture(t);
  }
  // ready: resolves once the model is in and its first screen is on (used to swap out the placeholder image)
  let markReady;
  const ready = new Promise((r) => (markReady = r));
  mv.addEventListener('load', async () => {
    mat = mv.model.materials.find((m) => m.name === 'EPaper');
    await show(...pending);
    markReady();
  });
  return { show, ready, preload: (names) => names.forEach(load) };
}

// press-and-hold on an element: pointer, or Enter/Space while the element itself has focus (never page-wide,
// so the space bar keeps scrolling the page). onStart(), onTick(seconds), onEnd(heldMs)
export function holdable(el, { onStart, onTick, onEnd }) {
  let t0 = 0, iv = 0, down = false;
  const start = () => {
    if (down) return; down = true; t0 = performance.now(); el.classList.add('down'); onStart?.();
    iv = setInterval(() => onTick?.(Math.floor((performance.now() - t0) / 1000), performance.now() - t0), 100);
  };
  const end = () => { if (!down) return; down = false; clearInterval(iv); el.classList.remove('down'); onEnd?.(performance.now() - t0); };
  el.addEventListener('pointerdown', (e) => { e.preventDefault(); el.setPointerCapture(e.pointerId); start(); });
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('contextmenu', (e) => e.preventDefault());
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (!e.repeat) start(); } });
  el.addEventListener('keyup', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); end(); } });
  el.addEventListener('blur', end);
  addEventListener('blur', end);
}

let audio;
export function beep() {
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain(), t = audio.currentTime;
    o.type = 'square'; o.frequency.value = 1320;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.04, t + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    o.connect(g).connect(audio.destination); o.start(t); o.stop(t + 0.1);
  } catch {}
}
