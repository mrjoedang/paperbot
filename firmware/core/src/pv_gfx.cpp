#include "pv_gfx.h"
#include <math.h>
#include <stdio.h>
#include <string.h>

namespace pv {

// Classic 5x7 font from design/bolt-variations.html: column-major, LSB = top row, ASCII 32..126.
static const uint8_t FONT5x7[95 * 5] = {
  0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x5f,0x00,0x00,0x00,0x07,0x00,0x07,0x00,0x14,0x7f,0x14,0x7f,0x14,
  0x24,0x2a,0x7f,0x2a,0x12,0x23,0x13,0x08,0x64,0x62,0x36,0x49,0x56,0x20,0x50,0x00,0x00,0x07,0x00,0x00,
  0x00,0x1c,0x22,0x41,0x00,0x00,0x41,0x22,0x1c,0x00,0x14,0x08,0x3e,0x08,0x14,0x08,0x08,0x3e,0x08,0x08,
  0x00,0x50,0x30,0x00,0x00,0x08,0x08,0x08,0x08,0x08,0x00,0x60,0x60,0x00,0x00,0x20,0x10,0x08,0x04,0x02,
  0x3e,0x51,0x49,0x45,0x3e,0x00,0x42,0x7f,0x40,0x00,0x42,0x61,0x51,0x49,0x46,0x21,0x41,0x45,0x4b,0x31,
  0x18,0x14,0x12,0x7f,0x10,0x27,0x45,0x45,0x45,0x39,0x3c,0x4a,0x49,0x49,0x30,0x01,0x71,0x09,0x05,0x03,
  0x36,0x49,0x49,0x49,0x36,0x06,0x49,0x49,0x29,0x1e,0x00,0x36,0x36,0x00,0x00,0x00,0x56,0x36,0x00,0x00,
  0x08,0x14,0x22,0x41,0x00,0x14,0x14,0x14,0x14,0x14,0x00,0x41,0x22,0x14,0x08,0x02,0x01,0x51,0x09,0x06,
  0x32,0x49,0x79,0x41,0x3e,0x7e,0x11,0x11,0x11,0x7e,0x7f,0x49,0x49,0x49,0x36,0x3e,0x41,0x41,0x41,0x22,
  0x7f,0x41,0x41,0x22,0x1c,0x7f,0x49,0x49,0x49,0x41,0x7f,0x09,0x09,0x09,0x01,0x3e,0x41,0x49,0x49,0x7a,
  0x7f,0x08,0x08,0x08,0x7f,0x00,0x41,0x7f,0x41,0x00,0x20,0x40,0x41,0x3f,0x01,0x7f,0x08,0x14,0x22,0x41,
  0x7f,0x40,0x40,0x40,0x40,0x7f,0x02,0x0c,0x02,0x7f,0x7f,0x04,0x08,0x10,0x7f,0x3e,0x41,0x41,0x41,0x3e,
  0x7f,0x09,0x09,0x09,0x06,0x3e,0x41,0x51,0x21,0x5e,0x7f,0x09,0x19,0x29,0x46,0x46,0x49,0x49,0x49,0x31,
  0x01,0x01,0x7f,0x01,0x01,0x3f,0x40,0x40,0x40,0x3f,0x1f,0x20,0x40,0x20,0x1f,0x3f,0x40,0x38,0x40,0x3f,
  0x63,0x14,0x08,0x14,0x63,0x07,0x08,0x70,0x08,0x07,0x61,0x51,0x49,0x45,0x43,0x00,0x7f,0x41,0x41,0x00,
  0x02,0x04,0x08,0x10,0x20,0x00,0x41,0x41,0x7f,0x00,0x04,0x02,0x01,0x02,0x04,0x40,0x40,0x40,0x40,0x40,
  0x00,0x01,0x02,0x04,0x00,0x20,0x54,0x54,0x54,0x78,0x7f,0x48,0x44,0x44,0x38,0x38,0x44,0x44,0x44,0x20,
  0x38,0x44,0x44,0x48,0x7f,0x38,0x54,0x54,0x54,0x18,0x08,0x7e,0x09,0x01,0x02,0x0c,0x52,0x52,0x52,0x3e,
  0x7f,0x08,0x04,0x04,0x78,0x00,0x44,0x7d,0x40,0x00,0x20,0x40,0x44,0x3d,0x00,0x7f,0x10,0x28,0x44,0x00,
  0x00,0x41,0x7f,0x40,0x00,0x7c,0x04,0x18,0x04,0x78,0x7c,0x08,0x04,0x04,0x78,0x38,0x44,0x44,0x44,0x38,
  0x7c,0x14,0x14,0x14,0x08,0x08,0x14,0x14,0x18,0x7c,0x7c,0x08,0x04,0x04,0x08,0x48,0x54,0x54,0x54,0x20,
  0x04,0x3f,0x44,0x40,0x20,0x3c,0x40,0x40,0x20,0x7c,0x1c,0x20,0x40,0x20,0x1c,0x3c,0x40,0x30,0x40,0x3c,
  0x44,0x28,0x10,0x28,0x44,0x0c,0x50,0x50,0x50,0x3c,0x44,0x64,0x54,0x4c,0x44,0x00,0x08,0x36,0x41,0x00,
  0x00,0x00,0x7f,0x00,0x00,0x00,0x41,0x36,0x08,0x00,0x08,0x04,0x08,0x10,0x08,
};

static inline double jsRound(double v) { return floor(v + 0.5); }  // Math.round

void Gfx::clear(int c) { memset(d_, (c ^ inv_) ? 0xff : 0x00, (size_t)stride_ * h_); }

void Gfx::px(double xf, double yf, int c) {
  int x = (int)floor(xf), y = (int)floor(yf);
  if (x < 0 || y < 0 || x >= w_ || y >= h_) return;
  uint8_t &b = d_[y * stride_ + (x >> 3)], bit = 0x80 >> (x & 7);
  if (c ^ inv_) b |= bit;
  else b &= ~bit;
}

int Gfx::get(int x, int y) const {
  if (x < 0 || y < 0 || x >= w_ || y >= h_) return 0;
  return ((d_[y * stride_ + (x >> 3)] >> (7 - (x & 7))) & 1) ^ inv_;
}

void Gfx::rect(double x, double y, double w, double h, int c) {
  for (int j = 0; j < h; j++)
    for (int i = 0; i < w; i++) px(x + i, y + j, c);
}

void Gfx::frame(int x, int y, int w, int h, int t, int c) {
  rect(x, y, w, t, c);
  rect(x, y + h - t, w, t, c);
  rect(x, y, t, h, c);
  rect(x + w - t, y, t, h, c);
}

bool Gfx::inRR(int px_, int py, int x, int y, int w, int h, int r) const {
  if (px_ < x || py < y || px_ >= x + w || py >= y + h) return false;
  int cx = px_ < x + r ? x + r : (px_ >= x + w - r ? x + w - r : px_);
  int cy = py < y + r ? y + r : (py >= y + h - r ? y + h - r : py);
  double dx = px_ + .5 - cx, dy = py + .5 - cy;
  return cx == px_ || cy == py || dx * dx + dy * dy <= (double)r * r;
}

void Gfx::rrect(int x, int y, int w, int h, int r, int c) {
  for (int j = y; j < y + h; j++)
    for (int i = x; i < x + w; i++)
      if (inRR(i, j, x, y, w, h, r)) px(i, j, c);
}

void Gfx::rframe(int x, int y, int w, int h, int r, int t, int c) {
  int ri = r - t > 0 ? r - t : 0;
  for (int j = y; j < y + h; j++)
    for (int i = x; i < x + w; i++)
      if (inRR(i, j, x, y, w, h, r) && !inRR(i, j, x + t, y + t, w - 2 * t, h - 2 * t, ri)) px(i, j, c);
}

void Gfx::line(double fx0, double fy0, double fx1, double fy1, int t, int c) {
  int x0 = (int)jsRound(fx0), y0 = (int)jsRound(fy0), x1 = (int)jsRound(fx1), y1 = (int)jsRound(fy1);
  int dx = x1 > x0 ? x1 - x0 : x0 - x1, dy = -(y1 > y0 ? y1 - y0 : y0 - y1), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  int e = dx + dy, o = (int)floor((t - 1) / 2.0);
  for (;;) {
    rect(x0 - o, y0 - o, t, t, c);
    if (x0 == x1 && y0 == y1) break;
    int e2 = 2 * e;
    if (e2 >= dy) { e += dy; x0 += sx; }
    if (e2 <= dx) { e += dx; y0 += sy; }
  }
}

void Gfx::ellipse(double cx, double cy, double rx, double ry, int c) {
  for (int y = (int)floor(cy - ry - 1); y <= cy + ry + 1; y++)
    for (int x = (int)floor(cx - rx - 1); x <= cx + rx + 1; x++) {
      double dx = (x + .5 - cx) / rx, dy = (y + .5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) px(x, y, c);
    }
}

void Gfx::ring(double cx, double cy, double r, double t, int c, double a0, double a1) {
  bool arc = a0 != 0 || a1 != 360;
  for (int y = (int)floor(cy - r - 1); y <= cy + r + 1; y++)
    for (int x = (int)floor(cx - r - 1); x <= cx + r + 1; x++) {
      double dx = x + .5 - cx, dy = y + .5 - cy, dd = hypot(dx, dy);
      if (dd > r || dd < r - t) continue;
      if (arc) {
        double a = atan2(dy, dx) * 180 / M_PI;
        if (a < 0) a += 360;
        if (a0 <= a1 ? (a < a0 || a > a1) : (a < a0 && a > a1)) continue;
      }
      px(x, y, c);
    }
}

void Gfx::poly(const double (*pts)[2], int n, int c) {
  double y0 = 1e9, y1 = -1e9;
  for (int i = 0; i < n; i++) {
    if (pts[i][1] < y0) y0 = pts[i][1];
    if (pts[i][1] > y1) y1 = pts[i][1];
  }
  double xs[16];
  for (int y = (int)floor(y0); y <= ceil(y1); y++) {
    double yc = y + .5;
    int k = 0;
    for (int i = 0; i < n && k < 16; i++) {
      const double *a = pts[i], *b = pts[(i + 1) % n];
      if ((a[1] <= yc && b[1] > yc) || (b[1] <= yc && a[1] > yc)) xs[k++] = a[0] + (yc - a[1]) / (b[1] - a[1]) * (b[0] - a[0]);
    }
    for (int i = 1; i < k; i++)  // insertion sort
      for (int j = i; j > 0 && xs[j - 1] > xs[j]; j--) { double t = xs[j]; xs[j] = xs[j - 1]; xs[j - 1] = t; }
    for (int m = 0; m + 1 < k; m += 2)
      for (int x = (int)ceil(xs[m] - .5); x < xs[m + 1] - .5; x++) px(x, y, c);
  }
}

void Gfx::hdots(int x, int y, int w, int gap, int c) {
  for (int i = 0; i < w; i += gap) px(x + i, y, c);
}

void Gfx::invert(int x, int y, int w, int h) {
  for (int j = y; j < y + h; j++)
    for (int i = x; i < x + w; i++) px(i, j, get(i, j) ? 0 : 1);
}

char asciiFold(const char *&p) {
  unsigned char c = (unsigned char)*p;
  if (c < 0x80) { p++; return c < 32 ? ' ' : (char)c; }
  // Decode one UTF-8 sequence.
  unsigned cp = 0;
  int n = c >= 0xF0 ? 3 : c >= 0xE0 ? 2 : c >= 0xC0 ? 1 : 0;
  cp = n == 3 ? (c & 7) : n == 2 ? (c & 15) : (c & 31);
  p++;
  for (int i = 0; i < n && ((unsigned char)*p & 0xC0) == 0x80; i++) cp = cp << 6 | ((unsigned char)*p++ & 0x3F);
  if (cp >= 0xC0 && cp <= 0x17F) {
    static const char lat[] = "AAAAAAACEEEEIIIIDNOOOOOxOUUUUYTsaaaaaaaceeeeiiiidnooooo/ouuuuyty";
    if (cp <= 0xFF) return lat[cp - 0xC0];
    return '?';
  }
  if (cp == 0x2018 || cp == 0x2019) return '\'';
  if (cp == 0x201C || cp == 0x201D) return '"';
  if (cp == 0x2013 || cp == 0x2014) return '-';
  if (cp == 0x2026) return '.';
  if (cp == 0x2713 || cp == 0x2714) return '*';
  return '?';
}

int Gfx::textWidth(const char *s, int k) {
  int n = 0;
  for (const char *p = s; *p;) { asciiFold(p); n++; }
  return n ? n * 6 * k - k : -k;
}

int Gfx::text(const char *s, int x, int y, int k, int c) {
  int cx = x;
  for (const char *p = s; *p;) {
    int ch = (unsigned char)asciiFold(p);
    if (ch < 32 || ch > 126) ch = '?';
    const uint8_t *g = FONT5x7 + (ch - 32) * 5;
    for (int col = 0; col < 5; col++)
      for (int r = 0; r < 8; r++)
        if (g[col] & (1 << r)) rect(cx + col * k, y + r * k, k, k, c);
    cx += 6 * k;
  }
  return cx - x - k;
}

int Gfx::ctext(const char *s, int y, int k, int c, int cx) {
  int w = textWidth(s, k);
  return text(s, (int)jsRound(cx - w / 2.0), y, k, c);
}

// Icons are drawn into a 16x16 scratch bitmap (as the design's mk()) and blitted with scale.
void Gfx::icon(const char *name, int x, int y, int s, int c) {
  uint8_t buf[32];
  Gfx b(buf, 16, 16);
  b.clear(0);
  if (!strcmp(name, "todo")) { b.frame(0, 0, 16, 16, 2); b.line(3, 7, 6, 10, 2); b.line(6, 10, 11, 4, 2); }
  else if (!strcmp(name, "reminder")) {
    b.ring(8, 9.5, 6.5, 2); b.rect(7, 5, 2, 5); b.rect(7, 8, 4, 2); b.ellipse(2.5, 2.5, 2.5, 2.5); b.ellipse(13.5, 2.5, 2.5, 2.5);
  } else if (!strcmp(name, "work")) {
    b.frame(0, 1, 16, 14, 2); b.rect(0, 1, 16, 4); b.line(3, 7, 5, 9, 2); b.line(5, 9, 3, 11, 2); b.rect(8, 11, 5, 2);
  } else if (!strcmp(name, "note")) {
    b.line(2, 0, 9, 0, 2); b.line(9, 0, 13, 4, 2); b.line(13, 4, 13, 14, 2); b.line(2, 14, 13, 14, 2); b.line(2, 0, 2, 14, 2);
    b.line(9, 0, 9, 4, 1); b.line(9, 4, 13, 4, 1); b.rect(5, 7, 6, 1); b.rect(5, 10, 6, 1);
  } else if (!strcmp(name, "cloud") || !strcmp(name, "cloudx")) {
    b.ellipse(5, 9.5, 4, 3.5); b.ellipse(9.5, 7, 4.5, 4.5); b.ellipse(13, 10, 3, 3); b.rect(4, 9, 10, 4);
    if (name[5] == 'x') { b.line(1, 1, 14, 14, 3, 0); b.line(1, 0, 15, 14, 1, 1); }
  } else if (!strcmp(name, "sd")) {
    static const double P[5][2] = { { 4, 0 }, { 14, 0 }, { 14, 16 }, { 2, 16 }, { 2, 2 } };
    b.poly(P, 5); b.rect(6, 2, 1, 4, 0); b.rect(8, 2, 1, 4, 0); b.rect(10, 2, 1, 4, 0); b.rect(12, 2, 1, 4, 0);
  } else if (!strcmp(name, "check")) { b.line(2, 8, 6, 12, 3); b.line(6, 12, 13, 3, 3); }
  else if (!strcmp(name, "batt0")) { b.frame(0, 4, 14, 9, 2); b.rect(14, 6, 2, 5); }
  else if (!strcmp(name, "sun") || !strcmp(name, "power")) {
    // Hand-placed pixels: anti-aliased thin diagonals turn to mush on the 1-bit panel.
    static const char *SUN[16] = {
        ".......##.......", ".......##.......", "..##.......##...", "..###.....###...",
        "...#.......#....", "......####......", ".....######.....", "###..######..###",
        "###..######..###", ".....######.....", "......####......", "...#.......#....",
        "..###.....###...", "..##.......##...", ".......##.......", ".......##.......",
    };
    static const char *POWER[16] = {
        ".......##.......", ".......##.......", "...##..##..##...", "..##...##...##..",
        ".##....##....##.", ".##....##....##.", "##.....##.....##", "##............##",
        "##............##", "##............##", ".##..........##.", ".##..........##.",
        "..##........##..", "...###....###...", ".....######.....", "................",
    };
    const char **px = name[0] == 's' ? SUN : POWER;
    for (int j = 0; j < 16; j++)
      for (int i = 0; i < 16; i++)
        if (px[j][i] == '#') b.rect(i, j, 1, 1);
  }
  for (int j = 0; j < 16; j++)
    for (int i = 0; i < 16; i++)
      if (b.get(i, j)) rect(x + i * s, y + j * s, s, s, c);
}

int wrapText(const char *text, int n, int max_lines, char *buf, size_t cap, const char **lines) {
  // ASCII-fold first so widths are in glyphs.
  char a[160];
  size_t k = 0;
  for (const char *p = text; *p && k + 1 < sizeof(a);) {
    char ch = asciiFold(p);
    a[k++] = ch == '\n' ? ' ' : ch;
  }
  a[k] = 0;
  int count = 0;
  size_t used = 0;
  char cur[64] = "";
  auto emit = [&](const char *ln) {
    size_t len = strlen(ln);
    if (count >= 8 || used + len + 1 > cap) return;
    memcpy(buf + used, ln, len + 1);
    lines[count++] = buf + used;
    used += len + 1;
  };
  if (n > 63) n = 63;
  const char *p = a;
  bool overflow = false;
  while (*p) {
    while (*p == ' ') p++;
    if (!*p) break;
    const char *e = p;
    while (*e && *e != ' ') e++;
    char w[160];
    int wl = (int)(e - p);
    memcpy(w, p, wl);
    w[wl] = 0;
    p = e;
    char *wp = w;
    while ((int)strlen(wp) > n) {  // hard-split long words
      if (cur[0]) { emit(cur); cur[0] = 0; }
      char part[64];
      snprintf(part, sizeof(part), "%.*s", n, wp);
      emit(part);
      wp += n;
    }
    int cl = (int)strlen(cur);
    if (!cl) snprintf(cur, sizeof(cur), "%s", wp);
    else if (cl + 1 + (int)strlen(wp) <= n) { strcat(cur, " "); strcat(cur, wp); }
    else { emit(cur); snprintf(cur, sizeof(cur), "%s", wp); }
    if (count > max_lines) { overflow = true; break; }
  }
  if (cur[0] && !overflow) emit(cur);
  if (count > max_lines) {
    count = max_lines;
    char *last = (char *)lines[max_lines - 1];
    int ll = (int)strlen(last);
    if (ll > n - 2) ll = n - 2;
    if (ll < 0) ll = 0;
    last[ll] = '.';
    last[ll + 1] = '.';
    last[ll + 2] = 0;
  }
  return count;
}

}  // namespace pv
