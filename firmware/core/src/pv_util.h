// Small pure pieces of the core: battery mapping, retry backoff, WAV header, SPSC ring,
// sleep decision, response parsing. No hardware access; unit-testable on the host.
#pragma once
#include <atomic>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

namespace pv {

// ---------- battery ----------
// Rough single-cell Li-ion resting curve (under load / charging it is only indicative).
int batteryPercent(int mv);
// Battery level with hysteresis: Low below low_pct, Critical below crit_pct; leaving Critical
// needs >= crit_exit_pct (the voltage recovers once the radio is off). Unknown (-1) = Ok.
// Returns 0 = ok, 1 = low, 2 = critical (pv::BattLevel values).
int batteryLevel(int pct, int prev_level, int low_pct, int crit_pct, int crit_exit_pct);

// ---------- retry backoff ----------
struct Backoff {
  uint32_t base_ms = 30000, cap_ms = 15 * 60000;
  uint32_t cur_ms = 0;   // 0 = not backing off
  uint64_t next_ms = 0;  // earliest retry time (0 = now)
  void fail(uint64_t now) {
    cur_ms = cur_ms ? (cur_ms * 2 > cap_ms ? cap_ms : cur_ms * 2) : base_ms;
    next_ms = now + cur_ms;
  }
  void success() { cur_ms = 0; next_ms = 0; }
  void retryNow() { next_ms = 0; }
  bool due(uint64_t now) const { return now >= next_ms; }
};

// ---------- WAV ----------
static const uint32_t WAV_HEADER_BYTES = 44;
void wavHeader(uint8_t out[44], uint32_t rate, uint32_t data_bytes);  // 16-bit mono PCM
// Returns data size recorded in a header, or -1 if hdr is not a PCM WAV header we wrote.
int64_t wavHeaderDataBytes(const uint8_t hdr[44]);

// ---------- single-producer single-consumer byte ring (lock-free) ----------
class Ring {
 public:
  Ring(uint8_t *buf, size_t cap) : buf_(buf), cap_(cap) {}
  void reset() { head_.store(0); tail_.store(0); }
  size_t used() const { return head_.load(std::memory_order_acquire) - tail_.load(std::memory_order_acquire); }
  size_t space() const { return cap_ - used(); }
  // Producer: copies as much as fits, returns bytes written.
  size_t push(const void *data, size_t n);
  // Consumer: copies up to n bytes, returns bytes read.
  size_t pop(void *out, size_t n);

 private:
  uint8_t *buf_;
  size_t cap_;
  std::atomic<size_t> head_{0}, tail_{0};  // free-running counters
};

// ---------- sleep decision ----------
struct SleepInputs {
  uint64_t now = 0;
  uint32_t idle_wake_s = 900;
  uint32_t pending = 0;          // queued clips
  uint64_t next_retry_ms = 0;    // backoff deadline (0 = none)
  bool uploads_possible = true;  // SD ok, battery not critical, ...
  uint64_t next_check_ms = 0;    // next result check (0 = nothing pending)
  uint64_t awake_until_ms = 0;   // console / status window
  bool stay = false;
  bool usb = false, skip_sleep_on_usb = false;
  bool boot_down = false, pwr_down = false;
};
struct SleepDecision {
  bool sleep = false;
  uint32_t ms = 0;
  const char *why = "";  // reason for staying awake (or "sleep")
};
SleepDecision decideSleep(const SleepInputs &in);

// ---------- server reply ----------
struct TaskReply {
  char kind[16] = "";
  char title[96] = "";
  bool duplicate = false;
};
// True only for a JSON object with string "kind" and "title" (the server stored the audio).
bool parseTaskReply(const char *body, TaskReply *out);

// Upload outcome classes (what to do with the clip).
enum class UploadVerdict : uint8_t { Done, Retry, Quarantine };
UploadVerdict classifyUpload(int status, bool reply_ok);

// Upper-cases ASCII in place.
void upcase(char *s);
// Copies src into dst (cap) replacing newlines/commas so it fits one CSV-ish log field.
void logSafe(char *dst, size_t cap, const char *src);

}  // namespace pv
