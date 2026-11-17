#include "pv_wifi.h"
#include "pv_json.h"
#include "pv_util.h"
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

namespace pv {

static const uint32_t LAST_MS = 5000, JOIN_MS = 6000, MIN_TRY_MS = 1500, BACK_MIN_MS = 10 * 60000, BACK_MAX_MS = 6 * 3600000;

static void hexEnc(const char *s, char *out) {
  static const char H[] = "0123456789abcdef";
  size_t n = strlen(s);
  for (size_t i = 0; i < n; i++) {
    out[2 * i] = H[(uint8_t)s[i] >> 4];
    out[2 * i + 1] = H[(uint8_t)s[i] & 15];
  }
  out[2 * n] = 0;
}

static int hexVal(char c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1; }

// Decodes a hex token of at most (cap-1) bytes; false on bad input.
static bool hexDec(const char *h, size_t hn, char *out, size_t cap) {
  if (hn % 2 || hn / 2 >= cap) return false;
  for (size_t i = 0; i < hn / 2; i++) {
    int a = hexVal(h[2 * i]), b = hexVal(h[2 * i + 1]);
    if (a < 0 || b < 0 || (a == 0 && b == 0)) return false;
    out[i] = (char)(a << 4 | b);
  }
  out[hn / 2] = 0;
  return true;
}

static uint32_t fnv(const char *s) {
  uint32_t h = 2166136261u;
  for (; *s; s++) h = (h ^ (uint8_t)*s) * 16777619u;
  return h ? h : 1;
}

void WifiPlaces::logf(const char *fmt, ...) {
  if (!log_) return;
  char b[200];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(b, sizeof(b), fmt, ap);
  va_end(ap);
  log_(log_ctx_, b);
}

// NVS "wifi": "1 <rev>\n" then "<prio> <hex ssid> <hex psk|->\n" per network.
// NVS "wifi_last": "<hex ssid> <bssid 12 hex> <channel>".
void WifiPlaces::load(Hal &hal, char *buf, size_t cap, LogFn log, void *log_ctx) {
  log_ = log;
  log_ctx_ = log_ctx;
  n_ = 0;
  rev_ = 0;
  if (hal.kvGet("wifi", buf, cap)) {
    unsigned ver = 0, rev = 0;
    const char *p = buf;
    WifiNet tmp[MAX];
    int n = 0;
    bool ok = sscanf(p, "%u %u", &ver, &rev) == 2 && ver == 1;
    for (p = strchr(p, '\n'); ok && p && p[1]; p = strchr(p + 1, '\n')) {
      unsigned prio;
      char hs[70], hp[140];
      if (n >= MAX || sscanf(p + 1, "%u %69s %139s", &prio, hs, hp) != 3 || prio > 9) { ok = false; break; }
      tmp[n].prio = (uint8_t)prio;
      ok = hexDec(hs, strlen(hs), tmp[n].ssid, sizeof(tmp[n].ssid)) &&
           (!strcmp(hp, "-") ? (tmp[n].psk[0] = 0, true) : hexDec(hp, strlen(hp), tmp[n].psk, sizeof(tmp[n].psk)));
      n++;
    }
    if (ok) {
      memcpy(nets_, tmp, sizeof(WifiNet) * n);
      n_ = n;
      rev_ = rev;
    } else {
      logf("WIFI,warn=stored list unreadable");
    }
  }
  char l[64];
  if (hal.kvGet("wifi_last", l, sizeof(l))) {
    char hs[70], hb[16];
    unsigned ch = 0;
    has_last_ = sscanf(l, "%69s %15s %u", hs, hb, &ch) == 3 && hexDec(hs, strlen(hs), last_ssid_, sizeof(last_ssid_)) && strlen(hb) == 12 &&
                ch > 0 && ch < 200;
    for (int i = 0; has_last_ && i < 6; i++) {
      int a = hexVal(hb[2 * i]), b = hexVal(hb[2 * i + 1]);
      if (a < 0 || b < 0) has_last_ = false;
      else last_bssid_[i] = (uint8_t)(a << 4 | b);
    }
    last_ch_ = (uint8_t)ch;
  }
  hal.setWifiRev(rev_);
}

int WifiPlaces::candidates(Hal &hal, Cand *out, char *bssid, char *bpsk) {
  int n = 0;
  for (int i = 0; i < n_; i++) out[n++] = { nets_[i].ssid, nets_[i].psk, nets_[i].prio };
  if (hal.wifiBuiltin(bssid, 33, bpsk, 65) && bssid[0]) {
    bool dup = false;
    for (int i = 0; i < n_; i++) dup |= !strcmp(nets_[i].ssid, bssid);  // the server's entry wins
    if (!dup) out[n++] = { bssid, bpsk, BUILTIN_PRIO };
  }
  return n;
}

WifiPlaces::Back *WifiPlaces::back(const char *ssid, bool create) {
  uint32_t h = fnv(ssid);
  Back *free_slot = nullptr;
  for (Back &b : back_) {
    if (b.h == h) return &b;
    if (!b.h && !free_slot) free_slot = &b;
  }
  if (!create) return nullptr;
  if (!free_slot) free_slot = &back_[0];
  *free_slot = { h, 0, 0 };
  return free_slot;
}

WifiResult WifiPlaces::connect(Hal &hal, uint32_t budget_ms, bool (*abort)(void *), void *ctx, int *rssi) {
  uint64_t t0 = hal.millis();
  Cand c[MAX + 1];
  char bssid_ssid[33] = "", bpsk[65] = "";
  int n = candidates(hal, c, bssid_ssid, bpsk);
  bool tried[MAX + 1] = {};
  if (rssi) *rssi = 0;
  if (!n) return WifiResult::NoSsid;
  auto left = [&]() -> uint32_t {
    uint64_t e = hal.millis() - t0;
    return e < budget_ms ? (uint32_t)(budget_ms - e) : 0;
  };
  auto skipped = [&](int i) {  // backed off after a wrong password (only while there is an alternative)
    Back *b = back(c[i].ssid, false);
    return n > 1 && b && b->until > hal.millis();
  };
  auto attempt = [&](int i, const uint8_t *bssid, uint8_t ch, const char *how, uint32_t cap) {
    uint32_t to = left() < cap ? left() : cap;
    uint64_t ta = hal.millis();
    WifiAp ap;
    WifiResult r = hal.wifiJoin(c[i].ssid, c[i].psk, bssid, ch, to, abort, ctx, &ap);
    tried[i] = true;
    char s[40];
    logSafe(s, sizeof(s), c[i].ssid);
    logf("WIFI,how=%s,ssid=%s,ch=%u,result=%d,ms=%u", how, s, (unsigned)ch, (int)r, (unsigned)(hal.millis() - ta));
    if (r == WifiResult::Ok) {
      snprintf(cur_ssid_, sizeof(cur_ssid_), "%s", c[i].ssid);
      if (rssi) *rssi = ap.rssi;
      if (Back *b = back(c[i].ssid, false)) *b = {};
      if (!has_last_ || strcmp(last_ssid_, c[i].ssid) || memcmp(last_bssid_, ap.bssid, 6) || last_ch_ != ap.channel) {
        has_last_ = true;
        snprintf(last_ssid_, sizeof(last_ssid_), "%s", c[i].ssid);
        memcpy(last_bssid_, ap.bssid, 6);
        last_ch_ = ap.channel;
        char hs[70], v[96];
        hexEnc(last_ssid_, hs);
        snprintf(v, sizeof(v), "%s %02x%02x%02x%02x%02x%02x %u", hs, ap.bssid[0], ap.bssid[1], ap.bssid[2], ap.bssid[3], ap.bssid[4],
                 ap.bssid[5], (unsigned)ap.channel);
        hal.kvSet("wifi_last", v);
      }
    } else if (r == WifiResult::Failed) {
      Back *b = back(c[i].ssid, true);
      uint32_t ms = BACK_MIN_MS << (b->fails < 6 ? b->fails : 6);
      if (ms > BACK_MAX_MS) ms = BACK_MAX_MS;
      b->fails++;
      b->until = hal.millis() + ms;
      if (n > 1) logf("WIFI,backoff=%s,min=%u", s, (unsigned)(ms / 60000));
    }
    return r;
  };

  WifiResult last = WifiResult::NoSsid;
  // 1. the network that worked last time, straight to its AP - unless that was a hotspot
  //    (prio 9) and other networks are known: then scan, a real network may be back
  int li = -1;
  for (int i = 0; has_last_ && i < n; i++)
    if (!strcmp(c[i].ssid, last_ssid_)) li = i;
  if (li >= 0 && !skipped(li) && (c[li].prio < 9 || n == 1)) {
    last = attempt(li, last_bssid_, last_ch_, "last", LAST_MS);
    if (last == WifiResult::Ok || last == WifiResult::Aborted) return last;
  }
  // 2. a single known network: the driver finds it (no extra scan)
  if (n == 1) {
    if (tried[0] || left() < MIN_TRY_MS) return last;
    return attempt(0, nullptr, 0, "direct", budget_ms);
  }
  // 3. one scan; known networks that are present, by prio then signal
  if (abort && abort(ctx)) return WifiResult::Aborted;
  if (left() < 2 * MIN_TRY_MS) return last;
  WifiAp aps[16];
  int m = hal.wifiScan(aps, 16);
  struct Opt {
    int ci, ai;
  } o[MAX + 1];
  int k = 0;
  for (int i = 0; i < n; i++) {
    if (tried[i] || skipped(i)) continue;
    int best = -1;
    for (int a = 0; a < m; a++)
      if (!strcmp(aps[a].ssid, c[i].ssid) && (best < 0 || aps[a].rssi > aps[best].rssi)) best = a;
    if (best < 0) continue;
    int j = k++;
    while (j > 0 && (c[o[j - 1].ci].prio > c[i].prio || (c[o[j - 1].ci].prio == c[i].prio && aps[o[j - 1].ai].rssi < aps[best].rssi))) {
      o[j] = o[j - 1];
      j--;
    }
    o[j] = { i, best };
  }
  logf("WIFI,scan=%d,known=%d,ms=%u", m, k, (unsigned)(hal.millis() - t0));
  for (int j = 0; j < k; j++) {
    if (left() < MIN_TRY_MS) break;
    if (abort && abort(ctx)) return WifiResult::Aborted;
    WifiResult r = attempt(o[j].ci, aps[o[j].ai].bssid, aps[o[j].ai].channel, "scan", JOIN_MS);
    if (r == WifiResult::Ok || r == WifiResult::Aborted) return r;
    last = r;
  }
  return last;
}

bool WifiPlaces::adopt(Hal &hal, const char *json, char *scratch, size_t cap, char *why, size_t why_cap, bool force) {
  JsonField f[2];
  f[0].key = "rev";
  f[1].key = "networks";
  auto no = [&](const char *w) {
    snprintf(why, why_cap, "%s", w);
    return false;
  };
  if (!jsonReadObject(json, f, 2)) return no("bad_json");
  if (f[0].type != JsonType::Number || f[0].num < 1 || f[0].num > 4e9 || f[0].num != (double)(uint32_t)f[0].num) return no("bad_rev");
  if (f[1].type != JsonType::Array) return no("no_networks");
  uint32_t rev = (uint32_t)f[0].num;
  if (rev <= rev_ && !force) return no("not_newer");
  struct Ctx {
    WifiNet tmp[MAX];
    int n = 0;
    const char *err = nullptr;
  } cx;
  int objs = jsonForEachObject(json, "networks", [](const char *obj, void *vp) {
    Ctx *c = (Ctx *)vp;
    if (c->err) return;
    if (c->n >= MAX) { c->err = "too_many"; return; }
    char ssid[64], psk[128];  // roomy: a cut (UTF-8-safe) copy of an over-long value must still read as too long
    JsonField g[3];
    g[0].key = "ssid";
    g[0].str = ssid;
    g[0].cap = sizeof(ssid);
    g[1].key = "psk";
    g[1].str = psk;
    g[1].cap = sizeof(psk);
    g[2].key = "prio";
    if (!jsonReadObjectPrefix(obj, g, 3) || g[0].type != JsonType::String) { c->err = "bad_entry"; return; }
    size_t sl = strlen(ssid), pl = g[1].type == JsonType::String ? strlen(psk) : 0;
    if (sl < 1 || sl > 32) { c->err = "bad_ssid"; return; }
    if (g[1].type != JsonType::String && g[1].type != JsonType::Missing && g[1].type != JsonType::Null) { c->err = "bad_psk"; return; }
    if (pl && (pl < 8 || pl > 64)) { c->err = "bad_psk"; return; }
    double pr = g[2].type == JsonType::Number ? g[2].num : g[2].type == JsonType::Missing ? 5 : -1;
    if (pr < 0 || pr > 9 || pr != (int)pr) { c->err = "bad_prio"; return; }
    WifiNet &w = c->tmp[c->n++];
    memcpy(w.ssid, ssid, sl + 1);
    memcpy(w.psk, psk, pl);
    w.psk[pl] = 0;
    w.prio = (uint8_t)pr;
  }, &cx);
  if (objs < 0) return no("bad_networks");
  if (cx.err) return no(cx.err);
  if (objs != cx.n) return no("too_many");
  // Save first (one NVS entry: old or new, never half), then use.
  int len = snprintf(scratch, cap, "1 %u\n", (unsigned)rev);
  for (int i = 0; i < cx.n && len > 0 && (size_t)len < cap; i++) {
    char hs[70], hp[140];
    hexEnc(cx.tmp[i].ssid, hs);
    if (cx.tmp[i].psk[0]) hexEnc(cx.tmp[i].psk, hp);
    else snprintf(hp, sizeof(hp), "-");
    len += snprintf(scratch + len, cap - len, "%u %s %s\n", (unsigned)cx.tmp[i].prio, hs, hp);
  }
  if (len <= 0 || (size_t)len >= cap) return no("too_big");
  if (!hal.kvSet("wifi", scratch)) return no("save_failed");
  memcpy(nets_, cx.tmp, sizeof(WifiNet) * cx.n);
  n_ = cx.n;
  rev_ = rev;
  memset(back_, 0, sizeof(back_));  // new passwords: forget the back-offs
  hal.setWifiRev(rev_);
  snprintf(why, why_cap, "ok");
  return true;
}

}  // namespace pv
