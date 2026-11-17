#include "pv_ota.h"
#include "pv_json.h"
#include "pv_queue.h"
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

namespace pv {

// NVS notes (survive the install reboot and a rollback):
//   ota_pend  version just installed (cleared once confirmed / when the rollback is noticed)
//   ota_prev  version that installed it (= what a rollback returns to)
//   ota_bad   "<version> <n>": that version rolled back n times
static const char *K_PEND = "ota_pend", *K_PREV = "ota_prev", *K_BAD = "ota_bad";

FwVersion parseFwVersion(const char *s) {
  FwVersion v;
  if (!s) return v;
  if (*s == 'v') s++;
  int part[3];
  for (int i = 0; i < 3; i++) {
    if (*s < '0' || *s > '9') return v;
    int n = 0, digits = 0;
    while (*s >= '0' && *s <= '9') {
      n = n * 10 + (*s++ - '0');
      if (++digits > 4) return v;
    }
    part[i] = n;
    if (i < 2 && *s++ != '.') return v;
  }
  if (*s) return v;
  v.major = part[0];
  v.minor = part[1];
  v.patch = part[2];
  return v;
}

int compareFwVersion(const FwVersion &a, const FwVersion &b) {
  if (a.major != b.major) return a.major < b.major ? -1 : 1;
  if (a.minor != b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch != b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

bool fwNewer(const char *offered, const char *current) {
  FwVersion o = parseFwVersion(offered), c = parseFwVersion(current);
  return o.valid() && c.valid() && compareFwVersion(o, c) > 0;
}

bool parseFwOffer(const char *json, FwOffer *o) {
  *o = FwOffer();
  char sha[72] = "", sig[176] = "";
  JsonField f[5];
  f[0].key = "version"; f[0].str = o->version; f[0].cap = sizeof(o->version);
  f[1].key = "url"; f[1].str = o->url; f[1].cap = sizeof(o->url);
  f[2].key = "size";
  f[3].key = "sha256"; f[3].str = sha; f[3].cap = sizeof(sha);
  f[4].key = "sig"; f[4].str = sig; f[4].cap = sizeof(sig);
  if (!jsonReadObject(json, f, 5)) return false;
  if (f[0].type != JsonType::String || !parseFwVersion(o->version).valid()) return false;
  if (f[1].type != JsonType::String || !o->url[0] || strlen(o->url) >= sizeof(o->url) - 1) return false;
  if (f[2].type != JsonType::Number || f[2].num < 1 || f[2].num > 64.0 * 1024 * 1024 || f[2].num != (double)(uint32_t)f[2].num) return false;
  o->size = (uint32_t)f[2].num;
  if (f[3].type != JsonType::String || strlen(sha) != 64 || !hexDecode(sha, o->sha256, 32)) return false;
  if (f[4].type == JsonType::String && sig[0]) {
    size_t n = strlen(sig);
    if (n % 2 || n / 2 > sizeof(o->sig) || !hexDecode(sig, o->sig, n / 2)) return false;
    o->sig_len = (uint8_t)(n / 2);
  } else if (f[4].type != JsonType::Missing && f[4].type != JsonType::Null && f[4].type != JsonType::String) {
    return false;
  }
  return true;
}

void fwManifestDigest(const FwOffer &o, uint8_t out[32]) {
  char hex[65], msg[128];
  hexEncode(o.sha256, 32, hex);
  int n = snprintf(msg, sizeof(msg), "pocket-voice-fw/1\n%s\n%u\n%s\n", o.version, (unsigned)o.size, hex);
  sha256(msg, (size_t)n, out);
}

const char *otaOutcomeName(OtaOutcome o) {
  static const char *n[] = { "none", "uptodate", "no_server_support", "deferred", "later", "rejected", "failed", "aborted", "installed" };
  return n[(int)o];
}

void Ota::logf(const OtaIo &io, const char *fmt, ...) {
  if (!io.log) return;
  char line[200];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(line, sizeof(line), fmt, ap);
  va_end(ap);
  io.log(io.ctx, line);
}

uint32_t Ota::attempts(const char *version) {
  char bad[32];
  if (!hal_.kvGet(K_BAD, bad, sizeof(bad))) return 0;
  char v[16];
  unsigned n = 0;
  if (sscanf(bad, "%15s %u", v, &n) != 2 || strcmp(v, version)) return 0;
  return n;
}

Ota::BootEvent Ota::boot(uint64_t now, const OtaIo &io) {
  boot_ms_ = now;
  last_check_ms_ = now;  // the dedicated daily check waits a day; piggyback checks may run at once
  next_check_ms_ = 0;
  const char *cur = hal_.fwVersion();
  verifying_ = hal_.otaPendingVerify();
  char pend[16] = "", prev[16] = "";
  hal_.kvGet(K_PEND, pend, sizeof(pend));
  hal_.kvGet(K_PREV, prev, sizeof(prev));
  BootEvent ev = BootEvent::None;
  if (pend[0]) {
    if (!strcmp(cur, pend)) {
      if (verifying_) {
        ev = BootEvent::Updated;
        snprintf(event_version_, sizeof(event_version_), "%s", pend);
      } else {  // confirmed earlier, the note just was not cleared
        hal_.kvSet(K_PEND, "");
        hal_.kvSet(K_PREV, "");
      }
    } else {
      if (!strcmp(cur, prev)) {
        // The installed image reset before confirming itself: the bootloader went back.
        ev = BootEvent::RolledBack;
        snprintf(event_version_, sizeof(event_version_), "%s", pend);
        char bad[32];
        snprintf(bad, sizeof(bad), "%s %u", pend, (unsigned)(attempts(pend) + 1));
        hal_.kvSet(K_BAD, bad);
      }
      hal_.kvSet(K_PEND, "");
      hal_.kvSet(K_PREV, "");
    }
  }
  logf(io, "OTA,boot,fw=%s,slot=%d,pending_verify=%d,event=%s,version=%s", cur, hal_.otaRunningSlot(), verifying_,
       ev == BootEvent::Updated ? "updated" : ev == BootEvent::RolledBack ? "rolled_back" : "none", event_version_);
  return ev;
}

bool Ota::maybeConfirm(uint64_t now, bool base_ok, bool server_ok) {
  if (!verifying_ || !base_ok) return false;
  if (!server_ok && now - boot_ms_ < cfg_.verify_uptime_ms) return false;
  if (!hal_.otaMarkValid()) return false;  // try again on the next loop
  verifying_ = false;
  hal_.kvSet(K_PEND, "");
  hal_.kvSet(K_PREV, "");
  return true;
}

bool Ota::checkDue(uint64_t now, const char *hint) const {
  if (!cfg_.enabled || verifying_ || hal_.otaRunningSlot() < 0) return false;
  if (install_at_ms_ && now >= install_at_ms_) return true;
  if (now >= next_check_ms_) return true;
  // The server says it has something newer: check now (once per advertised version).
  return hint && hint[0] && strcmp(hint, handled_hint_) && fwNewer(hint, hal_.fwVersion()) && fails_ == 0;
}

bool Ota::dedicatedDue(uint64_t now, bool batt_ok) const {
  if (!cfg_.enabled || verifying_ || !batt_ok || hal_.otaRunningSlot() < 0) return false;
  if (install_at_ms_) return now >= install_at_ms_;
  if (fails_) return now >= next_check_ms_;  // a failed download is retried on its backoff (1 h, 2 h, ...)
  return now >= next_check_ms_ && now - last_check_ms_ >= cfg_.check_interval_ms;
}

void Ota::schedule(uint64_t now, uint32_t delay_ms) {
  last_check_ms_ = now;
  next_check_ms_ = now + delay_ms;
}

void Ota::noNetwork(uint64_t now, bool user_busy) {
  ping_done_ = true;
  if (install_at_ms_) install_at_ms_ = now + (user_busy ? cfg_.quiet_ms : cfg_.retry_base_ms);
  if (now >= next_check_ms_) next_check_ms_ = now + cfg_.retry_base_ms;
  if (!user_busy) last_check_ms_ = now;
}

OtaOutcome Ota::reject(uint64_t now, const char *reason, const OtaIo &io) {
  reason_ = reason;
  install_at_ms_ = 0;
  fails_ = 0;
  schedule(now, cfg_.check_interval_ms);
  logf(io, "OTA,reject,version=%s,reason=%s", offer_version_, reason);
  return OtaOutcome::Rejected;
}

namespace {
struct Dl {
  Hal *hal;
  const OtaIo *io;
  const char *version;
  Sha256 sha;
  uint32_t size = 0, got = 0;
  int32_t clen = -1;
  int shown = -1;
  bool aborted = false, write_fail = false, too_long = false, bad_len = false;
};

bool sink(void *c, const uint8_t *d, size_t n) {
  Dl *x = (Dl *)c;
  if (x->clen >= 0 && (uint32_t)x->clen != x->size) { x->bad_len = true; return false; }  // announced length != offer
  if (x->io->abort && x->io->abort(x->io->ctx)) { x->aborted = true; return false; }
  if (x->got + n > x->size) { x->too_long = true; return false; }
  x->sha.update(d, n);
  if (!x->hal->otaWrite(d, n)) { x->write_fail = true; return false; }
  x->got += (uint32_t)n;
  int pct = (int)((uint64_t)x->got * 100 / x->size) / 10 * 10;
  if (pct != x->shown && pct < 100) {
    x->shown = pct;
    if (x->io->progress) x->io->progress(x->io->ctx, x->version, pct);
  }
  return true;
}
}  // namespace

OtaOutcome Ota::run(UploadQueue &q, uint64_t now, bool queue_empty, bool batt_ok, bool may_install, const OtaIo &io) {
  reason_ = "";
  dl_started_ = false;
  offer_version_[0] = 0;
  const char *cur = hal_.fwVersion();
  int running = hal_.otaRunningSlot();
  if (!cfg_.enabled || running < 0 || verifying_) return OtaOutcome::None;
  // Gates first: no radio time for a check we could not act on.
  if (!queue_empty) {
    // Clips first. The piggyback check stays due (the session that drains the queue does it);
    // only a dedicated session waits.
    reason_ = "queue";
    logf(io, "OTA,defer,reason=%s", reason_);
    last_check_ms_ = now;
    if (install_at_ms_) install_at_ms_ = now + cfg_.quiet_ms;
    return OtaOutcome::Deferred;
  }
  if (!batt_ok) {
    reason_ = "battery";
    logf(io, "OTA,defer,reason=%s", reason_);
    last_check_ms_ = now;
    next_check_ms_ = now + cfg_.retry_base_ms;
    if (install_at_ms_) install_at_ms_ = now + cfg_.retry_base_ms;
    return OtaOutcome::Deferred;
  }
  snprintf(handled_hint_, sizeof(handled_hint_), "%s", q.fwLatest());
  char path[96];
  snprintf(path, sizeof(path), "/v1/firmware?current=%s&device=%s", cur, hal_.deviceId());
  HttpResult h = q.get(path, cfg_.meta_timeout_ms);
  logf(io, "OTA,check,fw=%s,status=%d,len=%d,hint=%s", cur, h.status, h.body_len, handled_hint_);
  if (h.status == 204) {
    install_at_ms_ = 0;
    fails_ = 0;
    schedule(now, cfg_.check_interval_ms);
    return OtaOutcome::UpToDate;
  }
  if (h.status == 404 || h.status == 405 || h.status == 501) {  // server without the endpoint
    install_at_ms_ = 0;
    fails_ = 0;
    schedule(now, cfg_.check_interval_ms);
    return OtaOutcome::NoServerSupport;
  }
  if (h.status != 200) {
    reason_ = "check_failed";
    schedule(now, cfg_.retry_base_ms);
    if (install_at_ms_) install_at_ms_ = now + cfg_.retry_base_ms;
    return OtaOutcome::Failed;
  }
  FwOffer o;
  if (!parseFwOffer(q.body(), &o)) return reject(now, "bad_offer", io);
  snprintf(offer_version_, sizeof(offer_version_), "%s", o.version);
  if (!fwNewer(o.version, cur)) return reject(now, "not_newer", io);
  if (attempts(o.version) >= cfg_.max_attempts) return reject(now, "rolled_back_before", io);
  int target = 1 - running;
  if (o.size > hal_.otaSlotSize(target)) return reject(now, "too_big", io);
  if (cfg_.require_signature) {
    uint8_t digest[32];
    fwManifestDigest(o, digest);
    if (!o.sig_len) return reject(now, "unsigned", io);
    if (!hal_.otaVerifySignature(digest, o.sig, o.sig_len)) return reject(now, "signature", io);
  }
  if (!may_install) {
    // The user is looking at a fresh result: do not replace it with UPDATING + a reboot.
    install_at_ms_ = now + cfg_.quiet_ms;
    last_check_ms_ = now;
    next_check_ms_ = install_at_ms_;
    logf(io, "OTA,later,version=%s,in_s=%u", o.version, (unsigned)(cfg_.quiet_ms / 1000));
    return OtaOutcome::Later;
  }
  install_at_ms_ = 0;
  // ---- download into the other slot ----
  char url[320];
  bool auth;
  const char *base = q.serverUrl();
  if (o.url[0] == '/') {
    snprintf(url, sizeof(url), "%s%s", base, o.url);
    auth = true;
  } else {
    snprintf(url, sizeof(url), "%s", o.url);
    auth = base[0] && !strncmp(o.url, base, strlen(base)) && (o.url[strlen(base)] == '/' || !o.url[strlen(base)]);
  }
  logf(io, "OTA,download,version=%s,size=%u,slot=%d,running=%d,auth=%d", o.version, (unsigned)o.size, target, running, auth);
  if (!hal_.otaBegin(target, o.size)) {
    reason_ = "flash_begin";
    fails_++;
    schedule(now, cfg_.retry_base_ms);
    logf(io, "OTA,fail,version=%s,reason=%s", o.version, reason_);
    return OtaOutcome::Failed;
  }
  dl_started_ = true;
  Dl dl;
  dl.hal = &hal_;
  dl.io = &io;
  dl.version = o.version;
  dl.size = o.size;
  if (io.progress) io.progress(io.ctx, o.version, 0);
  dl.shown = 0;
  uint64_t t0 = hal_.millis();
  HttpResult r = hal_.httpGetStream(url, auth, sink, &dl, cfg_.download_timeout_ms, &dl.clen);
  uint8_t got_hash[32];
  dl.sha.finish(got_hash);
  bool hash_ok = memcmp(got_hash, o.sha256, 32) == 0;
  if (dl.aborted) reason_ = "aborted";
  else if (dl.write_fail) reason_ = "flash_write";
  else if (dl.bad_len) reason_ = "length";
  else if (dl.too_long) reason_ = "too_long";
  else if (r.status > 0 && r.status != 200) reason_ = "http";  // 404 / 500 ...: nothing written
  else if (dl.got != o.size) reason_ = "truncated";            // connection lost / timeout mid-body
  else if (r.status != 200) reason_ = "http";
  else if (!hash_ok) reason_ = "sha256";
  char hex[65];
  hexEncode(got_hash, 32, hex);
  logf(io, "OTA,downloaded,version=%s,status=%d,bytes=%u,ms=%u,sha256=%.16s,ok=%d", o.version, r.status, (unsigned)dl.got,
       (unsigned)(hal_.millis() - t0), hex, !reason_[0]);
  if (reason_[0]) {
    hal_.otaEnd(false);  // abandon: boot slot unchanged
    if (dl.aborted) {
      install_at_ms_ = now + cfg_.quiet_ms;  // user is busy: try again in a quiet moment
      last_check_ms_ = now;
      logf(io, "OTA,abort,version=%s,reason=boot", o.version);
      return OtaOutcome::Aborted;
    }
    fails_++;
    uint64_t back = (uint64_t)cfg_.retry_base_ms << (fails_ - 1 < 5 ? fails_ - 1 : 5);
    schedule(now, (uint32_t)(back < cfg_.check_interval_ms ? back : cfg_.check_interval_ms));
    logf(io, "OTA,fail,version=%s,reason=%s,fails=%u,retry_s=%u", o.version, reason_, (unsigned)fails_,
         (unsigned)((next_check_ms_ - now) / 1000));
    return OtaOutcome::Failed;
  }
  // Notes for the next boot first: a power cut after the commit then still knows what it ran.
  hal_.kvSet(K_PREV, cur);
  hal_.kvSet(K_PEND, o.version);
  if (!hal_.otaEnd(true)) {
    hal_.kvSet(K_PEND, "");
    hal_.kvSet(K_PREV, "");
    reason_ = "image_invalid";
    fails_++;
    schedule(now, cfg_.check_interval_ms);
    logf(io, "OTA,fail,version=%s,reason=%s", o.version, reason_);
    return OtaOutcome::Failed;
  }
  fails_ = 0;
  logf(io, "OTA,installed,version=%s,slot=%d,from=%s", o.version, target, cur);
  return OtaOutcome::Installed;
}

}  // namespace pv
