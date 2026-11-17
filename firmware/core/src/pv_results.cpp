#include "pv_results.h"
#include <stdio.h>
#include <string.h>
#include "pv_json.h"

namespace pv {

const char *rstatusName(RStatus s) {
  static const char *n[] = { "invalid", "processing", "done", "researching", "paused_budget", "stopped", "error" };
  return n[(int)s];
}

static RStatus mapStatus(const char *s, bool has_task) {
  if (!strcmp(s, "processing") || !strcmp(s, "queued") || !strcmp(s, "received") || !strcmp(s, "transcribing") ||
      !strcmp(s, "routing"))
    return RStatus::Processing;
  if (!strcmp(s, "researching") || !strcmp(s, "running")) return RStatus::Researching;
  if (!strcmp(s, "paused_budget") || !strcmp(s, "paused")) return RStatus::PausedBudget;
  if (!strcmp(s, "stopped") || !strcmp(s, "failed")) return RStatus::Stopped;
  if (!strcmp(s, "error")) return RStatus::Error;
  // "done", the legacy server's "open", or a status this firmware does not know yet: final if
  // the reply carries a task, otherwise assume the server is still working on it.
  return has_task ? RStatus::Done : RStatus::Processing;
}

static bool parseFields(const char *text, ResultReply *out, bool prefix) {
  *out = ResultReply();
  char status[24];
  char err[64];
  JsonField f[9];
  f[0].key = "id"; f[0].str = out->id; f[0].cap = sizeof(out->id);
  f[1].key = "status"; f[1].str = status; f[1].cap = sizeof(status);
  f[2].key = "kind"; f[2].str = out->kind; f[2].cap = sizeof(out->kind);
  f[3].key = "title"; f[3].str = out->title; f[3].cap = sizeof(out->title);
  f[4].key = "due"; f[4].str = out->due; f[4].cap = sizeof(out->due);
  f[5].key = "summary"; f[5].str = out->detail; f[5].cap = sizeof(out->detail);
  f[6].key = "duplicate";
  f[7].key = "error"; f[7].str = err; f[7].cap = sizeof(err);
  f[8].key = "reason";
  bool ok = prefix ? jsonReadObjectPrefix(text, f, 9) : jsonReadObject(text, f, 9);
  if (!ok) return false;
  if (f[2].type != JsonType::String) out->kind[0] = 0;
  if (f[3].type != JsonType::String) out->title[0] = 0;
  if (f[4].type != JsonType::String) out->due[0] = 0;  // null = no due date
  out->duplicate = f[6].type == JsonType::Bool && f[6].b;
  bool has_task = out->kind[0] && f[3].type == JsonType::String;
  if (f[1].type == JsonType::String) {
    out->status = mapStatus(status, has_task);
    out->legacy = out->status == RStatus::Done && strcmp(status, "done") != 0;  // e.g. the old server's "open"
  } else if (has_task) {
    out->status = RStatus::Done;  // legacy synchronous reply
    out->legacy = true;
  } else {
    return false;
  }
  if (out->status == RStatus::Done && !has_task) out->status = RStatus::Processing;  // "done" without a task: not yet usable
  if (!out->detail[0] && f[7].type == JsonType::String) snprintf(out->detail, sizeof(out->detail), "%s", err);
  if (!strcmp(out->kind, "inbox")) snprintf(out->kind, sizeof(out->kind), "%s", !strcmp(out->title, "(no speech)") ? "noise" : "unsure");
  return true;
}

bool parseResultReply(const char *body, ResultReply *out) {
  if (!parseFields(body, out, false)) { out->status = RStatus::Invalid; return false; }
  return true;
}

bool parseResultObject(const char *obj, ResultReply *out) {
  if (!parseFields(obj, out, true)) { out->status = RStatus::Invalid; return false; }
  return true;
}

// ---------- schedule ----------
uint32_t checkDelayMs(uint8_t step) {
  static const uint32_t D[] = { 30000, 120000, 300000, 900000 };
  return step < 4 ? D[step] : 1800000;
}

uint64_t checkAgeMs(uint8_t step) {
  uint64_t t = 0;
  for (uint8_t i = 0; i < step; i++) t += checkDelayMs(i);
  return t;
}

// ---------- list ----------
PendingItem *PendingResults::find(const char *id) {
  for (int i = 0; i < n_; i++)
    if (!strcmp(items_[i].id, id)) return &items_[i];
  return nullptr;
}

PendingItem *PendingResults::add(const char *id, Phase phase, uint64_t now, char *dropped, size_t dropped_cap) {
  if (dropped && dropped_cap) dropped[0] = 0;
  PendingItem *it = find(id);
  if (!it) {
    if (n_ == MAX) {
      if (dropped) snprintf(dropped, dropped_cap, "%s", items_[0].id);
      memmove(&items_[0], &items_[1], sizeof(items_[0]) * (MAX - 1));
      n_--;
    }
    it = &items_[n_++];
    memset(it, 0, sizeof(*it));
    snprintf(it->id, sizeof(it->id), "%s", id);
    it->step = 0;
    it->next_ms = now + checkDelayMs(0);
  }
  it->phase = phase;
  return it;
}

void PendingResults::remove(const char *id) {
  for (int i = 0; i < n_; i++)
    if (!strcmp(items_[i].id, id)) {
      memmove(&items_[i], &items_[i + 1], sizeof(items_[0]) * (n_ - i - 1));
      n_--;
      return;
    }
}

uint64_t PendingResults::nextDue() const {
  uint64_t t = 0;
  for (int i = 0; i < n_; i++)
    if (!t || items_[i].next_ms < t) t = items_[i].next_ms;
  return t;
}

void PendingResults::allDueNow(uint64_t now) {
  for (int i = 0; i < n_; i++) items_[i].next_ms = now;
}

bool PendingResults::reschedule(PendingItem &it, uint64_t now, uint32_t min_interval_ms) {
  if (it.step < 255) it.step++;
  if (checkAgeMs(it.step) >= RESULT_MAX_AGE_MS) return false;
  uint32_t d = checkDelayMs(it.step);
  if (d < min_interval_ms) d = min_interval_ms;
  it.next_ms = now + d;
  return true;
}

bool PendingResults::readFile(const char *path, bool need_end) {
  int fd = hal_.fsOpen(path, "rb");
  if (fd < 0) return false;
  char buf[MAX * 64 + 32];
  int len = hal_.fsRead(fd, buf, sizeof(buf) - 1);
  hal_.fsClose(fd, false);
  if (len <= 0) return false;
  buf[len] = 0;
  if (strncmp(buf, "PV1\n", 4)) return false;
  if (need_end && !strstr(buf, "\nEND\n")) return false;
  int n = 0;
  PendingItem tmp[MAX];
  for (char *l = buf + 4; *l && n < MAX;) {
    char *e = strchr(l, '\n');
    if (!e) break;  // unterminated last line: ignore
    *e = 0;
    unsigned ph, st, mi;
    char id[48];
    if (sscanf(l, "%u %u %u %47s", &ph, &st, &mi, id) == 4 && ph <= 1) {
      memset(&tmp[n], 0, sizeof(tmp[n]));
      snprintf(tmp[n].id, sizeof(tmp[n].id), "%s", id);
      tmp[n].phase = (Phase)ph;
      tmp[n].step = st > 255 ? 255 : st;
      tmp[n].misses = mi > 255 ? 255 : mi;
      n++;
    }
    l = e + 1;
  }
  memcpy(items_, tmp, sizeof(tmp[0]) * n);
  n_ = n;
  return true;
}

int PendingResults::load(uint64_t now) {
  n_ = 0;
  char tmp[72];
  snprintf(tmp, sizeof(tmp), "%s.tmp", path_);
  // A complete temp file is the newest state (power cut between write and rename).
  if (readFile(tmp, true)) {
    hal_.fsRemove(path_);
    hal_.fsRename(tmp, path_);
  } else {
    hal_.fsRemove(tmp);
    readFile(path_, false);
  }
  for (int i = 0; i < n_; i++) {
    uint32_t d = checkDelayMs(items_[i].step);
    items_[i].next_ms = now + (d < 30000 ? d : 30000);
  }
  return n_;
}

bool PendingResults::save() {
  char tmp[72];
  snprintf(tmp, sizeof(tmp), "%s.tmp", path_);
  if (!n_) {  // nothing pending: no file
    hal_.fsRemove(tmp);
    hal_.fsRemove(path_);
    return true;
  }
  int fd = hal_.fsOpen(tmp, "wb");
  if (fd < 0) return false;
  char line[80];
  bool ok = hal_.fsWrite(fd, "PV1\n", 4) == 4;
  for (int i = 0; i < n_ && ok; i++) {
    int k = snprintf(line, sizeof(line), "%u %u %u %s\n", (unsigned)items_[i].phase, (unsigned)items_[i].step,
                     (unsigned)items_[i].misses, items_[i].id);
    ok = hal_.fsWrite(fd, line, k) == k;
  }
  ok = ok && hal_.fsWrite(fd, "END\n", 4) == 4;
  ok = hal_.fsClose(fd, true) && ok;
  if (!ok) return false;
  hal_.fsRemove(path_);
  return hal_.fsRename(tmp, path_);
}

}  // namespace pv
