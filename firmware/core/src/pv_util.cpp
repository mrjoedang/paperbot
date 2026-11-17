#include "pv_util.h"
#include <stdio.h>
#include "pv_json.h"

namespace pv {

int batteryPercent(int mv) {
  static const int V[] = { 3300, 3500, 3600, 3700, 3750, 3800, 3900, 4000, 4100, 4200 };
  static const int P[] = { 0, 5, 10, 20, 30, 45, 60, 75, 90, 100 };
  if (mv < 0) return -1;
  if (mv <= V[0]) return 0;
  for (int i = 1; i < 10; i++)
    if (mv <= V[i]) return P[i - 1] + (P[i] - P[i - 1]) * (mv - V[i - 1]) / (V[i] - V[i - 1]);
  return 100;
}

int batteryLevel(int pct, int prev, int low_pct, int crit_pct, int crit_exit_pct) {
  if (pct < 0) return 0;
  if (pct < crit_pct || (prev == 2 && pct < crit_exit_pct)) return 2;
  if (pct < low_pct) return 1;
  return 0;
}

static void put16(uint8_t *p, uint16_t v) { p[0] = v; p[1] = v >> 8; }
static void put32(uint8_t *p, uint32_t v) { p[0] = v; p[1] = v >> 8; p[2] = v >> 16; p[3] = v >> 24; }
static uint32_t get32(const uint8_t *p) { return p[0] | p[1] << 8 | p[2] << 16 | (uint32_t)p[3] << 24; }

void wavHeader(uint8_t h[44], uint32_t rate, uint32_t data_bytes) {
  memcpy(h, "RIFF", 4);
  put32(h + 4, 36 + data_bytes);
  memcpy(h + 8, "WAVEfmt ", 8);
  put32(h + 16, 16);
  put16(h + 20, 1);  // PCM
  put16(h + 22, 1);  // mono
  put32(h + 24, rate);
  put32(h + 28, rate * 2);
  put16(h + 32, 2);
  put16(h + 34, 16);
  memcpy(h + 36, "data", 4);
  put32(h + 40, data_bytes);
}

int64_t wavHeaderDataBytes(const uint8_t h[44]) {
  if (memcmp(h, "RIFF", 4) || memcmp(h + 8, "WAVEfmt ", 8) || memcmp(h + 36, "data", 4)) return -1;
  return get32(h + 40);
}

size_t Ring::push(const void *data, size_t n) {
  size_t head = head_.load(std::memory_order_relaxed);
  size_t tail = tail_.load(std::memory_order_acquire);
  size_t free_ = cap_ - (head - tail);
  if (n > free_) n = free_;
  const uint8_t *src = (const uint8_t *)data;
  size_t off = head % cap_, first = n < cap_ - off ? n : cap_ - off;
  memcpy(buf_ + off, src, first);
  memcpy(buf_, src + first, n - first);
  head_.store(head + n, std::memory_order_release);
  return n;
}

size_t Ring::pop(void *out, size_t n) {
  size_t tail = tail_.load(std::memory_order_relaxed);
  size_t head = head_.load(std::memory_order_acquire);
  size_t avail = head - tail;
  if (n > avail) n = avail;
  uint8_t *dst = (uint8_t *)out;
  size_t off = tail % cap_, first = n < cap_ - off ? n : cap_ - off;
  memcpy(dst, buf_ + off, first);
  memcpy(dst + first, buf_, n - first);
  tail_.store(tail + n, std::memory_order_release);
  return n;
}

SleepDecision decideSleep(const SleepInputs &in) {
  SleepDecision d;
  // Level wake: sleeping with a button held would wake immediately (or lose the press).
  if (in.boot_down) { d.why = "boot_down"; return d; }
  if (in.pwr_down) { d.why = "pwr_down"; return d; }
  if (in.stay) { d.why = "stay"; return d; }
  if (in.now < in.awake_until_ms) { d.why = "window"; return d; }
  if (in.usb && in.skip_sleep_on_usb) { d.why = "usb"; return d; }
  uint64_t ms = (uint64_t)in.idle_wake_s * 1000;
  if (in.pending && in.uploads_possible) {
    if (in.next_retry_ms <= in.now) { d.why = "upload_due"; return d; }  // caller should upload first
    uint64_t left = in.next_retry_ms - in.now;
    if (left < ms) ms = left;
  }
  if (in.next_check_ms && in.uploads_possible) {
    if (in.next_check_ms <= in.now) { d.why = "check_due"; return d; }  // caller should check first
    uint64_t left = in.next_check_ms - in.now;
    if (left < ms) ms = left;
  }
  if (ms < 1) ms = 1;
  d.sleep = true;
  d.ms = (uint32_t)ms;
  d.why = "sleep";
  return d;
}

bool parseTaskReply(const char *body, TaskReply *out) {
  JsonField f[3];
  f[0].key = "kind"; f[0].str = out->kind; f[0].cap = sizeof(out->kind);
  f[1].key = "title"; f[1].str = out->title; f[1].cap = sizeof(out->title);
  f[2].key = "duplicate";
  if (!jsonReadObject(body, f, 3)) return false;
  out->duplicate = f[2].type == JsonType::Bool && f[2].b;
  return f[0].type == JsonType::String && f[1].type == JsonType::String && out->kind[0];
}

UploadVerdict classifyUpload(int status, bool reply_ok) {
  if (status >= 200 && status < 300) return reply_ok ? UploadVerdict::Done : UploadVerdict::Retry;
  // 400 / 413 / 415 / 422: the server will never accept this file; keep it aside so it does
  // not block the queue forever. 401/403 (token), 404 (URL), 408, 429 and 5xx may recover.
  if (status == 400 || status == 413 || status == 415 || status == 422) return UploadVerdict::Quarantine;
  return UploadVerdict::Retry;
}

void upcase(char *s) {
  for (; *s; s++)
    if (*s >= 'a' && *s <= 'z') *s -= 32;
}

void logSafe(char *dst, size_t cap, const char *src) {
  snprintf(dst, cap, "%s", src);
  for (char *c = dst; *c; c++)
    if (*c == '\n') *c = '|';
    else if (*c == ',') *c = ';';
}

}  // namespace pv
