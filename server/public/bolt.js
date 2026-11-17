// Bolt + the device screen, in 1-bit. A port of design/bolt-variations.html (bitmap class) and
// firmware/core/src/pv_gfx.cpp + pv_bolt.cpp (parametric Bolt, 5x7 font, 16x16 icons), plus a few
// web-only expressions (listening, scanning visor, hearts, dizzy).

const FONT_HEX = "000000000000005f00000007000700147f147f14242a7f2a12231308646236495620500000070000001c2241000041221c0014083e081408083e080800503000000808080808006060000020100804023e5149453e00427f400042615149462141454b311814127f1027454545393c4a49493001710905033649494936064949291e003636000000563600000814224100141414141400412214080201510906324979413e7e1111117e7f494949363e414141227f4141221c7f494949417f090909013e4149497a7f0808087f00417f41002040413f017f081422417f404040407f020c027f7f0408107f3e4141413e7f090909063e4151215e7f09192946464949493101017f01013f4040403f1f2040201f3f4038403f631408146307087008076151494543007f41410002040810200041417f0004020102044040404040000102040020545454787f484444383844444420384444487f3854545418087e0901020c5252523e7f0804047800447d40002040443d007f1028440000417f40007c041804787c0804047838444444387c14141408081414187c7c080404084854545420043f4440203c4040207c1c2040201c3c4030403c44281028440c5050503c4464544c44000836410000007f000000413608000804081008";
const FONT = new Uint8Array(FONT_HEX.length / 2);
for (let i = 0; i < FONT.length; i++) FONT[i] = parseInt(FONT_HEX.substr(i * 2, 2), 16);

/** ASCII fold like the firmware: accents dropped, smart quotes/dashes mapped, anything else "?". */
export function fold(s) {
  return String(s ?? "")
    .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2013\u2014]/g, "-").replace(/\u2026/g, "...")
    .replace(/[\r\n\t]/g, " ").replace(/[^\x20-\x7e]/g, "?");
}

export class B {
  constructor(w = 200, h = 200) { this.w = w; this.h = h; this.d = new Uint8Array(w * h); }
  px(x, y, c = 1) { x = Math.floor(x); y = Math.floor(y); if (x < 0 || y < 0 || x >= this.w || y >= this.h) return; this.d[y * this.w + x] = c; }
  get(x, y) { return x < 0 || y < 0 || x >= this.w || y >= this.h ? 0 : this.d[y * this.w + x]; }
  rect(x, y, w, h, c = 1) { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.px(x + i, y + j, c); }
  frame(x, y, w, h, t = 1, c = 1) { this.rect(x, y, w, t, c); this.rect(x, y + h - t, w, t, c); this.rect(x, y, t, h, c); this.rect(x + w - t, y, t, h, c); }
  inRR(px, py, x, y, w, h, r) {
    if (px < x || py < y || px >= x + w || py >= y + h) return false;
    const cx = px < x + r ? x + r : px >= x + w - r ? x + w - r : px, cy = py < y + r ? y + r : py >= y + h - r ? y + h - r : py;
    const dx = px + 0.5 - cx, dy = py + 0.5 - cy;
    return cx === px || cy === py || dx * dx + dy * dy <= r * r;
  }
  rrect(x, y, w, h, r, c = 1) { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) if (this.inRR(i, j, x, y, w, h, r)) this.px(i, j, c); }
  rframe(x, y, w, h, r, t = 2, c = 1) {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++)
      if (this.inRR(i, j, x, y, w, h, r) && !this.inRR(i, j, x + t, y + t, w - 2 * t, h - 2 * t, Math.max(0, r - t))) this.px(i, j, c);
  }
  line(x0, y0, x1, y1, t = 1, c = 1) {
    x0 = Math.round(x0); y0 = Math.round(y0); x1 = Math.round(x1); y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let e = dx + dy; const o = Math.floor((t - 1) / 2);
    for (;;) { this.rect(x0 - o, y0 - o, t, t, c); if (x0 === x1 && y0 === y1) break; const e2 = 2 * e; if (e2 >= dy) { e += dy; x0 += sx; } if (e2 <= dx) { e += dx; y0 += sy; } }
  }
  ellipse(cx, cy, rx, ry, c = 1) {
    for (let y = Math.floor(cy - ry - 1); y <= cy + ry + 1; y++) for (let x = Math.floor(cx - rx - 1); x <= cx + rx + 1; x++) {
      const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry; if (dx * dx + dy * dy <= 1) this.px(x, y, c);
    }
  }
  circle(cx, cy, r, c = 1) { this.ellipse(cx, cy, r, r, c); }
  ring(cx, cy, r, t, c = 1, a0 = 0, a1 = 360) {
    for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy, d = Math.hypot(dx, dy); if (d > r || d < r - t) continue;
      if (a0 !== 0 || a1 !== 360) { let a = (Math.atan2(dy, dx) * 180) / Math.PI; if (a < 0) a += 360; if (a0 <= a1 ? a < a0 || a > a1 : a < a0 && a > a1) continue; }
      this.px(x, y, c);
    }
  }
  poly(pts, c = 1) {
    let y0 = Infinity, y1 = -Infinity; for (const p of pts) { y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
    for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
      const yc = y + 0.5, xs = [];
      for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; if ((a[1] <= yc && b[1] > yc) || (b[1] <= yc && a[1] > yc)) xs.push(a[0] + ((yc - a[1]) / (b[1] - a[1])) * (b[0] - a[0])); }
      xs.sort((p, q) => p - q); for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.ceil(xs[k] - 0.5); x < xs[k + 1] - 0.5; x++) this.px(x, y, c);
    }
  }
  invert(x, y, w, h) { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.px(i, j, this.get(i, j) ? 0 : 1); }
  blit(src, x, y, s = 1, c = 1) { for (let j = 0; j < src.h; j++) for (let i = 0; i < src.w; i++) if (src.d[j * src.w + i]) this.rect(x + i * s, y + j * s, s, s, c); }
  text(str, x, y, s = 1, c = 1) {
    let cx = x;
    for (const ch of fold(str)) {
      let k = ch.charCodeAt(0); if (k < 32 || k > 126) k = 63;
      for (let col = 0; col < 5; col++) { const bits = FONT[(k - 32) * 5 + col]; for (let r = 0; r < 8; r++) if (bits & (1 << r)) this.rect(cx + col * s, y + r * s, s, s, c); }
      cx += 6 * s;
    }
    return cx - x - s;
  }
  ctext(str, y, s = 1, c = 1, cx = this.w / 2) { return this.text(str, Math.round(cx - tw(str, s) / 2), y, s, c); }
}
export const tw = (s, k = 1) => { const n = fold(s).length; return n ? n * 6 * k - k : -k; };

