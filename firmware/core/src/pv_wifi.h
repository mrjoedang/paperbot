// Wi-Fi "places" (docs/device-api.md section 8): the server's list of networks for this device
// (<= 8, stored in NVS, replaced only by a fully parsed + saved new list) plus the network
// compiled into the firmware as a permanent fallback, and a battery-minded connect strategy:
//  1. the network that worked last time, straight to its AP (BSSID + channel, no scan); not
//     when that was a hotspot (prio 9) and other networks are known
//  2. only one known network: let the driver find it (as before the list existed)
//  3. else one scan, then the known networks that are present: prio (0 first, 9 = hotspot =
//     last), then signal; each attempt <= 6 s; everything inside one budget (Config::wifi_timeout_ms)
// A network that rejected its password is skipped for a while (10 min, doubling to 6 h) as long
// as another known network exists.
#pragma once
#include "pv_hal.h"

namespace pv {

struct WifiNet {
  char ssid[33];  // exact bytes
  char psk[65];   // "" = open; 8..63 chars or 64 hex
  uint8_t prio;   // 0..9, lower first; 9 = hotspot / last resort
};

class WifiPlaces {
 public:
  static const int MAX = 8;                // networks from the server
  static const uint8_t BUILTIN_PRIO = 8;   // secrets.h network: after listed ones, before hotspots
  typedef void (*LogFn)(void *ctx, const char *line);

  // NVS: the list and the last network that worked. buf: scratch (>= 2 KB).
  void load(Hal &hal, char *buf, size_t cap, LogFn log, void *log_ctx);
  uint32_t rev() const { return rev_; }
  int count() const { return n_; }
  const WifiNet &at(int i) const { return nets_[i]; }
  WifiResult connect(Hal &hal, uint32_t budget_ms, bool (*abort)(void *), void *ctx, int *rssi);
  const char *ssid() const { return cur_ssid_; }  // network of the last successful connect ("" = none yet)
  // A GET /v1/wifi reply: validated completely, saved to NVS, then used. Anything wrong -> the
  // old list stays and false (why = reason). json and scratch may be the same buffer.
  // force: also an older / equal revision (setup over USB replaces whatever the device had).
  bool adopt(Hal &hal, const char *json, char *scratch, size_t cap, char *why, size_t why_cap, bool force = false);

 private:
  struct Cand {
    const char *ssid, *psk;
    uint8_t prio;
  };
  struct Back {
    uint32_t h;
    uint8_t fails;
    uint64_t until;
  };
  int candidates(Hal &hal, Cand *out, char *bssid_ssid, char *bpsk);
  Back *back(const char *ssid, bool create);
  void logf(const char *fmt, ...);

  WifiNet nets_[MAX];
  int n_ = 0;
  uint32_t rev_ = 0;
  char last_ssid_[33] = "", cur_ssid_[33] = "";
  uint8_t last_bssid_[6] = {}, last_ch_ = 0;
  bool has_last_ = false;
  Back back_[MAX + 1] = {};
  LogFn log_ = nullptr;
  void *log_ctx_ = nullptr;
};

}  // namespace pv
