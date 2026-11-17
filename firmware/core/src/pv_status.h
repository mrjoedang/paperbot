// Device status report (docs/device-api.md section 7): one small POST /v1/status at the end of
// a network session that is up anyway. Pure pieces live here (unit-tested on the host):
//  - LogRing: the last plog lines in RAM that survives a reset (RTC no-init RAM on the
//    ESP32-C6, Hal::retainedRam), so the first report after a panic / watchdog says what
//    happened right before it
//  - buildStatusJson: the report body, <= STATUS_MAX_BYTES, log lines cut from the oldest
// The send policy (when, how often, with or without log) is App::statusReport (pv_app.cpp).
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace pv {

static const size_t STATUS_MAX_BYTES = 2048;  // whole body, contract limit

// Fixed slots, each with its own checksum: a reset in the middle of add() costs at most the
// line being written, never the ring. 32 slots x 152 B (+16) = 4880 B: a 2 KB report holds
// ~15-20 lines, so 8 pinned + 24 newest covers anything that can be sent. Lines can be pinned (kept until a report carried them):
// the lines before a crash, or around the first error since the last report.
class LogRing {
 public:
  static const int SLOTS = 32, TEXT = 146, PIN_CRASH = 8, PIN_BEFORE = 6, PIN_AFTER = 3;
  struct Slot {
    uint32_t seq;  // 0 = empty
    uint8_t len, ck;
    char text[TEXT];
  };
  struct Mem {
    uint32_t magic, pin_lo, pin_hi, hdr_ck;  // pinned: pin_lo <= seq < pin_hi
    Slot slots[SLOTS];
  };
  static const size_t BYTES = sizeof(Mem);

  // Adopts a retained block (>= BYTES). Valid content (magic + per-slot checksums) is kept,
  // anything else (power-on garbage) is cleared. Returns the number of lines recovered.
  // mem = nullptr: the ring stays disabled (add() does nothing, no lines).
  int attach(void *mem, size_t size);
  bool enabled() const { return m_ != nullptr; }
  void add(const char *line, size_t n);
  void pinCrash();  // pin the newest PIN_CRASH lines (call before logging anything at boot)
  void pinError();  // first error since the last report: PIN_BEFORE lines back, PIN_AFTER ahead
  void unpin();
  bool pinned() const { return m_ && m_->pin_hi > m_->pin_lo; }
  bool isPinned(uint32_t seq) const { return m_ && seq >= m_->pin_lo && seq < m_->pin_hi; }
  int count() const;
  // Valid slots in ascending seq order (oldest first); returns how many (<= max).
  int sorted(const Slot **out, int max) const;
  uint32_t nextSeq() const { return next_; }

 private:
  static uint8_t slotCk(const Slot &s);
  static uint32_t hdrCk(const Mem &m);
  void setPin(uint32_t lo, uint32_t hi);
  Mem *m_ = nullptr;
  uint32_t next_ = 1;
};

struct StatusReport {
  const char *id = "", *fw = "", *reset = "other", *ssid = "";  // ssid: network of this session
  int slot = -1;
  uint32_t boot_n = 0, up_s = 0;
  int batt_mv = -1;
  bool usb = false;
  int rssi = 0;
  uint32_t connect_ms = 0, heap = 0, heap_min = 0, q = 0, pending = 0;
  uint64_t awake_ms = 0, sleep_ms = 0;  // since the previous successful report
  uint32_t clips = 0, uploads = 0, upload_fail = 0, wifi_fail = 0, dups = 0, quarantined = 0, dropped_bytes = 0, too_short = 0,
           epd_timeouts = 0, results = 0, check_fail = 0;  // since boot
};

// JSON string body (no quotes) for n bytes of s: escapes " \ and control characters, replaces
// broken UTF-8 with '?'. Returns the length it needs; writes only if out != nullptr (no NUL).
size_t jsonEscape(char *out, const char *s, size_t n);

// Writes the report into out (cap bytes incl. the NUL; at most STATUS_MAX_BYTES are used).
// log != nullptr: adds "log":[...] with as many lines as fit - pinned lines first, then the
// newest, each run cut from its oldest end - emitted oldest first. *log_lines = lines included
// (-1 = no log member). Returns the length, 0 if even the fixed part does not fit.
size_t buildStatusJson(char *out, size_t cap, const StatusReport &r, const LogRing *log, int *log_lines);

// Reset reasons that mean "something went wrong" (the first report after one carries the log).
bool isCrashReset(const char *reason);

}  // namespace pv