// ---------- 16x16 icons (device set + web extras) ----------
const mk = (w, h, fn) => { const b = new B(w, h); fn(b); return b; };
const grid = (rows) => mk(16, 16, (b) => rows.forEach((r, j) => [...r].forEach((ch, i) => ch === "#" && b.px(i, j))));
const ICONS = {
  list: mk(16, 16, (b) => { for (const y of [2, 7, 12]) { b.rect(1, y, 2, 2); b.rect(5, y, 10, 2); } }),
  inbox: mk(16, 16, (b) => { b.frame(0, 2, 16, 12, 2); b.rect(2, 7, 3, 2); b.rect(11, 7, 3, 2); b.rect(5, 7, 2, 4); b.rect(9, 7, 2, 4); b.rect(5, 10, 6, 2); }),
  todo: mk(16, 16, (b) => { b.frame(0, 0, 16, 16, 2); b.line(3, 7, 6, 10, 2); b.line(6, 10, 11, 4, 2); }),
  box: mk(16, 16, (b) => b.frame(0, 0, 16, 16, 2)),
  reminder: mk(16, 16, (b) => { b.ring(8, 9.5, 6.5, 2); b.rect(7, 5, 2, 5); b.rect(7, 8, 4, 2); b.ellipse(2.5, 2.5, 2.5, 2.5); b.ellipse(13.5, 2.5, 2.5, 2.5); }),
  work: mk(16, 16, (b) => { b.frame(0, 1, 16, 14, 2); b.rect(0, 1, 16, 4); b.line(3, 7, 5, 9, 2); b.line(5, 9, 3, 11, 2); b.rect(8, 11, 5, 2); }),
  note: mk(16, 16, (b) => { b.line(2, 0, 9, 0, 2); b.line(9, 0, 13, 4, 2); b.line(13, 4, 13, 14, 2); b.line(2, 14, 13, 14, 2); b.line(2, 0, 2, 14, 2); b.line(9, 0, 9, 4, 1); b.line(9, 4, 13, 4, 1); b.rect(5, 7, 6, 1); b.rect(5, 10, 6, 1); }),
  cloud: mk(16, 16, (b) => { b.ellipse(5, 9.5, 4, 3.5); b.ellipse(9.5, 7, 4.5, 4.5); b.ellipse(13, 10, 3, 3); b.rect(4, 9, 10, 4); }),
  check: mk(16, 16, (b) => { b.line(2, 8, 6, 12, 3); b.line(6, 12, 13, 3, 3); }),
  sd: mk(16, 16, (b) => { b.poly([[4, 0], [14, 0], [14, 16], [2, 16], [2, 2]]); for (const x of [6, 8, 10, 12]) b.rect(x, 2, 1, 4, 0); }),
  batt0: mk(16, 16, (b) => { b.frame(0, 4, 14, 9, 2); b.rect(14, 6, 2, 5); }),
  sun: grid([".......##.......", ".......##.......", "..##.......##...", "..###.....###...", "...#.......#....", "......####......", ".....######.....", "###..######..###",
    "###..######..###", ".....######.....", "......####......", "...#.......#....", "..###.....###...", "..##.......##...", ".......##.......", ".......##......."]),
  power: grid([".......##.......", ".......##.......", "...##..##..##...", "..##...##...##..", ".##....##....##.", ".##....##....##.", "##.....##.....##", "##............##",
    "##............##", "##............##", ".##..........##.", ".##..........##.", "..##........##..", "...###....###...", ".....######.....", "................"]),
  unsure: grid(["..##########....", "..#.......#.#...", "..#.......#..#..", "..#.......####..", "..#....###...#..", "..#...#...#..#..", "..#.......#..#..", "..#......#...#..",
    "..#.....#....#..", "..#.....#....#..", "..#..........#..", "..#.....#....#..", "..#..........#..", "..############..", "................", "................"]),
  noise: grid(["................", "................", "..........#.....", "......#...#.....", "......#..##.....", "..#..##..#.#....", "..#..#.#.#.#..#.", "#.#.#..#.#.#..#.",
    ".#.#...#.#..#.#.", ".#.#...##...##..", ".....#.##.......", "......##........", ".....#.#........", "....#...........", "................", "................"]),
  archive: grid(["################", "#..............#", "################", ".#............#.", ".#............#.", ".#...######...#.", ".#............#.", ".#............#.",
    ".#............#.", ".#............#.", ".#............#.", ".##############.", "................", "................", "................", "................"]),
  unarchive: grid(["................", "......##........", ".....####.......", "....##.###......", ".......##.......", "################", "#..............#", "################",
    ".#............#.", ".#...######...#.", ".#............#.", ".#............#.", ".#............#.", ".##############.", "................", "................"]),
  redo: grid(["................", ".....######.#...", "....##....####..", "...##......###..", "..##......####..", "..#.............", "..#.............", "..#.............",
    "..#.............", "..##........##..", "...##......##...", "....##....##....", ".....######.....", "................", "................", "................"]),
  pencil: grid(["................", "...........##...", "..........#..#..", ".........#....#.", "........#....#..", ".......#....#...", "......#....#....", ".....#....#.....",
    "....#....#......", "...#....#.......", "..###..#........", "..#.###.........", "..##.#..........", "..###...........", "................", "................"]),
  play: grid(["................", "................", "...##...........", "...####.........", "...######.......", "...########.....", "...##########...", "...###########..",
    "...###########..", "...##########...", "...########.....", "...######.......", "...####.........", "...##...........", "................", "................"]),
  pause: grid(["................", "................", "...####..####...", "...####..####...", "...####..####...", "...####..####...", "...####..####...", "...####..####...",
    "...####..####...", "...####..####...", "...####..####...", "...####..####...", "...####..####...", "...####..####...", "................", "................"]),
  search: grid(["................", "....#####.......", "...#.....#......", "..#.......#.....", "..#.......#.....", "..#.......#.....", "..#.......#.....", "...#.....#......",
    "....######......", "........###.....", ".........###....", "..........###...", "...........###..", "............##..", "................", "................"]),
  moon: grid(["................", ".....####.......", "...###..........", "..###...........", "..##............", ".###............", ".###............", ".###............",
    ".###.........#..", ".####.......##..", "..####....###...", "..#########.....", "....######......", "................", "................", "................"]),
  auto: grid(["................", ".....######.....", "...##.....###...", "..#.......####..", "..#.......####..", ".#........#####.", ".#........#####.", ".#........#####.",
    ".#........#####.", ".#........#####.", "..#.......####..", "..#.......####..", "...##.....###...", ".....######.....", "................", "................"]),
  help: grid(["................", ".....######.....", "....##....##....", "...##......##...", "...........##...", "..........##....", ".........##.....", "........##......",
    ".......##.......", ".......##.......", "................", ".......##.......", ".......##.......", "................", "................", "................"]),
  bolt: mk(16, 16, (b) => { b.rframe(1, 4, 14, 11, 2, 2); b.rect(7, 1, 2, 3); b.rect(5, 8, 2, 3); b.rect(9, 8, 2, 3); b.rect(0, 7, 1, 4); b.rect(15, 7, 1, 4); }),
  plug: grid(["................", ".....#....#.....", ".....#....#.....", ".....#....#.....", "...##########...", "...#........#...", "...#...#....#...", "...#..##....#...",
    "...#.####...#...", "...#...##...#...", "....#..#...#....", ".....######.....", ".......##.......", ".......##.......", ".......##.......", "................"]),
  wifi: grid(["................", "................", "....########....", "..##........##..", ".#............#.", "#....######....#", "...##......##...", "..#..........#..",
    ".....######.....", "....#......#....", "................", ".......##.......", "......####......", ".......##.......", "................", "................"]),
  alert: grid([".......##.......", "......####......", "......#..#......", ".....##..##.....", ".....#....#.....", "....##.##.##....", "....#..##..#....", "...##..##..##...",
    "...#...##...#...", "..##...##...##..", "..#..........#..", ".##....##....##.", ".#.....##.....#.", "################", "................", "................"]),
  log: grid(["################", "#..............#", "#.##.#####.....#", "#..............#", "#.##.######....#", "#..............#", "#.##.####......#", "#..............#",
    "#.##.#######...#", "#..............#", "#.##.###.......#", "#..............#", "################", "................", "................", "................"]),
  close: grid(["................", "................", "..##.......##...", "...##.....##....", "....##...##.....", ".....##.##......", "......###.......", ".....##.##......",
    "....##...##.....", "...##.....##....", "..##.......##...", "................", "................", "................", "................", "................"]),
};
ICONS.cloudx = mk(16, 16, (b) => { b.blit(ICONS.cloud, 0, 0); b.line(1, 1, 14, 14, 3, 0); b.line(1, 0, 15, 14, 1, 1); });
export const ICON_NAMES = Object.keys(ICONS);

