#include "pv_app.h"
#include "pv_json.h"
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

namespace pv {

const char *stateName(State s) {
  static const char *names[] = { "BOOT", "READY", "REC", "SAVING", "SENDING", "SLEEP", "OFF" };
  return names[(int)s];
}

// Beep patterns (1 kHz start/stop as in power_proto; low double beep = error).
static const Tone T_START[] = { { 1050, 70 } };                       // press: one bright "beep"
static const Tone T_STOP[] = { { 880, 55 }, { 0, 25 }, { 660, 70 } };  // release: lower "bee-boop", clearly different
static const Tone T_ERROR[] = { { 400, 80 }, { 0, 60 }, { 400, 80 } };
static const Tone T_SENT[] = { { 1500, 40 }, { 0, 40 }, { 2000, 50 } };
static const Tone T_OFF[] = { { 800, 100 }, { 0, 50 }, { 500, 150 } };
#define TONES(t) t, (uint8_t)(sizeof(t) / sizeof(t[0]))

App::App(Hal &hal, const Config &cfg)
    : hal_(hal), cfg_(cfg), auto_off_idle_ms_(cfg.auto_off_idle_ms), queue_(hal, cfg.queue), results_(hal, cfg.pending_path), ota_(hal, cfg.ota),
      rec_(hal, ring_buf_, sizeof(ring_buf_), cfg.rate) {}

// ---------- logging: "<seq>,<ms>,<body>*<xor>" on the console and the SD log ----------
void App::plog(const char *fmt, ...) {
  char body[360], line[420];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(body, sizeof(body), fmt, ap);
  va_end(ap);
  int n = snprintf(line, sizeof(line), "%u,%llu,%s", (unsigned)++log_seq_, (unsigned long long)hal_.millis(), body);
  if (n < 0) return;
  if (n > (int)sizeof(line) - 5) n = sizeof(line) - 5;
  uint8_t ck = 0;
  for (int i = 0; i < n; i++) ck ^= (uint8_t)line[i];
  ring_.add(line, n);  // without the checksum suffix
  snprintf(line + n, sizeof(line) - n, "*%02X", ck);
  hal_.log(line);
  if (!sd_ok_ || !cfg_.sd_log) return;
  int fd = hal_.fsOpen(cfg_.log_path, "ab");
  if (fd < 0) return;
  if ((uint32_t)hal_.fsSize(fd) > cfg_.log_max_bytes) {
    hal_.fsClose(fd, false);
    char old[64];
    snprintf(old, sizeof(old), "%s.old", cfg_.log_path);
    hal_.fsRemove(old);
    hal_.fsRename(cfg_.log_path, old);
    fd = hal_.fsOpen(cfg_.log_path, "ab");
    if (fd < 0) return;
  }
  size_t len = strlen(line);
  line[len] = '\n';
  hal_.fsWrite(fd, line, len + 1);
  hal_.fsClose(fd, false);
}

void App::beep(const Tone *t, uint8_t n) {
  if (cfg_.beeps) hal_.playTones(t, n);
}

void App::setState(State s) {
  st_.state = s;
  publish();
}

void App::publish() {
  st_.screen = ui_.model();
  st_.backoff_ms = backoff_.cur_ms;
  st_.next_retry_ms = backoff_.next_ms;
  st_.sd_ok = sd_ok_;
  st_.pwr_wake_enabled = pwr_wake_ok_;
  st_.pending = results_.count();
  st_.next_check_ms = results_.nextDue();
  st_.batt = (BattLevel)batt_level_;
  st_.fw = hal_.fwVersion();
  st_.fw_verifying = ota_.verifying();
  hal_.onStatus(st_);
}

void App::show(Screen s, const char *title, const char *detail, const char *kind, const char *due) {
  ui_.show(s, title, detail, kind, due);
  char d[100];
  logSafe(d, sizeof(d), detail);
  plog("UI,screen=%s,title=%s,detail=%s", screenName(s), title, d);
  publish();
}

void App::updateFooter(bool force) {
  int mv = hal_.batteryMv();
  int pct = batteryPercent(mv);
  uint32_t q = sd_ok_ ? queue_.pending() : 0;
  uint8_t pend = (uint8_t)results_.count();
  bool usb = hal_.usbConnected();
  st_.queued = q;
  char f[48];
  int n = 0;
  if (pct >= 0) n = snprintf(f, sizeof(f), batt_level_ ? "LOW %d%%" : "%d%%", pct);
  else n = snprintf(f, sizeof(f), "%s", q || pend ? "" : "ready");
  if (usb) n += snprintf(f + n, sizeof(f) - n, " USB");
  if (q) n += snprintf(f + n, sizeof(f) - n, "%s%u queued", n ? " | " : "", (unsigned)q);
  if (pend) n += snprintf(f + n, sizeof(f) - n, "%s%u waiting", n ? " | " : "", (unsigned)pend);
  (void)force;  // Ui::setFooter skips unchanged text, which is what saves e-paper refreshes
  ui_.setFooter(f, pct, q, pend, (BattLevel)batt_level_, usb);
  publish();
}

// ---------- setup ----------
void App::setup(UiLayout *layout) {
  hal_.powerLatch(true);  // keep battery power on before anything slow
  boot_ms_ = hal_.millis();
  used_ms_ = boot_ms_;
  // Log ring first: after a crash its newest lines are what happened right before - pin them
  // before this boot logs anything.
  size_t rsize = 0;
  void *rmem = hal_.retainedRam(&rsize);
  int kept = ring_.attach(rmem, rsize);
  reset_ = hal_.resetReason();
  if (isCrashReset(reset_)) {
    crash_unreported_ = true;
    ring_.pinCrash();
  } else if (ring_.pinned()) {
    err_since_rep_ = true;  // an error before a soft reset was not reported yet
  }
  {
    char b[16];
    hal_.kvGet("boot_n", b, sizeof(b));
    boot_n_ = (uint32_t)strtoul(b, nullptr, 10) + 1;
    snprintf(b, sizeof(b), "%u", (unsigned)boot_n_);
    hal_.kvSet("boot_n", b);
  }
  st_.stats.heap_boot = hal_.heapFree();
  {
    size_t cap = 0;
    char *buf = queue_.scratch(&cap);  // nothing in flight yet
    places_.load(hal_, buf, cap, logCb, this);
  }
  bool has_tok = false;
  {
    // Setup (pocketbot setup: NVS image or serial "prov"): the server URL and device token in NVS
    // replace the ones compiled into the firmware.
    char b[160];
    if (hal_.kvGet("srv_url", b, sizeof(b)) && b[0]) {
      snprintf(server_url_, sizeof(server_url_), "%s", b);
      queue_.setServerUrl(server_url_);
    }
    if (hal_.kvGet("dev_tok", b, sizeof(b)) && b[0]) {
      hal_.setAuth(b);
      has_tok = true;
    }
    memset(b, 0, sizeof(b));
    hello_kv_ = hal_.kvGet("hello", b, sizeof(b)) && b[0] == '1';
    hello_due_ = hello_kv_ && provisioned();
  }
  ui_.begin(hal_, layout);
  sd_ok_ = hal_.fsMount();
  if (sd_ok_) {
    // Continue the log sequence from the tail of the existing log.
    int fd = hal_.fsOpen(cfg_.log_path, "rb");
    if (fd >= 0) {
      int32_t size = hal_.fsSize(fd);
      char tail[600];
      uint32_t off = size > 512 ? size - 512 : 0;
      hal_.fsSeek(fd, off);
      int n = hal_.fsRead(fd, tail, sizeof(tail) - 1);
      hal_.fsClose(fd, false);
      if (n > 0) {
        tail[n] = 0;
        for (char *l = tail; l && *l; l = strchr(l, '\n') ? strchr(l, '\n') + 1 : nullptr) {
          unsigned s;
          if (sscanf(l, "%u,", &s) == 1 && s > log_seq_ && s < log_seq_ + 1000000) log_seq_ = s;
        }
      }
    }
    queue_.init(logCb, this);
    int n = results_.load(hal_.millis());
    if (n) plog("PEND,loaded=%d,next_s=%u", n, (unsigned)((results_.nextDue() - hal_.millis()) / 1000));
  }
  inline_writer_ = !hal_.startWorker(Recorder::task, &rec_);
  backoff_.base_ms = cfg_.backoff_base_ms;
  backoff_.cap_ms = cfg_.backoff_cap_ms;
  pwr_released_ = !hal_.buttonDown(Button::Pwr);
  last_wake_ms_ = hal_.millis();
  awake_until_ms_ = last_wake_ms_ + cfg_.boot_window_ms;
  int mv = hal_.batteryMv();
  plog("BOOT,sd=%d,heap=%u,batt_mv=%d,pwr_held=%d,usb=%d,id=%s,writer=%s,reset=%s,boot_n=%u,ring=%d", sd_ok_, (unsigned)hal_.heapFree(), mv,
       !pwr_released_, hal_.usbConnected(), hal_.deviceId(), inline_writer_ ? "inline" : "task", reset_, (unsigned)boot_n_,
       ring_.enabled() ? kept : -1);
  batt_level_ = batteryLevel(batteryPercent(mv), 0, cfg_.low_pct, cfg_.crit_pct, cfg_.crit_exit_pct);
  last_batt_ms_ = hal_.millis();
  Ota::BootEvent ev = ota_.boot(hal_.millis(), otaIo());
  char d[96];
  if (!sd_ok_) show(Screen::NoSd, "NO SD", "Insert FAT32 card\nand press RESET");
  else if (batt_level_ == 2 && !hal_.usbConnected()) show(Screen::ChargeMe, "CHARGE ME", "plug in USB");
  else if (ev == Ota::BootEvent::Updated) {
    snprintf(d, sizeof(d), "v%s", ota_.eventVersion());
    show(Screen::Updated, "UPDATED", d);
  } else if (ev == Ota::BootEvent::RolledBack) {
    statusError();
    snprintf(d, sizeof(d), "v%s did not start\nback on v%s", ota_.eventVersion(), hal_.fwVersion());
    show(Screen::UpdateFailed, "UPDATE FAILED", d);
  } else if (!provisioned()) show(Screen::Status, "SET ME UP", "Plug into a Mac and\nsee paperbot.ca");
  else if (hello_due_) show(Screen::Sending, "CONNECTING", "first check-in");
  else show(Screen::Ready, "READY", "Hold BOOT\nand talk");
  plog("SETUP,server=%d,token=%d,hello=%d,wifi_rev=%u,networks=%d", provisioned(), has_tok, hello_due_, (unsigned)places_.rev(), places_.count());
  updateFooter(true);
  st_.stats.heap_last_cycle = hal_.heapFree();
  setState(State::Ready);
}

// ---------- recording ----------
bool App::recordClip(uint32_t sim_ms) {
  bool simulated = sim_ms > 0;
  setState(State::Recording);
  used_ms_ = hal_.millis();
  beep(TONES(T_START));
  uint32_t stale = 0;
  hal_.audioBegin(&stale);
  char name[72], path[128];
  queue_.newClipName(name, sizeof(name));
  queue_.path(name, path, sizeof(path));
  rec_.begin(path);
  hal_.led(true);
  show(Screen::Rec, "REC", simulated ? "simulated" : "release to stop");
  uint64_t start = hal_.millis();
  int peak = 0;
  size_t captured = 0;
  int16_t mono[160];
  for (;;) {
    bool held = simulated ? (hal_.millis() - start < sim_ms) : hal_.buttonDown(Button::Boot);
    if (!held || rec_.openFailed()) break;
    size_t n = hal_.audioRead(mono, 160);
    if (!n) { hal_.delayMs(10); continue; }
    captured += n * 2;
    if (captured > cfg_.rate / 2)  // ignore the codec start-up click for the level meter
      for (size_t i = 0; i < n; i++) peak = peak > abs((int)mono[i]) ? peak : abs((int)mono[i]);
    rec_.push(mono, n);
    if (inline_writer_) rec_.step();
  }
  uint32_t held_ms = (uint32_t)(hal_.millis() - start);
  hal_.audioEnd();
  hal_.led(false);
  beep(TONES(T_STOP));  // right at release, not after the file is finalized
  setState(State::Saving);
  rec_.stop();
  uint64_t t0 = hal_.millis();
  while (!rec_.finalized()) {
    if (inline_writer_) rec_.step();
    else hal_.delayMs(2);
    if (hal_.millis() - t0 > cfg_.finalize_timeout_ms) break;  // SD wedged: do not hang here
  }
  bool finalized = rec_.finalized();
  float secs = rec_.written() / (2.0f * cfg_.rate);
  st_.stats.dropped_bytes += rec_.dropped();
  bool queued = false;
  char d[96];
  if (rec_.openFailed() || !finalized) {
    statusError();
    beep(TONES(T_ERROR));
    show(Screen::SdError, "SD ERROR", finalized ? "could not create file" : "card not responding");
  } else if (secs < cfg_.min_clip_s) {
    hal_.fsRemove(path);
    st_.stats.too_short++;
    beep(TONES(T_ERROR));
    show(Screen::TooShort, "TOO SHORT", "Hold BOOT\nwhile you talk");
  } else {
    queued = true;
    st_.stats.clips++;
    snprintf(d, sizeof(d), "%.1f s%s%s%s%s", secs, peak < cfg_.quiet_peak ? "\n(very quiet)" : "", rec_.dropped() ? "\nDROPPED AUDIO" : "",
             rec_.writeFailed() ? "\nSD WRITE ERROR" : "", netAllowed() ? "" : "\ncharge to send");
    show(Screen::Saved, "SAVED", d);
  }
  plog("REC,name=%s,sim=%d,held_ms=%u,secs=%.2f,dropped=%u,peak=%d,stale_ms=%u,write_failed=%d,queued=%d", name, simulated,
       (unsigned)held_ms, secs, (unsigned)rec_.dropped(), peak, (unsigned)stale, rec_.writeFailed(), queued);
  updateFooter();
  setState(State::Ready);
  stayAwake(cfg_.activity_grace_ms);
  return queued;
}

// ---------- network sessions: upload queue + result collection ----------
bool App::abortOnBoot(void *self) { return ((App *)self)->hal_.buttonDown(Button::Boot); }

static const char *failText(int status, bool reply_ok, char *buf, size_t len) {
  if (status >= 200 && status < 300 && !reply_ok) return "bad reply";
  switch (status) {
    case HTTP_ERR_DNS: return "DNS failed";
    case HTTP_ERR_TIMEOUT: return "server timeout";
    case HTTP_ERR_CONNECT: return "no connection";
    case HTTP_ERR_IO: return "network error";
    case HTTP_ERR_NO_FILE: return "file error";
  }
  snprintf(buf, len, "server %d", status);
  return buf;
}

static void clipId(const char *name, char *id, size_t cap) {
  size_t n = strlen(name);
  snprintf(id, cap, "%.*s", (int)(n > 4 ? n - 4 : n), name);
}

bool App::netAllowed() { return sd_ok_ && (batt_level_ < 2 || hal_.usbConnected() || force_net_); }

void App::updateBattery() {
  last_batt_ms_ = hal_.millis();
  int pct = batteryPercent(hal_.batteryMv());
  int lvl = batteryLevel(pct, batt_level_, cfg_.low_pct, cfg_.crit_pct, cfg_.crit_exit_pct);
  if (lvl == batt_level_) return;
  int was = batt_level_;
  batt_level_ = lvl;
  st_.batt = (BattLevel)lvl;
  plog("BATT,level=%d,was=%d,pct=%d,usb=%d", lvl, was, pct, hal_.usbConnected());
  if (lvl == 2) {
    char d[64];
    snprintf(d, sizeof(d), "%u queued\nplug in USB", (unsigned)(sd_ok_ ? queue_.pending() : 0));
    show(Screen::ChargeMe, "CHARGE ME", d);
    beep(TONES(T_ERROR));
  } else if (was == 2 && ui_.model().id == Screen::ChargeMe) {
    show(Screen::Ready, "READY", "Hold BOOT\nand talk");
  }
  updateFooter();
}

void App::noteUpdate(const ResultReply &r) {
  updates_++;
  last_update_ = r;
  char t[100];
  logSafe(t, sizeof(t), r.title);
  plog("RES,id=%s,status=%s,kind=%s,legacy=%d,title=%s", r.id, rstatusName(r.status), r.kind, r.legacy, t);
}

static void formatDue(const char *due, char *out, size_t cap) {
  // "2026-10-18T09:00:00Z" -> "10-18 09:00"; anything else is shown as sent.
  int y, mo, d, h, mi;
  if (sscanf(due, "%4d-%2d-%2dT%2d:%2d", &y, &mo, &d, &h, &mi) == 5) snprintf(out, cap, "%02d-%02d %02d:%02d", mo, d, h, mi);
  else if (sscanf(due, "%4d-%2d-%2d", &y, &mo, &d) == 3) snprintf(out, cap, "%02d-%02d", mo, d);
  else snprintf(out, cap, "%s", due);
}

void App::showUpdate(const ResultReply &r) {
  const char *title = r.title[0] ? r.title : "(untitled)";
  char d[96];
  switch (r.status) {
    case RStatus::Researching: show(Screen::Researching, "RESEARCHING", title, "work"); break;
    case RStatus::PausedBudget: show(Screen::WorkPaused, "PAUSED", title, "work"); break;
    case RStatus::Stopped: show(Screen::WorkStopped, "STOPPED", title, "work"); break;
    case RStatus::Error:
      snprintf(d, sizeof(d), "%s\naudio kept on server", r.detail[0] ? r.detail : "could not process");
      show(Screen::ResultError, "ERROR", d);
      break;
    default:
      if (!strcmp(r.kind, "noise")) {
        st_.stats.noise++;
        show(Screen::Noise, "HUH?", "didn't catch that\ntry again");
      } else if (!strcmp(r.kind, "answer")) {
        show(Screen::Answer, "ANSWER", r.detail[0] ? r.detail : title, "answer");
      } else if (!strcmp(r.kind, "work") && !r.legacy) {
        show(Screen::WorkDone, "DONE", r.detail[0] ? r.detail : title, "work");
      } else {
        char heading[16], due[24] = "";
        if (!strcmp(r.kind, "unsure")) snprintf(heading, sizeof(heading), "NOTE?");
        else snprintf(heading, sizeof(heading), "%s", r.kind);
        upcase(heading);
        if (r.due[0]) formatDue(r.due, due, sizeof(due));
        show(Screen::Result, heading, title, r.kind, due);
      }
  }
}

// One reply (or failure) for a pending id. scheduled: this was the item's timer check (its
// schedule advances); otherwise a poll-window GET right after the upload.
void App::handleReply(const char *id, int http, const ResultReply *r, bool scheduled) {
  PendingItem *it = results_.find(id);
  if (!it) return;
  bool changed = false;
  if (http >= 200 && http < 300 && r && r->status != RStatus::Invalid) {
    it->misses = 0;
    if (r->final()) {
      ResultReply rr = *r;
      snprintf(rr.id, sizeof(rr.id), "%s", id);
      noteUpdate(rr);
      st_.stats.results++;
      results_.remove(id);
      results_.save();
      return;
    }
    if (r->status == RStatus::Researching && it->phase != Phase::Researching) {
      it->phase = Phase::Researching;
      ResultReply rr = *r;
      snprintf(rr.id, sizeof(rr.id), "%s", id);
      noteUpdate(rr);
      changed = true;
    }
  } else if (http == 404) {
    // Not visible yet (eventual consistency) or lost: tolerate a few scheduled misses.
    if (scheduled && ++it->misses >= cfg_.result_miss_limit) {
      plog("PEND,giveup=%s,reason=404", id);
      st_.stats.gave_up++;
      results_.remove(id);
      results_.save();
      return;
    }
    changed = scheduled;
  } else if (scheduled) {
    st_.stats.check_fail++;
    statusError();
  }
  if (scheduled) {
    if (!results_.reschedule(*it, hal_.millis(), batt_level_ ? cfg_.low_check_min_ms : 0)) {
      plog("PEND,giveup=%s,reason=age,steps=%u", id, (unsigned)it->step);
      st_.stats.gave_up++;
      results_.remove(id);
    }
    changed = true;
  }
  if (changed) results_.save();
}


// GETs results for the pending ids (fresh_only: those accepted in this session and still
// processing; else all, advancing the schedule of the due ones). One /v1/updates request per
// 6 ids, falling back to GET /v1/recordings/:id when the server lacks the batch endpoint.
void App::checkPending(bool fresh_only) {
  uint64_t now = hal_.millis();
  char ids[PendingResults::MAX][48];
  bool sched[PendingResults::MAX];
  int n = 0;
  for (int i = 0; i < results_.count(); i++) {
    PendingItem &it = results_.at(i);
    if (fresh_only && !(it.fresh && it.phase == Phase::Await)) continue;
    snprintf(ids[n], sizeof(ids[n]), "%s", it.id);
    sched[n++] = !fresh_only && it.next_ms <= now;
  }
  char path[400];
  for (int i0 = 0; i0 < n;) {
    if (hal_.buttonDown(Button::Boot)) return;  // let the user record; unchecked items stay due
    int k = n - i0 > 6 ? 6 : n - i0;
    if (k > 1 && updates_api_) {
      int len = snprintf(path, sizeof(path), "/v1/updates?ids=");
      for (int j = 0; j < k; j++) len += snprintf(path + len, sizeof(path) - len, "%s%s", j ? "," : "", ids[i0 + j]);
      HttpResult h = queue_.get(path, cfg_.check_timeout_ms);
      st_.stats.gets++;
      plog("GET,what=updates,n=%d,status=%d,len=%d", k, h.status, h.body_len);
      if (h.status == 404 || h.status == 405 || h.status == 400 || h.status == 501) {
        updates_api_ = false;  // older server: per-id GETs from now on (until reboot)
        plog("WARN,no /v1/updates (status %d): per-id GETs", h.status);
        continue;              // redo this chunk per id
      }
      bool seen[6] = {};
      int got = -1;
      if (h.status == 200) {
        struct Ctx {
          App *app;
          char (*ids)[48];
          bool *seen, *sched;
          int k;
        } c{ this, ids + i0, seen, sched + i0, k };
        got = jsonForEachObject(queue_.body(), "items", [](const char *obj, void *vp) {
          Ctx *c = (Ctx *)vp;
          ResultReply r;
          if (!parseResultObject(obj, &r)) return;
          for (int j = 0; j < c->k; j++)
            if (!c->seen[j] && !strcmp(r.id, c->ids[j])) {
              c->seen[j] = true;
              c->app->handleReply(c->ids[j], 200, &r, c->sched[j]);
            }
        }, &c);
      }
      for (int j = 0; j < k; j++)
        if (!seen[j]) handleReply(ids[i0 + j], got >= 0 ? 404 : (h.status == 200 ? HTTP_ERR_IO : h.status), nullptr, sched[i0 + j]);
    } else {
      for (int j = 0; j < k; j++) {
        if (j && hal_.buttonDown(Button::Boot)) return;
        snprintf(path, sizeof(path), "/v1/recordings/%s", ids[i0 + j]);
        HttpResult h = queue_.get(path, cfg_.check_timeout_ms);
        st_.stats.gets++;
        ResultReply r;
        bool ok = h.status == 200 && parseResultReply(queue_.body(), &r);
        plog("GET,what=recording,id=%s,status=%d,ok=%d,result=%s", ids[i0 + j], h.status, ok, ok ? rstatusName(r.status) : "-");
        handleReply(ids[i0 + j], h.status == 200 && !ok ? HTTP_ERR_IO : h.status, ok ? &r : nullptr, sched[i0 + j]);
      }
    }
    i0 += k;
  }
}

// Short poll right after a 202: 0.5, 1, 2, 2 s gaps until the fresh ids are resolved or the
// window ends. BOOT ends it (the ids stay pending and are checked on schedule).
void App::pollFresh(uint64_t deadline) {
  static const uint16_t GAPS[] = { 500, 1000, 2000, 2000 };
  for (int i = 0;; i++) {
    int waiting = 0;
    for (int k = 0; k < results_.count(); k++)
      if (results_.at(k).fresh && results_.at(k).phase == Phase::Await) waiting++;
    if (!waiting) return;
    uint32_t gap = GAPS[i < 3 ? i : 3];
    if (hal_.millis() + gap > deadline) return;
    for (uint64_t t = hal_.millis() + gap; hal_.millis() < t;) {
      if (hal_.buttonDown(Button::Boot)) return;
      hal_.delayMs(10);
    }
    checkPending(true);
  }
}

void App::netSession(const char *reason, bool upload, bool check, bool fw, bool hello) {
  char name[72], d[96], kind[16] = "";
  uint32_t q = upload ? queue_.pending(name, sizeof(name)) : 0;
  if (!q) upload = false;
  if (!upload && !check && !fw && !hello) return;
  bool new_clip = !strcmp(reason, "new_clip");
  st_.stats.sessions++;
  if (check) st_.stats.checks++;
  updates_ = 0;
  setState(State::Sending);
  queue_.sessionStart();
  if (upload) {  // a result check alone changes nothing on screen unless news arrives
    snprintf(d, sizeof(d), "%u queued", (unsigned)q);
    show(Screen::Sending, "SENDING", d);
  }
  uint32_t heap0 = hal_.heapFree();
  uint64_t t0 = hal_.millis(), t_acc = 0;
  int rssi = 0;
  WifiResult wr = places_.connect(hal_, cfg_.wifi_timeout_ms, abortOnBoot, this, &rssi);
  uint32_t connect_ms = (uint32_t)(hal_.millis() - t0);
  bool conn = wr == WifiResult::Ok;
  char ssidSafe[40];
  logSafe(ssidSafe, sizeof(ssidSafe), places_.ssid());
  bool failed = !conn, aborted = wr == WifiResult::Aborted;
  uint32_t up = 0, bad = 0, acc = 0;
  int last_status = 0;
  bool last_reply_ok = true;
  if (conn && upload) {
    while (queue_.pending(name, sizeof(name)) > 0) {
      if (hal_.buttonDown(Button::Boot)) { aborted = true; break; }  // let the user record now
      UploadOutcome o = queue_.upload(name);
      last_status = o.status;
      last_reply_ok = o.reply_ok;
      plog("UP,name=%s,status=%d,reply_ok=%d,dup=%d,ms=%u,heap=%u,verdict=%d,result=%s,kind=%s", name, o.status, o.reply_ok,
           o.reply.duplicate, (unsigned)o.ms, (unsigned)hal_.heapFree(), (int)o.verdict, o.reply_ok ? rstatusName(o.reply.status) : "-",
           o.reply_ok ? o.reply.kind : "-");
      if (o.verdict == UploadVerdict::Quarantine) {
        queue_.quarantine(name);
        bad++;
        st_.stats.quarantined++;
        statusError();
        continue;
      }
      if (o.verdict == UploadVerdict::Retry) {
        failed = true;
        st_.stats.upload_fail++;
        statusError();
        break;
      }
      // 2xx: the server has the audio. Remember the id BEFORE deleting the clip, so a power
      // cut in between re-uploads (server dedupes) instead of losing the result.
      char id[48], dropped[48];
      clipId(name, id, sizeof(id));
      if (!o.reply.final()) {
        PendingItem *it = results_.add(id, o.reply.status == RStatus::Researching ? Phase::Researching : Phase::Await, hal_.millis(),
                                       dropped, sizeof(dropped));
        it->fresh = true;
        if (dropped[0]) plog("PEND,dropped=%s,reason=full", dropped);
        if (!results_.save()) plog("WARN,pending list not saved");
        acc++;
        st_.stats.accepted++;
        t_acc = hal_.millis();
        if (o.reply.status == RStatus::Researching) {
          snprintf(o.reply.id, sizeof(o.reply.id), "%s", id);
          noteUpdate(o.reply);
        }
      } else {
        // Legacy synchronous server, or a duplicate PUT of something already finished.
        snprintf(o.reply.id, sizeof(o.reply.id), "%s", id);
        noteUpdate(o.reply);
        st_.stats.results++;
        if (results_.find(id)) {
          results_.remove(id);
          results_.save();
        }
      }
      queue_.remove(name);
      up++;
      st_.stats.uploaded++;
      if (o.reply.duplicate) st_.stats.dups++;
      snprintf(kind, sizeof(kind), "%s", o.reply.kind);
    }
  } else if (!conn && !aborted) {
    st_.stats.wifi_fail++;
    statusError();
  }
  bool ota_tried = false;
  if (conn && !aborted && !hal_.buttonDown(Button::Boot)) {
    if (acc) pollFresh(t_acc + cfg_.result_window_ms);
    if (check && !hal_.buttonDown(Button::Boot)) checkPending(false);
    // The server has a newer Wi-Fi list for us (X-PV-Wifi-Rev): fetch it while connected.
    uint32_t wrev = queue_.wifiRevSeen();
    if (wifi_api_ && wrev > places_.rev() && !(wrev == wifi_bad_rev_ && hal_.millis() < wifi_bad_until_) &&
        !hal_.buttonDown(Button::Boot))
      fetchWifiList();
    // Firmware: last, so clips and results never wait for it. "busy" = the user just recorded,
    // pressed PWR or is about to see news: check only, install later in a quiet session.
    if (!hal_.buttonDown(Button::Boot) && (fw || ota_.verifyPingDue() || ota_.checkDue(hal_.millis(), queue_.fwLatest())))
      ota_tried = otaStep(reason, new_clip || updates_ || !strcmp(reason, "pwr"));
  }
  if (fw && !ota_tried) ota_.noNetwork(hal_.millis(), aborted || hal_.buttonDown(Button::Boot));
  for (int i = 0; i < results_.count(); i++) results_.at(i).fresh = false;
  // Wi-Fi stays up for the status report, sent after the screen below so the user never waits for it.
  if (!conn || !cfg_.status_report) netOff();
  stayAwake(cfg_.wake_grace_ms);
  // A due check that could not run (no Wi-Fi, server down) still advances its schedule, so an
  // unreachable server is retried at 30 s, 2 min, ... and not in a tight loop.
  if (check && !aborted) {
    uint64_t now = hal_.millis();
    bool changed = false;
    for (int i = 0; i < results_.count();) {
      PendingItem &it = results_.at(i);
      if (it.next_ms > now) { i++; continue; }
      changed = true;
      st_.stats.check_fail++;
      statusError();
      if (!results_.reschedule(it, now, batt_level_ ? cfg_.low_check_min_ms : 0)) {
        plog("PEND,giveup=%s,reason=age,steps=%u", it.id, (unsigned)it.step);
        st_.stats.gave_up++;
        results_.remove(it.id);
        continue;
      }
      i++;
    }
    if (changed) results_.save();
  }
  uint32_t left = queue_.pending();
  if (upload) {
    if (aborted && !failed && !up) {
      // Nothing learned about the network: keep the schedule, record first.
    } else if (failed) {
      backoff_.fail(hal_.millis());
    } else {
      backoff_.success();
    }
  }
  plog("NET,reason=%s,wifi=%d,rssi=%d,connect_ms=%u,uploaded=%u,accepted=%u,updates=%u,pending=%d,bad=%u,left=%u,last_status=%d,"
       "aborted=%d,heap_before=%u,heap_after=%u,heap_min=%u,backoff_ms=%u,session_ms=%u,ssid=%s",
       reason, (int)wr, rssi, (unsigned)connect_ms, (unsigned)up, (unsigned)acc, (unsigned)updates_, results_.count(), (unsigned)bad,
       (unsigned)left, last_status, aborted, (unsigned)heap0, (unsigned)hal_.heapFree(), (unsigned)hal_.heapMinFree(),
       (unsigned)backoff_.cur_ms, (unsigned)(hal_.millis() - t0), conn ? ssidSafe : "-");
  st_.queued = left;
  bool upload_failed = upload && failed && !(aborted && !up);
  if (upload_failed && (new_clip || !updates_)) {
    char buf[24];
    const char *why = !conn ? "no wifi" : failText(last_status, last_reply_ok, buf, sizeof(buf));
    snprintf(d, sizeof(d), "%s\n%u queued\nretry in %us", why, (unsigned)left, (unsigned)(backoff_.cur_ms / 1000));
    show(Screen::Queued, "QUEUED", d);
  } else if (updates_) {
    showUpdate(last_update_);
    bool good = last_update_.status != RStatus::Error && strcmp(last_update_.kind, "noise") != 0;
    if (new_clip && up && good) beep(TONES(T_SENT));  // no success beep for "didn't catch that"
  } else if (up) {
    if (up > 1) snprintf(d, sizeof(d), "result soon\n%u clips sent", (unsigned)up);
    else snprintf(d, sizeof(d), "result soon");
    show(Screen::Sent, "SENT", d, kind);
    if (new_clip) beep(TONES(T_SENT));
  } else if (bad) {
    snprintf(d, sizeof(d), "%u bad clip%s\nset aside", (unsigned)bad, bad > 1 ? "s" : "");
    show(Screen::BadClip, "SKIPPED", d);
  } else {
    // Check without news, or aborted for a recording before anything was sent (REC replaces
    // this immediately): leave the screen alone - no e-paper refresh.
  }
  bool reported = false;
  if (conn && (cfg_.status_report || hello)) {
    // Last, piggybacking on this session's Wi-Fi (never a reason to turn it on - except the
    // one setup check-in). Backoff and result schedules above were computed before it, so it
    // cannot shift them. Footer first: screen + footer changes go out as one e-paper refresh,
    // not split by the report's radio time.
    updateFooter();
    reported = statusReport(rssi, connect_ms);
    netOff();
  }
  // For "info": how the last session went (setup reports wrong Wi-Fi password / token rejected).
  net_last_ms_ = hal_.millis();
  net_last_http_ = reported ? 204 : queue_.lastStatus();
  net_last_ = conn ? (reported || (net_last_http_ >= 200 && net_last_http_ < 300) ? NET_OK : NET_HTTP) : aborted ? NET_ABORTED
              : wr == WifiResult::Failed ? NET_WIFI_PASSWORD : wr == WifiResult::NoSsid ? NET_WIFI_NOT_FOUND : NET_WIFI;
  if (!hello && reported && hello_kv_) {  // the check-in gave up earlier, but this session reached the server
    hello_kv_ = false;
    hal_.kvSet("hello", "");
    plog("HELLO,ok,late=1");
  }
  if (hello) {
    if (reported) {
      hello_kv_ = false;
      hello_due_ = false;
      hal_.kvSet("hello", "");
      plog("HELLO,ok,ssid=%s", conn ? ssidSafe : "-");
      if (!updates_ && !up) show(Screen::Ready, "ALL SET", "Hold BOOT\nand talk");
      beep(TONES(T_SENT));
    } else {
      hello_wait_ms_ = hello_wait_ms_ ? hello_wait_ms_ * 2 : cfg_.hello_retry_ms;
      if (hello_wait_ms_ > cfg_.hello_retry_cap_ms) hello_wait_ms_ = cfg_.hello_retry_cap_ms;
      hello_next_ms_ = hal_.millis() + hello_wait_ms_;
      if (!hello_started_ms_) hello_started_ms_ = hal_.millis();
      if (hal_.millis() - hello_started_ms_ > cfg_.hello_give_up_ms) {
        hello_due_ = false;  // stop spending battery; the next recording, ⏻ press or reboot tries again
        plog("HELLO,give_up,after_s=%u", (unsigned)((hal_.millis() - hello_started_ms_) / 1000));
      }
      plog("HELLO,fail,result=%s,http=%d,retry_s=%u", netResultName(net_last_), net_last_http_, (unsigned)(hello_wait_ms_ / 1000));
      if (!updates_ && !up) {
        snprintf(d, sizeof(d), "%s\nretry in %us", netResultName(net_last_), (unsigned)(hello_wait_ms_ / 1000));
        show(Screen::Queued, "NOT ONLINE", d);
      }
    }
  }
  updateFooter();
  setState(State::Ready);
}

void App::netOff() {
  hal_.httpSessionEnd();
  hal_.wifiOff();
}

// GET /v1/wifi (docs/device-api.md section 8): adopted only if it parses completely and is
// saved; a rejected revision is not fetched again for wifi_list_retry_ms.
void App::fetchWifiList() {
  uint32_t want = queue_.wifiRevSeen();
  HttpResult h = queue_.get("/v1/wifi", cfg_.check_timeout_ms);
  if (h.status == 404 || h.status == 405 || h.status == 501) {
    wifi_api_ = false;  // server without the endpoint: until reboot
    plog("WIFI,list=unsupported,status=%d", h.status);
    return;
  }
  char why[24] = "http";
  size_t cap = 0;
  char *scratch = queue_.scratch(&cap);
  bool ok = h.status == 200 && places_.adopt(hal_, queue_.body(), scratch, cap, why, sizeof(why));
  if (!ok && h.status == 200) {
    wifi_bad_rev_ = want;
    wifi_bad_until_ = hal_.millis() + cfg_.wifi_list_retry_ms;
  }
  plog("WIFI,list=%s,rev=%u,advertised=%u,status=%d,len=%d,networks=%d,why=%s", ok ? "adopted" : "kept", (unsigned)places_.rev(),
       (unsigned)want, h.status, h.body_len, places_.count(), why);
  if (!ok) statusError();
}

// ---------- status report (docs/device-api.md section 7) ----------
void App::statusError() {
  err_since_rep_ = true;
  ring_.pinError();  // keep the lines around the first error until a report carried them
}

// One POST /v1/status inside a session whose Wi-Fi is up anyway. Bounded (status_timeout_ms),
// never retried; the outcome only changes what the next report carries.
bool App::statusReport(int rssi, uint32_t connect_ms) {
  if (hal_.buttonDown(Button::Boot)) return false;  // BOOT: the user records now
  uint64_t now = hal_.millis();
  int lvl = hal_.usbConnected() ? 0 : batt_level_;
  int last = queue_.lastStatus();
  const char *skip = nullptr;
  if (last < 0 && last != HTTP_ERR_NO_FILE) skip = "unreachable";  // would only pay another timeout
  else if (lvl == 2 && !(crash_unreported_ && !crash_crit_tried_)) skip = "critical";
  else if (lvl == 1 && rep_tried_ && now - rep_try_ms_ < cfg_.status_low_min_ms && !crash_unreported_) skip = "low";
  if (skip) {
    st_.stats.status_skipped++;
    plog("STATUS,skip=%s", skip);
    return false;
  }
  uint32_t epd = hal_.displayTimeouts();
  bool with_log = want_log_ || err_since_rep_ || crash_unreported_ || epd != epd_seen_;
  StatusReport r;
  r.id = hal_.deviceId();
  r.fw = hal_.fwVersion();
  r.slot = hal_.otaRunningSlot();
  r.reset = reset_;
  r.ssid = places_.ssid();
  r.boot_n = boot_n_;
  r.up_s = (uint32_t)((now - boot_ms_) / 1000);
  r.batt_mv = hal_.batteryMv();
  r.usb = hal_.usbConnected();
  r.rssi = rssi;
  r.connect_ms = connect_ms;
  r.heap = hal_.heapFree();
  r.heap_min = hal_.heapMinFree();
  r.q = queue_.pending();
  r.pending = (uint32_t)results_.count();
  uint64_t awake = st_.stats.awake_ms + (now - last_wake_ms_);  // + the current awake stretch
  r.awake_ms = awake - rep_awake_;
  r.sleep_ms = st_.stats.sleep_ms - rep_sleep_;
  const Stats &s = st_.stats;
  r.clips = s.clips;
  r.uploads = s.uploaded;
  r.upload_fail = s.upload_fail;
  r.wifi_fail = s.wifi_fail;
  r.dups = s.dups;
  r.quarantined = s.quarantined;
  r.dropped_bytes = s.dropped_bytes;
  r.too_short = s.too_short;
  r.epd_timeouts = epd;
  r.results = s.results;
  r.check_fail = s.check_fail;
  size_t cap = 0;
  char *body = queue_.scratch(&cap);  // the reply buffer is free now: no extra RAM for the body
  int lines = -1;
  size_t len = buildStatusJson(body, cap, r, with_log ? &ring_ : nullptr, &lines);
  if (!len) return false;
  char reply[128];
  HttpResult h = queue_.postJson("/v1/status", body, len, reply, sizeof(reply), cfg_.status_timeout_ms);
  uint32_t ms = (uint32_t)(hal_.millis() - now);
  rep_tried_ = true;
  rep_try_ms_ = now;
  if (lvl == 2) crash_crit_tried_ = true;
  bool ok = h.status >= 200 && h.status < 300, want = false;
  if (ok) {
    want = h.want_log;
    JsonField f[1];
    f[0].key = "want_log";
    if (!want && h.body_len > 0 && jsonReadObject(reply, f, 1) && f[0].type == JsonType::Bool) want = f[0].b;
    rep_awake_ = awake;  // deltas restart only after the server has them
    rep_sleep_ = st_.stats.sleep_ms;
    want_log_ = want;
    err_since_rep_ = crash_unreported_ = false;
    epd_seen_ = epd;
    ring_.unpin();
    st_.stats.status_sent++;
  } else {
    st_.stats.status_fail++;  // older server (404/405), 5xx, timeout: ignored, tried next session
  }
  plog("STATUS,code=%d,ms=%u,bytes=%u,log=%d,want_log=%d", h.status, (unsigned)ms, (unsigned)len, lines, want);
  return ok;
}

// ---------- firmware update ----------
OtaIo App::otaIo() {
  OtaIo io;
  io.log = logCb;
  io.progress = otaProgress;
  io.abort = abortOnBoot;
  io.ctx = this;
  return io;
}

void App::otaProgress(void *self, const char *version, int pct) {
  App *a = (App *)self;
  char d[48];
  if (pct < 0) snprintf(d, sizeof(d), "v%s\nrestarting", version);
  else snprintf(d, sizeof(d), "v%s\n%d%%", version, pct);
  a->show(Screen::Updating, "UPDATING", d);
}

bool App::otaBattOk() {
  if (hal_.usbConnected()) return true;
  int pct = batteryPercent(hal_.batteryMv());
  return pct >= cfg_.ota.min_batt_pct;
}

// Runs inside a connected session (Wi-Fi up). Returns false if nothing was attempted.
bool App::otaStep(const char *reason, bool busy) {
  OtaIo io = otaIo();
  if (ota_.verifyPingDue()) {
    // Freshly installed firmware: one request to prove Wi-Fi + TLS + HTTP work (it also tells
    // the server the new version, X-PV-FW). Unless this session already reached the server.
    if (!queue_.reached()) {
      char path[96];
      snprintf(path, sizeof(path), "/v1/firmware?current=%s&device=%s", hal_.fwVersion(), hal_.deviceId());
      HttpResult h = queue_.get(path, cfg_.ota.meta_timeout_ms);
      plog("OTA,ping,status=%d", h.status);
    }
    ota_.pingDone();
    return true;
  }
  if (ota_.verifying()) return true;
  OtaOutcome o = ota_.run(queue_, hal_.millis(), queue_.pending() == 0, otaBattOk(), !busy, io);
  plog("OTA,result=%s,reason=%s,session=%s,busy=%d", otaOutcomeName(o), ota_.lastReason(), reason, busy);
  if (o == OtaOutcome::Installed) {
    otaProgress(this, ota_.offerVersion(), -1);
    netOff();
    ui_.settle();
    hal_.logFlush();
    hal_.restart();  // the bootloader starts the new slot (pending verify)
    return true;
  }
  if (o == OtaOutcome::Failed) statusError();
  if (o == OtaOutcome::Failed && ota_.downloadStarted()) {
    char d[96];
    snprintf(d, sizeof(d), "v%s: %s\nstill on v%s\nwill retry", ota_.offerVersion(), ota_.lastReason(), hal_.fwVersion());
    show(Screen::UpdateFailed, "UPDATE FAILED", d);
  }
  return true;
}

// ---------- power button ----------
// Battery, auto_off_idle_ms_ unused: like powerOff without the PWR handshake or a tone.
void App::autoOff() {
  setState(State::Off);
  show(Screen::Off, "OFF", "press PWR to start");
  updateFooter(true);
  ui_.settle();
  plog("POWEROFF,auto=1,idle_min=%u,queued=%u", (unsigned)((hal_.millis() - used_ms_) / 60000), (unsigned)(sd_ok_ ? queue_.pending() : 0));
  hal_.logFlush();
  hal_.powerLatch(false);
  hal_.delayMs(1500);
  // Still alive: VBUS without a USB host (wall charger) keeps the board powered.
  hal_.powerLatch(true);
  used_ms_ = hal_.millis();
  plog("POWEROFF,still_running=1,note=USB powered");
  show(Screen::Ready, "READY", "Hold BOOT\nand talk");
  setState(State::Ready);
}

void App::powerOff() {
  setState(State::Off);
  show(Screen::Off, "OFF", "release PWR");
  ui_.settle();
  while (hal_.buttonDown(Button::Pwr)) hal_.delayMs(10);  // the gate is held while PWR is down
  beep(TONES(T_OFF));
  show(Screen::Off, "OFF", "press PWR to start");
  updateFooter(true);
  ui_.settle();
  plog("POWEROFF,usb=%d", hal_.usbConnected());
  hal_.logFlush();
  hal_.powerLatch(false);
  hal_.delayMs(1500);
  // Still alive: VBUS keeps the board powered.
  hal_.powerLatch(true);
  plog("POWEROFF,still_running=1,note=USB powered");
  show(Screen::StillOn, "STILL ON", "USB power\n(latch released)");
  setState(State::Ready);
}

bool App::handlePwr() {
  if (!hal_.buttonDown(Button::Pwr)) {
    pwr_released_ = true;
    return false;
  }
  if (!pwr_released_) return false;  // still held from power-on
  uint64_t t0 = hal_.millis();
  while (hal_.buttonDown(Button::Pwr)) {
    if (hal_.millis() - t0 >= cfg_.pwr_long_ms) {
      powerOff();
      return true;
    }
    hal_.delayMs(10);
  }
  used_ms_ = hal_.millis();
  uint32_t q = sd_ok_ ? queue_.pending() : 0;
  char d[80];
  snprintf(d, sizeof(d), "%u queued\n%u sent\n%u waiting", (unsigned)q, (unsigned)st_.stats.uploaded, (unsigned)results_.count());
  show(sd_ok_ ? Screen::Status : Screen::NoSd, sd_ok_ ? "READY" : "NO SD", sd_ok_ ? d : "Insert FAT32 card\nand press RESET");
  updateFooter(true);
  awake_until_ms_ = hal_.millis() + cfg_.status_window_ms;
  // Short press = retry now: queued clips and pending results, even on a critical battery.
  if (q) backoff_.retryNow();
  results_.allDueNow(hal_.millis());
  force_net_ = q || results_.count();
  return false;
}

// ---------- sleep ----------
void App::endCycle() {
  uint64_t now = hal_.millis();
  uint32_t awake = (uint32_t)(now - last_wake_ms_);
  st_.stats.awake_ms += awake;
  uint32_t heap = hal_.heapFree();
  st_.stats.heap_cycle_delta = (int32_t)heap - (int32_t)st_.stats.heap_last_cycle;
  st_.stats.heap_last_cycle = heap;
  int mv = hal_.batteryMv();
  plog("CYCLE,n=%u,cause=%s,slept_ms=%u,awake_ms=%u,epd=%u,queued=%u,heap=%u,heap_delta=%d,heap_min=%u,batt_mv=%d,pct=%d,usb=%d,"
       "tot_awake_ms=%llu,tot_sleep_ms=%llu,screen=%s",
       (unsigned)st_.cycle, cause_, (unsigned)slept_ms_, (unsigned)awake, (unsigned)(ui_.refreshes() - refresh_at_wake_),
       (unsigned)st_.queued, (unsigned)heap, (int)st_.stats.heap_cycle_delta, (unsigned)hal_.heapMinFree(), mv, batteryPercent(mv),
       hal_.usbConnected(), (unsigned long long)st_.stats.awake_ms, (unsigned long long)st_.stats.sleep_ms, ui_.model().title);
}

void App::lightSleep(uint32_t ms) {
  updateFooter();
  ui_.settle();
  endCycle();
  hal_.logFlush();  // HAL must bound this (HWCDC flush can block once USB is gone)
  // Re-check: a press that arrived while settling must be recorded, not slept through.
  if (hal_.buttonDown(Button::Boot) || hal_.buttonDown(Button::Pwr)) {
    last_wake_ms_ = hal_.millis();
    return;
  }
  uint64_t now = hal_.millis();
  if (!pwr_wake_ok_ && now >= pwr_wake_off_until_) {
    pwr_wake_ok_ = true;
    st_.stats.spurious_pwr = 0;
    plog("WARN,pwr wake re-enabled");
  }
  setState(State::Sleeping);
  // PWR still held since power-on would wake us at once (level wake): leave it out then.
  bool pwr_wake = pwr_wake_ok_ && !hal_.buttonDown(Button::Pwr);
  Wake w = hal_.lightSleep(ms, true, pwr_wake);
  uint64_t t1 = hal_.millis();
  bool boot = hal_.buttonDown(Button::Boot), pwr = hal_.buttonDown(Button::Pwr);
  slept_ms_ = (uint32_t)(t1 - now);
  st_.stats.sleep_ms += slept_ms_;
  st_.stats.wakes++;
  st_.cycle++;
  last_wake_ms_ = t1;
  refresh_at_wake_ = ui_.refreshes();
  stayAwake(cfg_.wake_grace_ms);  // never decide to sleep again in the first moments after a wake
  switch (w) {
    case Wake::Timer: cause_ = "timer"; st_.stats.timer_wakes++; break;
    case Wake::Boot: cause_ = "boot"; st_.stats.boot_wakes++; break;
    case Wake::Pwr: cause_ = "pwr"; st_.stats.pwr_wakes++; break;
    case Wake::Gpio:
      cause_ = boot ? "boot" : pwr ? "pwr" : "gpio?";
      if (boot) st_.stats.boot_wakes++;
      else if (pwr) st_.stats.pwr_wakes++;
      break;
    default: cause_ = "other"; break;
  }
  // A PWR wake with no button down (noise on GPIO2 or a very short tap): after several in a
  // row stop using PWR as a wake source for a while (power_proto disabled it for good).
  if ((w == Wake::Pwr || w == Wake::Gpio) && !boot && !pwr) {
    if (++st_.stats.spurious_pwr >= cfg_.pwr_spurious_max && pwr_wake_ok_) {
      pwr_wake_ok_ = false;
      pwr_wake_off_until_ = t1 + cfg_.pwr_wake_reenable_ms;
      plog("WARN,pwr wake disabled (spurious) for %u s", (unsigned)(cfg_.pwr_wake_reenable_ms / 1000));
    }
  } else if (pwr || boot) {
    st_.stats.spurious_pwr = 0;
  }
  setState(State::Ready);
}

// ---------- loop ----------
void App::loop() {
  bool did = false, recorded = false;
  if (hal_.buttonDown(Button::Boot) && sd_ok_) {
    recorded = recordClip(0);
    did = true;
  } else if (sim_rec_ms_ && sd_ok_) {
    uint32_t ms = sim_rec_ms_;
    sim_rec_ms_ = 0;
    recorded = recordClip(ms);
    did = true;
  }
  if (handlePwr()) did = true;
  if (hal_.millis() - last_batt_ms_ >= 5000) updateBattery();
  if (prov_busy_ && hal_.millis() - prov_busy_since_ > cfg_.console_window_ms) {
    prov_busy_ = false;  // setup stopped halfway (tool closed, cable pulled): carry on with what was saved
    plog("PROV,abandoned=1");
  }
  bool net = netAllowed() && provisioned() && !prov_busy_;
  uint64_t now = hal_.millis();
  // The setup check-in also runs without an SD card (it only reports).
  bool hello = hello_due_ && !prov_busy_ && now >= hello_next_ms_ && (batt_level_ < 2 || hal_.usbConnected());
  if ((net || hello) && !hal_.buttonDown(Button::Boot)) {
    // A new clip goes out at once (even while backing off); timer retries wait for the backoff.
    bool upload = net && (recorded || backoff_.due(now)) && queue_.pending() > 0;
    bool check = net && results_.anyDue(now);
    bool fw = net && (ota_.verifyPingDue() || ota_.dedicatedDue(now, otaBattOk()));
    if (upload || check || fw || hello)
      netSession(recorded ? "new_clip" : upload ? (force_net_ ? "pwr" : "retry") : check ? "check" : hello ? "hello"
                 : ota_.verifying() ? "fw_verify" : "fw_check",
                 upload, check, fw, hello);
  }
  // New firmware: confirm it once healthy (app up, SD mounted or confirmed absent - setup did
  // that -, display refreshed, and the server reached or enough uptime). Else a reset rolls back.
  if (ota_.verifying() && ota_.maybeConfirm(hal_.millis(), ui_.refreshes() > 0, queue_.reached())) {
    plog("OTA,valid,fw=%s,via=%s,uptime_s=%u", hal_.fwVersion(), queue_.reached() ? "server" : "uptime",
         (unsigned)(hal_.millis() / 1000));
    publish();
  }
  force_net_ = false;
  (void)did;
  SleepInputs in;
  in.now = hal_.millis();
  in.idle_wake_s = cfg_.idle_wake_s;
  in.pending = sd_ok_ ? queue_.pending() : 0;
  in.next_retry_ms = backoff_.next_ms;
  in.uploads_possible = netAllowed();
  in.next_check_ms = results_.nextDue();
  if (hello_due_) {  // wake for the next check-in attempt
    uint64_t h = hello_next_ms_ > in.now ? hello_next_ms_ : in.now + 1;
    if (!in.next_check_ms || h < in.next_check_ms) in.next_check_ms = h;
  }
  in.awake_until_ms = awake_until_ms_;
  in.stay = stay_ || sim_rec_ms_;
  in.usb = hal_.usbConnected();
  if (in.usb) used_ms_ = in.now;
  in.skip_sleep_on_usb = cfg_.skip_sleep_on_usb;
  in.boot_down = hal_.buttonDown(Button::Boot);  // also without SD: never sleep on a held level
  in.pwr_down = hal_.buttonDown(Button::Pwr) && pwr_released_;
  SleepDecision dec = decideSleep(in);
  if (!dec.sleep) {
    if (in.now - last_footer_ms_ > 30000) {
      last_footer_ms_ = in.now;
      updateFooter();
    }
    hal_.delayMs(10);
    return;
  }
  if (auto_off_idle_ms_ && in.now - used_ms_ >= auto_off_idle_ms_ && !results_.count() && !ota_.verifying()) {
    autoOff();
    return;
  }
  lightSleep(dec.ms);
  updateBattery();  // fresh reading after every wake
}

void App::stayAwake(uint32_t ms) {
  uint64_t until = hal_.millis() + ms;
  if (until > awake_until_ms_) awake_until_ms_ = until;
}

void App::command(const char *line) {
  char cmd[16] = "";
  unsigned arg = 0;
  int n = sscanf(line, "%15s %u", cmd, &arg);
  if (n < 1) return;
  stayAwake(cfg_.console_window_ms);
  if (!strcmp(cmd, "sim")) requestRecording(n > 1 ? arg : 3000);
  else if (!strcmp(cmd, "stay")) stay_ = n > 1 ? arg : 1;
  else if (!strcmp(cmd, "sleep")) { stay_ = false; awake_until_ms_ = 0; }
  else if (!strcmp(cmd, "beep")) beep(TONES(T_START));
  else if (!strcmp(cmd, "check")) { results_.allDueNow(hal_.millis()); force_net_ = true; }
  else if (!strcmp(cmd, "ota")) ota_.forceCheck(hal_.millis());
  else if (!strcmp(cmd, "autooff")) auto_off_idle_ms_ = arg * 1000u;  // test: seconds, until the next start
  else if (!strcmp(cmd, "info")) { info(); return; }
  else if (!strcmp(cmd, "prov")) { provision(line + 4); return; }
  else if (!strcmp(cmd, "wifi")) { wifiCmd(line + 4); return; }
  else if (strcmp(cmd, "stat")) { plog("CMD,unknown=%s", cmd); return; }
  plog("STAT,cmd=%s,state=%s,q=%u,pending=%d,sent=%u,heap=%u,heap_min=%u,batt=%d,awake_ms=%llu,sleep_ms=%llu,backoff_ms=%u", cmd,
       stateName(st_.state), (unsigned)(sd_ok_ ? queue_.pending() : 0), results_.count(), (unsigned)st_.stats.uploaded, (unsigned)hal_.heapFree(),
       (unsigned)hal_.heapMinFree(), hal_.batteryMv(), (unsigned long long)st_.stats.awake_ms, (unsigned long long)st_.stats.sleep_ms,
       (unsigned)backoff_.cur_ms);
}

// ---------- setup over USB (pocketbot setup; the tool reads the "@{...}" lines) ----------
const char *netResultName(int r) {
  switch (r) {
    case NET_OK: return "ok";
    case NET_HTTP: return "server";
    case NET_WIFI_PASSWORD: return "wifi_password";
    case NET_WIFI_NOT_FOUND: return "wifi_not_found";
    case NET_WIFI: return "no_wifi";
    case NET_ABORTED: return "aborted";
    default: return "never";
  }
}

static void esc(char *dst, size_t cap, const char *s) {  // JSON string body, NUL-terminated ("?" if it does not fit)
  size_t n = strlen(s), need = jsonEscape(nullptr, s, n);
  if (need >= cap) { snprintf(dst, cap, "?"); return; }
  jsonEscape(dst, s, n);
  dst[need] = 0;
}

void App::reply(const char *json) {
  char l[1024];
  snprintf(l, sizeof(l), "@%s", json);
  hal_.log(l);
  hal_.logFlush();
}

// One line: {"id","fw","server","token","wifi_rev","networks":[ssid...],"hello","net","net_http","net_age_s","ssid",
// "sd","batt_mv","usb","state"}. Never prints the token or Wi-Fi passwords.
void App::info() {
  // Worst case: 640 of names + a 200-character server + an 80-character SSID + ~300 of keys and values. Built
  // straight into the reply line ("@" + JSON) so there's no second copy on the stack.
  char nets[640] = "", e[80], srv[200], l[1400];
  size_t o = 0;
  for (int i = 0; i < places_.count(); i++) {  // whole names only: the reply stays valid JSON
    esc(e, sizeof(e), places_.at(i).ssid);
    if (o + strlen(e) + 4 >= sizeof(nets)) break;
    o += snprintf(nets + o, sizeof(nets) - o, "%s\"%s\"", i ? "," : "", e);
  }
  esc(srv, sizeof(srv), queue_.serverUrl());
  char tok[160] = "";  // NVS refuses a read into a buffer smaller than the value: size it like setup() does
  bool has_tok = hal_.kvGet("dev_tok", tok, sizeof(tok)) && tok[0];
  memset(tok, 0, sizeof(tok));
  esc(e, sizeof(e), places_.ssid());
  l[0] = '@';
  snprintf(l + 1, sizeof(l) - 1,
           "{\"v\":1,\"id\":\"%s\",\"fw\":\"%s\",\"server\":\"%s\",\"token\":%s,\"wifi_rev\":%u,\"networks\":[%s],\"hello\":%s,"
           "\"net\":\"%s\",\"net_http\":%d,\"net_age_s\":%d,\"ssid\":\"%s\",\"sd\":%s,\"batt_mv\":%d,\"usb\":%s,\"state\":\"%s\"}",
           hal_.deviceId(), hal_.fwVersion(), srv, has_tok ? "true" : "false", (unsigned)places_.rev(), nets, hello_due_ ? "true" : "false",
           netResultName(net_last_), net_last_http_, net_last_ < 0 ? -1 : (int)((hal_.millis() - net_last_ms_) / 1000), e,
           sd_ok_ ? "true" : "false", hal_.batteryMv(), hal_.usbConnected() ? "true" : "false", stateName(st_.state));
  hal_.log(l);
  hal_.logFlush();
}

// prov server <https://...> | prov token <token> | prov wifi <GET /v1/wifi body> | prov done | prov reset
// Each answers @{"ok":true,...} or @{"ok":false,"error":"..."}. "done" starts the check-in at once.
void App::provision(const char *args) {
  while (*args == ' ') args++;
  char what[12] = "";
  int wl = 0;
  while (args[wl] && args[wl] != ' ' && wl < (int)sizeof(what) - 1) { what[wl] = args[wl]; wl++; }
  const char *val = args + wl;
  while (*val == ' ') val++;
  char err[48] = "";
  if (!strcmp(what, "server")) {
    size_t n = strlen(val);
    while (n && (val[n - 1] == '/' || val[n - 1] == ' ')) n--;
    if (n < 8 || n >= sizeof(server_url_) || (strncmp(val, "https://", 8) && strncmp(val, "http://", 7))) snprintf(err, sizeof(err), "bad_url");
    else {
      char b[sizeof(server_url_)];
      memcpy(b, val, n);
      b[n] = 0;
      if (!hal_.kvSet("srv_url", b)) snprintf(err, sizeof(err), "save_failed");
      else {
        memcpy(server_url_, b, n + 1);
        queue_.setServerUrl(server_url_);
      }
    }
  } else if (!strcmp(what, "token")) {
    size_t n = strlen(val);
    bool ok = n >= 8 && n < 120;
    for (size_t i = 0; ok && i < n; i++) ok = val[i] > 32 && val[i] < 127;
    if (!ok) snprintf(err, sizeof(err), "bad_token");
    else if (!hal_.kvSet("dev_tok", val)) snprintf(err, sizeof(err), "save_failed");
    else hal_.setAuth(val);
  } else if (!strcmp(what, "wifi")) {
    size_t cap = 0;
    char *scratch = queue_.scratch(&cap);  // no request in flight while a command runs
    char why[24] = "";
    if (strlen(val) >= cap) snprintf(err, sizeof(err), "too_big");
    else {
      memmove(scratch, val, strlen(val) + 1);
      if (!places_.adopt(hal_, scratch, scratch, cap, why, sizeof(why), true)) snprintf(err, sizeof(err), "wifi_%s", why);
      else hal_.kvSet("wifi_last", "");  // the old "last network" may not be on the new list
    }
  } else if (!strcmp(what, "done")) {
    if (!provisioned()) snprintf(err, sizeof(err), "no_server");
    else {
      hal_.kvSet("hello", "1");
      hello_due_ = hello_kv_ = true;
      hello_next_ms_ = 0;
      hello_wait_ms_ = 0;
      hello_started_ms_ = 0;
      backoff_.retryNow();  // clips recorded before setup go up in the check-in session
      stayAwake(cfg_.console_window_ms);
      show(Screen::Sending, "CONNECTING", "first check-in");
    }
  } else if (!strcmp(what, "reset")) {  // forget the setup (back to the compiled-in settings)
    hal_.kvSet("srv_url", "");
    hal_.kvSet("dev_tok", "");
    hal_.kvSet("hello", "");
    server_url_[0] = 0;
    queue_.setServerUrl(nullptr);
    hal_.setAuth(nullptr);  // back to the token compiled into the firmware (none in a release image)
    hello_due_ = false;
  } else {
    snprintf(err, sizeof(err), "unknown");
  }
  // Half set up (a setting saved, no "done" yet): no network sessions, so the board doesn't try a server or
  // network that is about to change. Only after a successful change, and only for console_window_ms.
  if (!err[0] && (!strcmp(what, "server") || !strcmp(what, "token") || !strcmp(what, "wifi"))) {
    prov_busy_ = true;
    prov_busy_since_ = hal_.millis();
  } else if (!strcmp(what, "done") || !strcmp(what, "reset")) {
    prov_busy_ = false;
  }
  plog("PROV,what=%s,ok=%d%s%s", what, !err[0], err[0] ? ",error=" : "", err);
  char l[160];
  if (err[0]) snprintf(l, sizeof(l), "{\"ok\":false,\"what\":\"%s\",\"error\":\"%s\"}", what, err);
  else if (!strcmp(what, "wifi")) snprintf(l, sizeof(l), "{\"ok\":true,\"what\":\"wifi\",\"rev\":%u,\"count\":%d}", (unsigned)places_.rev(), places_.count());
  else snprintf(l, sizeof(l), "{\"ok\":true,\"what\":\"%s\"}", what);
  reply(l);
}

// wifi scan: the networks the board sees, one per name (its strongest access point), strongest first:
//   @{"ok":true,"what":"scan","nets":[{"ssid":"...","rssi":-40,"open":false},...]} (as many as fit one line)
// wifi test {"ssid":"...","psk":"..."}: joins that network (nothing is saved) and makes one request to the server:
//   @{"ok":true,"what":"test","ssid":"...","rssi":-40,"ms":2100}
//   @{"ok":false,"what":"test","error":"wifi_password|wifi_not_found|no_wifi|server|no_server|bad_input","http":0,"ms":0}
// Used by the setup wizard while the board is plugged in, so a password is proven before it is saved.
void App::wifiCmd(const char *args) {
  while (*args == ' ') args++;
  // Setup is under way: no network sessions of its own meanwhile (as after a "prov"; ends with "prov done" or after
  // console_window_ms), so a board that was set up before doesn't hold the console up with one.
  prov_busy_ = true;
  prov_busy_since_ = hal_.millis();
  char e[80], l[1000];
  if (!strncmp(args, "scan", 4)) {
    static WifiAp aps[24];  // static: ~1 KB that doesn't need to live on the loop task's stack
    int n = hal_.wifiScan(aps, 24);
    hal_.wifiOff();
    if (n < 0) {
      plog("WIFI,cmd=scan,error=scan_failed");
      reply("{\"ok\":false,\"what\":\"scan\",\"error\":\"scan_failed\"}");
      return;
    }
    int k = 0;  // one entry per name, keeping the strongest access point
    for (int i = 0; i < n; i++) {
      if (!aps[i].ssid[0]) continue;
      int j = 0;
      while (j < k && strcmp(aps[j].ssid, aps[i].ssid)) j++;
      if (j < k) {
        if (aps[i].rssi > aps[j].rssi) aps[j] = aps[i];
      } else {
        aps[k++] = aps[i];
      }
    }
    for (int i = 1; i < k; i++) {  // strongest first
      WifiAp t = aps[i];
      int j = i - 1;
      while (j >= 0 && aps[j].rssi < t.rssi) { aps[j + 1] = aps[j]; j--; }
      aps[j + 1] = t;
    }
    size_t o = (size_t)snprintf(l, sizeof(l), "{\"ok\":true,\"what\":\"scan\",\"nets\":[");
    int shown = 0;
    for (int i = 0; i < k; i++) {
      esc(e, sizeof(e), aps[i].ssid);
      char item[128];
      int m = snprintf(item, sizeof(item), "%s{\"ssid\":\"%s\",\"rssi\":%d,\"open\":%s}", shown ? "," : "", e, (int)aps[i].rssi,
                       aps[i].open ? "true" : "false");
      if (m <= 0 || o + (size_t)m + 3 >= sizeof(l)) break;  // whole entries only: the reply stays valid JSON
      memcpy(l + o, item, (size_t)m);
      o += (size_t)m;
      shown++;
    }
    snprintf(l + o, sizeof(l) - o, "]}");
    plog("WIFI,cmd=scan,aps=%d,names=%d,shown=%d", n, k, shown);
    reply(l);
    return;
  }
  if (!strncmp(args, "test", 4)) {
    char ssid[33] = "", psk[65] = "";
    JsonField f[2];
    f[0].key = "ssid", f[0].str = ssid, f[0].cap = sizeof(ssid);
    f[1].key = "psk", f[1].str = psk, f[1].cap = sizeof(psk);
    size_t pl = 0;
    bool ok = jsonReadObject(args + 4, f, 2) && f[0].type == JsonType::String && ssid[0] &&
              (f[1].type == JsonType::Missing || f[1].type == JsonType::String);
    if (ok) pl = strlen(psk);
    if (ok && pl && (pl < 8 || pl > 63)) ok = false;  // WPA2 passphrase, or none (open network)
    const char *err = nullptr;
    int http = 0, rssi = 0;
    uint32_t ms = 0;
    if (!ok) err = "bad_input";
    else if (!provisioned()) err = "no_server";
    else {
      show(Screen::Sending, "CONNECTING", ssid);
      uint64_t t0 = hal_.millis();
      WifiAp ap;
      WifiResult r = hal_.wifiJoin(ssid, psk, nullptr, 0, cfg_.wifi_test_ms, nullptr, nullptr, &ap);
      if (r == WifiResult::Ok) {
        rssi = ap.rssi;
        char url[sizeof(server_url_) + 16], body[64];
        snprintf(url, sizeof(url), "%s/v1/ping", queue_.serverUrl());
        HttpResult h = hal_.httpGet(url, body, sizeof(body), cfg_.wifi_test_http_ms);
        http = h.status;
        if (h.status < 200 || h.status > 299) err = "server";  // 204 from /v1/ping (a portal's 30x/404 doesn't count)
      } else {
        err = r == WifiResult::Failed ? "wifi_password" : r == WifiResult::NoSsid ? "wifi_not_found" : "no_wifi";
      }
      ms = (uint32_t)(hal_.millis() - t0);
      hal_.httpSessionEnd();
      hal_.wifiOff();
      memset(psk, 0, sizeof(psk));
      // Calm either way: the wizard on the Mac says what went wrong.
      show(Screen::Status, err ? "WI-FI" : "ONLINE", !err ? ssid : !strcmp(err, "wifi_password") ? "check the password" : "try again");
    }
    plog("WIFI,cmd=test,result=%s,http=%d,ms=%u", err ? err : "ok", http, (unsigned)ms);
    if (err) snprintf(l, sizeof(l), "{\"ok\":false,\"what\":\"test\",\"error\":\"%s\",\"http\":%d,\"ms\":%u}", err, http, (unsigned)ms);
    else {
      esc(e, sizeof(e), ssid);
      snprintf(l, sizeof(l), "{\"ok\":true,\"what\":\"test\",\"ssid\":\"%s\",\"rssi\":%d,\"ms\":%u}", e, rssi, (unsigned)ms);
    }
    reply(l);
    return;
  }
  reply("{\"ok\":false,\"what\":\"wifi\",\"error\":\"unknown\"}");
}

}  // namespace pv
