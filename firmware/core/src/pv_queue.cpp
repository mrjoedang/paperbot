#include "pv_queue.h"
#include <stdio.h>
#include <string.h>
#include <strings.h>

namespace pv {

bool isClipName(const char *name) {
  size_t n = strlen(name);
  return n > 4 && strcasecmp(name + n - 4, ".wav") == 0 && name[0] != '.';
}

void UploadQueue::path(const char *name, char *out, size_t len) const { snprintf(out, len, "%s/%s", cfg_.rec_dir, name); }

namespace {
struct OldestCtx {
  uint32_t n = 0;
  char *oldest;
  size_t len;
};
void oldestCb(const FsEntry &e, void *c) {
  OldestCtx *o = (OldestCtx *)c;
  if (!isClipName(e.name)) return;
  o->n++;
  if (o->oldest && (!o->oldest[0] || strcmp(e.name, o->oldest) < 0)) snprintf(o->oldest, o->len, "%s", e.name);
}

struct ScanCtx {
  const char *prefix;
  uint32_t max_seq = 0;
  // Fixed-size list of names to fix up (init only).
  char names[16][64];
  uint32_t sizes[16];
  int count = 0;
};
void scanCb(const FsEntry &e, void *c) {
  ScanCtx *s = (ScanCtx *)c;
  if (!isClipName(e.name)) return;
  size_t pl = strlen(s->prefix);
  unsigned seq;
  if (!strncmp(e.name, s->prefix, pl) && sscanf(e.name + pl, "%*12[0-9a-f]-%6u", &seq) == 1 && seq > s->max_seq) s->max_seq = seq;
  if (s->count < 16) {
    snprintf(s->names[s->count], sizeof(s->names[0]), "%s", e.name);
    s->sizes[s->count++] = e.size;
  }
}
}  // namespace

uint32_t UploadQueue::pending(char *oldest, size_t len) {
  OldestCtx o;
  o.oldest = oldest;
  o.len = len;
  if (oldest && len) oldest[0] = 0;
  hal_.fsList(cfg_.rec_dir, oldestCb, &o);
  return o.n;
}

void UploadQueue::init(void (*log)(void *, const char *), void *ctx) {
  hal_.fsMkdir(cfg_.rec_dir);
  ScanCtx s;
  s.prefix = cfg_.id_prefix;
  hal_.fsList(cfg_.rec_dir, scanCb, &s);
  seq_ = s.max_seq;
  // Card emptied (all uploaded): start from a random base so ids stay unique after a reset
  // even if the random suffix collided; names still sort oldest-first within the queue.
  if (!seq_) seq_ = hal_.random32() % 1000 * 100;
  char p[128], line[160];
  for (int i = 0; i < s.count; i++) {
    path(s.names[i], p, sizeof(p));
    if (s.sizes[i] < WAV_HEADER_BYTES + 2) {
      // Power was cut before the header landed: nothing worth uploading.
      quarantine(s.names[i]);
      snprintf(line, sizeof(line), "REPAIR,name=%s,action=quarantine,size=%u", s.names[i], (unsigned)s.sizes[i]);
      log(ctx, line);
      continue;
    }
    int fd = hal_.fsOpen(p, "r+b");
    if (fd < 0) continue;
    uint8_t h[WAV_HEADER_BYTES];
    int32_t size = hal_.fsSize(fd);
    uint32_t data = (uint32_t)(size - WAV_HEADER_BYTES) & ~1u;
    if (hal_.fsRead(fd, h, sizeof(h)) == (int)sizeof(h)) {
      int64_t hd = wavHeaderDataBytes(h);
      if (hd >= 0 && hd != data) {
        // Recording stopped by a power cut / reset: header still says 0 bytes.
        wavHeader(h, cfg_.rate, data);
        hal_.fsSeek(fd, 0);
        hal_.fsWrite(fd, h, sizeof(h));
        snprintf(line, sizeof(line), "REPAIR,name=%s,action=header,data=%u,was=%lld", s.names[i], (unsigned)data, (long long)hd);
        log(ctx, line);
      }
    }
    hal_.fsClose(fd, true);
  }
}

void UploadQueue::newClipName(char *name, size_t len) {
  if (!seq_) seq_ = hal_.random32() % 1000 * 100;
  seq_++;
  snprintf(name, len, "%s%s-%06u-%08lx.wav", cfg_.id_prefix, hal_.deviceId(), (unsigned)seq_, (unsigned long)hal_.random32());
}

UploadOutcome UploadQueue::upload(const char *name) {
  UploadOutcome o;
  char p[128], url[256], id[64];
  path(name, p, sizeof(p));
  snprintf(id, sizeof(id), "%.*s", (int)(strlen(name) - 4), name);
  snprintf(url, sizeof(url), "%s/v1/recordings/%s", serverUrl(), id);
  uint64_t t0 = hal_.millis();
  HttpResult r = hal_.httpPutFile(url, p, "audio/wav", body_, sizeof(body_), cfg_.http_timeout_ms);
  o.ms = (uint32_t)(hal_.millis() - t0);
  o.status = r.status;
  note(r);
  if (r.status >= 200 && r.status < 300) o.reply_ok = parseResultReply(body_, &o.reply);
  o.verdict = classifyUpload(r.status, o.reply_ok);
  return o;
}

HttpResult UploadQueue::get(const char *p, uint32_t timeout_ms) {
  char url[512];
  snprintf(url, sizeof(url), "%s%s", serverUrl(), p);
  HttpResult r = hal_.httpGet(url, body_, sizeof(body_), timeout_ms);
  note(r);
  return r;
}

HttpResult UploadQueue::postJson(const char *p, const char *json, size_t len, char *reply, size_t cap, uint32_t timeout_ms) {
  char url[256];
  snprintf(url, sizeof(url), "%s%s", serverUrl(), p);
  HttpResult r = hal_.httpPostJson(url, json, len, reply, cap, timeout_ms);
  note(r);
  return r;
}

void UploadQueue::note(const HttpResult &r) {
  last_status_ = r.status;
  if (r.wifi_rev > wifi_rev_seen_) wifi_rev_seen_ = r.wifi_rev;
  if (r.status >= 200 && r.status < 500) reached_ = true;
  if (r.fw_latest[0]) snprintf(fw_latest_, sizeof(fw_latest_), "%s", r.fw_latest);
}

bool UploadQueue::remove(const char *name) {
  char p[128];
  path(name, p, sizeof(p));
  return hal_.fsRemove(p);
}

bool UploadQueue::quarantine(const char *name) {
  char from[128], to[128];
  path(name, from, sizeof(from));
  hal_.fsMkdir(cfg_.bad_dir);
  snprintf(to, sizeof(to), "%s/%s", cfg_.bad_dir, name);
  if (hal_.fsRename(from, to)) return true;
  return hal_.fsRemove(from);  // never let one file block the queue
}

}  // namespace pv