/** A 16x16 icon as crisp inline SVG (fill = currentColor, so it follows the theme). */
export function iconSVG(name, size = 16, title = "") {
  const b = ICONS[name] ?? ICONS.note;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${b.w} ${b.h}`);
  svg.setAttribute("width", size); svg.setAttribute("height", size);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("class", "px-icon");
  if (title) { svg.setAttribute("role", "img"); svg.setAttribute("aria-label", title); } else svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", bitmapPath(b));
  path.setAttribute("fill", "currentColor");
  svg.appendChild(path);
  return svg;
}
/** Bitmap -> SVG path of horizontal runs. */
export function bitmapPath(b) {
  let d = "";
  for (let y = 0; y < b.h; y++) for (let x = 0; x < b.w; x++) {
    if (!b.d[y * b.w + x]) continue;
    let e = x; while (e < b.w && b.d[y * b.w + e]) e++;
    d += `M${x} ${y}h${e - x}v1h${x - e}z`; x = e;
  }
  return d;
}
export function textSVG(str, scale = 1, title = str) {
  const b = new B(Math.max(1, tw(str, 1)), 8); b.text(str, 0, 0, 1);
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${b.w} ${b.h}`);
  svg.setAttribute("width", b.w * scale); svg.setAttribute("height", b.h * scale);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img"); svg.setAttribute("aria-label", title);
  const p = document.createElementNS(NS, "path"); p.setAttribute("d", bitmapPath(b)); p.setAttribute("fill", "currentColor"); svg.appendChild(p);
  return svg;
}
export function icon(b, name, x, y, s = 1, c = 1) { b.blit(ICONS[name] ?? ICONS.note, x, y, s, c); }

