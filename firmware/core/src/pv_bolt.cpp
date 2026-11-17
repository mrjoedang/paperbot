#include "pv_bolt.h"
#include <math.h>
#include <stdio.h>
#include <string.h>

namespace pv {

namespace {

inline double R_(double v) { return floor(v + 0.5); }  // Math.round
inline double dmax(double a, double b) { return a > b ? a : b; }

struct Expr {
  const char *eyes, *mouth, *ant;
};

// EXPR table of the design, extended to every Screen of the app.
Expr exprFor(const ScreenModel &m) {
  switch (m.id) {
    case Screen::Ready: return { "sleep", "small", "ball" };
    case Screen::Rec: return { "wide", "talk", "blink" };
    case Screen::Saved:
    case Screen::Sending: return { "look", "small", "signal" };
    case Screen::Result:
      if (!strcmp(m.kind, "todo") || !strcmp(m.kind, "shopping") || !strcmp(m.kind, "done")) return { "happy", "smile", "ball" };
      if (!strcmp(m.kind, "reminder")) return { "wink", "smile", "ball" };
      if (!strcmp(m.kind, "work")) return { "visor", "flat", "ball" };
      if (!strcmp(m.kind, "unsure")) return { "open", "flat", "?" };
      return { "happy", "smile", "bulb" };  // note
    case Screen::Sent: return { "happy", "smile", "signal" };
    case Screen::Queued: return { "sad", "frown", "hollow" };
    case Screen::TooShort:
    case Screen::BadClip:
    case Screen::Noise: return { "confused", "zig", "?" };
    case Screen::NoSd:
    case Screen::SdError: return { "x", "zig", "hollow" };
    case Screen::Off: return { "sleep", "flat", "hollow" };
    case Screen::Researching: return { "visor", "flat", "signal" };
    case Screen::WorkDone:
    case Screen::Answer: return { "happy", "smile", "bulb" };
    case Screen::WorkPaused: return { "small", "flat", "hollow" };
    case Screen::WorkStopped: return { "sad", "frown", "hollow" };
    case Screen::ResultError: return { "x", "frown", "hollow" };
    case Screen::ChargeMe: return { "sleep", "frown", "hollow" };
    case Screen::Updating: return { "visor", "flat", "signal" };
    case Screen::Updated: return { "happy", "smile", "bulb" };
    case Screen::UpdateFailed: return { "sad", "frown", "hollow" };
    default: return { "open", "small", "ball" };  // Boot, StillOn, Status
  }
}

void antTop(Gfx &b, const char *k, double cx, double cy, double r, uint32_t f, int c = 1) {
  if (!strcmp(k, "ball")) b.circle(cx, cy, r, c);
  else if (!strcmp(k, "hollow")) b.ring(cx, cy, r, 2, c);
  else if (!strcmp(k, "blink")) { if (f % 2 == 0) b.circle(cx, cy, r, c); else b.ring(cx, cy, r, 2, c); }
  else if (!strcmp(k, "signal")) {
    b.circle(cx, cy, r, c);
    int n = 1 + f % 3;
    for (int i = 0; i < n; i++) {
      double rr = r + 6 + i * 5;
      b.ring(cx, cy, rr, 2, c, 140, 220);
      b.ring(cx, cy, rr, 2, c, 320, 40);
    }
  } else if (!strcmp(k, "bulb")) {
    b.ring(cx, cy - 1, r + 1, 2, c);
    b.rect(R_(cx - r * .6), R_(cy + r), R_(r * 1.2), 3, c);
    for (int s = -1; s <= 1; s += 2) {
      b.line(cx + s * (r + 4), cy - r, cx + s * (r + 7), cy - r - 3, 1, c);
      b.line(cx + s * (r + 4), cy + 1, cx + s * (r + 8), cy + 1, 1, c);
    }
  } else if (!strcmp(k, "?")) b.text("?", (int)R_(cx - 5), (int)R_(cy - 8), 2, c);
}

void eyeRound(Gfx &b, const char *k, double cx, double cy, double R, uint32_t f, int side, int c = 1) {
  int nc = c ? 0 : 1, t = (int)dmax(2, R_(R / 3.5));
  if (!strcmp(k, "sleep")) b.rect(R_(cx - R), R_(cy + 1), R_(2 * R), t, c);
  else if (!strcmp(k, "open")) {
    b.ellipse(cx, cy, R * .75, R * .95, c);
    double h = dmax(2, R_(R * .28));
    b.rect(R_(cx + R * .1), R_(cy - R * .6), h, h, nc);
  } else if (!strcmp(k, "wide")) {
    b.circle(cx, cy, R + 1, c);
    b.circle(cx + R * .35, cy - R * .35, dmax(1.5, R * .28), nc);
  } else if (!strcmp(k, "look")) {
    b.ring(cx, cy, R + 1, t, c);
    static const int DX[4] = { -1, 0, 1, 0 };
    b.circle(cx + DX[f % 4] * R * .35, cy - R * .35, R * .42, c);
  } else if (!strcmp(k, "happy")) b.ring(cx, cy + R * .45, R, dmax(3, R * .36), c, 180, 360);
  else if (!strcmp(k, "sad")) {
    b.circle(cx, cy + R * .3, R * .62, c);
    if (side < 0) b.line(cx - R, cy - R * .7, cx + R * .6, cy - R * 1.25, t, c);
    else b.line(cx - R * .6, cy - R * 1.25, cx + R, cy - R * .7, t, c);
  } else if (!strcmp(k, "small")) {
    b.circle(cx, cy, dmax(2, R * .36), c);
    b.line(cx - R * .7, cy - R * 1.15, cx + R * .7, cy - R * 1.5, t, c);
  } else if (!strcmp(k, "x")) {
    double a = R * .7;
    b.line(cx - a, cy - a, cx + a, cy + a, t, c);
    b.line(cx - a, cy + a, cx + a, cy - a, t, c);
  }
}

void visorBox(Gfx &b, double L, double Rr, double cy, double R, int c = 1) {
  int nc = c ? 0 : 1;
  int x0 = (int)R_(L - R * 1.9), w = (int)R_(Rr - L + R * 3.8), h = (int)R_(R * 2.2);
  b.rrect(x0, (int)R_(cy - h / 2.0), w, h, 4, c);
  double sw = R_(R * 2), sh = dmax(3, R_(R * .6));
  b.rect(R_(L - R), R_(cy - sh / 2), sw, sh, nc);
  b.rect(R_(Rr - R), R_(cy - sh / 2), sw, sh, nc);
}

void mouthRound(Gfx &b, const char *k, double cx, double cy, double W, uint32_t f, int c = 1) {
  int t = (int)dmax(2, R_(W / 4));
  if (!strcmp(k, "talk")) k = f % 2 ? "o" : "O";
  cy = R_(cy);
  if (!strcmp(k, "small")) b.rect(R_(cx - W / 2), cy, R_(W), t, c);
  else if (!strcmp(k, "flat")) b.rect(R_(cx - W), cy, R_(2 * W), t, c);
  else if (!strcmp(k, "o")) b.ellipse(cx, cy + 1, W * .5, W * .42, c);
  else if (!strcmp(k, "O")) b.ellipse(cx, cy, W * .92, W * .75, c);
  else if (!strcmp(k, "smile")) b.ring(cx, cy - W * .9, W * 1.45, t, c, 25, 155);
  else if (!strcmp(k, "frown")) b.ring(cx, cy + W * 1.15, W * 1.1, t, c, 210, 330);
  else if (!strcmp(k, "zig")) {
    int tt = t - 1 > 2 ? t - 1 : 2;
    for (int i = 0; i < 6; i++)
      b.line(cx - W * 1.2 + i * W * .4, cy + (i % 2 ? -W * .35 : 0), cx - W * 1.2 + (i + 1) * W * .4, cy + ((i + 1) % 2 ? -W * .35 : 0), tt, c);
  }
}

void drawEyes(Gfx &b, const char *k, double L, double Rr, double cy, double R, uint32_t f, int c) {
  if (!strcmp(k, "visor")) { visorBox(b, L, Rr, cy, R, c); return; }
  const char *a = k, *z = k;
  if (!strcmp(k, "wink")) { a = "happy"; z = "open"; }
  else if (!strcmp(k, "confused")) { a = "wide"; z = "small"; }
  eyeRound(b, a, L, cy, R, f, -1, c);
  eyeRound(b, z, Rr, cy, R, f, 1, c);
}

// boxBot(b, x, y, w, h, ex, f) of the design (outline head, ears, antenna, eyes, mouth).
void boxBot(Gfx &b, int x, int y, int w, int h, const Expr &ex, uint32_t f) {
  const int c = 1;
  double k = w / 120.0, cx = x + w / 2.0;
  int t = (int)dmax(2, R_(3 * k));
  b.rframe(x, y, w, h, (int)R_(14 * k), t, c);
  double ew = dmax(3, R_(7 * k)), eh = R_(h * .4);
  b.rect(x - ew, R_(y + h * .3), ew, eh, c);
  b.rect(x + w, R_(y + h * .3), ew, eh, c);
  double sl = R_(12 * k), ar = dmax(2.5, 5 * k), sw = dmax(2, R_(4 * k));
  b.rect(R_(cx - sw / 2), y - sl, sw, sl, c);
  antTop(b, ex.ant, cx, y - sl - ar + 1, ar, f, c);
  double L = x + w * .3, Rr = x + w * .7, ey = y + h * .4, R = w * .09;
  drawEyes(b, ex.eyes, L, Rr, ey, R, f, c);
  mouthRound(b, ex.mouth, cx, y + h * .76, w * .1, f, c);
}

void batt(Gfx &b, int x, int y, int pct) {
  b.frame(x, y, 14, 8, 1);
  b.rect(x + 14, y + 2, 2, 4);
  b.rect(x + 2, y + 2, dmax(1, R_(10 * pct / 100.0)), 4);
}

void battPct(Gfx &b, int xr, int y, int pct, BattLevel lvl) {
  char s[16];
  snprintf(s, sizeof(s), lvl == BattLevel::Ok ? "%d%%" : "LOW %d%%", pct);
  b.text(s, xr - 18 - Gfx::textWidth(s, 1) - 2, y + 1, 1);
  batt(b, xr - 16, y, pct);
}

void zzz(Gfx &b, int x, int y) {
  b.text("z", x, y + 12, 1);
  b.text("z", x + 7, y + 6, 2);
  b.text("Z", x + 19, y, 2);
}

// First line of s (up to '\n') into out.
const char *line(const char *s, int n, char *out, size_t cap) {
  for (int i = 0; i < n && s; i++) {
    s = strchr(s, '\n');
    if (s) s++;
  }
  if (!s) { out[0] = 0; return out; }
  const char *e = strchr(s, '\n');
  snprintf(out, cap, "%.*s", e ? (int)(e - s) : (int)strlen(s), s);
  return out;
}

// textBlock(b, str, x, y, s, maxW, lh, maxLines) of the design; returns the y after the block.
int textBlock(Gfx &b, const char *str, int x, int y, int s, int maxW, int lh, int maxLines, bool center = false, int c = 1) {
  int n = (maxW + s) / (6 * s);
  char buf[200];
  const char *L[8];
  int count = wrapText(str, n, maxLines, buf, sizeof(buf), L);
  for (int i = 0; i < count; i++) {
    if (center) b.ctext(L[i], y + i * lh, s, c);
    else b.text(L[i], x, y + i * lh, s, c);
  }
  return y + count * lh;
}

// Inverted "[icon] WORD" header of the design's resultText().
void header(Gfx &b, const char *icon, const char *word, int y0) {
  b.rect(8, y0 - 1, Gfx::textWidth(word, 2) + 34, 22);
  b.icon(icon, 12, y0 + 2, 1, 0);
  b.text(word, 32, y0 + 3, 2, 0);
}

// Centered "pre [icon] post" line in size-2 text: the buttons are shown by the symbols printed
// on the case (sun = BOOT, power = PWR) instead of their names.
void hint(Gfx &b, const char *pre, const char *icon, const char *post, int y) {
  const int gap = 8;
  int wp = *pre ? Gfx::textWidth(pre, 2) + gap : 0, wq = *post ? Gfx::textWidth(post, 2) + gap : 0;
  int x = 100 - (wp + 16 + wq) / 2;
  if (*pre) b.text(pre, x, y, 2);
  b.icon(icon, x + wp, y - 1);
  if (*post) b.text(post, x + wp + 16 + gap, y, 2);
}

void textArea(Gfx &b, const ScreenModel &m, uint32_t f, uint32_t sec, int y0) {
  char l0[64], l1[64], l2[64], t[48];
  switch (m.id) {
    case Screen::Ready:
      hint(b, "hold", "sun", "to talk", y0 + 22);
      if (m.batt != BattLevel::Ok) b.ctext("battery low - charge soon", y0 + 62, 1);
      break;
    case Screen::Rec:
      b.circle(66, y0 + 11, 5);
      b.text("REC", 76, y0 + 5, 2);
      snprintf(t, sizeof(t), "%us", (unsigned)sec);
      b.ctext(t, y0 + 28, 4);
      b.ctext("release to send", y0 + 66, 1);
      break;
    case Screen::Saved:
      snprintf(t, sizeof(t), "saved %s", line(m.detail, 0, l0, sizeof(l0)));
      b.ctext(t, y0 + 14, 2);
      b.ctext(line(m.detail, 1, l1, sizeof(l1)), y0 + 40, 1);  // e.g. "(very quiet)" only
      break;
    case Screen::Sending: {
      snprintf(t, sizeof(t), "sending%.*s", (int)(f % 4), "...");
      b.text(t, 100 - Gfx::textWidth("sending...", 2) / 2, y0 + 22, 2);  // fixed x: dots don't shift the word
      break;
    }
    case Screen::Queued:
      b.ctext(line(m.detail, 0, l0, sizeof(l0)), y0 + 14, 2);  // "no wifi" / "server 500" ...
      b.ctext("will retry", y0 + 40, 1);
      break;
    case Screen::TooShort:
      b.ctext("too short!", y0 + 14, 2);
      hint(b, "hold", "sun", "longer", y0 + 42);
      break;
    case Screen::NoSd:
      b.rect(0, y0, 200, 200 - y0);
      b.icon("sd", 12, y0 + 12, 2, 0);
      b.text("no SD", 52, y0 + 12, 3, 0);
      b.text("card", 52, y0 + 38, 2, 0);
      b.ctext("insert card + restart", y0 + 64, 1, 0);
      break;
    case Screen::Result: {
      // The kind names the list the item went to (todo, shopping, reminder, note) or what changed (done, removed).
      bool unsure = !strcmp(m.kind, "unsure");  // older servers
      const char *icon = !strcmp(m.kind, "todo") || !strcmp(m.kind, "shopping") ? "todo" : !strcmp(m.kind, "done") ? "check"
                       : !strcmp(m.kind, "reminder") || !strcmp(m.kind, "work") ? m.kind : "note";
      char word[13];
      if (unsure || !m.kind[0]) snprintf(word, sizeof(word), "%s", unsure ? "NOTE?" : "NOTE");
      else { snprintf(word, sizeof(word), "%s", m.kind); for (char *c = word; *c; c++) if (*c >= 'a' && *c <= 'z') *c -= 32; }
      header(b, icon, word, y0);
      const char *title = m.detail;  // the app puts the task title in detail
      if (m.due[0]) {
        if (Gfx::textWidth(title, 2) <= 180) textBlock(b, title, 10, y0 + 28, 2, 180, 17, 1);
        else textBlock(b, title, 10, y0 + 26, 1, 180, 10, 2);  // long title: small text, two lines
        b.rect(8, y0 + 48, 184, 1);
        b.icon("reminder", 10, y0 + 56);
        if (Gfx::textWidth(m.due, 2) <= 158) b.text(m.due, 32, y0 + 57, 2);
        else b.text(m.due, 32, y0 + 61, 1);
      } else if (unsure) {
        textBlock(b, title, 10, y0 + 28, 2, 180, 17, 2);
      } else {
        textBlock(b, title, 10, y0 + 28, 2, 180, 17, 2);
      }
      break;
    }
    case Screen::Sent: {
      int w = Gfx::textWidth("sent", 3);
      b.text("sent", 100 - (w + 26) / 2, y0 + 6, 3);
      b.icon("check", 100 - (w + 26) / 2 + w + 6, y0 + 2, 1);
      b.icon("check", 100 - (w + 26) / 2 + w + 6, y0 + 6, 1);  // bold
      b.ctext("result soon", y0 + 40, 1);
      break;
    }
    case Screen::Researching:
      header(b, "work", "WORK", y0);
      b.text("researching", 104, y0 + 6, 1);
      textBlock(b, m.detail, 10, y0 + 28, 2, 180, 17, 2);
      break;
    case Screen::WorkDone:
      header(b, "work", "DONE", y0);
      if (Gfx::textWidth(m.detail, 2) <= 2 * 180) textBlock(b, m.detail, 10, y0 + 28, 2, 180, 17, 2);
      else textBlock(b, m.detail, 10, y0 + 28, 1, 180, 11, 4);
      break;
    case Screen::Answer:  // up to 2 big lines, else up to 6 small ones (120 bytes)
      header(b, "note", "ANSWER", y0);
      if (Gfx::textWidth(m.detail, 2) <= 2 * 180) textBlock(b, m.detail, 10, y0 + 28, 2, 180, 17, 2);
      else textBlock(b, m.detail, 10, y0 + 28, 1, 180, 11, 6);
      break;
    case Screen::WorkPaused:
      header(b, "work", "PAUSED", y0);
      textBlock(b, m.detail, 6, y0 + 28, 2, 190, 17, 2);
      b.ctext("daily budget hit", y0 + 68, 1);
      break;
    case Screen::WorkStopped:
      header(b, "work", "STOPPED", y0);
      textBlock(b, m.detail, 6, y0 + 28, 2, 190, 17, 2);
      b.ctext("the agent gave up", y0 + 68, 1);
      break;
    case Screen::Noise:
      b.ctext("didn't catch", y0 + 8, 2);
      b.ctext("that", y0 + 28, 2);
      hint(b, "hold", "sun", "to retry", y0 + 56);
      break;
    case Screen::ResultError:
      b.ctext("server error", y0 + 8, 2);
      b.ctext(line(m.detail, 0, l0, sizeof(l0)), y0 + 34, 1);
      b.ctext(line(m.detail, 1, l1, sizeof(l1)), y0 + 46, 1);
      break;
    case Screen::ChargeMe:
      b.icon("batt0", 34, y0 + 4, 2);
      b.text("charge", 74, y0 + 6, 2);
      b.text("me", 74, y0 + 24, 2);
      b.ctext(line(m.detail, 0, l0, sizeof(l0)), y0 + 50, 1);
      b.ctext(line(m.detail, 1, l1, sizeof(l1)), y0 + 62, 1);
      break;
    case Screen::Updating:
      b.ctext("updating", y0 + 4, 2);
      b.ctext(line(m.detail, 1, l1, sizeof(l1)), y0 + 26, 3);
      b.ctext(line(m.detail, 0, l0, sizeof(l0)), y0 + 58, 1);
      break;
    case Screen::Updated:
      b.ctext("updated", y0 + 6, 2);
      b.ctext(line(m.detail, 0, l0, sizeof(l0)), y0 + 30, 3);
      hint(b, "hold", "sun", "to talk", y0 + 56);
      break;
    case Screen::UpdateFailed:
      b.ctext("update failed", y0 + 6, 2);
      for (int i = 0; i < 3; i++) b.ctext(line(m.detail, i, l0, sizeof(l0)), y0 + 32 + i * 12, 1);
      break;
    case Screen::Off:
      b.ctext("off", y0 + 8, 3);
      if (strstr(m.detail, "release")) hint(b, "release", "power", "", y0 + 44);
      else hint(b, "press", "power", "to start", y0 + 44);
      break;
    default: {  // Boot, Status, StillOn, SdError, BadClip: lower-case title + detail lines
      snprintf(t, sizeof(t), "%s", m.title);
      for (char *p = t; *p; p++)
        if (*p >= 'A' && *p <= 'Z') *p += 32;
      b.ctext(t, y0 + 6, 2);
      for (int i = 0; i < 3; i++) b.ctext(line(m.detail, i, l0, sizeof(l0)), y0 + 30 + i * 14, 1);
    }
  }
}

}  // namespace

void BoltLayout::render(uint8_t *bits, const ScreenModel &m, uint32_t f, uint32_t sec, bool white_is_1) {
  Gfx b(bits, EPD_W, EPD_H, white_is_1);
  b.clear(0);
  if (!screenAnimates(m.id)) f = 0;  // static screens are always frame 0
  Expr ex = exprFor(m);
  boxBot(b, 50, 36, 100, 72, ex, f);  // lower + smaller: clear of the bezel and status row
  if (m.id == Screen::Ready) zzz(b, 158, 34);
  if (m.id == Screen::Rec) {
    int w = f % 2 ? 14 : 20;
    b.ring(44, 72, w, 2, 1, 150, 210);
    b.ring(156, 72, w, 2, 1, 330, 30);
  }
  if (m.id != Screen::NoSd) {
    // cloudQ(): crossed cloud + count when clips wait on the card; plain cloud + count of
    // results still expected from the server.
    // While sending, the screen itself says so: no "waiting" cloud that reads like "offline".
    bool busy = m.id == Screen::Sending;
    // Inset ~8 px: the case bezel covers the panel edge. Counts dropped (crossed cloud = clips waiting).
    if (!busy) b.icon(m.queued ? "cloudx" : "cloud", 8, 6);
    if (m.battery_pct >= 0) battPct(b, 190, 8, m.battery_pct, m.batt);
  }
  textArea(b, m, f, sec, 116);
}

void BoltLayout::build(lv_obj_t *scr) {
  scr_ = scr;
  drawn_ = false;
  m_ = ScreenModel();
  frame_ = 0;
  timer_ = lv_timer_create(timerCb, 1000, this);
  lv_timer_pause(timer_);
}

void BoltLayout::redraw() {
  uint32_t sec = (lv_tick_get() - rec_start_) / 1000;
  render(fb_, m_, frame_, sec, true);
  for (int i = 0; i < BANDS; i++) {
    uint32_t h = 2166136261u;  // FNV-1a over the band
    const uint8_t *p = fb_ + i * BAND_ROWS * (EPD_W / 8);
    for (int k = 0; k < BAND_ROWS * (EPD_W / 8); k++) h = (h ^ p[k]) * 16777619u;
    if (drawn_ && h == band_hash_[i]) continue;
    band_hash_[i] = h;
    lv_area_t a = { 0, (int32_t)(i * BAND_ROWS), EPD_W - 1, (int32_t)(i * BAND_ROWS + BAND_ROWS - 1) };
    lv_obj_invalidate_area(scr_, &a);
  }
  drawn_ = true;
}

void BoltLayout::apply(const ScreenModel &m, bool footer_only) {
  bool entered = m.id != m_.id || !drawn_;
  m_ = m;
  if (entered) {
    frame_ = 0;
    if (m.id == Screen::Rec) rec_start_ = lv_tick_get();
    if (screenAnimates(m.id)) {
      lv_timer_reset(timer_);
      lv_timer_resume(timer_);
    } else {
      lv_timer_pause(timer_);
    }
  }
  (void)footer_only;
  redraw();
}

void BoltLayout::timerCb(lv_timer_t *t) {
  BoltLayout *self = (BoltLayout *)lv_timer_get_user_data(t);
  if (!screenAnimates(self->m_.id)) {  // belt and braces: never animate a static screen
    lv_timer_pause(t);
    return;
  }
  self->frame_++;
  self->redraw();
}

}  // namespace pv
