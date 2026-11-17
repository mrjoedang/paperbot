#include "pv_status.h"
#include <stdio.h>
#include <string.h>

namespace pv {

static const uint32_t RING_MAGIC = 0x50564c31;  // "PVL1"

uint32_t LogRing::hdrCk(const Mem &m) { return (m.magic ^ 0xa5a5f00du) + m.pin_lo * 2654435761u + (m.pin_hi ^ 0x3c6ef372u); }

uint8_t LogRing::slotCk(const Slot &s) {
  uint8_t ck = (uint8_t)(0x5a ^ s.seq ^ (s.seq >> 8) ^ (s.seq >> 16) ^ (s.seq >> 24) ^ s.len);
  for (int i = 0; i < s.len && i < TEXT; i++) ck = (uint8_t)((ck << 1 | ck >> 7) ^ (uint8_t)s.text[i]);
  return ck;
}

int LogRing::attach(void *mem, size_t size) {
  m_ = nullptr;
  next_ = 1;
  if (!mem || size < BYTES) return 0;
  m_ = (Mem *)mem;
  if (m_->magic != RING_MAGIC || m_->hdr_ck != hdrCk(*m_)) {
    memset(m_, 0, BYTES);  // power-on garbage (or another layout): start empty
    m_->magic = RING_MAGIC;
    m_->hdr_ck = hdrCk(*m_);
    return 0;
  }
  int n = 0;
  uint32_t top = 0;
  for (Slot &s : m_->slots) {
    if (!s.seq) continue;
    if (s.len > TEXT || s.ck != slotCk(s)) {
      memset(&s, 0, sizeof(s));  // torn write
      continue;
    }
    n++;
    if (s.seq > top) top = s.seq;
  }
  next_ = top + 1;
  return n;
}

void LogRing::add(const char *line, size_t n) {
  if (!m_) return;
  if (n > (size_t)TEXT) n = TEXT;
  Slot *v = nullptr, *oldest = nullptr;
  for (Slot &s : m_->slots) {
    if (!s.seq) { v = &s; break; }
    if (!oldest || s.seq < oldest->seq) oldest = &s;
    if (isPinned(s.seq)) continue;
    if (!v || s.seq < v->seq) v = &s;
  }
  if (!v) v = oldest;  // everything pinned (cannot happen with the pin sizes above)
  // seq last: a reset in between leaves an empty slot, never a half-written valid one.
  v->seq = 0;
  memcpy(v->text, line, n);
  v->len = (uint8_t)n;
  Slot tmp;
  tmp.seq = next_;
  tmp.len = v->len;
  memcpy(tmp.text, v->text, n);
  v->ck = slotCk(tmp);
  v->seq = next_++;
}

void LogRing::setPin(uint32_t lo, uint32_t hi) {
  if (!m_) return;
  m_->pin_lo = lo;
  m_->pin_hi = hi;
  m_->hdr_ck = hdrCk(*m_);
}

void LogRing::pinCrash() {
  if (next_ > 1) setPin(next_ > (uint32_t)PIN_CRASH ? next_ - PIN_CRASH : 1, next_);
}

void LogRing::pinError() {
  if (!m_ || pinned()) return;  // keep the first error: usually the cause
  setPin(next_ > (uint32_t)PIN_BEFORE ? next_ - PIN_BEFORE : 1, next_ + PIN_AFTER);
}

void LogRing::unpin() { setPin(0, 0); }

int LogRing::count() const {
  int n = 0;
  if (m_)
    for (const Slot &s : m_->slots) n += s.seq != 0;
  return n;
}

int LogRing::sorted(const Slot **out, int max) const {
  int n = 0;
  if (!m_) return 0;
  for (const Slot &s : m_->slots) {
    if (!s.seq || n >= max) continue;
    int i = n++;
    while (i > 0 && out[i - 1]->seq > s.seq) {
      out[i] = out[i - 1];
      i--;
    }
    out[i] = &s;
  }
  return n;
}

size_t jsonEscape(char *out, const char *s, size_t n) {
  size_t k = 0;
  auto put = [&](char c) {
    if (out) out[k] = c;
    k++;
  };
  for (size_t i = 0; i < n;) {
    uint8_t c = (uint8_t)s[i];
    if (c == '"' || c == '\\') {
      put('\\');
      put((char)c);
    } else if (c == '\n') {
      put('\\');
      put('n');
    } else if (c == '\r') {
      put('\\');
      put('r');
    } else if (c == '\t') {
      put('\\');
      put('t');
    } else if (c < 0x20 || c == 0x7f) {
      char b[8];
      snprintf(b, sizeof(b), "\\u%04x", c);
      for (int j = 0; j < 6; j++) put(b[j]);
    } else if (c >= 0x80) {
      // Copy a complete UTF-8 sequence; anything else (a line cut mid-character, binary) -> '?'.
      int need = c >= 0xc2 && c <= 0xdf ? 1 : c >= 0xe0 && c <= 0xef ? 2 : c >= 0xf0 && c <= 0xf4 ? 3 : 0;
      bool ok = need > 0 && i + need < n;
      for (int j = 1; ok && j <= need; j++) ok = ((uint8_t)s[i + j] & 0xc0) == 0x80;
      if (!ok) {
        put('?');
        i++;
        continue;
      }
      for (int j = 0; j <= need; j++) put(s[i + j]);
      i += need + 1;
      continue;
    } else {
      put((char)c);
    }
    i++;
  }
  return k;
}

bool isCrashReset(const char *r) {
  return !strcmp(r, "panic") || !strcmp(r, "int_wdt") || !strcmp(r, "task_wdt") || !strcmp(r, "wdt") || !strcmp(r, "brownout");
}

static void escInto(char *dst, size_t cap, const char *s) {
  size_t n = strlen(s);
  if (n > 32) n = 32;
  size_t need = jsonEscape(nullptr, s, n);
  if (need >= cap) {
    snprintf(dst, cap, "?");
    return;
  }
  jsonEscape(dst, s, n);
  dst[need] = 0;
}

size_t buildStatusJson(char *out, size_t cap, const StatusReport &r, const LogRing *log, int *log_lines) {
  if (log_lines) *log_lines = -1;
  if (!out || !cap) return 0;
  if (cap > STATUS_MAX_BYTES) cap = STATUS_MAX_BYTES;
  char id[72], fw[72], reset[72], ssid[200];
  escInto(ssid, sizeof(ssid), r.ssid);
  escInto(id, sizeof(id), r.id);
  escInto(fw, sizeof(fw), r.fw);
  escInto(reset, sizeof(reset), r.reset);
  int n = snprintf(out, cap,
                   "{\"v\":1,\"id\":\"%s\",\"fw\":\"%s\",\"slot\":%d,\"reset\":\"%s\",\"boot_n\":%u,\"up_s\":%u,\"batt_mv\":%d,\"usb\":%d,"
                   "\"ssid\":\"%s\",\"rssi\":%d,\"connect_ms\":%u,\"heap\":%u,\"heap_min\":%u,\"q\":%u,\"pending\":%u,\"awake_ms\":%llu,\"sleep_ms\":%llu,"
                   "\"stats\":{\"clips\":%u,\"uploads\":%u,\"upload_fail\":%u,\"wifi_fail\":%u,\"dups\":%u,\"quarantined\":%u,"
                   "\"dropped_bytes\":%u,\"too_short\":%u,\"epd_timeouts\":%u,\"results\":%u,\"check_fail\":%u}",
                   id, fw, r.slot, reset, (unsigned)r.boot_n, (unsigned)r.up_s, r.batt_mv, r.usb ? 1 : 0, ssid, r.rssi, (unsigned)r.connect_ms,
                   (unsigned)r.heap, (unsigned)r.heap_min, (unsigned)r.q, (unsigned)r.pending, (unsigned long long)r.awake_ms,
                   (unsigned long long)r.sleep_ms, (unsigned)r.clips, (unsigned)r.uploads, (unsigned)r.upload_fail, (unsigned)r.wifi_fail,
                   (unsigned)r.dups, (unsigned)r.quarantined, (unsigned)r.dropped_bytes, (unsigned)r.too_short, (unsigned)r.epd_timeouts,
                   (unsigned)r.results, (unsigned)r.check_fail);
  if (n < 0 || (size_t)n + 2 > cap) return 0;  // "}" + NUL must fit
  size_t pos = (size_t)n;
  static const char OPEN[] = ",\"log\":[";
  const size_t open_len = sizeof(OPEN) - 1;
  if (log && log->enabled() && pos + open_len + 3 <= cap) {  // + "]}" + NUL
    size_t budget = cap - pos - open_len - 3;
    const LogRing::Slot *v[LogRing::SLOTS];
    bool take[LogRing::SLOTS] = {};
    int k = log->sorted(v, LogRing::SLOTS), lines = 0;
    size_t used = 0;
    // Pass 0: pinned lines (crash / first error), newest first; pass 1: the newest others.
    // Each pass stops at the first line that does not fit, so what is sent is contiguous.
    for (int pass = 0; pass < 2; pass++) {
      for (int i = k - 1; i >= 0; i--) {
        if (log->isPinned(v[i]->seq) != (pass == 0)) continue;
        size_t cost = jsonEscape(nullptr, v[i]->text, v[i]->len) + 2 + (lines ? 1 : 0);
        if (used + cost > budget) break;
        take[i] = true;
        used += cost;
        lines++;
      }
    }
    memcpy(out + pos, OPEN, open_len);
    pos += open_len;
    bool first = true;
    for (int i = 0; i < k; i++) {
      if (!take[i]) continue;
      if (!first) out[pos++] = ',';
      first = false;
      out[pos++] = '"';
      pos += jsonEscape(out + pos, v[i]->text, v[i]->len);
      out[pos++] = '"';
    }
    out[pos++] = ']';
    if (log_lines) *log_lines = lines;
  }
  out[pos++] = '}';
  out[pos] = 0;
  return pos;
}

}  // namespace pv