// ---------- Bolt (parametric head of firmware/core/src/pv_bolt.cpp) ----------
const R_ = (v) => Math.floor(v + 0.5);

function antTop(b, k, cx, cy, r, f) {
  if (k === "ball") b.circle(cx, cy, r);
  else if (k === "hollow") b.ring(cx, cy, r, 2);
  else if (k === "blink") { if (f % 2 === 0) b.circle(cx, cy, r); else b.ring(cx, cy, r, 2); }
  else if (k === "signal" || k === "scan") {
    b.circle(cx, cy, r);
    const n = 1 + (f % 3);
    for (let i = 0; i < n; i++) { const rr = r + 6 + i * 5; b.ring(cx, cy, rr, 2, 1, 140, 220); b.ring(cx, cy, rr, 2, 1, 320, 40); }
  } else if (k === "bulb" || k === "bulb-on") {
    b.ring(cx, cy - 1, r + 1, 2);
    if (k === "bulb-on") b.circle(cx, cy - 1, r - 1);
    b.rect(R_(cx - r * 0.6), R_(cy + r), R_(r * 1.2), 3);
    for (let s = -1; s <= 1; s += 2) { b.line(cx + s * (r + 4), cy - r, cx + s * (r + 7), cy - r - 3, 1); b.line(cx + s * (r + 4), cy + 1, cx + s * (r + 8), cy + 1, 1); }
  } else if (k === "?") b.text("?", R_(cx - 5), R_(cy - 8), 2);
  else if (k === "heart") heart(b, cx, cy - 2, r + 2);
}
function heart(b, cx, cy, r) {
  b.circle(cx - r * 0.5, cy - r * 0.15, r * 0.55); b.circle(cx + r * 0.5, cy - r * 0.15, r * 0.55);
  b.poly([[cx - r * 1.04, cy], [cx + r * 1.04, cy], [cx, cy + r * 1.05]]);
}
function eyeRound(b, k, cx, cy, R, f, side) {
  const t = Math.max(2, R_(R / 3.5));
  switch (k) {
    case "sleep": b.rect(R_(cx - R), R_(cy + 1), R_(2 * R), t); break;
    case "open": case "blinky":
      if (k === "blinky" && f % 7 === 6) { b.rect(R_(cx - R), R_(cy + 1), R_(2 * R), t); break; }
      b.ellipse(cx, cy, R * 0.75, R * 0.95); { const h = Math.max(2, R_(R * 0.28)); b.rect(R_(cx + R * 0.1), R_(cy - R * 0.6), h, h, 0); } break;
    case "wide": b.circle(cx, cy, R + 1); b.circle(cx + R * 0.35, cy - R * 0.35, Math.max(1.5, R * 0.28), 0); break;
    case "look": { b.ring(cx, cy, R + 1, t); const DX = [-1, 0, 1, 0]; b.circle(cx + DX[f % 4] * R * 0.35, cy - R * 0.35, R * 0.42); break; }
    case "happy": b.ring(cx, cy + R * 0.45, R, Math.max(3, R * 0.36), 1, 180, 360); break;
    case "sad": b.circle(cx, cy + R * 0.3, R * 0.62);
      if (side < 0) b.line(cx - R, cy - R * 0.7, cx + R * 0.6, cy - R * 1.25, t); else b.line(cx - R * 0.6, cy - R * 1.25, cx + R, cy - R * 0.7, t); break;
    case "small": b.circle(cx, cy, Math.max(2, R * 0.36)); b.line(cx - R * 0.7, cy - R * 1.15, cx + R * 0.7, cy - R * 1.5, t); break;
    case "x": { const a = R * 0.7; b.line(cx - a, cy - a, cx + a, cy + a, t); b.line(cx - a, cy + a, cx + a, cy - a, t); break; }
    case "heart": heart(b, cx, cy, R * 0.95); break;
    case "spiral": b.ring(cx, cy, R, t); b.ring(cx, cy, R * 0.45, Math.max(2, t - 1)); b.rect(R_(cx + (f % 2 ? -R : R * 0.45)), R_(cy - 1), R_(R * 0.55), 2, 0); break;
  }
}
function visorBox(b, L, Rr, cy, R, scan) {
  const x0 = R_(L - R * 1.9), w = R_(Rr - L + R * 3.8), h = R_(R * 2.2);
  b.rrect(x0, R_(cy - h / 2), w, h, 4);
  const sw = R_(R * 2), sh = Math.max(3, R_(R * 0.6));
  b.rect(R_(L - R), R_(cy - sh / 2), sw, sh, 0);
  b.rect(R_(Rr - R), R_(cy - sh / 2), sw, sh, 0);
  if (scan != null) { // web-only: a bright slit sweeping the visor while researching
    const span = w - 12, p = scan % (2 * span), x = x0 + 6 + (p < span ? p : 2 * span - p);
    b.invert(R_(x), R_(cy - h / 2) + 2, 4, h - 4);
  }
}
function mouthRound(b, k, cx, cy, W, f) {
  const t = Math.max(2, R_(W / 4));
  if (k === "talk") k = f % 2 ? "o" : "O";
  cy = R_(cy);
  switch (k) {
    case "small": b.rect(R_(cx - W / 2), cy, R_(W), t); break;
    case "flat": b.rect(R_(cx - W), cy, R_(2 * W), t); break;
    case "o": b.ellipse(cx, cy + 1, W * 0.5, W * 0.42); break;
    case "O": b.ellipse(cx, cy, W * 0.92, W * 0.75); break;
    case "smile": b.ring(cx, cy - W * 0.9, W * 1.45, t, 1, 25, 155); break;
    case "grin": b.ring(cx, cy - W * 0.9, W * 1.45, t, 1, 25, 155); b.rect(R_(cx - W * 0.9), R_(cy + W * 0.25), R_(W * 1.8), t); break;
    case "frown": b.ring(cx, cy + W * 1.15, W * 1.1, t, 1, 210, 330); break;
    case "zig": { const tt = Math.max(2, t - 1); for (let i = 0; i < 6; i++) b.line(cx - W * 1.2 + i * W * 0.4, cy + (i % 2 ? -W * 0.35 : 0), cx - W * 1.2 + (i + 1) * W * 0.4, cy + ((i + 1) % 2 ? -W * 0.35 : 0), tt); break; }
  }
}
/** Bolt's head at (x, y, w, h). ex = {eyes, mouth, ant}; f = animation frame. */
export function boxBot(b, x, y, w, h, ex, f = 0) {
  const k = w / 120, cx = x + w / 2, t = Math.max(2, R_(3 * k));
  b.rframe(x, y, w, h, R_(14 * k), t);
  const ew = Math.max(3, R_(7 * k)), eh = R_(h * 0.4);
  b.rect(x - ew, R_(y + h * 0.3), ew, eh); b.rect(x + w, R_(y + h * 0.3), ew, eh);
  const sl = R_(12 * k), ar = Math.max(2.5, 5 * k), sw = Math.max(2, R_(4 * k));
  b.rect(R_(cx - sw / 2), y - sl, sw, sl);
  antTop(b, ex.ant, cx, y - sl - ar + 1, ar, f);
  const L = x + w * 0.3, Rr = x + w * 0.7, ey = y + h * 0.4, R = w * 0.09;
  if (ex.eyes === "visor") visorBox(b, L, Rr, ey, R, ex.scan ? f * 3 : null);
  else {
    let a = ex.eyes, z = ex.eyes;
    if (ex.eyes === "wink") { a = "happy"; z = "open"; }
    else if (ex.eyes === "confused") { a = "wide"; z = "small"; }
    eyeRound(b, a, L, ey, R, f, -1); eyeRound(b, z, Rr, ey, R, f, 1);
  }
  mouthRound(b, ex.mouth, cx, y + h * 0.76, w * 0.1, f);
}

