// 1-bit drawing primitives, a C++ port of the `B` bitmap class in design/bolt-variations.html
// (same rasterisation rules, so the Bolt layout matches the design pixel for pixel), plus the
// design's classic 5x7 font and 16x16 icons. No allocation; the caller owns the bit buffer.
// Bits: 1 = ink (black), MSB first, rows of (w+7)/8 bytes.
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace pv {

class Gfx {
 public:
  // white_is_1: buffer polarity of the e-paper frame (1 = white) - drawing "ink" clears bits.
  Gfx(uint8_t *bits, int w, int h, bool white_is_1 = false) : d_(bits), w_(w), h_(h), stride_((w + 7) / 8), inv_(white_is_1 ? 1 : 0) {}
  int w() const { return w_; }
  int h() const { return h_; }
  void clear(int c = 0);
  void px(double x, double y, int c = 1);
  int get(int x, int y) const;
  void rect(double x, double y, double w, double h, int c = 1);
  void frame(int x, int y, int w, int h, int t = 1, int c = 1);
  void rrect(int x, int y, int w, int h, int r, int c = 1);
  void rframe(int x, int y, int w, int h, int r, int t = 2, int c = 1);
  void line(double x0, double y0, double x1, double y1, int t = 1, int c = 1);
  void ellipse(double cx, double cy, double rx, double ry, int c = 1);
  void circle(double cx, double cy, double r, int c = 1) { ellipse(cx, cy, r, r, c); }
  void ring(double cx, double cy, double r, double t, int c = 1, double a0 = 0, double a1 = 360);
  void poly(const double (*pts)[2], int n, int c = 1);
  void hdots(int x, int y, int w, int gap = 2, int c = 1);
  void invert(int x, int y, int w, int h);
  // 5x7 font scaled by s; returns the drawn width. Non-ASCII UTF-8 is folded to ASCII.
  int text(const char *s, int x, int y, int s_ = 1, int c = 1);
  int ctext(const char *s, int y, int s_ = 1, int c = 1, int cx = 100);
  static int textWidth(const char *s, int s_ = 1);
  // 16x16 icon by name (todo, reminder, work, note, cloud, cloudx, sd, check, batt0); s = scale
  void icon(const char *name, int x, int y, int s = 1, int c = 1);

 private:
  bool inRR(int px, int py, int x, int y, int w, int h, int r) const;
  uint8_t *d_;
  int w_, h_, stride_, inv_;
};

// Folds one UTF-8 sequence at *p to a printable ASCII char and advances p.
char asciiFold(const char *&p);

// Word-wraps text (ASCII-folded) into at most max_lines lines of max_chars; the last line ends
// in ".." when cut. Lines are written into buf (NUL-separated); returns the line count.
int wrapText(const char *text, int max_chars, int max_lines, char *buf, size_t cap, const char **lines);

}  // namespace pv