/** Moods of the web Bolt (what the whole system is doing). */
export const MOODS = {
  sleep: { eyes: "sleep", mouth: "small", ant: "ball" },
  awake: { eyes: "blinky", mouth: "smile", ant: "ball" },
  listen: { eyes: "wide", mouth: "talk", ant: "blink" },
  think: { eyes: "look", mouth: "small", ant: "signal" },
  happy: { eyes: "happy", mouth: "smile", ant: "ball" },
  wink: { eyes: "wink", mouth: "smile", ant: "ball" },
  idea: { eyes: "happy", mouth: "grin", ant: "bulb-on" },
  research: { eyes: "visor", mouth: "flat", ant: "scan", scan: true },
  confused: { eyes: "confused", mouth: "zig", ant: "?" },
  unsure: { eyes: "open", mouth: "flat", ant: "?" },
  sad: { eyes: "sad", mouth: "frown", ant: "hollow" },
  error: { eyes: "x", mouth: "zig", ant: "hollow" },
  love: { eyes: "heart", mouth: "grin", ant: "heart" },
  dizzy: { eyes: "spiral", mouth: "zig", ant: "?" },
  paused: { eyes: "small", mouth: "flat", ant: "hollow" },
};

/** The hero Bolt: 240x136 bitmap with flourishes around the head. */
export function drawHero(mood, f) {
  const b = new B(240, 136);
  const ex = MOODS[mood] ?? MOODS.awake;
  boxBot(b, 60, 38, 120, 86, ex, f);
  if (mood === "sleep") { // drifting zzz
    const z = Math.floor(f / 2) % 3;
    b.text("z", 190, 34 - z * 2, 1); b.text("z", 198, 24 - z * 2, 2); b.text("Z", 212, 10 - z * 2, 2);
  }
  if (mood === "listen") { // sound-wave ears
    for (let i = 0; i < 3; i++) {
      const r = 10 + i * 7 + (f % 2) * 3;
      if (i <= f % 3 + 1) { b.ring(44, 72, r, 2, 1, 150, 210); b.ring(196, 72, r, 2, 1, 330, 30); }
    }
  }
  if (mood === "think") { const n = f % 4; for (let i = 0; i < n; i++) b.circle(196 + i * 9, 30 - i * 6, 2 + i * 0.6); }
  if (mood === "happy" || mood === "idea" || mood === "wink" || mood === "love") { // sparkles
    const S = [[30, 30], [206, 44], [24, 104], [214, 112]];
    S.forEach(([x, y], i) => { if ((f + i) % 3 !== 0) { b.rect(x - 4, y, 9, 1); b.rect(x, y - 4, 1, 9); b.rect(x - 1, y - 1, 3, 3); } });
  }
  if (mood === "dizzy") { for (let i = 0; i < 4; i++) { const a = (f * 0.7 + (i * Math.PI) / 2), x = 120 + Math.cos(a) * 70, y = 20 + Math.sin(a) * 9; b.rect(R_(x) - 2, R_(y), 5, 1); b.rect(R_(x), R_(y) - 2, 1, 5); } }
  if (mood === "error") { b.text("!", 196, 30, 2); }
  if (mood === "sad") { const y = 96 + (f % 4) * 3; b.poly([[52, y - 6], [49, y], [55, y]]); b.circle(52, y + 1, 3); }
  return b;
}

// ---------- device screen mirror (firmware render(): Bolt head + status row + text area) ----------
const EXPR = {
  Ready: MOODS.sleep, Sending: { eyes: "look", mouth: "small", ant: "signal" }, Sent: { eyes: "happy", mouth: "smile", ant: "signal" },
  Researching: { eyes: "visor", mouth: "flat", ant: "signal" }, WorkDone: { eyes: "happy", mouth: "smile", ant: "bulb" }, Answer: { eyes: "happy", mouth: "smile", ant: "bulb" },
  WorkPaused: { eyes: "small", mouth: "flat", ant: "hollow" }, WorkStopped: { eyes: "sad", mouth: "frown", ant: "hollow" },
  Noise: { eyes: "confused", mouth: "zig", ant: "?" }, ResultError: { eyes: "x", mouth: "frown", ant: "hollow" },
};
function resultExpr(kind) {
  if (kind === "todo" || kind === "shopping" || kind === "done") return { eyes: "happy", mouth: "smile", ant: "ball" };
  if (kind === "reminder") return { eyes: "wink", mouth: "smile", ant: "ball" };
  if (kind === "work") return { eyes: "visor", mouth: "flat", ant: "ball" };
  if (kind === "unsure") return { eyes: "open", mouth: "flat", ant: "?" };
  return { eyes: "happy", mouth: "smile", ant: "bulb" };
}
/** wrapText() of pv_gfx.cpp: word wrap to n glyphs, hard-split long words, ".." on overflow. */
export function wrap(str, n, maxLines) {
  const words = fold(str).split(" ").filter(Boolean), lines = [];
  let cur = "";
  for (let w of words) {
    while (w.length > n) { if (cur) { lines.push(cur); cur = ""; } lines.push(w.slice(0, n)); w = w.slice(n); }
    if (!cur) cur = w; else if (cur.length + 1 + w.length <= n) cur += " " + w; else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { lines.length = maxLines; lines[maxLines - 1] = lines[maxLines - 1].slice(0, Math.max(0, n - 2)) + ".."; }
  return lines;
}
function textBlock(b, str, x, y, s, maxW, lh, maxLines) {
  const L = wrap(str, Math.floor((maxW + s) / (6 * s)), maxLines);
  L.forEach((ln, i) => b.text(ln, x, y + i * lh, s));
  return y + L.length * lh;
}
function header(b, ic, word, y0) { b.rect(8, y0 - 1, tw(word, 2) + 34, 22); icon(b, ic, 12, y0 + 2, 1, 0); b.text(word, 32, y0 + 3, 2, 0); }
function hint(b, pre, ic, post, y) {
  const gap = 8, wp = pre ? tw(pre, 2) + gap : 0, wq = post ? tw(post, 2) + gap : 0;
  const x = 100 - Math.trunc((wp + 16 + wq) / 2);
  if (pre) b.text(pre, x, y, 2); icon(b, ic, x + wp, y - 1); if (post) b.text(post, x + wp + 16 + gap, y, 2);
}
function battPct(b, xr, y, pct) {
  const s = pct < 15 ? `LOW ${pct}%` : `${pct}%`;
  b.text(s, xr - 18 - tw(s, 1) - 2, y + 1, 1);
  const x = xr - 16; b.frame(x, y, 14, 8, 1); b.rect(x + 14, y + 2, 2, 4); b.rect(x + 2, y + 2, Math.max(1, R_((10 * pct) / 100)), 4);
}
/** Device due format: MM-DD HH:MM. */
export const deviceDue = (due) => { const m = String(due ?? "").match(/^\d{4}-(\d\d)-(\d\d)(?:T(\d\d:\d\d))?/); return m ? `${m[1]}-${m[2]}${m[3] ? " " + m[3] : ""}` : ""; };

/** m = {screen, kind, title, due, summary, error, pct, queued, sec}. Returns a 200x200 bitmap. */
export function drawMirror(m, f = 0) {
  const b = new B(200, 200), y0 = 116;
  // m.expr: the web app's override (pokes, offline, crash); Researching scans its visor on the web
  const ex = m.expr ?? (m.screen === "Result" ? resultExpr(m.kind) : m.screen === "Researching" ? { ...EXPR.Researching, scan: true } : EXPR[m.screen] ?? MOODS.awake);
  boxBot(b, 50, 36, 100, 72, ex, m.screen === "Sending" || m.screen === "Researching" || m.expr ? f : 0);
  if (m.screen === "Ready") { b.text("z", 158, 46, 1); b.text("z", 165, 40, 2); b.text("Z", 177, 34, 2); }
  if (m.screen !== "Sending") icon(b, m.queued ? "cloudx" : "cloud", 8, 6);
  if (m.pct != null && m.pct >= 0) battPct(b, 190, 8, m.pct);
  switch (m.screen) {
    case "Ready": hint(b, "hold", "sun", "to talk", y0 + 22); if (m.pct != null && m.pct < 15) b.ctext("battery low - charge soon", y0 + 62, 1); break;
    case "Sending": b.text("sending" + ".".repeat(f % 4), 100 - Math.trunc(tw("sending...", 2) / 2), y0 + 22, 2); break;
    case "Sent": { const w = tw("sent", 3), x = 100 - Math.trunc((w + 26) / 2); b.text("sent", x, y0 + 6, 3); icon(b, "check", x + w + 6, y0 + 2); icon(b, "check", x + w + 6, y0 + 6); b.ctext("result soon", y0 + 40, 1); break; }
    case "Result": {
      // The kind names the list (todo, shopping, reminder, note) or what changed (done, removed): pv_bolt.cpp.
      const unsure = m.kind === "unsure";
      const ic = ["todo", "shopping"].includes(m.kind) ? "todo" : m.kind === "done" ? "check" : ["reminder", "work"].includes(m.kind) ? m.kind : "note";
      const word = unsure ? "NOTE?" : (m.kind || "note").toUpperCase().slice(0, 12);
      header(b, ic, word, y0);
      const due = deviceDue(m.due);
      if (due) {
        if (tw(m.title, 2) <= 180) textBlock(b, m.title, 10, y0 + 28, 2, 180, 17, 1); else textBlock(b, m.title, 10, y0 + 26, 1, 180, 10, 2);
        b.rect(8, y0 + 48, 184, 1); icon(b, "reminder", 10, y0 + 56);
        if (tw(due, 2) <= 158) b.text(due, 32, y0 + 57, 2); else b.text(due, 32, y0 + 61, 1);
      } else textBlock(b, m.title, 10, y0 + 28, 2, 180, 17, 2);
      break;
    }
    case "Researching": header(b, "work", "WORK", y0); b.text("researching", 104, y0 + 6, 1); textBlock(b, m.title, 10, y0 + 28, 2, 180, 17, 2); break;
    case "WorkDone": header(b, "work", "DONE", y0);
      if (tw(m.summary, 2) <= 360) textBlock(b, m.summary, 10, y0 + 28, 2, 180, 17, 2); else textBlock(b, m.summary, 10, y0 + 28, 1, 180, 11, 4); break;
    case "Answer": header(b, "note", "ANSWER", y0);
      if (tw(m.summary, 2) <= 360) textBlock(b, m.summary, 10, y0 + 28, 2, 180, 17, 2); else textBlock(b, m.summary, 10, y0 + 28, 1, 180, 11, 6); break;
    case "WorkPaused": header(b, "work", "PAUSED", y0); textBlock(b, m.title, 6, y0 + 28, 2, 190, 17, 2); b.ctext("daily budget hit", y0 + 68, 1); break;
    case "WorkStopped": header(b, "work", "STOPPED", y0); textBlock(b, m.title, 6, y0 + 28, 2, 190, 17, 2); b.ctext("the agent gave up", y0 + 68, 1); break;
    case "Noise": b.ctext("didn't catch", y0 + 8, 2); b.ctext("that", y0 + 28, 2); hint(b, "hold", "sun", "to retry", y0 + 56); break;
    case "ResultError": b.ctext("server error", y0 + 8, 2); b.ctext(fold(m.error ?? "").slice(0, 32), y0 + 34, 1); break;
  }
  return b;
}

// ---------- painting ----------
/** Paint a bitmap into a canvas, ink pixels in `ink`, others `paper` (null = transparent). */
export function paint(canvas, b, ink, paper = null) {
  if (canvas.width !== b.w) canvas.width = b.w;
  if (canvas.height !== b.h) canvas.height = b.h;
  const ctx = canvas.getContext("2d");
  const img = ctx.createImageData(b.w, b.h);
  const [ir, ig, ib] = rgb(ink), pp = paper ? rgb(paper) : null;
  for (let i = 0; i < b.d.length; i++) {
    const o = i * 4;
    if (b.d[i]) { img.data[o] = ir; img.data[o + 1] = ig; img.data[o + 2] = ib; img.data[o + 3] = 255; }
    else if (pp) { img.data[o] = pp[0]; img.data[o + 1] = pp[1]; img.data[o + 2] = pp[2]; img.data[o + 3] = 255; }
  }
  ctx.putImageData(img, 0, 0);
}
const rgbCache = new Map();
function rgb(css) {
  if (rgbCache.has(css)) return rgbCache.get(css);
  const m = css.trim().match(/^#([0-9a-f]{6})$/i);
  let v = [0, 0, 0];
  if (m) v = [0, 2, 4].map((i) => parseInt(m[1].substr(i, 2), 16));
  else if (typeof document !== "undefined") {
    const c = document.createElement("canvas").getContext("2d"); c.fillStyle = css; const h = c.fillStyle;
    if (/^#/.test(h)) v = [1, 3, 5].map((i) => parseInt(h.substr(i, 2), 16));
  }
  rgbCache.set(css, v);
  return v;
}
/** CSS size for a bitmap so every bitmap pixel is a whole number of device pixels (always crisp). */
export function crispScale(bitmapW, maxCssW, dpr = (typeof devicePixelRatio === "number" ? devicePixelRatio : 1)) {
  const devPx = Math.max(1, Math.floor((maxCssW * dpr) / bitmapW));
  return devPx / dpr;
}
