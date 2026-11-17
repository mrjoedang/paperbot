// Headless scenarios: each runs a fresh simulated device (own SD folder, mock reset) against
// the mock server, drives buttons / faults in virtual time and checks the outcome.
// Output: console summary + <report_dir>/report.html with screenshots of key screens.
#include <dirent.h>
#include <stdarg.h>
#include <sys/stat.h>
#include <chrono>
#include <functional>
#include <random>
#include <set>
#include "sim.h"
#include "wavfile.h"

namespace sim {

std::string jsonEsc(const std::string &s);

pv::Config defaultConfig(const Options &o) {
  pv::Config c;
  c.queue.server_url = o.server_url.c_str();
  c.queue.id_prefix = o.id_prefix.c_str();
  return c;
}

namespace {

struct Check {
  std::string name, detail;
  bool ok;
};

struct MockState {
  int puts = 0, ok = 0, errors = 0, tasks = 0, max_ok_per_id = 0, max_puts_per_id = 0, dup_replies = 0, bytes = 0, bad_headers = 0;
  int gets = 0, get_recording = 0, get_updates = 0, get_errors = 0, unfinished = 0;
  int fw_checks = 0, fw_offers = 0, fw_downloads = 0, fw_bytes = 0, fw_bin_auth = 0;
  char fw_last[16] = "";
  bool valid = false;
};

struct Ctx {
  Sim &s;
  pv::Config cfg;
  std::string dir;
  std::vector<Check> checks;
  std::vector<std::pair<std::string, std::string>> shots;
  std::vector<std::string> notes;

  Ctx(Sim &sim, const Options &o, const std::string &d) : s(sim), cfg(defaultConfig(o)), dir(d) {}

  bool check(bool ok, const std::string &name, const char *fmt = "", ...) {
    char b[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(b, sizeof(b), fmt, ap);
    va_end(ap);
    checks.push_back({ name, b, ok });
    return ok;
  }
  void note(const char *fmt, ...) {
    char b[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(b, sizeof(b), fmt, ap);
    va_end(ap);
    notes.push_back(b);
  }
  pv::AppStatus st() { return s.snapshot().st; }
  std::string title() { return st().screen.title; }
  pv::Screen screen() { return st().screen.id; }
  // Screenshot of the panel. LVGL redraws asynchronously (<= 500 ms later, like the UI task on
  // the board), so let that happen first.
  void shot(const std::string &label) {
    s.runFor(600);
    Sim::Snapshot sn = s.snapshot();
    char name[96];
    snprintf(name, sizeof(name), "%02d-%s.png", (int)shots.size() + 1, label.c_str());
    writeFile(dir + "/" + name, framePng(sn.fb, pv::EPD_W, pv::EPD_H, 2));
    shots.push_back({ label, name });
  }
  bool waitScreen(pv::Screen id, uint64_t max_ms) { return s.runUntil([&] { return screen() == id; }, max_ms); }
  bool waitSleep(uint64_t max_ms) {
    return s.runUntil([&] { return s.sleeping() && st().state == pv::State::Sleeping; }, max_ms);
  }
  bool boot() {
    s.start(cfg);
    return s.runUntil([&] { return st().state == pv::State::Ready && screen() != pv::Screen::Boot; }, 5000);
  }
  // Holds BOOT for ms (the recording) and releases it.
  void record(uint64_t ms) { s.hold(pv::Button::Boot, ms); }
  void mockConfig(const std::string &json) { s.mockRequest("POST", "/__mock/config", json); }
  MockState mock() {
    MockState m;
    std::string body = s.mockRequest("GET", "/__mock/state");
    const int N = 20;
    pv::JsonField f[N];
    const char *keys[N] = { "puts", "ok", "errors", "tasks", "max_ok_per_id", "max_puts_per_id", "dup_replies", "bytes", "bad_headers",
                            "gets", "get_recording", "get_updates", "get_errors", "unfinished", "fw_checks", "fw_offers", "fw_downloads",
                            "fw_bytes", "fw_bin_auth", "fw_last" };
    for (int i = 0; i < N; i++) f[i].key = keys[i];
    f[19].str = m.fw_last;
    f[19].cap = sizeof(m.fw_last);
    m.valid = pv::jsonReadObject(body.c_str(), f, N);
    int *dst[N - 1] = { &m.puts, &m.ok, &m.errors, &m.tasks, &m.max_ok_per_id, &m.max_puts_per_id, &m.dup_replies, &m.bytes, &m.bad_headers,
                        &m.gets, &m.get_recording, &m.get_updates, &m.get_errors, &m.unfinished, &m.fw_checks, &m.fw_offers, &m.fw_downloads,
                        &m.fw_bytes, &m.fw_bin_auth };
    for (int i = 0; i < N - 1; i++) *dst[i] = (int)f[i].num;
    return m;
  }
  // Pending-results file on the simulated SD card ("" if none).
  std::string pendingFile() {
    FILE *f = fopen(s.sdPath("/pv_pending.txt").c_str(), "rb");
    if (!f) return "";
    char b[1024];
    size_t n = fread(b, 1, sizeof(b) - 1, f);
    fclose(f);
    b[n] = 0;
    return b;
  }
  uint32_t asleepRefreshes() { return s.snapshot().energy.refreshes_asleep; }
  uint32_t refreshes() { return s.snapshot().energy.refreshes; }
  // Beeps at >= hz since virtual time t (success = 2000 Hz in T_SENT).
  int beepsSince(uint64_t t, uint16_t hz) {
    int n = 0;
    for (auto &b : s.snapshot().beeps)
      if (b.t >= t && b.hz == hz) n++;
    return n;
  }
  // Virtual times (ms) of log lines containing needle.
  std::vector<uint64_t> logTimes(const std::string &needle) {
    std::vector<uint64_t> t;
    for (auto &l : s.logSince(0, 100000))
      if (l.second.find(needle) != std::string::npos) {
        double sec = 0;
        sscanf(l.second.c_str(), "[%lf]", &sec);
        t.push_back((uint64_t)(sec * 1000 + 0.5));
      }
    return t;
  }
  uint32_t filesIn(const std::string &sd_dir) {
    DIR *d = opendir(s.sdPath(sd_dir).c_str());
    if (!d) return 0;
    uint32_t n = 0;
    while (struct dirent *e = readdir(d))
      if (e->d_name[0] != '.') n++;
    closedir(d);
    return n;
  }
};

typedef void (*ScenarioFn)(Ctx &);
struct Scenario {
  const char *name, *what;
  ScenarioFn fn;
};

const uint64_t SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN;

// ---------- status reports (POST /v1/status) as the mock received and validated them ----------
struct StatusRep {
  double t = 0, code = 0, bytes = 0, log_n = -1, v = 0, slot = 0, boot_n = 0, up_s = 0, batt_mv = 0, usb = 0, rssi = 0, connect_ms = 0,
         heap = 0, heap_min = 0, q = 0, pending = 0, awake_ms = 0, sleep_ms = 0;
  double clips = 0, uploads = 0, upload_fail = 0, wifi_fail = 0, quarantined = 0, check_fail = 0, results = 0, epd_timeouts = 0;
  bool valid = false;
  std::string id, fw, reset, err, log;
};

static std::vector<StatusRep> statusReports(Ctx &c) {
  std::string body = c.s.mockRequest("GET", "/__mock/status");
  std::vector<StatusRep> out;
  pv::jsonForEachObject(body.c_str(), "reports", [](const char *obj, void *vp) {
    static const char *nk[] = { "_t", "_code", "_bytes", "_log_n", "v", "slot", "boot_n", "up_s", "batt_mv", "usb", "rssi", "connect_ms",
                                "heap", "heap_min", "q", "pending", "awake_ms", "sleep_ms", "stats_clips", "stats_uploads",
                                "stats_upload_fail", "stats_wifi_fail", "stats_quarantined", "stats_check_fail", "stats_results",
                                "stats_epd_timeouts" };
    const int NN = sizeof(nk) / sizeof(nk[0]), NS = 6;
    StatusRep r;
    double *dst[NN] = { &r.t, &r.code, &r.bytes, &r.log_n, &r.v, &r.slot, &r.boot_n, &r.up_s, &r.batt_mv, &r.usb, &r.rssi, &r.connect_ms,
                        &r.heap, &r.heap_min, &r.q, &r.pending, &r.awake_ms, &r.sleep_ms, &r.clips, &r.uploads, &r.upload_fail,
                        &r.wifi_fail, &r.quarantined, &r.check_fail, &r.results, &r.epd_timeouts };
    static char id[40], fw[40], reset[40], err[200], valid_dummy[8], log[8192];
    pv::JsonField f[NN + NS];
    for (int i = 0; i < NN; i++) f[i].key = nk[i];
    const char *sk[NS] = { "id", "fw", "reset", "_err", "_log_text", "_valid" };
    char *sb[NS] = { id, fw, reset, err, log, valid_dummy };
    size_t sc[NS] = { sizeof(id), sizeof(fw), sizeof(reset), sizeof(err), sizeof(log), sizeof(valid_dummy) };
    for (int i = 0; i < NS; i++) {
      f[NN + i].key = sk[i];
      f[NN + i].str = sb[i];
      f[NN + i].cap = sc[i];
      sb[i][0] = 0;
    }
    if (!pv::jsonReadObjectPrefix(obj, f, NN + NS)) return;
    for (int i = 0; i < NN; i++) *dst[i] = f[i].type == pv::JsonType::Number ? f[i].num : -1;
    if (f[3].type != pv::JsonType::Number) r.log_n = -1;
    r.id = id;
    r.fw = fw;
    r.reset = reset;
    r.err = err;
    r.log = log;
    r.valid = f[NN + 5].type == pv::JsonType::Bool && f[NN + 5].b;
    ((std::vector<StatusRep> *)vp)->push_back(r);
  }, &out);
  return out;
}

// Network sessions whose Wi-Fi connected (the ones that may carry a status report).
static uint32_t connectedSessions(Ctx &c) {
  uint32_t n = 0;
  for (auto &l : c.s.logSince(0, 1000000))
    if (l.second.find(",NET,reason=") != std::string::npos && l.second.find(",wifi=0,") != std::string::npos) n++;
  return n;
}

// Energy / activity totals for the reporting-on vs reporting-off comparison.
struct RunMetrics {
  double mah = 0;
  uint32_t wakes = 0, timer_wakes = 0, refreshes = 0, sessions = 0, posts = 0, connected = 0, handshakes = 0, requests = 0, leaks = 0;
  uint64_t wifi_ms = 0, awake_ms = 0, t = 0, session_ms = 0;  // session_ms: sum over connected sessions (NET session_ms)
  uint32_t boots = 0;
};
static RunMetrics runMetrics(Ctx &c) {
  Sim::Snapshot sn = c.s.snapshot();
  RunMetrics m;
  m.mah = sn.energy.total_mah();
  m.boots = sn.boots;
  m.wakes = sn.st.stats.wakes;
  m.timer_wakes = sn.st.stats.timer_wakes;
  m.refreshes = sn.energy.refreshes;
  m.sessions = c.s.countLog(",NET,reason=");
  m.connected = connectedSessions(c);
  m.posts = sn.status_posts;
  m.wifi_ms = sn.energy.wifi_ms;
  m.handshakes = sn.http_handshakes;
  m.requests = sn.http_requests;
  m.leaks = sn.conn_leaks;
  for (auto &l : c.s.logSince(0, 1000000)) {
    if (l.second.find(",NET,reason=") == std::string::npos || l.second.find(",wifi=0,") == std::string::npos) continue;
    size_t p = l.second.find(",session_ms=");
    if (p != std::string::npos) m.session_ms += atol(l.second.c_str() + p + 12);
  }
  m.awake_ms = sn.energy.awake_ms + sn.energy.rec_ms + sn.energy.wifi_ms;
  m.t = c.s.now();
  return m;
}
// Runs drive() again on a fresh device with status reporting OFF (own run dir; resets the mock and
// stops the main device, so take its metrics / mock checks first); returns its totals at `until`.
static RunMetrics runVariant(Ctx &c, const char *sub, void (*drive)(Ctx &), uint64_t until, void (*prep)(Ctx &)) {
  c.s.stop();  // LVGL is process-global: only one simulated device at a time (main run is finished)
  Options o = c.s.options();
  o.run_dir = c.dir + "/" + sub;
  Sim s2(o);
  s2.setAudio("file:sim/audio/R0001.WAV") || s2.setAudio("tone:440");
  s2.mockRequest("POST", "/__mock/reset", "{}");
  Ctx c2(s2, o, c.dir);
  c2.cfg = c.cfg;  // same firmware config as the main run; prep changes what is compared
  prep(c2);
  drive(c2);
  s2.runTo(until);
  RunMetrics m = runMetrics(c2);
  s2.stop();
  return m;
}
static RunMetrics twinWithoutStatus(Ctx &c, void (*drive)(Ctx &), uint64_t until) {
  return runVariant(c, "run_nostatus", drive, until, [](Ctx &x) { x.cfg.status_report = false; });
}
// Asserts that reporting costs (almost) nothing: same wakes / sessions / refreshes, energy within 1 %.
static void compareEnergy(Ctx &c, const RunMetrics &on, const RunMetrics &off) {
  double de = off.mah > 0 ? 100.0 * (on.mah - off.mah) / off.mah : 0;
  double dw = off.wakes ? 100.0 * ((double)on.wakes - off.wakes) / off.wakes : (on.wakes ? 100 : 0);
  c.check(on.t == off.t, "compared at the same virtual time", "%llu vs %llu", (unsigned long long)on.t, (unsigned long long)off.t);
  c.check(fabs(de) <= 1.0, "energy with status reports within 1 % of reporting off", "%.4f vs %.4f mAh (%+.3f %%)", on.mah, off.mah, de);
  c.check(fabs(dw) <= 1.0 || (int)on.wakes - (int)off.wakes == 0, "wake count within 1 %", "%u vs %u (%+.2f %%)", on.wakes, off.wakes, dw);
  c.check(on.sessions == off.sessions, "no extra Wi-Fi sessions (reports only piggyback)", "%u vs %u", on.sessions, off.sessions);
  c.check(on.refreshes == off.refreshes, "no extra display refreshes", "%u vs %u", on.refreshes, off.refreshes);
  c.check(off.posts == 0, "reporting off sends nothing", "posts=%u", off.posts);
  c.note("status reports: %u posts in %u connected sessions; energy %+.3f %% (%.4f vs %.4f mAh), Wi-Fi time %+lld ms (%llu vs %llu), "
         "awake %+lld ms, wakes %u vs %u, refreshes %u vs %u", on.posts, on.connected, de, on.mah, off.mah,
         (long long)on.wifi_ms - (long long)off.wifi_ms, (unsigned long long)on.wifi_ms, (unsigned long long)off.wifi_ms,
         (long long)on.awake_ms - (long long)off.awake_ms, on.wakes, off.wakes, on.refreshes, off.refreshes);
}

// ---------------------------------------------------------------------------------------
void scRecordUpload(Ctx &c) {
  c.check(c.boot(), "boots to READY");
  c.shot("ready");
  c.s.setButton(pv::Button::Boot, true);
  c.s.runFor(1500);
  c.check(c.screen() == pv::Screen::Rec, "REC while BOOT held", "screen=%s", pv::screenName(c.screen()));
  c.shot("rec");  // +600 ms
  c.s.runFor(900);
  c.s.setButton(pv::Button::Boot, false);
  c.check(c.waitScreen(pv::Screen::Sending, 5 * SEC), "SENDING after release");
  c.shot("sending");
  bool res = c.waitScreen(pv::Screen::Result, 60 * SEC);
  pv::AppStatus st = c.st();
  c.check(res, "result screen shows routed kind", "title=%s detail=%s", st.screen.title, st.screen.detail);
  c.shot("result");
  c.check(c.s.countLog("screen=SAVED") == 1, "SAVED shown once");
  MockState m = c.mock();
  c.check(m.tasks == 1 && m.max_ok_per_id == 1, "server got exactly one clip", "tasks=%d puts=%d", m.tasks, m.puts);
  int expect = 44 + 3 * 32000;
  c.check(abs(m.bytes - expect) <= 640, "WAV length matches the hold (3.0 s)", "bytes=%d expected~%d", m.bytes, expect);
  c.check(c.s.queueFiles() == 0, "clip deleted after 2xx");
  c.check(m.bad_headers == 0, "WAV header patched with the data size");
  c.check(c.waitSleep(60 * SEC), "goes to light sleep after the boot window");
  Sim::Snapshot sn = c.s.snapshot();
  c.check(sn.open_files == 0, "no open files when asleep", "open=%u", sn.open_files);
  c.check(sn.energy.beeps >= 3, "start/stop/sent beeps", "beeps=%u", sn.energy.beeps);
}

void scTooShort(Ctx &c) {
  c.check(c.boot(), "boots to READY");
  c.record(300);
  c.check(c.waitScreen(pv::Screen::TooShort, 3 * SEC), "TOO SHORT after a 0.3 s tap", "screen=%s", pv::screenName(c.screen()));
  c.shot("too-short");
  c.s.runFor(5 * SEC);
  c.check(c.s.queueFiles() == 0, "nothing queued");
  c.check(c.mock().puts == 0, "nothing uploaded");
  c.record(590);
  c.s.runFor(2 * SEC);
  c.check(c.st().stats.too_short == 2 && c.s.queueFiles() == 0, "0.59 s also rejected (min 0.6 s)");
  c.record(700);
  c.check(c.waitScreen(pv::Screen::Result, 30 * SEC), "0.7 s accepted and uploaded");
}

void scPwrOffBattery(Ctx &c) {
  c.s.setUsb(false);
  c.check(c.boot(), "boots to READY");
  c.s.setButton(pv::Button::Pwr, true);
  c.s.runFor(2500);
  c.check(c.screen() == pv::Screen::Off, "OFF after 2 s PWR hold", "screen=%s", pv::screenName(c.screen()));
  c.s.setButton(pv::Button::Pwr, false);
  c.s.runFor(3 * SEC);
  c.check(!c.s.powered(), "battery power cut (latch released)");
  c.shot("off");
  c.check(strcmp(c.st().screen.detail, "press PWR to start") == 0, "OFF screen tells how to start", "detail=%s", c.st().screen.detail);
  c.s.runFor(HOUR);
  c.check(!c.s.powered(), "stays off");
  c.s.setButton(pv::Button::Pwr, true);
  c.s.runFor(800);
  c.s.setButton(pv::Button::Pwr, false);
  c.check(c.s.runUntil([&] { return c.s.powered() && c.screen() == pv::Screen::Ready; }, 10 * SEC), "PWR press boots again");
  c.check(c.s.snapshot().boots == 2, "second boot", "boots=%u", c.s.snapshot().boots);
  c.s.runFor(2 * SEC);
  c.check(c.screen() == pv::Screen::Ready, "power-on PWR hold is not treated as a press");
}

void scPwrOffUsb(Ctx &c) {
  c.s.setUsb(true);
  c.check(c.boot(), "boots to READY");
  c.s.hold(pv::Button::Pwr, 2500);
  c.check(c.waitScreen(pv::Screen::StillOn, 5 * SEC), "STILL ON when USB keeps the board powered");
  c.check(c.s.powered(), "still powered");
  c.shot("still-on");
  c.s.hold(pv::Button::Pwr, 300);
  c.check(c.waitScreen(pv::Screen::Status, 2 * SEC), "short PWR press shows status", "title=%s", c.title().c_str());
  c.shot("status");
}

void scServer500(Ctx &c) {
  c.mockConfig("{\"script\":[{\"status\":500},{\"status\":503}]}");
  c.check(c.boot(), "boots");
  c.record(2000);
  c.check(c.waitScreen(pv::Screen::Queued, 30 * SEC), "QUEUED after HTTP 500", "detail=%s", c.st().screen.detail);
  c.check(strstr(c.st().screen.detail, "server 500") != nullptr, "screen says server 500");
  c.shot("queued-500");
  c.check(c.waitScreen(pv::Screen::Result, 10 * MIN), "uploaded after retries");
  auto t = c.logTimes(",UP,name=");
  c.check(t.size() == 3, "three attempts (500, 503, ok)", "attempts=%zu", t.size());
  if (t.size() == 3) {
    // gap = backoff + Wi-Fi connect (1.5 s) + request time
    long g1 = (long)(t[1] - t[0]), g2 = (long)(t[2] - t[1]);
    c.check(g1 >= 30000 && g1 < 34000, "1st retry after ~30 s backoff", "gap=%ld ms", g1);
    c.check(g2 >= 60000 && g2 < 64000, "2nd retry after ~60 s (doubled)", "gap=%ld ms", g2);
  }
  MockState m = c.mock();
  c.check(m.tasks == 1 && m.max_ok_per_id == 1, "one task, no duplicate success", "tasks=%d max_ok=%d", m.tasks, m.max_ok_per_id);
  c.check(c.st().backoff_ms == 0, "backoff reset after success");
}

void scMalformed(Ctx &c) {
  c.mockConfig("{\"always\":{\"malformed\":true}}");
  c.check(c.boot(), "boots");
  c.record(2000);
  c.check(c.waitScreen(pv::Screen::Queued, 30 * SEC), "QUEUED when the 200 reply is not valid JSON");
  c.check(strstr(c.st().screen.detail, "bad reply") != nullptr, "screen says bad reply", "detail=%s", c.st().screen.detail);
  c.shot("queued-bad-reply");
  c.s.runFor(20 * MIN);
  c.check(c.s.queueFiles() == 1, "clip stays queued (not deleted)");
  c.check(c.st().backoff_ms >= 240000, "backoff keeps growing", "backoff=%u ms", c.st().backoff_ms);
  c.mockConfig("{\"always\":{\"status\":200,\"body\":\"{}\"}}");
  c.s.hold(pv::Button::Pwr, 200);  // short press = retry now
  c.s.runFor(30 * SEC);
  c.check(c.s.queueFiles() == 1, "empty JSON object also keeps the clip");
  c.mockConfig("{\"always\":{}}");
  c.s.hold(pv::Button::Pwr, 200);
  c.check(c.waitScreen(pv::Screen::Result, 60 * SEC), "uploads once the server replies properly");
  MockState m = c.mock();
  c.check(m.tasks == 1, "server still has a single task (idempotent id)", "tasks=%d puts=%d", m.tasks, m.puts);
  c.check(c.st().stats.dups == 1, "final reply flagged duplicate", "dups=%u", c.st().stats.dups);
}

void scNoSd(Ctx &c) {
  c.s.faults().sd_missing = true;
  c.check(c.boot(), "boots");
  c.check(c.screen() == pv::Screen::NoSd, "NO SD screen", "screen=%s", pv::screenName(c.screen()));
  c.shot("no-sd");
  c.record(2000);
  c.s.runFor(2 * SEC);
  c.check(c.s.countLog(",REC,") == 0 && c.screen() == pv::Screen::NoSd, "BOOT does not record without a card");
  c.check(c.waitSleep(60 * SEC), "still sleeps (no busy loop)");
  c.s.runFor(HOUR);
  // 15-min timer wakes; each wake now stays up >= wake_grace_ms, so an hour holds 3-4 of them.
  c.check(c.st().stats.wakes >= 3 && c.st().stats.wakes <= 6, "only periodic timer wakes", "wakes=%u", c.st().stats.wakes);
  c.s.faults().sd_missing = false;
  c.s.reset();
  c.check(c.s.runUntil([&] { return c.screen() == pv::Screen::Ready; }, 10 * SEC), "card inserted + RESET -> READY");
}

struct SoakResult {
  int clips = 0;
  std::vector<uint32_t> heap, lvgl;
  bool stuck = false;
};

SoakResult soak(Ctx &c, int cycles, double offline_p, uint32_t seed) {
  SoakResult r;
  std::mt19937 rng(seed);
  for (int i = 0; i < cycles; i++) {
    c.s.faults().wifi_offline = (rng() % 1000) < offline_p * 1000;
    // wake from sleep with BOOT, talk 1-5 s
    c.record(1000 + rng() % 4000);
    r.clips++;
    if (!c.waitSleep(5 * MIN)) {
      r.stuck = true;
      c.check(false, "cycle returns to sleep", "cycle %d stuck in state %s screen %s", i, pv::stateName(c.st().state), c.title().c_str());
      break;
    }
    Sim::Snapshot sn = c.s.snapshot();
    r.heap.push_back(sn.heap_free);
    r.lvgl.push_back(sn.lvgl_used);
    if (sn.open_files) c.check(false, "no open files while asleep", "cycle %d open=%u", i, sn.open_files);
    c.s.runFor(MIN + rng() % (9 * MIN));  // idle gap (timer wakes / retries happen here)
  }
  return r;
}

static SoakResult soakDrive(Ctx &c, bool *drained) {
  bool booted = c.boot();
  c.waitSleep(60 * SEC);
  SoakResult r = soak(c, 30, 0.5, 42);
  if (!booted) r.stuck = true;
  c.s.faults().wifi_offline = false;
  *drained = c.s.runUntil([&] { return c.s.queueFiles() == 0 && c.st().state == pv::State::Sleeping; }, 2 * HOUR);
  return r;
}

void scSoak(Ctx &c) {
  bool drained = false;
  SoakResult r = soakDrive(c, &drained);
  c.check(!r.stuck, "30 cycles without a stuck state");
  c.check(drained, "queue drains once back online", "left=%u", c.s.queueFiles());
  c.shot("after-drain");
  MockState m = c.mock();
  pv::AppStatus st = c.st();
  c.check(m.tasks == r.clips, "every clip reached the server", "clips=%d tasks=%d", r.clips, m.tasks);
  c.check(m.max_ok_per_id == 1, "no duplicate uploads", "max_ok_per_id=%d puts=%d", m.max_ok_per_id, m.puts);
  c.check(st.stats.uploaded == (uint32_t)r.clips, "device counted every upload", "uploaded=%u", st.stats.uploaded);
  if (r.heap.size() > 5) {
    uint32_t lo = *std::min_element(r.heap.begin() + 2, r.heap.end()), hi = *std::max_element(r.heap.begin() + 2, r.heap.end());
    double per = (double)((int64_t)r.heap[2] - (int64_t)r.heap.back()) / (r.heap.size() - 3);
    c.check(hi - lo < 64 && per < 16, "heap stable per cycle (core + HAL model)", "range=%u B, drift=%.1f B/cycle", hi - lo, per);
    uint32_t llo = *std::min_element(r.lvgl.begin() + 2, r.lvgl.end()), lhi = *std::max_element(r.lvgl.begin() + 2, r.lvgl.end());
    c.check(lhi - llo < 512, "LVGL pool stable", "used %u..%u B", llo, lhi);
  }
  Sim::Snapshot sn = c.s.snapshot();
  c.note("virtual time %.1f h, wakes %u (timer %u), wifi fails %u, upload sessions %u, energy %.1f mAh (estimate)", c.s.now() / 3.6e6,
         st.stats.wakes, st.stats.timer_wakes, st.stats.wifi_fail, st.stats.sessions, sn.energy.total_mah());
  // Status reports: exactly one per connected session (minus deliberate skips), all valid.
  auto reps = statusReports(c);
  uint32_t conn = connectedSessions(c), skips = c.s.countLog(",STATUS,skip="), invalid = 0, with_log = 0;
  for (auto &x : reps) {
    invalid += !x.valid;
    with_log += x.log_n > 0;
  }
  c.check(reps.size() == conn - skips && sn.status_posts == reps.size() && c.s.countLog(",STATUS,code=") == reps.size(),
          "every connected session sent exactly one status report", "reports=%zu connected=%u skipped=%u", reps.size(), conn, skips);
  c.check(invalid == 0 && with_log > 0, "all reports valid; those after Wi-Fi failures carry the log", "invalid=%u with_log=%u", invalid,
          with_log);
  // Same run with reporting off: energy, wakes, sessions, refreshes compared at the same time.
  const uint64_t T_END = 5 * HOUR;
  c.s.runTo(T_END);
  RunMetrics on = runMetrics(c);
  RunMetrics off = twinWithoutStatus(c, [](Ctx &x) {
    bool d;
    soakDrive(x, &d);
  }, T_END);
  compareEnergy(c, on, off);
}

void scLeakDetector(Ctx &c) {
  // Negative control: emulate the ~450 B/Wi-Fi-cycle loss seen on the prototype and make
  // sure the same heap check flags it.
  c.s.faults().wifi_leak_bytes = 450;
  c.check(c.boot(), "boots");
  c.waitSleep(60 * SEC);
  SoakResult r = soak(c, 10, 0.0, 7);
  double per = r.heap.size() > 3 ? (double)((int64_t)r.heap[1] - (int64_t)r.heap.back()) / (r.heap.size() - 2) : 0;
  c.check(per > 400, "per-cycle heap drift is detected", "drift=%.0f B/cycle (injected 450 B per Wi-Fi session)", per);
  c.check(c.s.countLog("heap_delta=-450") >= 5, "CYCLE log shows heap_delta=-450", "lines=%u", c.s.countLog("heap_delta=-450"));
}

static void idleDrive(Ctx &c) {
  c.boot();
  c.waitSleep(60 * SEC);
}

void scIdleDay(Ctx &c) {
  c.cfg.auto_off_idle_ms = 0;  // days of uptime on battery: no auto power-off here (see auto_power_off)
  c.check(c.boot(), "boots");
  c.check(c.waitSleep(60 * SEC), "sleeps");
  auto t0 = std::chrono::steady_clock::now();
  uint32_t ref0 = c.s.snapshot().energy.refreshes;
  int pct0 = pv::batteryPercent(c.s.batteryNow());
  c.s.runFor(24 * HOUR);
  double wall = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
  pv::AppStatus st = c.st();
  Sim::Snapshot sn = c.s.snapshot();
  c.check(st.stats.timer_wakes >= 95 && st.stats.timer_wakes <= 97, "one timer wake per 15 min", "timer wakes=%u", st.stats.timer_wakes);
  c.check(wall < 30, "24 h simulated quickly", "wall=%.1f s", wall);
  int pct1 = pv::batteryPercent(c.s.batteryNow());
  c.check(pct1 < pct0, "battery % follows the drain model", "%d%% -> %d%%", pct0, pct1);
  c.check(sn.energy.refreshes - ref0 <= (uint32_t)(pct0 - pct1) + 2, "e-paper refreshes only when the footer changes",
          "refreshes=%u for %d%% change", sn.energy.refreshes - ref0, pct0 - pct1);
  double avg = sn.energy.total_mah() / (c.s.now() / 3.6e6);
  c.note("idle estimate: %.2f mA average, %.1f mAh/day, ~%.0f days on %.0f mAh (MODEL ESTIMATE, not measured)", avg, avg * 24,
         c.s.energyModel().capacity_mah / avg / 24, c.s.energyModel().capacity_mah);
  c.shot("after-day");
  // Status reporting never turns Wi-Fi on by itself: an idle day has no session, so no report.
  c.check(c.s.countLog(",NET,reason=") == 0 && c.s.snapshot().status_posts == 0, "no Wi-Fi and no status report on an idle day",
          "sessions=%u posts=%u", c.s.countLog(",NET,reason="), c.s.snapshot().status_posts);
  uint64_t t_end = c.s.now();
  RunMetrics on = runMetrics(c);
  RunMetrics off = twinWithoutStatus(c, idleDrive, t_end);
  compareEnergy(c, on, off);
}

static void writeRaw(const std::string &path, const std::string &data) { writeFile(path, data); }

void scPoisonClip(Ctx &c) {
  // A non-WAV file and an empty file in the queue (e.g. corrupted card / power cut before
  // the header) must not block newer clips forever.
  mkdir(c.s.sdPath("").c_str(), 0775);
  mkdir(c.s.sdPath("/REC").c_str(), 0775);
  writeRaw(c.s.sdPath("/REC/000000000000-000001-deadbeef.wav"), std::string(1000, 'x'));
  writeRaw(c.s.sdPath("/REC/000000000000-000002-deadbeef.wav"), "");
  c.check(c.boot(), "boots");
  c.check(c.s.countLog("REPAIR,name=000000000000-000002") == 1, "empty clip set aside at boot");
  c.check(c.s.runUntil([&] { return c.st().stats.quarantined == 1; }, 2 * MIN), "server-rejected clip (400) set aside");
  c.record(2000);
  c.check(c.waitScreen(pv::Screen::Result, MIN), "new clip still uploads");
  c.check(c.s.queueFiles() == 0, "queue empty");
  c.check(c.filesIn("/REC_BAD") == 2, "both bad files kept in /REC_BAD for inspection", "files=%u", c.filesIn("/REC_BAD"));
}

void scPowerCutRecording(Ctx &c) {
  c.s.setUsb(false);
  c.check(c.boot(), "boots");
  c.s.setButton(pv::Button::Boot, true);
  c.s.runFor(2500);
  c.s.cutPower();  // battery yanked mid-recording
  c.s.runFor(100);
  c.s.setButton(pv::Button::Boot, false);
  c.check(!c.s.powered(), "device is off");
  c.check(c.s.queueFiles() == 1, "partial clip is on the card");
  c.s.hold(pv::Button::Pwr, 1000);
  c.check(c.s.runUntil([&] { return c.s.countLog("REPAIR,name=") == 1; }, 10 * SEC), "header repaired at boot");
  c.check(c.waitScreen(pv::Screen::Result, MIN), "repaired clip uploaded");
  MockState m = c.mock();
  c.check(m.bytes > 44 + 2 * 32000 - 8192, "uploaded clip has the audio up to the cut", "bytes=%d", m.bytes);
  c.check(m.bad_headers == 0, "server sees a consistent WAV header (else: '(no speech)')", "bad_headers=%d", m.bad_headers);
}

void scDnsTimeout(Ctx &c) {
  c.s.faults().dns_fail = true;
  c.check(c.boot(), "boots");
  c.record(1500);
  c.check(c.waitScreen(pv::Screen::Queued, 30 * SEC), "QUEUED on DNS failure");
  c.check(strstr(c.st().screen.detail, "DNS") != nullptr, "screen says DNS failed", "detail=%s", c.st().screen.detail);
  c.shot("queued-dns");
  c.s.faults().dns_fail = false;
  c.s.faults().http_timeout = true;
  uint64_t t = c.s.now();
  c.check(c.s.runUntil([&] { return c.s.countLog("server timeout") > 0; }, 3 * MIN), "retry hits the HTTP timeout");
  c.check(c.s.now() - t >= 30000 + 60000, "timeout costs the full 60 s HTTP timeout", "%.0f s", (c.s.now() - t) / 1000.0);
  c.s.faults().http_timeout = false;
  c.check(c.waitScreen(pv::Screen::Result, 5 * MIN), "uploads after the network recovers");
  c.check(c.mock().tasks == 1, "one task");
}

void scBootDuringUpload(Ctx &c) {
  // Three clips queued offline, then a slow server: pressing BOOT during the upload session
  // must start a new recording after the current request instead of after the whole queue.
  c.s.faults().wifi_offline = true;
  c.check(c.boot(), "boots");
  for (int i = 0; i < 3; i++) {
    c.record(1500);
    c.s.runFor(10 * SEC);
  }
  c.check(c.s.queueFiles() == 3, "3 clips queued offline", "queued=%u", c.s.queueFiles());
  c.check(c.waitSleep(5 * MIN), "sleeps with the queue");
  c.s.faults().wifi_offline = false;
  c.mockConfig("{\"latency_ms\":15000}");
  c.s.hold(pv::Button::Pwr, 200);  // short press = retry now
  c.check(c.waitScreen(pv::Screen::Sending, 5 * SEC), "upload session starts", "screen=%s", pv::screenName(c.screen()));
  c.s.runFor(3000);  // Wi-Fi up, first request in flight
  uint64_t press = c.s.now();
  c.s.setButton(pv::Button::Boot, true);
  bool rec = c.waitScreen(pv::Screen::Rec, 60 * SEC);
  uint64_t delay = c.s.now() - press;
  c.check(rec, "recording starts during the session");
  c.check(delay < 20000, "after at most one in-flight request", "waited %.1f s", delay / 1000.0);
  c.check(c.s.countLog("aborted=1") == 1, "session aborted for the recording");
  c.s.runFor(2000);
  c.s.setButton(pv::Button::Boot, false);
  c.mockConfig("{\"latency_ms\":0}");
  c.check(c.s.runUntil([&] { return c.s.queueFiles() == 0; }, 10 * MIN), "all 4 clips uploaded afterwards");
  c.check(c.mock().tasks == 4 && c.mock().max_ok_per_id == 1, "4 tasks, no duplicates");
}

void scDroppedReply(Ctx &c) {
  // Server stores the clip but the connection drops before the reply: the device must keep
  // the clip, retry, and accept the server's "duplicate" answer.
  c.mockConfig("{\"script\":[{\"drop\":true}]}");
  c.check(c.boot(), "boots");
  c.record(2000);
  c.check(c.waitScreen(pv::Screen::Queued, 30 * SEC), "QUEUED after the dropped reply", "detail=%s", c.st().screen.detail);
  c.check(c.waitScreen(pv::Screen::Result, 5 * MIN), "retry succeeds");
  MockState m = c.mock();
  c.check(m.tasks == 1 && m.dup_replies == 1, "server kept one task and answered duplicate", "tasks=%d dup=%d", m.tasks, m.dup_replies);
  c.check(c.st().stats.dups == 1 && c.s.queueFiles() == 0, "device deleted the clip after the duplicate reply");
}

void scBadWifi(Ctx &c) {
  c.s.faults().wifi_bad_pass = true;
  c.check(c.boot(), "boots");
  c.record(1500);
  c.check(c.waitScreen(pv::Screen::Queued, 30 * SEC), "QUEUED with wrong Wi-Fi password");
  c.check(strstr(c.st().screen.detail, "no wifi") != nullptr, "screen says no wifi");
  c.shot("queued-no-wifi");
  c.s.faults().wifi_bad_pass = false;
  c.s.faults().wifi_hang = true;
  c.s.runFor(2 * MIN);
  c.check(c.s.countLog("wifi=3,") >= 1, "association timeout handled (12 s cap)");
  c.s.faults().wifi_hang = false;
  c.check(c.waitScreen(pv::Screen::Result, 10 * MIN), "uploads after Wi-Fi recovers");
  c.check(c.st().stats.wifi_fail >= 2, "Wi-Fi failures counted", "wifi_fail=%u", c.st().stats.wifi_fail);
}

void scHttp4xx(Ctx &c) {
  // 401 (token / config problem) must keep the clip; 413 (server will never take it) must not
  // block the queue.
  c.mockConfig("{\"script\":[{\"status\":401}]}");
  c.check(c.boot(), "boots");
  c.record(1500);
  c.check(c.waitScreen(pv::Screen::Queued, 30 * SEC), "QUEUED on 401", "detail=%s", c.st().screen.detail);
  c.check(strstr(c.st().screen.detail, "server 401") != nullptr && c.s.queueFiles() == 1, "clip kept for retry");
  c.check(c.waitScreen(pv::Screen::Result, 5 * MIN), "retry succeeds");
  c.mockConfig("{\"script\":[{\"status\":413}]}");
  c.record(1500);
  c.check(c.waitScreen(pv::Screen::BadClip, 30 * SEC), "413 -> clip set aside, not retried forever", "screen=%s", pv::screenName(c.screen()));
  c.shot("skipped");
  c.check(c.s.queueFiles() == 0 && c.filesIn("/REC_BAD") == 1, "kept in /REC_BAD");
}

// ---------------------------------------------------------------------------------------
// Async contract (docs/device-api.md)

// Count of network sessions (Wi-Fi up) with a given reason.
static uint32_t netCount(Ctx &c, const char *reason) {
  return c.s.countLog(std::string("NET,reason=") + reason + ",");
}

// The router's quick answer (kind "answer", summary up to 120 bytes) gets the ANSWER screen; a saved shopping item shows its list.
void scAnswer(Ctx &c) {
  c.mockConfig("{\"process_ms\":1500,\"kinds\":[\"answer\",\"shopping\"]}");
  c.check(c.boot(), "boots");
  c.check(c.waitSleep(MIN), "sleeps");
  c.record(2000);
  c.check(c.waitScreen(pv::Screen::Answer, 30 * SEC), "answer shown within the poll window", "screen=%s", pv::screenName(c.screen()));
  pv::AppStatus st = c.st();
  c.check(!strcmp(st.screen.title, "ANSWER") && strstr(st.screen.detail, "They don't have the guts."), "the whole answer, past 60 bytes", "detail=%s", st.screen.detail);
  c.shot("answer");
  c.check(c.waitSleep(MIN), "sleeps again");
  c.record(2000);
  c.check(c.waitScreen(pv::Screen::Result, 30 * SEC), "saved item shown", "screen=%s", pv::screenName(c.screen()));
  st = c.st();
  c.check(!strcmp(st.screen.kind, "shopping") && strstr(st.screen.detail, "Eggs"), "SHOPPING + item", "kind=%s detail=%s", st.screen.kind, st.screen.detail);
  c.shot("shopping");
}

void scAsyncQuick(Ctx &c) {
  c.mockConfig("{\"process_ms\":1500,\"kind\":\"todo\"}");
  c.check(c.boot(), "boots");
  c.check(c.waitSleep(MIN), "sleeps");
  uint64_t t0 = c.s.now();
  c.record(2000);
  c.check(c.waitScreen(pv::Screen::Result, 30 * SEC), "result shown within the poll window", "screen=%s", pv::screenName(c.screen()));
  pv::AppStatus st = c.st();
  c.check(!strcmp(st.screen.title, "TODO") && strstr(st.screen.detail, "Buy AA batteries"), "TODO + title", "title=%s detail=%s",
          st.screen.title, st.screen.detail);
  c.shot("todo");
  c.check(c.s.countLog("screen=SENT") == 0, "no SENT screen (result was ready)");
  c.check(st.pending == 0 && c.pendingFile().empty(), "nothing pending, no pending file");
  c.check(c.beepsSince(t0, 2000) == 1, "success beep");
  auto acc = c.logTimes(",UP,name="), res = c.logTimes(",RES,id=");
  c.check(acc.size() == 1 && res.size() == 1 && res[0] - acc[0] <= 6000, "result <= 6 s after the 202", "%.1f s",
          res.size() && acc.size() ? (res[0] - acc[0]) / 1000.0 : -1.0);
  MockState m = c.mock();
  c.check(m.get_recording >= 1 && m.get_recording <= 4 && m.get_updates == 0, "a few GET /v1/recordings/:id polls", "gets=%d",
          m.get_recording);
  uint32_t nets = netCount(c, "new_clip");
  c.s.runFor(3 * HOUR);
  c.check(c.s.countLog("NET,reason=check") == 0 && netCount(c, "new_clip") == nets, "no Wi-Fi afterwards (nothing pending)");
  c.check(c.asleepRefreshes() == 0, "no refresh while asleep");
}

void scAsyncLate(Ctx &c) {
  c.mockConfig("{\"process_ms\":20000,\"kind\":\"note\"}");
  c.check(c.boot(), "boots");
  c.waitSleep(MIN);
  uint64_t t0 = c.s.now();
  c.record(2000);
  c.check(c.waitScreen(pv::Screen::Sent, 30 * SEC), "SENT when the result is not ready in the window", "screen=%s",
          pv::screenName(c.screen()));
  c.check(c.beepsSince(t0, 2000) == 1, "success beep for the delivered clip");
  c.shot("sent");
  c.check(c.st().pending == 1 && c.pendingFile().find("5100c0ffee01-") != std::string::npos, "id kept in the persisted pending list",
          "pending=%u file=%s", c.st().pending, c.pendingFile().c_str());
  c.check(c.s.queueFiles() == 0, "clip deleted after the 202");
  c.check(c.waitSleep(MIN), "sleeps");
  c.check(!c.s.snapshot().wifi_on, "Wi-Fi off while waiting");
  uint64_t tw = c.s.now();
  bool got = c.waitScreen(pv::Screen::Result, 5 * MIN);
  c.check(got, "result shown on a later wake", "screen=%s", pv::screenName(c.screen()));
  c.check(c.s.now() - tw < 40 * SEC, "at the first scheduled check (~30 s)", "%.0f s", (c.s.now() - tw) / 1000.0);
  c.check(netCount(c, "check") == 1 && netCount(c, "new_clip") == 1, "exactly one extra Wi-Fi session for it");
  c.check(c.beepsSince(tw, 2000) == 0, "quiet on the timer wake (no beep in the pocket)");
  c.shot("note-later");
  c.check(c.st().pending == 0 && c.pendingFile().empty(), "pending list empty");
  c.s.runFor(3 * HOUR);
  c.check(netCount(c, "check") == 1, "no further checks");
  c.check(c.asleepRefreshes() == 0, "no refresh while asleep");
}

// Records a work item and returns the virtual time of its 202.
static uint64_t workSetup(Ctx &c, const char *outcome, int research_min) {
  char cfg[160];
  snprintf(cfg, sizeof(cfg), "{\"process_ms\":1500,\"kind\":\"work\",\"research_ms\":%d,\"work_outcome\":\"%s\"}", research_min * 60000, outcome);
  c.mockConfig(cfg);
  c.check(c.boot(), "boots");
  c.waitSleep(MIN);
  c.record(2500);
  c.check(c.waitScreen(pv::Screen::Researching, 30 * SEC), "RESEARCHING with the title", "screen=%s", pv::screenName(c.screen()));
  c.check(strstr(c.st().screen.detail, "Research e-paper") != nullptr, "title on screen", "detail=%s", c.st().screen.detail);
  c.check(c.st().pending == 1 && c.pendingFile().find("\n1 ") != std::string::npos, "pending as researching (phase 1)", "%s",
          c.pendingFile().c_str());
  auto up = c.logTimes(",UP,name=");
  return up.empty() ? 0 : up[0];
}

void scWorkLifecycle(Ctx &c) {
  uint64_t t_acc = workSetup(c, "done", 20);
  c.shot("researching");
  c.check(c.waitSleep(MIN), "sleeps");
  uint32_t ref0 = c.refreshes();
  bool done = c.waitScreen(pv::Screen::WorkDone, HOUR);
  c.check(done, "DONE on a later wake", "screen=%s", pv::screenName(c.screen()));
  pv::AppStatus st = c.st();
  c.check(strlen(st.screen.detail) > 0 && strlen(st.screen.detail) <= 60, "summary <= 60 chars", "detail=%s", st.screen.detail);
  c.shot("done");
  auto chk = c.logTimes("NET,reason=check");
  // Schedule from the 202: +30 s, +2 min, +5 min, +15 min (cumulative 0:30, 2:30, 7:30, 22:30).
  const double expect[] = { 30, 150, 450, 1350 };
  bool sched = chk.size() == 4;
  std::string got;
  for (size_t i = 0; i < chk.size(); i++) {
    double t = (chk[i] - t_acc) / 1000.0;
    got += std::to_string((int)t) + "s ";
    if (i < 4 && (t < expect[i] - 2 || t > expect[i] + 25)) sched = false;
  }
  c.check(sched, "checks at ~30 s, 2:30, 7:30, 22:30 after the 202", "%s", got.c_str());
  c.check(c.refreshes() - ref0 == 1, "unchanged checks do not touch the panel (1 refresh = DONE)", "refreshes=%u", c.refreshes() - ref0);
  c.check(c.st().pending == 0 && c.pendingFile().empty(), "nothing pending");
  c.s.runFor(6 * HOUR);
  c.check(c.logTimes("NET,reason=check").size() == 4, "stops checking afterwards");
  c.check(c.asleepRefreshes() == 0, "no refresh while asleep");
}

void scWorkPaused(Ctx &c) {
  workSetup(c, "paused_budget", 3);
  c.check(c.waitScreen(pv::Screen::WorkPaused, HOUR), "PAUSED: budget", "screen=%s", pv::screenName(c.screen()));
  c.check(strstr(c.st().screen.detail, "Research e-paper") != nullptr, "with the title");
  c.shot("paused");
  c.check(c.st().pending == 0, "nothing pending");
  uint32_t n = netCount(c, "check");
  c.s.runFor(3 * HOUR);
  c.check(netCount(c, "check") == n, "no more checks");
}

void scWorkStopped(Ctx &c) {
  workSetup(c, "stopped", 6);
  c.check(c.waitScreen(pv::Screen::WorkStopped, HOUR), "STOPPED", "screen=%s", pv::screenName(c.screen()));
  c.shot("stopped");
  c.check(c.st().pending == 0, "nothing pending");
  uint32_t n = netCount(c, "check");
  c.s.runFor(3 * HOUR);
  c.check(netCount(c, "check") == n, "no more checks");
}

void scNoiseUnsure(Ctx &c) {
  c.mockConfig("{\"process_ms\":1000,\"kind\":\"noise\"}");
  c.check(c.boot(), "boots");
  uint64_t t0 = c.s.now();
  c.record(1500);
  c.check(c.waitScreen(pv::Screen::Noise, 30 * SEC), "noise -> \"didn't catch that\"", "screen=%s", pv::screenName(c.screen()));
  c.check(strstr(c.st().screen.detail, "didn't catch that") != nullptr, "friendly text", "detail=%s", c.st().screen.detail);
  c.shot("noise");
  c.check(c.beepsSince(t0, 2000) == 0, "no success beep for noise");
  // press = 1050 Hz "beep", release = 880->660 Hz "bee-boop" (each beep entry is one tone)
  c.check(c.beepsSince(t0, 1050) == 1 && c.beepsSince(t0, 880) == 1 && c.beepsSince(t0, 660) == 1, "start/stop beeps only");
  c.mockConfig("{\"kind\":\"unsure\"}");
  uint64_t t1 = c.s.now();
  c.record(1500);
  c.check(c.waitScreen(pv::Screen::Result, 30 * SEC), "unsure -> result", "screen=%s", pv::screenName(c.screen()));
  pv::AppStatus st = c.st();
  c.check(!strcmp(st.screen.title, "NOTE?") && !strcmp(st.screen.kind, "unsure"), "shown as NOTE? (saved as note)", "title=%s kind=%s",
          st.screen.title, st.screen.kind);
  c.shot("unsure");
  c.check(c.beepsSince(t1, 2000) == 1, "success beep for unsure");
  c.check(c.st().pending == 0 && c.st().stats.noise == 1, "nothing pending, noise counted");
}

void scNewClipBypassesBackoff(Ctx &c) {
  c.mockConfig("{\"always\":{\"status\":503}}");
  c.check(c.boot(), "boots");
  c.record(1500);
  c.check(c.waitScreen(pv::Screen::Queued, 30 * SEC), "QUEUED after 503");
  c.check(c.st().backoff_ms == 30000, "backing off 30 s", "backoff=%u", c.st().backoff_ms);
  c.s.runFor(10 * SEC);
  c.check(c.logTimes(",UP,name=").size() == 1, "no timer retry inside the backoff");
  uint64_t next = c.st().next_retry_ms;
  c.record(1500);
  uint64_t rel = c.s.now();
  c.check(rel < next, "second clip recorded while backing off", "%.1f s before the retry", (next - rel) / 1000.0);
  c.check(c.s.runUntil([&] { return netCount(c, "new_clip") == 2; }, 10 * SEC), "new clip triggers an immediate upload session");
  auto up = c.logTimes(",UP,name=");
  c.check(up.size() == 2 && up[1] < next && up[1] - rel < 5000, "attempt starts right after recording", "%.1f s after release",
          up.size() == 2 ? (up[1] - rel) / 1000.0 : -1.0);
  c.check(c.st().backoff_ms == 60000, "failure doubles the backoff", "backoff=%u", c.st().backoff_ms);
  c.mockConfig("{\"always\":{}}");
  uint64_t t2 = up[1];
  c.check(c.s.runUntil([&] { return c.s.queueFiles() == 0; }, 5 * MIN), "both clips uploaded once the server recovers");
  up = c.logTimes(",UP,name=");
  c.check(up.size() >= 3 && up[2] - t2 >= 60000, "timer retry waited for the 60 s backoff", "gap=%.1f s",
          up.size() >= 3 ? (up[2] - t2) / 1000.0 : -1.0);
  MockState m = c.mock();
  c.check(m.tasks == 2, "2 tasks", "tasks=%d", m.tasks);
  // While idle, the backoff is respected for timer retries.
  c.mockConfig("{\"always\":{\"status\":500}}");
  c.record(1500);
  c.check(c.waitScreen(pv::Screen::Queued, 30 * SEC), "QUEUED again");
  size_t n0 = c.logTimes(",UP,name=").size();
  c.s.runFor(29 * SEC);
  c.check(c.logTimes(",UP,name=").size() == n0, "no timer retry before 30 s");
  c.s.runFor(10 * SEC);
  c.check(c.logTimes(",UP,name=").size() == n0 + 1, "timer retry at the backoff");
}

void scLegacySync(Ctx &c) {
  c.mockConfig("{\"mode\":\"sync\",\"kind\":\"todo\"}");
  c.check(c.boot(), "boots");
  c.record(2000);
  c.check(c.waitScreen(pv::Screen::Result, 30 * SEC), "legacy 200 task shown", "screen=%s", pv::screenName(c.screen()));
  c.check(!strcmp(c.st().screen.title, "TODO"), "TODO", "title=%s", c.st().screen.title);
  c.mockConfig("{\"kind\":\"work\"}");
  c.record(2000);
  c.check(c.waitScreen(pv::Screen::Result, 30 * SEC) && !strcmp(c.st().screen.kind, "work"), "legacy work = plain WORK result (no research phase)",
          "screen=%s", pv::screenName(c.screen()));
  c.shot("legacy-work");
  MockState m = c.mock();
  c.check(m.gets == 0 && c.st().pending == 0, "no polling, nothing pending", "gets=%d", m.gets);
  c.check(m.tasks == 2 && c.s.queueFiles() == 0, "both delivered");
  // Duplicate on a legacy server (reply lost, retry gets 200 duplicate).
  c.mockConfig("{\"script\":[{\"drop\":true}],\"kind\":\"note\"}");
  c.record(2000);
  c.check(c.waitScreen(pv::Screen::Result, 5 * MIN), "dropped reply -> retry -> duplicate 200 accepted");
  c.check(c.mock().tasks == 3 && c.st().stats.dups == 1, "one task, duplicate counted");
  // Async server without /v1/updates: two late items -> batch 404 -> per-id GETs.
  c.mockConfig("{\"mode\":\"async\",\"updates_api\":false,\"process_ms\":40000,\"kind\":\"note\"}");
  c.record(1500);
  c.check(c.waitScreen(pv::Screen::Sent, 30 * SEC), "async: SENT");
  c.record(1500);
  c.check(c.s.runUntil([&] { return c.st().pending == 2; }, 30 * SEC), "two pending");
  c.check(c.s.runUntil([&] { return c.st().pending == 0; }, 10 * MIN), "both resolved");
  m = c.mock();
  c.check(c.s.countLog("no /v1/updates") == 1 && m.get_updates == 0 && m.get_recording >= 2, "fell back to per-id GETs once",
          "get_recording=%d", m.get_recording);
}

void scResultCheckOffline(Ctx &c) {
  c.mockConfig("{\"process_ms\":60000,\"not_found_ms\":5000,\"kind\":\"reminder\"}");
  c.check(c.boot(), "boots");
  c.record(2000);
  c.check(c.waitScreen(pv::Screen::Sent, 30 * SEC), "SENT (GETs 404 at first: not visible yet)");
  c.check(c.st().pending == 1, "pending");
  c.check(c.waitSleep(MIN), "sleeps");
  c.s.faults().wifi_offline = true;
  c.s.runFor(10 * MIN);
  uint32_t fails = c.st().stats.check_fail;
  c.check(netCount(c, "check") >= 2 && fails >= 2, "scheduled checks fail offline", "checks=%u fails=%u", netCount(c, "check"), fails);
  c.check(c.st().pending == 1, "still pending");
  c.s.reset();  // reboot while offline
  c.check(c.s.runUntil([&] { return c.s.countLog("PEND,loaded=1") == 1; }, 10 * SEC), "pending list reloaded after reboot");
  c.check(c.s.runUntil([&] { return c.st().pending == 1; }, 5 * SEC), "still pending after reboot");
  c.s.runFor(10 * MIN);
  c.s.faults().wifi_offline = false;
  c.mockConfig("{\"get_script\":[{\"status\":500}]}");  // first check after recovery: server error
  bool got = c.waitScreen(pv::Screen::Result, 2 * HOUR);
  pv::AppStatus st = c.st();
  c.check(got && !strcmp(st.screen.title, "REMINDER"), "result arrives once back online", "screen=%s", pv::screenName(c.screen()));
  c.check(strlen(st.screen.due) > 0, "due date shown", "due=%s", st.screen.due);
  c.shot("reminder-after-reboot");
  MockState m = c.mock();
  c.check(m.puts == 1 && m.max_puts_per_id == 1, "no duplicate uploads", "puts=%d", m.puts);
  c.check(m.get_errors >= 1, "survived a 500 on the result check", "get_errors=%d", m.get_errors);
  c.check(c.st().pending == 0 && c.pendingFile().empty(), "pending list empty");
}

void scResultTransientMiss(Ctx &c) {
  // Result not visible for the first scheduled checks (eventual consistency, or the server leaving the id out
  // of a size-capped /v1/updates batch). A couple of misses must not drop the id.
  c.mockConfig("{\"process_ms\":1000,\"not_found_ms\":150000,\"kind\":\"todo\"}");
  c.check(c.boot(), "boots");
  c.record(2000);
  c.check(c.waitScreen(pv::Screen::Sent, 30 * SEC), "SENT (result not visible yet)");
  c.check(c.st().pending == 1, "pending");
  bool got = c.waitScreen(pv::Screen::Result, 30 * MIN);
  c.check(got && !strcmp(c.st().screen.title, "TODO"), "result shown after transient misses", "screen=%s", pv::screenName(c.screen()));
  MockState m = c.mock();
  c.check(m.get_recording + m.get_updates >= 3, "needed several checks", "gets=%d", m.get_recording + m.get_updates);
  c.check(c.st().pending == 0, "pending list empty");
}

void scLowBattery(Ctx &c) {
  c.s.setBatteryMv(3620);  // ~12 %
  c.mockConfig("{\"process_ms\":90000,\"kind\":\"note\"}");
  c.check(c.boot(), "boots");
  pv::AppStatus st = c.st();
  c.check(st.batt == pv::BattLevel::Low && strstr(st.screen.footer, "LOW 12%"), "low-battery warning in the footer", "footer=%s",
          st.screen.footer);
  c.shot("ready-low");
  c.record(2000);
  c.check(c.waitScreen(pv::Screen::Sent, 30 * SEC), "uploads still work when low");
  uint64_t t_acc = c.logTimes(",UP,name=")[0];
  c.check(c.waitScreen(pv::Screen::Result, 2 * HOUR), "result collected");
  auto chk = c.logTimes("NET,reason=check");
  c.check(chk.size() == 2 && chk[1] - chk[0] >= 30 * MIN, "result checks stretched to >= 30 min when low", "n=%zu gap=%.0f s", chk.size(),
          chk.size() == 2 ? (chk[1] - chk[0]) / 1000.0 : 0);
  (void)t_acc;
}

void scCriticalBattery(Ctx &c) {
  c.s.setBatteryMv(3420);  // ~3 %
  c.check(c.boot(), "boots");
  c.check(c.screen() == pv::Screen::ChargeMe, "CHARGE ME at boot", "screen=%s", pv::screenName(c.screen()));
  c.shot("charge-me");
  c.record(2000);
  c.check(c.waitScreen(pv::Screen::Saved, 5 * SEC), "recording still works");
  c.check(strstr(c.st().screen.detail, "charge to send") != nullptr, "SAVED says it will send when charged", "detail=%s",
          c.st().screen.detail);
  c.s.runFor(2 * HOUR);
  c.check(c.s.countLog("NET,reason=") == 0 && c.s.queueFiles() == 1, "no Wi-Fi at all on a critical battery, clip kept");
  c.s.hold(pv::Button::Pwr, 300);  // explicit retry: one forced attempt
  c.check(c.s.runUntil([&] { return c.s.queueFiles() == 0 && netCount(c, "pwr") == 1; }, MIN), "short PWR press forces one upload");
  c.check(netCount(c, "pwr") == 1, "as a pwr session");
  c.record(2000);
  c.s.runFor(30 * MIN);
  c.check(c.s.queueFiles() == 1 && netCount(c, "new_clip") == 0, "next clip waits again");
  c.s.setUsb(true);
  c.check(c.s.runUntil([&] { return c.s.queueFiles() == 0; }, 20 * MIN), "flushed once on USB (charging)");
  c.s.setUsb(false);
  c.s.setBatteryMv(3700);  // charged to 20 %
  c.s.runFor(16 * MIN);
  c.check(c.st().batt == pv::BattLevel::Ok && c.screen() != pv::Screen::ChargeMe, "leaves critical once charged", "batt=%d", (int)c.st().batt);
  c.check(c.mock().tasks == 2, "both clips delivered", "tasks=%d", c.mock().tasks);
}

void scNoRefreshSleeping(Ctx &c) {
  c.cfg.auto_off_idle_ms = 0;  // days of uptime on battery: no auto power-off here (see auto_power_off)
  c.mockConfig("{\"process_ms\":1500,\"kind\":\"work\",\"research_ms\":2400000}");
  c.check(c.boot(), "boots");
  c.check(c.waitSleep(MIN), "sleeps on READY");
  uint32_t r0 = c.refreshes();
  c.s.runFor(6 * HOUR);
  c.check(c.refreshes() == r0, "READY: no refresh over 6 h idle (static frame)", "refreshes=%u", c.refreshes() - r0);
  c.record(2000);  // work item: RESEARCHING for 40 min with scheduled checks
  c.check(c.waitScreen(pv::Screen::Researching, MIN), "researching");
  c.check(c.waitScreen(pv::Screen::WorkDone, 2 * HOUR), "done later");
  c.waitSleep(MIN);
  uint32_t r1 = c.refreshes();
  c.s.runFor(24 * HOUR);
  c.check(c.refreshes() == r1, "idle day after the result: 0 refreshes", "refreshes=%u", c.refreshes() - r1);
  c.check(c.asleepRefreshes() == 0, "0 refreshes while asleep (bolt)", "asleep=%u", c.asleepRefreshes());
  c.check(c.st().stats.timer_wakes >= 95, "timer wakes still happen", "timer_wakes=%u", c.st().stats.timer_wakes);
  // Same with the classic text layout.
  c.s.setUi("classic");
  c.mockConfig("{\"kind\":\"note\"}");
  c.s.reset();
  c.s.runUntil([&] { return c.st().state == pv::State::Ready; }, 10 * SEC);
  c.record(2000);
  c.waitSleep(2 * MIN);
  c.shot("classic-result");
  uint32_t r2 = c.refreshes();
  c.s.runFor(12 * HOUR);
  c.check(c.refreshes() == r2 && c.asleepRefreshes() == 0, "classic layout: same", "refreshes=%u asleep=%u", c.refreshes() - r2,
          c.asleepRefreshes());
}

// 50 cycles mixing kinds, processing delays, work outcomes and faults (seeded).
void scSoakAsync(Ctx &c) {
  std::mt19937 rng(1234);
  c.check(c.boot(), "boots");
  c.waitSleep(MIN);
  const char *kinds[] = { "note", "todo", "reminder", "work", "unsure", "noise" };
  const char *outcomes[] = { "done", "stopped", "paused_budget" };
  const int procs[] = { 1000, 3000, 20000, 200000 };
  int clips = 0, reboots = 0;
  std::vector<uint32_t> heap, lvgl;
  bool stuck = false;
  for (int i = 0; i < 50; i++) {
    char cfg[512];
    std::string put_script, get_script;
    uint32_t r = rng() % 100;
    if (r < 12) put_script = "{\"status\":500}";
    else if (r < 20) put_script = "{\"drop\":true}";
    r = rng() % 100;
    if (r < 12) get_script = "{\"status\":500}";
    else if (r < 17) get_script = "{\"drop\":true}";
    else if (r < 22) get_script = "{\"latency_ms\":20000}";
    snprintf(cfg, sizeof(cfg),
             "{\"kind\":\"%s\",\"process_ms\":%d,\"research_ms\":%u,\"work_outcome\":\"%s\",\"not_found_ms\":%d,\"script\":[%s],\"get_script\":[%s]}",
             kinds[rng() % 6], procs[rng() % 4], (unsigned)(2 + rng() % 38) * 60000, outcomes[rng() % 3], rng() % 4 ? 0 : 3000,
             put_script.c_str(), get_script.c_str());
    c.mockConfig(cfg);
    c.s.faults().wifi_offline = rng() % 100 < 25;
    c.s.faults().dns_fail = rng() % 100 < 5;
    c.record(1000 + rng() % 3000);
    clips++;
    if (rng() % 100 < 15) {  // reboot at a random point shortly after
      c.s.runFor(rng() % 8000);
      c.s.reset();
      reboots++;
    }
    if (!c.waitSleep(5 * MIN)) {
      stuck = true;
      c.check(false, "cycle returns to sleep", "cycle %d stuck in %s / %s", i, pv::stateName(c.st().state), c.title().c_str());
      break;
    }
    Sim::Snapshot sn = c.s.snapshot();
    heap.push_back(sn.heap_free);
    lvgl.push_back(sn.lvgl_used);
    if (sn.open_files) c.check(false, "no open files while asleep", "cycle %d open=%u", i, sn.open_files);
    c.s.runFor(MIN + rng() % (12 * MIN));
  }
  c.check(!stuck, "50 cycles without a stuck state");
  c.s.faults().wifi_offline = false;
  c.s.faults().dns_fail = false;
  c.mockConfig("{\"script\":[],\"get_script\":[]}");
  bool drained = c.s.runUntil([&] { return c.s.queueFiles() == 0 && c.st().pending == 0 && c.st().state == pv::State::Sleeping; }, 8 * HOUR);
  c.check(drained, "queue and pending list drain once healthy", "queued=%u pending=%u", c.s.queueFiles(), c.st().pending);
  c.shot("after-soak");
  MockState m = c.mock();
  c.check(m.tasks == clips, "every clip delivered (one record each)", "clips=%d records=%d", clips, m.tasks);
  c.check(c.filesIn("/REC_BAD") == 0, "nothing set aside");
  c.check(m.unfinished == 0, "server finished everything", "unfinished=%d", m.unfinished);
  // Every record's final result reached the device exactly once (or via a duplicate PUT reply).
  std::set<std::string> final_ids;
  int final_lines = 0;
  for (auto &l : c.s.logSince(0, 1000000)) {
    size_t k = l.second.find(",RES,id=");
    if (k == std::string::npos) continue;
    std::string rest = l.second.substr(k + 8);
    std::string id = rest.substr(0, rest.find(','));
    if (rest.find("status=researching") != std::string::npos) continue;
    final_ids.insert(id);
    final_lines++;
  }
  c.check((int)final_ids.size() == clips, "a final result for every clip", "ids=%zu clips=%d", final_ids.size(), clips);
  c.check(final_lines <= clips + reboots, "no repeated results", "lines=%d clips=%d reboots=%d", final_lines, clips, reboots);
  c.check(c.st().stats.gave_up == 0, "nothing given up");
  c.check(c.asleepRefreshes() == 0, "no refresh while asleep", "asleep=%u", c.asleepRefreshes());
  if (heap.size() > 10) {
    // Reboots re-create the app; compare the steady part after the last reboot-free stretch.
    uint32_t lo = *std::min_element(heap.begin() + 2, heap.end()), hi = *std::max_element(heap.begin() + 2, heap.end());
    c.check(hi - lo < 64, "heap stable", "range=%u B", hi - lo);
    uint32_t llo = *std::min_element(lvgl.begin() + 2, lvgl.end()), lhi = *std::max_element(lvgl.begin() + 2, lvgl.end());
    c.check(lhi - llo < 512, "LVGL pool stable", "used %u..%u B", llo, lhi);
  }
  pv::AppStatus st = c.st();
  c.note("clips %d, reboots %d, virtual %.1f h, puts %d, GETs %d (updates %d), dup replies %d, check sessions %u", clips, reboots,
         c.s.now() / 3.6e6, m.puts, m.gets, m.get_updates, m.dup_replies, st.stats.checks);
}

// ---------------------------------------------------------------------------------------
// Firmware update (docs/device-api.md section 6, firmware/core/src/pv_ota.h). The sim models the
// ESP-IDF bootloader with rollback: two 3 MB slots, otadata states, NVS, images that crash.

static void fwCfg(Ctx &c, const std::string &fw, const std::string &bin_script = "[]") {
  c.mockConfig("{\"fw\":" + fw + ",\"fw_bin_script\":" + bin_script + "}");
}
static bool waitValid(Ctx &c, const std::string &v, uint64_t max_ms) {
  return c.s.runUntil([&] {
    Sim::Snapshot sn = c.s.snapshot();
    return sn.fw == v && sn.slot >= 0 && sn.slot_state[sn.slot] == "valid";
  }, max_ms);
}
static bool waitLog(Ctx &c, const std::string &needle, uint32_t n, uint64_t max_ms) {
  return c.s.runUntil([&] { return c.s.countLog(needle) >= n; }, max_ms);
}
static void powerOn(Ctx &c) {
  c.s.hold(pv::Button::Pwr, 1000);
  c.s.runUntil([&] { return c.s.powered() && c.st().state == pv::State::Ready && c.screen() != pv::Screen::Boot; }, 10 * SEC);
}
static std::string fwState(Ctx &c) {
  Sim::Snapshot sn = c.s.snapshot();
  char b[200];
  snprintf(b, sizeof(b), "fw=%s slot=%d boot=%d s0=%s(%s) s1=%s(%s) boots=%u rollbacks=%u bricked=%d", sn.fw.c_str(), sn.slot, sn.boot_slot,
           sn.slot_state[0].c_str(), sn.slot_fw[0].c_str(), sn.slot_state[1].c_str(), sn.slot_fw[1].c_str(), sn.boots, sn.rollbacks, sn.bricked);
  return b;
}

void scOtaHappy(Ctx &c) {
  fwCfg(c, "{\"version\":\"1.1.0\",\"size\":1800000}");
  c.check(c.boot(), "boots");
  Sim::Snapshot sn = c.s.snapshot();
  c.check(sn.fw == "1.0.0" && sn.slot == 0, "factory firmware 1.0.0 runs from slot 0", "%s", fwState(c).c_str());
  std::string sha0 = c.s.slotSha(0);
  c.record(2000);
  c.check(c.waitScreen(pv::Screen::Result, 30 * SEC), "the clip's result is shown first");
  c.check(waitLog(c, "OTA,later,version=1.1.0", 1, 30 * SEC), "update found in the same session (X-PV-FW-Latest), install postponed");
  MockState m = c.mock();
  c.check(m.fw_checks == 1 && m.fw_downloads == 0, "one firmware check, no download yet", "checks=%d downloads=%d", m.fw_checks, m.fw_downloads);
  c.check(c.s.countLog("NET,reason=") == 1, "check piggybacked on the upload session (no extra Wi-Fi)", "sessions=%u", c.s.countLog("NET,reason="));
  auto up = c.logTimes(",UP,name="), chk = c.logTimes("OTA,check,");
  c.check(up.size() == 1 && chk.size() == 1 && chk[0] >= up[0], "firmware check after the upload");
  c.check(c.screen() == pv::Screen::Result, "result stays on screen", "screen=%s", pv::screenName(c.screen()));
  uint64_t t_later = c.s.now();
  bool upd = c.waitScreen(pv::Screen::Updating, 30 * MIN);
  c.check(upd && c.s.now() - t_later >= 9 * MIN, "UPDATING in a quiet session >= 10 min later", "after %.0f s", (c.s.now() - t_later) / 1000.0);
  c.s.runUntil([&] { return strstr(c.st().screen.detail, "40%") != nullptr; }, MIN);
  c.shot("updating");
  c.check(c.waitScreen(pv::Screen::Updated, 3 * MIN), "reboots into the new firmware: UPDATED", "screen=%s", pv::screenName(c.screen()));
  sn = c.s.snapshot();
  c.check(sn.fw == "1.1.0" && sn.slot == 1 && sn.boots == 2, "running 1.1.0 from slot 1 after one restart", "%s", fwState(c).c_str());
  c.check(!strcmp(c.st().screen.detail, "v1.1.0"), "screen says v1.1.0", "detail=%s", c.st().screen.detail);
  c.shot("updated");
  c.check(c.s.countLog("screen=UPDATING") >= 11, "progress 0..90 % + restarting", "updates=%u", c.s.countLog("screen=UPDATING"));
  c.check(c.s.countLog("OTA,result=installed,reason=,session=fw_check,busy=0") == 1, "installed in a dedicated quiet fw session");
  c.check(c.st().fw_verifying, "boots unconfirmed (pending verify)");
  bool valid = waitValid(c, "1.1.0", 2 * MIN);
  c.check(valid && c.s.countLog("OTA,valid,fw=1.1.0,via=server") == 1, "confirms itself after reaching the server", "%s", fwState(c).c_str());
  c.check(c.s.slotSha(0) == sha0 && c.s.snapshot().slot_fw[0] == "1.0.0", "previous firmware untouched in slot 0 (rollback target)");
  c.check(!strcmp(c.mock().fw_last, "1.1.0"), "server sees X-PV-FW: 1.1.0", "fw_last=%s", c.mock().fw_last);
  c.check(c.s.kvValue("ota_pend").empty() && c.s.kvValue("ota_bad").empty(), "install notes cleared");
  c.record(2000);
  c.check(c.waitScreen(pv::Screen::Result, 30 * SEC), "recording + upload work on the new firmware");
  c.s.runFor(50 * HOUR);
  m = c.mock();
  c.check(m.fw_downloads == 1 && m.tasks == 2, "downloaded exactly once", "downloads=%d tasks=%d", m.fw_downloads, m.tasks);
  c.check(m.fw_checks <= 6, "then only ~daily checks", "checks=%d", m.fw_checks);
  c.check(c.asleepRefreshes() == 0, "no refresh while asleep");
}

void scOtaDaily(Ctx &c) {
  c.cfg.auto_off_idle_ms = 0;  // days of uptime on battery: no auto power-off here (see auto_power_off)
  c.check(c.boot(), "boots");
  c.check(c.waitSleep(MIN), "sleeps");
  c.s.runFor(74 * HOUR);  // nothing recorded: no other reason for Wi-Fi
  auto t = c.logTimes("NET,reason=fw_check");
  bool gaps = t.size() == 3;
  std::string got;
  for (size_t i = 0; i < t.size(); i++) {
    double h = (t[i] - (i ? t[i - 1] : 0)) / 3.6e6;
    got += std::to_string(h).substr(0, 5) + "h ";
    if (h < 24 || h > 24.3) gaps = false;
  }
  c.check(gaps, "one dedicated check per ~24 h", "%s", got.c_str());
  c.check(c.s.countLog("NET,reason=") == 3 && c.mock().fw_checks == 3, "no other Wi-Fi sessions", "sessions=%u", c.s.countLog("NET,reason="));
  fwCfg(c, "{\"version\":\"1.1.0\",\"hint\":false}");
  c.check(waitValid(c, "1.1.0", 25 * HOUR), "next daily check installs a release", "%s", fwState(c).c_str());
  c.check(netCount(c, "fw_check") == 3 && c.s.countLog("OTA,result=installed,reason=,session=fw_check") == 1 && netCount(c, "fw_verify") == 1,
          "installed in the 4th daily session, one verify session after", "fw_check=%u fw_verify=%u", netCount(c, "fw_check"),
          netCount(c, "fw_verify"));
}

void scOtaCorruptHash(Ctx &c) {
  fwCfg(c, "{\"version\":\"1.1.0\",\"fault\":\"corrupt\"}");
  c.check(c.boot(), "boots");
  std::string sha0 = c.s.slotSha(0);
  c.s.command("ota");
  c.check(waitLog(c, "OTA,fail,", 1, 5 * MIN), "download fails", "%s", fwState(c).c_str());
  c.check(c.s.countLog("OTA,fail,version=1.1.0,reason=sha256") == 1, "rejected by the SHA-256 check");
  c.check(c.s.countLog("SIM,ota commit") == 0 && c.s.countLog("SIM,ota abandoned") == 1, "slot never committed, write abandoned");
  Sim::Snapshot sn = c.s.snapshot();
  c.check(sn.fw == "1.0.0" && sn.boot_slot == 0 && sn.boots == 1 && c.s.slotSha(0) == sha0, "still 1.0.0, boot slot 0, no restart, slot 0 intact",
          "%s", fwState(c).c_str());
  c.check(c.screen() == pv::Screen::UpdateFailed, "UPDATE FAILED shown", "screen=%s", pv::screenName(c.screen()));
  c.shot("update-failed");
  // A valid image that is not the one the (signed) offer describes: only the hash catches it.
  fwCfg(c, "{\"version\":\"1.1.0\",\"fault\":\"wrong_hash\"}");
  uint64_t t1 = c.logTimes("OTA,fail,")[0];
  c.check(waitLog(c, "OTA,fail,", 2, 3 * HOUR), "retried after the backoff, fails again");
  auto f = c.logTimes("OTA,fail,");
  c.check(f.size() == 2 && f[1] - t1 >= HOUR && f[1] - t1 < HOUR + 16 * MIN, "retry ~1 h later", "%.2f h", f.size() == 2 ? (f[1] - t1) / 3.6e6 : 0);
  c.check(c.s.countLog("OTA,fail,version=1.1.0,reason=sha256") == 2 && c.s.countLog("SIM,ota commit") == 0, "wrong image rejected by hash, never committed");
  c.check(c.s.snapshot().fw == "1.0.0" && c.s.slotSha(0) == sha0, "still on 1.0.0");
  fwCfg(c, "{\"version\":\"1.1.0\"}");
  c.check(waitValid(c, "1.1.0", 4 * HOUR), "installs once the server serves the right bytes", "%s", fwState(c).c_str());
  f = c.logTimes("OTA,installed");
  c.check(f.size() == 1 && f[0] - c.logTimes("OTA,fail,")[1] >= 2 * HOUR, "after a doubled (2 h) backoff");
  c.check(c.mock().fw_downloads == 3, "3 downloads in total", "downloads=%d", c.mock().fw_downloads);
}

void scOtaTruncated(Ctx &c) {
  c.cfg.auto_off_idle_ms = 0;  // days of uptime on battery: no auto power-off here (see auto_power_off)
  fwCfg(c, "{\"version\":\"1.1.0\",\"fault\":\"truncated\"}");
  c.check(c.boot(), "boots");
  std::string sha0 = c.s.slotSha(0);
  c.s.command("ota");
  c.check(waitLog(c, "OTA,fail,", 1, 5 * MIN), "download fails");
  c.check(c.s.countLog("OTA,fail,version=1.1.0,reason=truncated") == 1, "connection lost at 60 % -> truncated");
  Sim::Snapshot sn = c.s.snapshot();
  c.check(sn.slot_fw[1].empty() && sn.boot_slot == 0 && c.s.slotSha(0) == sha0 && sn.fw == "1.0.0",
          "partial image left in slot 1 only; boot slot and slot 0 untouched", "%s", fwState(c).c_str());
  // then 404, a short Content-Length and a dropped connection before success
  fwCfg(c, "{\"version\":\"1.1.0\"}", "[\"bin_404\",\"short_length\",\"drop\"]");
  c.check(waitValid(c, "1.1.0", 24 * HOUR), "eventually installed", "%s", fwState(c).c_str());
  const char *F = "OTA,fail,version=1.1.0,reason=";
  c.check(c.s.countLog(std::string(F) + "http") == 1 && c.s.countLog(std::string(F) + "length") == 1 && c.s.countLog(std::string(F) + "truncated") == 2,
          "404 / wrong length / dropped all rejected", "http=%u length=%u truncated=%u", c.s.countLog(std::string(F) + "http"),
          c.s.countLog(std::string(F) + "length"), c.s.countLog(std::string(F) + "truncated"));
  c.check(c.s.countLog("SIM,ota commit") == 1 && c.mock().fw_downloads == 5, "one commit, 5 downloads", "downloads=%d", c.mock().fw_downloads);
  c.check(c.s.slotSha(0) == sha0, "old firmware still in slot 0");
  auto f = c.logTimes("OTA,fail,");
  bool backoff = f.size() == 4;
  for (size_t i = 1; i < f.size(); i++)
    if (f[i] - f[i - 1] < (HOUR << (i - 1))) backoff = false;
  c.check(backoff, "retries back off 1 h, 2 h, 4 h");
}

void scOtaPowerLossDownload(Ctx &c) {
  c.s.setUsb(false);
  fwCfg(c, "{\"version\":\"1.1.0\",\"kbps\":40}");
  c.check(c.boot(), "boots");
  std::string sha0 = c.s.slotSha(0);
  c.s.command("ota");
  c.check(c.s.runUntil([&] { return strstr(c.st().screen.detail, "40%") != nullptr; }, 5 * MIN), "download at 40 %");
  c.shot("updating-40");
  c.s.cutPower();
  c.s.runFor(1000);
  Sim::Snapshot sn = c.s.snapshot();
  c.check(!c.s.powered(), "battery pulled mid-download");
  c.check(sn.slot_fw[1].empty() && sn.boot_slot == 0 && c.s.slotSha(0) == sha0, "slot 1 half written, boot slot still 0, slot 0 intact",
          "%s", fwState(c).c_str());
  c.check(c.s.kvValue("ota_pend").empty(), "no install note (cut before the commit)");
  powerOn(c);
  sn = c.s.snapshot();
  c.check(sn.fw == "1.0.0" && sn.slot == 0 && !sn.bricked && sn.boots == 2, "boots the old firmware", "%s", fwState(c).c_str());
  c.check(c.screen() == pv::Screen::Ready, "plain READY (nothing to report)", "screen=%s", pv::screenName(c.screen()));
  c.record(2000);
  c.check(waitValid(c, "1.1.0", HOUR), "later session installs it", "%s", fwState(c).c_str());
  c.check(c.s.slotSha(0) == sha0 && c.mock().tasks == 1, "slot 0 unchanged, clip delivered");
}

void scOtaPowerLossSwitch(Ctx &c) {
  c.s.setUsb(false);
  fwCfg(c, "{\"version\":\"1.1.0\"}");
  c.check(c.boot(), "boots");
  c.s.faults().ota_cut_after_commit = true;
  c.s.command("ota");
  c.check(c.s.runUntil([&] { return !c.s.powered(); }, 5 * MIN), "power lost right after the boot slot switch");
  Sim::Snapshot sn = c.s.snapshot();
  c.check(sn.boot_slot == 1 && sn.slot_state[1] == "new" && c.s.kvValue("ota_pend") == "1.1.0", "otadata: slot 1 new; NVS note written",
          "%s pend=%s", fwState(c).c_str(), c.s.kvValue("ota_pend").c_str());
  powerOn(c);
  c.check(c.screen() == pv::Screen::Updated && c.s.snapshot().fw == "1.1.0", "next power-on boots it: UPDATED", "%s", fwState(c).c_str());
  c.check(waitValid(c, "1.1.0", 2 * MIN), "and confirms it");
  // A new image that loses power before it confirmed itself is rolled back (and retried).
  fwCfg(c, "{\"version\":\"1.2.0\"}");
  c.s.faults().ota_cut_after_commit = true;
  c.s.command("ota");
  c.check(c.s.runUntil([&] { return !c.s.powered(); }, 5 * MIN), "1.2.0 committed, power lost");
  c.s.faults().wifi_offline = true;  // its verify session cannot reach the server
  powerOn(c);
  c.check(c.s.snapshot().fw == "1.2.0" && c.st().fw_verifying, "1.2.0 boots unconfirmed", "%s", fwState(c).c_str());
  c.s.runFor(2 * MIN);
  c.check(c.st().fw_verifying, "not confirmed without the server (uptime fallback not reached)");
  c.s.cutPower();
  c.s.runFor(1000);
  powerOn(c);
  sn = c.s.snapshot();
  c.check(sn.fw == "1.1.0" && sn.rollbacks == 1 && sn.slot_state[0] == "aborted", "bootloader rolled back to 1.1.0", "%s", fwState(c).c_str());
  c.check(c.screen() == pv::Screen::UpdateFailed, "UPDATE FAILED", "screen=%s detail=%s", pv::screenName(c.screen()), c.st().screen.detail);
  c.shot("rolled-back");
  c.check(c.s.kvValue("ota_bad") == "1.2.0 1", "attempt counted", "ota_bad=%s", c.s.kvValue("ota_bad").c_str());
  c.s.faults().wifi_offline = false;
  c.s.faults().ota_cut_after_commit = true;
  c.s.command("ota");
  c.check(c.s.runUntil([&] { return !c.s.powered(); }, 5 * MIN), "second attempt allowed (max 2)");
  c.s.faults().wifi_offline = true;
  powerOn(c);
  c.check(waitValid(c, "1.2.0", 40 * MIN), "offline: confirmed by uptime instead", "%s", fwState(c).c_str());
  c.check(c.s.countLog("OTA,valid,fw=1.2.0,via=uptime") == 1, "via=uptime (>= 10 min, no server)");
  c.check(!c.s.snapshot().bricked, "never bricked");
}

void scOtaCrashRollback(Ctx &c) {
  c.cfg.auto_off_idle_ms = 0;  // days of uptime on battery: no auto power-off here (see auto_power_off)
  fwCfg(c, "{\"version\":\"1.1.0\",\"crash_ms\":800}");
  c.check(c.boot(), "boots");
  std::string sha0 = c.s.slotSha(0);
  for (int attempt = 1; attempt <= 2; attempt++) {
    c.record(1500);
    c.check(waitLog(c, "SIM,panic", attempt, 40 * MIN), "1.1.0 installed and crashes on boot (attempt " + std::to_string(attempt) + ")");
    c.check(c.waitScreen(pv::Screen::UpdateFailed, MIN), "rolled back: UPDATE FAILED", "screen=%s", pv::screenName(c.screen()));
    Sim::Snapshot sn = c.s.snapshot();
    c.check(sn.fw == "1.0.0" && sn.slot == 0 && sn.rollbacks == (uint32_t)attempt && sn.slot_state[1] == "aborted",
            "bootloader went back to 1.0.0 in slot 0", "%s", fwState(c).c_str());
    c.check(c.s.slotSha(0) == sha0, "slot 0 image unchanged");
    if (attempt == 1) c.shot("crash-rolled-back");
  }
  c.check(c.s.kvValue("ota_bad") == "1.1.0 2", "two failed attempts recorded", "ota_bad=%s", c.s.kvValue("ota_bad").c_str());
  c.record(1500);
  c.check(waitLog(c, "reason=rolled_back_before", 1, 5 * MIN), "third offer refused");
  c.s.runFor(72 * HOUR);
  MockState m = c.mock();
  c.check(m.fw_downloads == 2 && c.s.snapshot().boots == 5, "never downloaded again, no boot loop", "downloads=%d boots=%u", m.fw_downloads,
          c.s.snapshot().boots);
  c.check(m.tasks == 3 && c.s.queueFiles() == 0, "every clip delivered", "tasks=%d", m.tasks);
  fwCfg(c, "{\"version\":\"1.1.1\"}");
  c.record(1500);
  c.check(waitValid(c, "1.1.1", HOUR), "fixed release 1.1.1 installs", "%s", fwState(c).c_str());
  c.check(!c.s.snapshot().bricked, "never bricked");
}

void scOtaLowBattery(Ctx &c) {
  c.cfg.auto_off_idle_ms = 0;  // days of uptime on battery: no auto power-off here (see auto_power_off)
  c.s.setBatteryMv(3720);  // ~24 %
  fwCfg(c, "{\"version\":\"1.1.0\"}");
  c.check(c.boot(), "boots");
  c.record(2000);
  c.check(c.waitScreen(pv::Screen::Result, 30 * SEC), "uploads still work");
  c.check(waitLog(c, "OTA,defer,reason=battery", 1, MIN), "update deferred: battery < 30 %");
  c.s.runFor(30 * HOUR);
  MockState m = c.mock();
  c.check(m.fw_checks == 0 && m.fw_downloads == 0 && netCount(c, "fw_check") == 0, "no check, no download, no dedicated session",
          "checks=%d downloads=%d", m.fw_checks, m.fw_downloads);
  c.check(c.s.snapshot().fw == "1.0.0", "still 1.0.0");
  c.s.setUsb(true);  // charging
  c.check(waitValid(c, "1.1.0", 2 * HOUR), "installed once on USB", "%s", fwState(c).c_str());
}

void scOtaNotDuringRecording(Ctx &c) {
  fwCfg(c, "{\"version\":\"1.1.0\",\"kbps\":30}");
  c.check(c.boot(), "boots");
  std::string sha0 = c.s.slotSha(0);
  c.s.command("ota");
  c.check(c.s.runUntil([&] { return strstr(c.st().screen.detail, "20%") != nullptr; }, 5 * MIN), "download running (20 %)");
  uint64_t t = c.s.now();
  c.s.setButton(pv::Button::Boot, true);
  bool rec = c.waitScreen(pv::Screen::Rec, 3 * SEC);
  c.check(rec && c.s.now() - t < 1000, "BOOT starts a recording at once", "%.2f s", (c.s.now() - t) / 1000.0);
  c.check(c.s.countLog("OTA,abort") == 1 && c.s.countLog("SIM,ota abandoned") == 1, "download aborted, slot abandoned");
  Sim::Snapshot sn = c.s.snapshot();
  c.check(sn.boot_slot == 0 && c.s.slotSha(0) == sha0 && !sn.wifi_on, "boot slot unchanged, Wi-Fi off while recording", "%s", fwState(c).c_str());
  c.s.runFor(2500);
  c.s.setButton(pv::Button::Boot, false);
  c.check(c.waitScreen(pv::Screen::Result, 30 * SEC), "clip uploaded");
  c.check(c.s.snapshot().fw == "1.0.0", "no restart under the user's hands");
  c.check(waitValid(c, "1.1.0", HOUR), "update finished in a quiet moment later", "%s", fwState(c).c_str());
  auto ab = c.logTimes("OTA,abort"), ins = c.logTimes("OTA,download,");
  c.check(ins.size() == 2 && ins[1] - ab[0] >= 10 * MIN, ">= 10 min after the recording", "%.0f s", ins.size() == 2 ? (ins[1] - ab[0]) / 1000.0 : 0);
  c.check(c.mock().tasks == 1, "clip delivered once");
}

void scOtaQueueFirst(Ctx &c) {
  c.s.faults().wifi_offline = true;
  fwCfg(c, "{\"version\":\"1.1.0\"}");
  c.check(c.boot(), "boots");
  for (int i = 0; i < 3; i++) {
    c.record(1500);
    c.s.runFor(10 * SEC);
  }
  c.check(c.s.queueFiles() == 3, "3 clips queued offline");
  c.mockConfig("{\"always\":{\"status\":500}}");
  c.s.faults().wifi_offline = false;
  c.s.runFor(20 * MIN);
  c.check(c.s.queueFiles() == 3 && c.mock().fw_downloads == 0, "uploads failing: no firmware download", "queued=%u downloads=%d", c.s.queueFiles(),
          c.mock().fw_downloads);
  c.check(c.s.countLog("OTA,defer,reason=queue") >= 1 && c.mock().fw_checks == 0, "deferred because clips wait (not even checked)");
  c.mockConfig("{\"always\":{}}");
  c.check(c.s.runUntil([&] { return c.s.queueFiles() == 0; }, HOUR), "queue drains");
  c.check(waitValid(c, "1.1.0", 2 * HOUR), "then the update", "%s", fwState(c).c_str());
  auto up = c.logTimes(",UP,name="), dl = c.logTimes("OTA,download,");
  c.check(!up.empty() && dl.size() == 1 && dl[0] > up.back(), "every upload before the download");
  c.check(c.mock().tasks == 3, "3 clips delivered");
}

void scOtaNoDowngrade(Ctx &c) {
  c.check(c.boot(), "boots");
  struct Case { const char *fw, *expect; } cases[] = {
    { "{\"version\":\"0.9.0\",\"fault\":\"downgrade\"}", "reason=not_newer" },
    { "{\"version\":\"1.0.0\",\"fault\":\"downgrade\"}", "reason=not_newer" },
    { "{\"version\":\"1.1.0\",\"fault\":\"meta_malformed\"}", "reason=bad_offer" },
    { "{\"version\":\"1.1.0\",\"fault\":\"oversize\"}", "reason=too_big" },
    { "{\"version\":\"1.1.0\",\"fault\":\"meta_500\"}", "result=failed,reason=check_failed" },
    { "{\"version\":\"1.1.0\",\"fault\":\"meta_404\"}", "result=no_server_support" },
  };
  for (auto &k : cases) {
    fwCfg(c, k.fw);
    uint32_t n = c.s.countLog(k.expect);
    c.s.command("ota");
    c.check(waitLog(c, k.expect, n + 1, 2 * MIN), std::string("offer ") + k.fw + " -> " + k.expect);
  }
  Sim::Snapshot sn = c.s.snapshot();
  c.check(c.mock().fw_downloads == 0 && sn.slot_state[1] == "empty" && sn.slot_fw[1].empty(), "nothing downloaded, slot 1 never touched",
          "%s", fwState(c).c_str());
  c.check(sn.fw == "1.0.0" && sn.boots == 1, "still 1.0.0, no restart");
  fwCfg(c, "{\"version\":\"1.1.0\"}");
  c.s.command("ota");
  c.check(waitValid(c, "1.1.0", 10 * MIN), "a real upgrade installs");
  fwCfg(c, "{\"version\":\"1.0.5\",\"fault\":\"downgrade\"}");
  c.s.command("ota");
  c.check(waitLog(c, "OTA,reject,version=1.0.5,reason=not_newer", 1, 2 * MIN), "1.0.5 offered to 1.1.0: refused");
  c.check(c.s.snapshot().fw == "1.1.0" && c.mock().fw_downloads == 1, "stays on 1.1.0");
}

void scOtaSignature(Ctx &c) {
  c.check(c.boot(), "boots");
  fwCfg(c, "{\"version\":\"1.1.0\",\"fault\":\"bad_sig\"}");
  c.s.command("ota");
  c.check(waitLog(c, "OTA,reject,version=1.1.0,reason=signature", 1, 2 * MIN), "offer signed with another key: refused");
  fwCfg(c, "{\"version\":\"1.1.0\",\"fault\":\"unsigned\"}");
  c.s.command("ota");
  c.check(waitLog(c, "OTA,reject,version=1.1.0,reason=unsigned", 1, 2 * MIN), "unsigned offer: refused");
  Sim::Snapshot sn = c.s.snapshot();
  c.check(c.mock().fw_downloads == 0 && sn.slot_state[1] == "empty" && sn.fw == "1.0.0", "nothing downloaded (checked before the download)",
          "%s", fwState(c).c_str());
  // Valid signature, image on another host (e.g. a public bucket): no device token sent there.
  fwCfg(c, "{\"version\":\"1.1.0\",\"abs_url\":true}");
  c.s.command("ota");
  c.check(waitValid(c, "1.1.0", 10 * MIN), "correctly signed release installs", "%s", fwState(c).c_str());
  c.check(c.mock().fw_bin_auth == 0, "device token not sent to the download host", "auth=%d", c.mock().fw_bin_auth);
}

// 40 seeded cycles: clips + server faults + a new release every 3 cycles (some corrupt,
// truncated, badly signed, 404, or crashing on boot) + resets / battery pulls aimed at the
// download, at the unconfirmed new image, or at random moments.
void scSoakOta(Ctx &c) {
  std::mt19937 rng(4242);
  c.check(c.boot(), "boots");
  c.waitSleep(MIN);
  int clips = 0, cuts = 0, resets = 0, minor = 0, mid_dl = 0, mid_verify = 0;
  std::set<std::string> crashing;
  std::vector<uint32_t> heap;
  bool stuck = false, bricked = false;
  for (int i = 0; i < 40; i++) {
    if (i % 3 == 0) {
      char fw[200];
      std::string ver = "1." + std::to_string(++minor) + ".0";
      uint32_t r = rng() % 100;
      const char *fault = r < 15 ? "corrupt" : r < 25 ? "truncated" : r < 32 ? "bad_sig" : r < 40 ? "bin_404" : "";
      bool crash = r >= 40 && r < 52;
      if (crash) crashing.insert(ver);
      snprintf(fw, sizeof(fw), "{\"version\":\"%s\",\"kbps\":%u,\"crash_ms\":%u%s%s%s}", ver.c_str(), 60 + rng() % 3 * 60, crash ? 700 : 0,
               fault[0] ? ",\"fault\":\"" : "", fault, fault[0] ? "\"" : "");
      fwCfg(c, fw);
    }
    uint32_t r = rng() % 100;
    c.mockConfig(r < 10 ? "{\"script\":[{\"status\":500}]}" : "{\"script\":[]}");
    c.s.faults().wifi_offline = rng() % 100 < 20;
    c.record(1000 + rng() % 3000);
    clips++;
    r = rng() % 100;
    if (r < 35) {  // something goes wrong: mid-download, while a new image is unconfirmed, or at random
      int kind = rng() % 3;
      if (kind == 0 && c.s.runUntil([&] { return c.screen() == pv::Screen::Updating; }, 30 * MIN)) {
        c.s.runFor(rng() % 15000);
        mid_dl++;
      } else if (kind == 1 && c.s.runUntil([&] { return c.st().fw_verifying; }, 30 * MIN)) {
        c.s.runFor(rng() % 3000);
        mid_verify++;
      } else {
        c.s.runFor(rng() % (25 * MIN));
      }
      if (r < 20) {
        c.s.cutPower();
        c.s.runFor(500);
        powerOn(c);
        cuts++;
      } else {
        c.s.reset();
        resets++;
      }
    }
    if (c.s.snapshot().bricked) bricked = true;
    if (!c.waitSleep(30 * MIN)) {
      stuck = true;
      c.check(false, "cycle returns to sleep", "cycle %d stuck in %s / %s", i, pv::stateName(c.st().state), c.title().c_str());
      break;
    }
    heap.push_back(c.s.snapshot().heap_free);
    c.s.runFor(5 * MIN + rng() % (55 * MIN));
  }
  c.check(!stuck, "40 cycles without a stuck state");
  c.check(!bricked && !c.s.snapshot().bricked, "never bricked");
  c.s.faults().wifi_offline = false;
  c.mockConfig("{\"script\":[]}");
  fwCfg(c, "{\"version\":\"1.20.0\"}");
  c.s.command("ota");
  c.check(waitValid(c, "1.20.0", 4 * HOUR), "ends on the final release", "%s", fwState(c).c_str());
  c.check(c.s.runUntil([&] { return c.s.queueFiles() == 0 && c.st().pending == 0; }, 4 * HOUR), "queue + pending drained");
  MockState m = c.mock();
  c.check(m.tasks == clips && m.max_ok_per_id == 1, "every clip delivered once", "clips=%d tasks=%d", clips, m.tasks);
  int crash_valid = 0;
  for (auto &v : crashing) crash_valid += c.s.countLog("OTA,valid,fw=" + v + ",");
  c.check(crash_valid == 0, "no crashing release ever confirmed", "crashing=%zu", crashing.size());
  c.check(c.s.countLog("SIM,BRICKED") == 0, "bootloader always found a valid slot");
  c.check(c.asleepRefreshes() == 0, "no refresh while asleep");
  if (heap.size() > 5) {
    uint32_t lo = *std::min_element(heap.begin() + 2, heap.end()), hi = *std::max_element(heap.begin() + 2, heap.end());
    c.check(hi - lo < 64, "heap stable", "range=%u B", hi - lo);
  }
  Sim::Snapshot sn = c.s.snapshot();
  c.note("clips %d, releases %d (%zu crashing), installs %u, rollbacks %u, downloads %d, power cuts %d + resets %d (%d mid-download, %d while "
         "unconfirmed), boots %u, virtual %.1f h", clips, minor + 1, crashing.size(), c.s.countLog("OTA,installed"), sn.rollbacks, m.fw_downloads,
         cuts, resets, mid_dl, mid_verify, sn.boots, c.s.now() / 3.6e6);
}

// ---------------------------------------------------------------------------------------
// Status reports (docs/device-api.md section 7)

// One recording + its upload session; returns once the device sleeps again.
static void clipSession(Ctx &c, uint64_t gap_ms = 2 * MIN) {
  c.record(1500);
  c.s.runUntil([&] { return c.st().state == pv::State::Sending; }, 10 * SEC);
  c.waitSleep(5 * MIN);
  c.s.runFor(gap_ms);
}
static std::vector<uint32_t> statusMs(Ctx &c) {  // "ms=" of every STATUS,code= line
  std::vector<uint32_t> v;
  for (auto &l : c.s.logSince(0, 1000000)) {
    size_t p = l.second.find(",STATUS,code=");
    if (p == std::string::npos) continue;
    size_t m = l.second.find(",ms=", p);
    if (m != std::string::npos) v.push_back((uint32_t)atol(l.second.c_str() + m + 4));
  }
  return v;
}
static long logIndex(Ctx &c, const std::string &needle, bool last = false) {
  long idx = -1, i = 0;
  for (auto &l : c.s.logSince(0, 1000000)) {
    if (l.second.find(needle) != std::string::npos) {
      idx = i;
      if (!last) break;
    }
    i++;
  }
  return idx;
}

void scStatusAfterUpload(Ctx &c) {
  c.mockConfig("{\"kind\":\"note\"}");  // one session per clip, nothing left pending
  c.check(c.boot(), "boots");
  c.record(2000);
  c.check(c.waitScreen(pv::Screen::Result, MIN), "result shown");
  c.check(c.waitSleep(2 * MIN), "sleeps");
  auto reps = statusReports(c);
  c.check(reps.size() == 1, "one report for the session", "reports=%zu", reps.size());
  if (reps.empty()) return;
  StatusRep a = reps[0];
  c.check(a.valid, "report matches the contract (mock validator: JSON, <= 2 KB, all fields, types)", "%s", a.err.c_str());
  c.check(a.code == 204 && a.bytes <= 2048, "204, small body", "code=%.0f bytes=%.0f", a.code, a.bytes);
  c.check(a.v == 1 && a.id == "5100c0ffee01" && a.fw == PV_FW_VERSION && a.slot == 0 && a.reset == "poweron" && a.boot_n == 1,
          "identity: id, fw, slot, reset=poweron, boot_n=1", "id=%s fw=%s slot=%.0f reset=%s boot_n=%.0f", a.id.c_str(), a.fw.c_str(), a.slot,
          a.reset.c_str(), a.boot_n);
  c.check(a.clips == 1 && a.uploads == 1 && a.results == 1 && a.upload_fail == 0 && a.wifi_fail == 0 && a.q == 0 && a.pending == 0,
          "counters", "clips=%.0f uploads=%.0f results=%.0f q=%.0f pending=%.0f", a.clips, a.uploads, a.results, a.q, a.pending);
  c.check(a.rssi == -58 && a.connect_ms >= 1500 && a.connect_ms < 1700 && a.usb == 0 && a.batt_mv == 3950 && a.heap > 0 &&
              a.heap_min <= a.heap && a.heap < 210000,
          "radio / power / heap fields", "rssi=%.0f connect_ms=%.0f batt=%.0f heap=%.0f min=%.0f", a.rssi, a.connect_ms, a.batt_mv, a.heap,
          a.heap_min);
  c.check(a.log_n == -1, "no log without a reason", "log_n=%.0f", a.log_n);
  c.check(fabs(a.up_s - a.t / 1000) <= 1 && fabs(a.awake_ms + a.sleep_ms - a.t) < 1000, "first report: uptime / awake+sleep since boot",
          "up_s=%.0f awake=%.0f sleep=%.0f t=%.0f", a.up_s, a.awake_ms, a.sleep_ms, a.t);
  long res = logIndex(c, std::string("UI,screen=") + pv::screenName(pv::Screen::Result)), st = logIndex(c, ",STATUS,code=");
  c.check(res >= 0 && st > res, "result shown (and beeped) before the report: the user never waits for it");
  // second session 10 min later: deltas since the previous report add up to the elapsed time
  c.s.runFor(10 * MIN);
  c.record(2000);
  c.check(c.waitScreen(pv::Screen::Result, MIN), "second result");
  c.waitSleep(2 * MIN);
  reps = statusReports(c);
  c.check(reps.size() == 2, "one more report", "reports=%zu", reps.size());
  if (reps.size() < 2) return;
  StatusRep b = reps[1];
  double dt = b.t - a.t, sum = b.awake_ms + b.sleep_ms;
  c.check(fabs(sum - dt) <= 20, "awake_ms + sleep_ms = time since the previous report", "%.0f + %.0f = %.0f, elapsed %.0f", b.awake_ms,
          b.sleep_ms, sum, dt);
  c.check(b.sleep_ms > 8 * MIN && b.awake_ms > 5 * SEC, "mostly asleep in between", "awake=%.0f sleep=%.0f", b.awake_ms, b.sleep_ms);
  c.check(b.valid && b.clips == 2 && b.uploads == 2 && b.boot_n == 1 && b.log_n == -1, "cumulative stats, same boot, no log");
  Sim::Snapshot sn = c.s.snapshot();
  c.check(connectedSessions(c) == 2 && sn.status_posts == 2 && sn.st.stats.status_sent == 2, "exactly one report per connected session",
          "sessions=%u posts=%u", connectedSessions(c), sn.status_posts);
  c.check(sn.status_last.find("\"reset\":\"poweron\"") != std::string::npos, "sim UI sees the last body");
}

void scStatusOldServer(Ctx &c) {
  c.mockConfig("{\"kind\":\"note\",\"status_always\":{\"status\":404}}");
  c.check(c.boot(), "boots");
  for (int i = 0; i < 3; i++) clipSession(c);
  auto reps = statusReports(c);
  pv::AppStatus st = c.st();
  c.check(reps.size() == 3 && c.s.countLog(",STATUS,code=404") == 3, "older server (404): one attempt per session, never retried",
          "posts=%zu", reps.size());
  c.check(c.s.queueFiles() == 0 && c.mock().tasks == 3 && st.backoff_ms == 0 && st.stats.upload_fail == 0, "uploads unaffected, no backoff",
          "tasks=%d backoff=%u", c.mock().tasks, st.backoff_ms);
  c.check(c.s.countLog("screen=QUEUED") == 0 && st.stats.status_fail == 3, "nothing on screen; counted as status_fail");
  c.mockConfig("{\"status_always\":{\"status\":405}}");
  clipSession(c);
  c.check(c.s.countLog(",STATUS,code=405") == 1 && statusReports(c).size() == 4, "405 the same");
  // A failing status endpoint does not shift the upload retry schedule (30 s backoff).
  c.mockConfig("{\"status_always\":{\"status\":500},\"script\":[{\"status\":500}]}");
  c.record(1500);
  c.check(c.waitScreen(pv::Screen::Queued, MIN), "upload 500 -> QUEUED");
  c.check(c.waitScreen(pv::Screen::Result, 5 * MIN), "retried and delivered");
  auto up = c.logTimes(",UP,name=");
  long gap = up.size() >= 2 ? (long)(up[up.size() - 1] - up[up.size() - 2]) : 0;
  c.check(gap >= 30000 && gap < 34000, "retry still after ~30 s", "gap=%ld ms", gap);
  c.waitSleep(5 * MIN);
  c.check(connectedSessions(c) == statusReports(c).size(), "still exactly one POST per connected session", "sessions=%u posts=%zu",
          connectedSessions(c), statusReports(c).size());
  // Deltas restart only after a 2xx: ok, 500, ok -> the third covers the time since the first.
  c.mockConfig("{\"status_always\":{},\"status_script\":[{},{\"status\":500},{}]}");
  size_t n0 = statusReports(c).size();
  for (int i = 0; i < 3; i++) clipSession(c, 7 * MIN);
  reps = statusReports(c);
  c.check(reps.size() == n0 + 3, "three more reports", "reports=%zu", reps.size());
  if (reps.size() == n0 + 3) {
    StatusRep &r1 = reps[n0], &r2 = reps[n0 + 1], &r3 = reps[n0 + 2];
    c.check(r1.code == 204 && r2.code == 500 && r3.code == 204, "codes ok / 500 / ok");
    c.check(fabs(r2.awake_ms + r2.sleep_ms - (r2.t - r1.t)) <= 20 && fabs(r3.awake_ms + r3.sleep_ms - (r3.t - r1.t)) <= 20,
            "a failed report does not restart the awake/sleep deltas", "r3: %.0f + %.0f vs %.0f", r3.awake_ms, r3.sleep_ms, r3.t - r1.t);
  }
}

void scStatusWantLog(Ctx &c) {
  c.mockConfig("{\"kind\":\"note\"}");  // one session per clip, nothing left pending
  c.mockConfig("{\"status_script\":[{\"want_log\":\"body\"}]}");
  c.check(c.boot(), "boots");
  for (int i = 0; i < 3; i++) clipSession(c);
  auto r = statusReports(c);
  c.check(r.size() == 3, "3 reports", "n=%zu", r.size());
  if (r.size() < 3) return;
  c.check(r[0].log_n == -1 && r[0].code == 200, "first: no log; server answers 200 {\"want_log\":true}");
  c.check(r[1].log_n > 3 && r[1].log.find(",NET,reason=new_clip") != std::string::npos && r[1].valid, "next report carries the log",
          "log_n=%.0f", r[1].log_n);
  c.check(r[2].log_n == -1, "then no log again");
  c.mockConfig("{\"status_script\":[{\"want_log\":\"header\"}]}");
  for (int i = 0; i < 3; i++) clipSession(c);
  r = statusReports(c);
  c.check(r.size() == 6 && r[3].log_n == -1 && r[4].log_n > 0 && r[5].log_n == -1, "X-PV-Want-Log: 1 header works the same");
  // asked, but the report with the log fails: the next one still carries it
  c.mockConfig("{\"status_script\":[{\"want_log\":\"body\"},{\"status\":500},{}]}");
  for (int i = 0; i < 4; i++) clipSession(c);
  r = statusReports(c);
  c.check(r.size() == 10 && r[7].log_n > 0 && r[7].code == 500 && r[8].log_n > 0 && r[8].code == 204 && r[9].log_n == -1,
          "log request survives a failed report, cleared after a delivered one");
  bool all_valid = true;
  for (auto &x : r) all_valid &= x.valid && x.bytes <= 2048;
  c.check(all_valid, "all reports valid and <= 2 KB");
}

void scStatusAfterCrash(Ctx &c) {
  c.cfg.auto_off_idle_ms = 0;  // days of uptime on battery: no auto power-off here (see auto_power_off)
  c.mockConfig("{\"kind\":\"note\"}");  // one session per clip, nothing left pending
  c.check(c.boot(), "boots");
  clipSession(c);
  c.check(statusReports(c).size() == 1 && statusReports(c)[0].log_n == -1, "normal report first, no log");
  // panic while awake: the lines right before it must reach the server
  c.s.command("stat");
  c.s.runFor(2 * SEC);
  c.s.crash("panic");
  c.check(waitLog(c, "reset=panic,boot_n=2,ring=", 1, 10 * SEC), "reboots");
  c.check(c.s.snapshot().reset_reason == "panic" && c.s.countLog("reset=panic,boot_n=2,ring=0") == 0, "BOOT: reset=panic, boot_n=2, ring kept");
  clipSession(c);
  auto r = statusReports(c);
  c.check(r.size() == 2, "report in the next session", "n=%zu", r.size());
  if (r.size() < 2) return;
  size_t pre = r[1].log.find("STAT,cmd=stat"), boot = r[1].log.rfind(",NET,reason=new_clip");
  c.check(r[1].reset == "panic" && r[1].boot_n == 2 && r[1].log_n > 0, "reset=panic with the log", "reset=%s log_n=%.0f",
          r[1].reset.c_str(), r[1].log_n);
  c.check(pre != std::string::npos && boot != std::string::npos && pre < boot, "log has the pre-crash lines, then this session's",
          "pre=%zd post=%zd", (ssize_t)pre, (ssize_t)boot);
  clipSession(c);
  r = statusReports(c);
  c.check(r.size() == 3 && r[2].log_n == -1 && r[2].reset == "panic", "only the first report after the crash carries the log");
  // watchdog, then 12 h without Wi-Fi (the ring rotates): the pinned lines survive
  c.s.command("stat");
  c.s.runFor(1 * SEC);
  c.s.crash("task_wdt");
  c.check(waitLog(c, "reset=task_wdt,boot_n=3", 1, 10 * SEC), "reboots (wdt)");
  long first = logIndex(c, "reset=task_wdt");
  c.s.runFor(12 * HOUR);
  long lines_since = (long)c.s.logSince(0, 1000000).size() - first;
  clipSession(c);
  r = statusReports(c);
  StatusRep *w = nullptr;
  for (auto &x : r)
    if (x.boot_n == 3 && !w) w = &x;
  c.check(w && w->reset == "task_wdt" && w->log.find("STAT,cmd=stat") != std::string::npos,
          "first report after the watchdog has the pre-crash lines (after the ring rotated)", "lines logged since boot=%ld", lines_since);
  c.check(lines_since > 40, "ring really rotated in between", "%ld lines", lines_since);
  // power loss: the ring is gone (no-init RAM garbage), reset=poweron, no log
  c.s.command("stat");
  c.s.runFor(SEC);
  c.s.cutPower();
  c.s.runFor(500);
  powerOn(c);
  c.check(c.s.snapshot().reset_reason == "poweron" && c.s.countLog("reset=poweron,boot_n=4,ring=0") == 1, "power loss: ring rebuilt empty");
  clipSession(c);
  r = statusReports(c);
  c.check(!r.empty() && r.back().boot_n == 4 && r.back().reset == "poweron" && r.back().log_n == -1, "after a power cut: no log");
  c.check(c.s.kvValue("boot_n") == "4", "boot counter persisted in NVS", "boot_n=%s", c.s.kvValue("boot_n").c_str());
}

void scStatusErrorLog(Ctx &c) {
  c.mockConfig("{\"kind\":\"note\"}");  // one session per clip, nothing left pending
  c.check(c.boot(), "boots");
  clipSession(c);
  // Wi-Fi failure: no report possible then; the next good session reports it with the log
  c.s.faults().wifi_offline = true;
  c.record(1500);
  c.check(c.waitScreen(pv::Screen::Queued, MIN), "offline -> QUEUED");
  c.check(statusReports(c).size() == 1, "no report without Wi-Fi (never turned on for it)");
  c.s.faults().wifi_offline = false;
  c.check(c.s.runUntil([&] { return c.s.queueFiles() == 0; }, 5 * MIN), "uploaded on the retry");
  c.waitSleep(5 * MIN);
  auto r = statusReports(c);
  c.check(r.size() == 2 && r[1].log_n > 0 && r[1].log.find(",NET,reason=new_clip,wifi=1,") != std::string::npos && r[1].wifi_fail == 1,
          "next report carries the log with the failed session", "log_n=%.0f", r.size() > 1 ? r[1].log_n : -9);
  clipSession(c);
  r = statusReports(c);
  c.check(r.size() == 3 && r[2].log_n == -1, "clean session: no log");
  // upload 500 in a connected session: the report of that same session has it
  c.mockConfig("{\"script\":[{\"status\":500}]}");
  c.record(1500);
  c.check(c.waitScreen(pv::Screen::Queued, MIN), "upload 500");
  c.check(c.s.runUntil([&] { return c.s.queueFiles() == 0; }, 5 * MIN), "delivered on retry");
  c.waitSleep(5 * MIN);
  r = statusReports(c);
  c.check(r.size() == 5 && r[3].log.find("status=500") != std::string::npos && r[3].upload_fail == 1 && r[4].log_n == -1,
          "upload failure: log in that session's report, none after the clean retry");
  // e-paper BUSY timeout reported by the board
  c.s.faults().epd_timeouts = 2;
  clipSession(c);
  r = statusReports(c);
  c.check(r.size() == 6 && r[5].log_n > 0 && r[5].epd_timeouts == 2, "display timeout -> log + epd_timeouts");
  clipSession(c);
  r = statusReports(c);
  c.check(r.size() == 7 && r[6].log_n == -1, "then quiet again");
  bool valid = true;
  for (auto &x : r) valid &= x.valid;
  c.check(valid, "all reports valid");
}

void scStatusNotWhenRecording(Ctx &c) {
  c.mockConfig("{\"kind\":\"note\"}");
  c.s.faults().wifi_offline = true;
  c.check(c.boot(), "boots");
  for (int i = 0; i < 3; i++) {
    c.record(1500);
    c.s.runFor(10 * SEC);
  }
  c.waitSleep(5 * MIN);
  c.s.faults().wifi_offline = false;
  c.mockConfig("{\"latency_ms\":15000}");
  c.s.hold(pv::Button::Pwr, 200);
  c.check(c.waitScreen(pv::Screen::Sending, 5 * SEC), "upload session");
  c.s.runFor(3000);
  c.s.setButton(pv::Button::Boot, true);  // user starts talking mid-session
  c.check(c.waitScreen(pv::Screen::Rec, MIN), "recording starts");
  c.check(c.s.snapshot().status_posts == 0 && c.s.countLog(",STATUS,") == 0, "no status report while BOOT is down");
  c.s.runFor(2000);
  c.s.setButton(pv::Button::Boot, false);
  c.mockConfig("{\"latency_ms\":0}");
  c.check(c.s.runUntil([&] { return c.s.queueFiles() == 0; }, 10 * MIN), "queue drains afterwards");
  c.waitSleep(5 * MIN);
  uint32_t aborted = c.s.countLog("aborted=1");
  c.check(aborted == 1 && c.s.snapshot().status_posts == connectedSessions(c) - 1, "every other connected session reported once",
          "posts=%u connected=%u aborted=%u", c.s.snapshot().status_posts, connectedSessions(c), aborted);
}

void scStatusBattery(Ctx &c) {
  // low (12 %): at most one report per hour of sessions
  c.mockConfig("{\"kind\":\"note\"}");
  c.s.setBatteryMv(3620);
  c.check(c.boot(), "boots");
  for (int i = 0; i < 4; i++) clipSession(c, 10 * MIN);
  c.check(c.s.snapshot().status_posts == 1 && c.s.countLog(",STATUS,skip=low") == 3, "low battery: 1 report for 4 sessions in < 1 h",
          "posts=%u skips=%u", c.s.snapshot().status_posts, c.s.countLog(",STATUS,skip=low"));
  c.s.runFor(30 * MIN);
  clipSession(c);
  c.check(c.s.snapshot().status_posts == 2, "next one after an hour", "posts=%u", c.s.snapshot().status_posts);
  // critical (3 %): never - a PWR-forced upload session sends no report
  c.s.setBatteryMv(3420);
  c.check(c.s.runUntil([&] { return c.st().batt == pv::BattLevel::Critical; }, 30 * MIN), "critical");
  c.record(1500);
  c.s.runFor(10 * SEC);
  c.s.hold(pv::Button::Pwr, 300);
  c.check(c.s.runUntil([&] { return c.s.queueFiles() == 0; }, MIN), "PWR forces the upload");
  c.waitSleep(5 * MIN);
  c.check(c.s.snapshot().status_posts == 2 && c.s.countLog(",STATUS,skip=critical") == 1, "critical: no report");
  // ... except one crash report after a crash-type reset
  c.s.crash("brownout");
  c.check(waitLog(c, "reset=brownout,boot_n=2", 1, 10 * SEC), "reboots");
  for (int i = 0; i < 2; i++) {
    c.record(1500);
    c.s.runFor(10 * SEC);
    c.s.hold(pv::Button::Pwr, 300);
    c.s.runUntil([&] { return c.s.queueFiles() == 0; }, MIN);
    c.waitSleep(5 * MIN);
  }
  auto r = statusReports(c);
  c.check(c.s.snapshot().status_posts == 3 && r.size() == 3 && r[2].reset == "brownout" && r[2].log_n > 0,
          "critical: exactly one crash report (with log), then none", "posts=%u", c.s.snapshot().status_posts);
  // on USB the battery is not drained: normal reports
  c.s.setUsb(true);
  clipSession(c);
  c.check(c.s.snapshot().status_posts == 4, "on USB: reports again");
}

void scStatusBounded(Ctx &c) {
  c.mockConfig("{\"kind\":\"note\"}");  // one session per clip, nothing left pending
  c.check(c.boot(), "boots");
  uint64_t t0 = c.s.now();
  c.record(1500);
  c.check(c.waitScreen(pv::Screen::Result, MIN), "baseline result");
  uint64_t base_screen = c.s.now() - t0;
  c.waitSleep(5 * MIN);
  c.s.runFor(2 * MIN);
  // a server that takes 20 s to answer the status POST
  c.mockConfig("{\"status_always\":{\"latency_ms\":20000}}");
  t0 = c.s.now();
  c.record(1500);
  c.check(c.waitScreen(pv::Screen::Result, MIN), "result");
  uint64_t slow_screen = c.s.now() - t0;
  c.check(slow_screen <= base_screen + 200, "result on screen just as fast (report comes after it)", "%.1f s vs %.1f s", slow_screen / 1e3,
          base_screen / 1e3);
  c.check(c.s.runUntil([&] { return c.s.countLog(",STATUS,code=") == 2; }, 10 * SEC), "report attempted");
  auto ms = statusMs(c);
  c.check(ms.size() == 2 && ms[1] <= 3000 && c.s.countLog(",STATUS,code=-3,") == 1, "slow server: given up after <= 3 s",
          "ms=%u", ms.size() == 2 ? ms[1] : 0);
  c.check(c.waitSleep(5 * MIN), "sleeps afterwards");
  // recording right after a slow report is not blocked
  c.s.runFor(MIN);
  uint64_t p = c.s.now();
  c.s.setButton(pv::Button::Boot, true);
  c.check(c.waitScreen(pv::Screen::Rec, 3 * SEC), "BOOT -> REC at once", "%.1f s", (c.s.now() - p) / 1e3);
  c.s.runFor(1500);
  c.s.setButton(pv::Button::Boot, false);
  c.waitSleep(5 * MIN);
  // connection dropped; a server that really stalls (wall clock): both bounded the same way
  c.mockConfig("{\"status_always\":{\"drop\":true}}");
  clipSession(c);
  c.mockConfig("{\"status_always\":{\"real_delay_ms\":4000}}");
  clipSession(c);
  ms = statusMs(c);
  uint32_t mx = 0;
  for (uint32_t x : ms) mx = x > mx ? x : mx;
  c.check(ms.size() == 5 && mx <= 3000 && c.s.countLog(",STATUS,code=-1,") == 1, "dropped / stalled: <= 3 s each", "n=%zu max=%u ms",
          ms.size(), mx);
  c.check(c.s.queueFiles() == 0 && c.mock().tasks == 5 && c.st().backoff_ms == 0, "uploads unaffected");
  c.check(c.s.snapshot().status_posts == connectedSessions(c), "one attempt per session (no retries)", "posts=%u sessions=%u",
          c.s.snapshot().status_posts, connectedSessions(c));
}

// Hostile text in log lines (quotes, backslashes, tab, control char, multi-byte UTF-8 cut by the
// 146-byte ring limit) and the 2 KB cap: every report must still be valid strict JSON / UTF-8
// (the mock rejects anything else), keep the newest lines and drop the oldest.
void scStatusLogEscaping(Ctx &c) {
  c.mockConfig("{\"status_always\":{\"want_log\":\"body\"}}");  // every report after the first carries the log
  c.check(c.boot(), "boots");
  const char *hostile = "Say \\\"hi\\\" \\\\ back\\\\slash\\\\ tab\\there \\u0001 €uro 😀 ";
  for (int i = 0; i < 4; i++) {
    std::string pad;
    for (int k = 0; k < 40 + i; k++) pad += "é";  // 2-byte characters, shifted by one each clip: some get cut mid-character
    c.mockConfig(std::string("{\"kind\":\"note\",\"script\":[{\"title\":\"") + hostile + pad + "\"}]}");
    clipSession(c);
  }
  auto r = statusReports(c);
  c.check(r.size() == 4, "4 reports", "n=%zu", r.size());
  bool valid = true, capped = true;
  double biggest = 0;
  for (auto &x : r) {
    valid &= x.valid;
    capped &= x.bytes <= 2048;
    biggest = x.bytes > biggest ? x.bytes : biggest;
  }
  c.check(valid, "all reports strict JSON + UTF-8 (escaped quotes / backslashes / control chars, cut characters replaced)",
          "%s", r.empty() ? "" : r.back().err.c_str());
  c.check(capped && biggest > 1700, "<= 2 KB each, log filled up to the cap", "largest=%.0f B", biggest);
  if (r.size() < 4) return;
  const std::string &lg = r[3].log;
  c.check(lg.find("Say \"hi\" \\ back\\slash\\ tab\there \x01 \xe2\x82\xac" "uro \xf0\x9f\x98\x80 ") != std::string::npos,
          "hostile title round-trips exactly", "log=%.200s", lg.c_str());
  // newest kept, oldest dropped: consecutive sequence numbers ending with the last line before the report
  std::vector<unsigned> seqs;
  for (size_t p = 0; p < lg.size();) {
    size_t e = lg.find('\n', p);
    if (e == std::string::npos) e = lg.size();
    seqs.push_back((unsigned)atol(lg.c_str() + p));
    p = e + 1;
  }
  bool consecutive = !seqs.empty();
  for (size_t i = 1; i < seqs.size(); i++) consecutive &= seqs[i] == seqs[i - 1] + 1;
  unsigned last_before = 0;
  for (auto &l : c.s.logSince(0, 1000000)) {
    size_t b = l.second.find("] ");
    unsigned seq = 0, ms = 0;
    if (b == std::string::npos || sscanf(l.second.c_str() + b + 2, "%u,%u,", &seq, &ms) != 2) continue;
    if (l.second.find(",STATUS,code=") != std::string::npos && seq > seqs.back()) break;
    last_before = seq;
  }
  c.check(consecutive && seqs.back() == last_before && seqs.front() > 1 && r[3].log_n == (double)seqs.size(),
          "log = the newest consecutive lines, oldest dropped", "seqs %u..%u, last before report %u", seqs.empty() ? 0 : seqs.front(),
          seqs.empty() ? 0 : seqs.back(), last_before);
}

// ---------------------------------------------------------------------------------------
// Keep-alive (one TLS connection per session) and Wi-Fi places (docs/device-api.md section 8)

static double mockNum(Ctx &c, const char *key) {
  std::string body = c.s.mockRequest("GET", "/__mock/state");
  pv::JsonField f[1];
  f[0].key = key;
  return pv::jsonReadObject(body.c_str(), f, 1) && f[0].type == pv::JsonType::Number ? f[0].num : -999;
}
static std::vector<std::string> logLines(Ctx &c, const std::string &needle) {
  std::vector<std::string> v;
  for (auto &l : c.s.logSince(0, 1000000))
    if (l.second.find(needle) != std::string::npos) v.push_back(l.second);
  return v;
}
static std::string lastLine(Ctx &c, const std::string &needle) {
  auto v = logLines(c, needle);
  return v.empty() ? "" : v.back();
}
static const char *HOTSPOT = "Joe\xe2\x80\x99s iPhone 15 Pro";
static const char *HOTSPOT_J = "Joe\\u2019s iPhone 15 Pro";  // as JSON
static std::string netJ(const std::string &ssid_json, const char *psk, int prio) {
  return "{\"ssid\":\"" + ssid_json + "\",\"psk\":\"" + psk + "\",\"prio\":" + std::to_string(prio) + "}";
}

void scKeepaliveEnergy(Ctx &c) {
  bool drained = false;
  SoakResult r = soakDrive(c, &drained);
  c.check(!r.stuck && drained, "soak runs and drains (keep-alive)");
  const uint64_t T_END = 5 * HOUR;
  c.s.runTo(T_END);
  RunMetrics on = runMetrics(c);
  MockState m = c.mock();
  c.check(m.tasks == r.clips && m.max_ok_per_id == 1, "every clip once");
  c.check(on.handshakes == on.connected && on.leaks == 0, "one TLS handshake per connected session, closed before Wi-Fi off",
          "handshakes=%u sessions=%u requests=%u leaks=%u", on.handshakes, on.connected, on.requests, on.leaks);
  RunMetrics off = runVariant(c, "run_no_keepalive", [](Ctx &x) {
    bool d;
    soakDrive(x, &d);
  }, T_END, [](Ctx &x) { x.s.faults().no_keepalive = true; });
  c.check(off.handshakes == off.requests, "old behaviour: a handshake per request", "%u handshakes / %u requests", off.handshakes,
          off.requests);
  double ds = off.connected ? (double)off.session_ms / off.connected : 0, ns = on.connected ? (double)on.session_ms / on.connected : 0;
  double de = 100.0 * (on.mah - off.mah) / off.mah;
  c.check(on.wifi_ms < off.wifi_ms && on.mah < off.mah && ns < ds, "keep-alive: less radio time and energy");
  c.note("keep-alive vs a new TLS connection per request (model: +720 ms per handshake, 80 ms per request; soak 30 clips, 50%% offline, "
         "5 h): connected session %.2f s vs %.2f s (%+.0f %%), Wi-Fi time %.0f s vs %.0f s, energy %.2f vs %.2f mAh (%+.1f %%), "
         "handshakes %u vs %u, requests %u vs %u, sessions %u vs %u, wakes %u vs %u",
         ns / 1000, ds / 1000, 100 * (ns - ds) / ds, on.wifi_ms / 1e3, off.wifi_ms / 1e3, on.mah, off.mah, de, on.handshakes, off.handshakes,
         on.requests, off.requests, on.connected, off.connected, on.wakes, off.wakes);
}

void scKeepaliveServerClose(Ctx &c) {
  // A server / proxy without keep-alive ("Connection: close"): the device reconnects per request.
  c.mockConfig("{\"conn_close\":true,\"kind\":\"note\"}");
  c.check(c.boot(), "boots");
  for (int i = 0; i < 3; i++) clipSession(c);
  Sim::Snapshot sn = c.s.snapshot();
  c.check(c.mock().tasks == 3 && c.s.queueFiles() == 0 && c.st().stats.upload_fail == 0, "uploads work without keep-alive");
  c.check(sn.http_handshakes == sn.http_requests && sn.conn_leaks == 0, "a new connection per request when the server closes",
          "handshakes=%u requests=%u", sn.http_handshakes, sn.http_requests);
  // keep-alive again; a dropped reply mid-session: next request on a fresh connection, clip delivered
  c.mockConfig("{\"conn_close\":false,\"script\":[{\"drop\":true}]}");
  uint32_t h0 = sn.http_handshakes, r0 = sn.http_requests, s0 = connectedSessions(c);
  clipSession(c);
  c.check(c.s.runUntil([&] { return c.s.queueFiles() == 0; }, 5 * MIN), "dropped reply: retried and delivered");
  c.waitSleep(5 * MIN);
  clipSession(c);
  sn = c.s.snapshot();
  uint32_t hs = sn.http_handshakes - h0, rq = sn.http_requests - r0, ss = connectedSessions(c) - s0;
  c.check(hs < rq && hs <= ss + 1 && sn.conn_leaks == 0, "otherwise one connection per session (+1 after the drop)",
          "handshakes=%u requests=%u sessions=%u", hs, rq, ss);
}

void scWifiHomeFast(Ctx &c) {
  c.mockConfig("{\"kind\":\"note\"}");
  c.check(c.boot(), "boots");
  for (int i = 0; i < 3; i++) clipSession(c);
  auto w = logLines(c, ",WIFI,how=");
  c.check(w.size() == 3 && w[0].find("how=direct,ssid=PV-Home") != std::string::npos && w[1].find("how=last,ssid=PV-Home") != std::string::npos &&
              w[2].find("how=last") != std::string::npos,
          "1st session: driver finds the only network; then straight to the last AP", "n=%zu", w.size());
  c.check(c.s.countLog(",WIFI,scan=") == 0, "never scanned");
  auto r = statusReports(c);
  c.check(r.size() == 3 && r[0].connect_ms >= 1500 && r[1].connect_ms < 800 && r[2].connect_ms < 800, "connect 1.5 s, then 0.7 s",
          "%.0f / %.0f / %.0f ms", r.size() > 0 ? r[0].connect_ms : 0, r.size() > 1 ? r[1].connect_ms : 0, r.size() > 2 ? r[2].connect_ms : 0);
  std::string body = c.s.mockRequest("GET", "/__mock/status");
  c.check(body.find("\"ssid\": \"PV-Home\"") != std::string::npos, "status report names the network");
  c.check(mockNum(c, "wifi_rev_seen") == 0 && mockNum(c, "wifi_gets") == 0, "sends X-PV-Wifi-Rev: 0; nothing advertised, nothing fetched");
  c.check(c.s.kvValue("wifi_last") == "50562d486f6d65 025056000001 6", "last AP (ssid, bssid, channel) in NVS", "%s",
          c.s.kvValue("wifi_last").c_str());
  c.s.cutPower();
  c.s.runFor(500);
  powerOn(c);
  clipSession(c);
  c.check(lastLine(c, ",WIFI,how=").find("how=last,ssid=PV-Home") != std::string::npos, "after a power cut: still straight to the last AP");
}

// Arrive somewhere new: offline queue; the list changes on the server meanwhile (unreachable);
// hotspot -> upload + new list in that session; next session -> the venue network.
void scWifiPlacesHotspot(Ctx &c) {
  std::string home = netJ("PV-Home", "home-secret-1", 1), hot = netJ(HOTSPOT_J, "hotspot-pw-7", 9);
  c.mockConfig("{\"kind\":\"note\",\"wifi\":{\"rev\":1,\"networks\":[" + home + "," + hot + "]}}");
  c.check(c.boot(), "boots at home");
  clipSession(c);
  c.check(c.s.countLog("WIFI,list=adopted,rev=1,") == 1 && mockNum(c, "wifi_gets") == 1, "list rev 1 fetched in the first session");
  clipSession(c);
  c.check(mockNum(c, "wifi_rev_seen") == 1, "device now sends X-PV-Wifi-Rev: 1");
  c.s.setPlace("venue");
  c.record(1500);
  c.check(c.waitScreen(pv::Screen::Queued, MIN), "venue: no known network -> QUEUED");
  c.check(c.s.countLog("WIFI,scan=") == 1 && c.s.countLog("known=0") == 1, "last AP tried, one scan, nothing known");
  // the owner adds the venue network in the web app while the device is offline
  c.mockConfig("{\"wifi\":{\"rev\":2,\"networks\":[" + home + "," + hot + "," + netJ("Venue Guest", "venue-pass-42", 2) + "]}}");
  c.s.runFor(20 * MIN);
  c.check(c.s.queueFiles() == 1 && mockNum(c, "wifi_gets") == 1, "offline: the new list cannot reach the device, clip stays queued");
  uint32_t offline = c.s.countLog(",NET,reason=") - 2;
  c.s.setApOn(HOTSPOT, true);
  c.check(c.s.runUntil([&] { return c.s.queueFiles() == 0; }, 20 * MIN), "hotspot on: queued clip uploaded");
  c.waitSleep(5 * MIN);
  long adopt = logIndex(c, "WIFI,list=adopted,rev=2,"), via = logIndex(c, "how=scan,ssid=Joe"), net = logIndex(c, "ssid=Joe", true);
  c.check(mockNum(c, "wifi_gets") == 2 && adopt > via && adopt < net, "list rev 2 fetched in that same hotspot session");
  std::string body = c.s.mockRequest("GET", "/__mock/status");
  c.check(body.find("\"ssid\": \"Joe\\u2019s iPhone 15 Pro\"") != std::string::npos, "status report: via the hotspot (exact UTF-8 SSID)");
  clipSession(c);  // hotspot still on: the venue network wins (prio 2 < 9)
  std::string w = lastLine(c, ",WIFI,how=");
  c.check(w.find("how=scan,ssid=Venue Guest") != std::string::npos && w.find("result=0") != std::string::npos,
          "next session: Venue Guest, not the hotspot", "%s", w.c_str());
  clipSession(c);
  c.check(lastLine(c, ",WIFI,how=").find("how=last,ssid=Venue Guest") != std::string::npos, "then straight to the venue AP");
  c.check(c.mock().tasks == 5 && c.s.queueFiles() == 0, "every clip delivered");
  c.s.reset();
  c.check(waitLog(c, "reset=poweron,boot_n=2", 1, 10 * SEC), "rebooted");
  clipSession(c);
  c.check(lastLine(c, ",WIFI,how=").find("how=last,ssid=Venue Guest") != std::string::npos && mockNum(c, "wifi_rev_seen") == 2 &&
              mockNum(c, "wifi_gets") == 2,
          "after reboot: list rev 2 kept, venue at once, no refetch");
  c.note("offline sessions at the venue before the hotspot: %u (each: last AP ~1 s + one scan 1.5 s)", offline);
}

void scWifiWrongPassword(Ctx &c) {
  std::string home = netJ("PV-Home", "home-secret-1", 1), hot = netJ(HOTSPOT_J, "hotspot-pw-7", 9);
  c.mockConfig("{\"kind\":\"note\",\"wifi\":{\"rev\":1,\"networks\":[" + home + "," + netJ("Venue Guest", "typo-pass-42", 2) + "," + hot + "]}}");
  c.check(c.boot(), "boots");
  clipSession(c);
  c.s.setPlace("venue");
  uint32_t s0 = c.s.countLog(",NET,reason=");
  c.record(1500);
  c.check(c.waitScreen(pv::Screen::Queued, MIN), "wrong venue password -> QUEUED");
  c.s.runFor(50 * MIN);
  auto tries = c.logTimes("WIFI,how=scan,ssid=Venue Guest");
  uint32_t sessions = c.s.countLog(",NET,reason=") - s0;
  c.check(c.s.countLog("WIFI,backoff=Venue Guest,min=10") == 1, "network backed off after the rejection");
  c.check(tries.size() >= 2 && tries.size() <= 3 && sessions >= 6, "not retried every session", "tries=%zu sessions=%u", tries.size(), sessions);
  if (tries.size() >= 2) c.check(tries[1] - tries[0] >= 10 * MIN, "first back-off >= 10 min");
  if (tries.size() >= 3) c.check(tries[2] - tries[1] >= 20 * MIN, "then >= 20 min");
  // fixed via the hotspot: corrected list, back-offs forgotten
  c.mockConfig("{\"wifi\":{\"rev\":2,\"networks\":[" + home + "," + netJ("Venue Guest", "venue-pass-42", 2) + "," + hot + "]}}");
  c.s.setApOn(HOTSPOT, true);
  c.check(c.s.runUntil([&] { return c.s.queueFiles() == 0; }, 30 * MIN), "uploaded via the hotspot");
  c.waitSleep(5 * MIN);
  c.check(c.s.countLog("WIFI,list=adopted,rev=2,") == 1, "corrected list fetched");
  c.s.setApOn(HOTSPOT, false);
  clipSession(c);
  std::string w = lastLine(c, ",WIFI,how=");
  c.check(w.find("ssid=Venue Guest") != std::string::npos && w.find("result=0") != std::string::npos,
          "venue network works right away (back-off cleared by the new list)", "%s", w.c_str());
}

void scWifiListRejected(Ctx &c) {
  std::string good = netJ("PV-Home", "home-secret-1", 1) + "," + netJ("Venue Guest", "venue-pass-42", 2);
  c.mockConfig("{\"kind\":\"note\",\"wifi\":{\"rev\":1,\"networks\":[" + good + "]}}");
  c.check(c.boot(), "boots");
  clipSession(c);
  c.check(c.s.countLog("WIFI,list=adopted,rev=1,") == 1, "rev 1 adopted");
  std::string nvs1 = c.s.kvValue("wifi");
  std::string nine;
  for (int i = 0; i < 9; i++) nine += (i ? "," : "") + netJ("Net" + std::to_string(i), "password-1", 3);
  std::string pad(2100, 'x'), e17;
  for (int i = 0; i < 17; i++) e17 += "\\u00e9";  // 34 bytes
  struct Bad {
    int rev;
    std::string cfg, why;
  } bad[] = {
    { 2, "\"wifi_raw\":\"{\\\"rev\\\":2,\\\"networks\\\":[{\\\"ssid\\\":\\\"x\\\"\"", "why=bad_json" },
    { 3, "\"wifi_raw\":\"{\\\"rev\\\":3,\\\"pad\\\":\\\"" + pad + "\\\",\\\"networks\\\":[]}\"", "why=bad_json" },  // > 2 KB: cut
    { 4, "\"wifi_raw\":null,\"wifi\":{\"rev\":4,\"networks\":[" + nine + "]}", "why=too_many" },
    { 5, "\"wifi\":{\"rev\":5,\"networks\":[" + netJ("ThirtyThreeBytesLongSSIDxxxxxxxxx", "password-1", 1) + "]}", "why=bad_ssid" },
    { 6, "\"wifi\":{\"rev\":6,\"networks\":[" + netJ(e17, "password-1", 1) + "]}", "why=bad_ssid" },
    { 7, "\"wifi\":{\"rev\":7,\"networks\":[" + netJ("Short", "1234567", 1) + "]}", "why=bad_psk" },
    { 8, "\"wifi\":{\"rev\":8,\"networks\":[" + good + "," + netJ("Prio", "password-1", 12) + "]}", "why=bad_prio" },
  };
  bool all_kept = true, no_refetch = true;
  std::string detail;
  for (auto &b : bad) {
    bool raw = b.cfg.find("\"wifi\":{") == std::string::npos;
    c.mockConfig("{" + b.cfg + (raw ? ",\"wifi\":{\"rev\":" + std::to_string(b.rev) + ",\"networks\":[]}" : "") + "}");
    double g0 = mockNum(c, "wifi_gets");
    clipSession(c);
    std::string l = lastLine(c, ",WIFI,list=");
    bool kept = l.find("WIFI,list=kept,rev=1,advertised=" + std::to_string(b.rev) + ",status=200") != std::string::npos &&
                l.find(b.why) != std::string::npos && c.s.kvValue("wifi") == nvs1;
    clipSession(c);  // the same revision advertised again: not fetched again
    no_refetch &= mockNum(c, "wifi_gets") == g0 + 1;
    all_kept &= kept;
    if (!kept) detail += " [rev " + std::to_string(b.rev) + ": " + l.substr(l.find("WIFI")) + "]";
  }
  c.check(all_kept, "malformed / > 2 KB / 9 networks / 33-byte SSID / 17 x U+00E9 / 7-char psk / prio 12 -> old list kept, NVS unchanged",
          "%s", detail.c_str());
  c.check(no_refetch, "a rejected revision is not fetched every session");
  // a server error is not a verdict on the list: fetched again next session
  c.mockConfig("{\"wifi\":{\"rev\":20,\"networks\":[" + good + "]},\"wifi_status\":500}");
  double g0 = mockNum(c, "wifi_gets");
  clipSession(c);
  clipSession(c);
  c.check(mockNum(c, "wifi_gets") == g0 + 2, "HTTP 500: tried again next session");
  c.mockConfig("{\"wifi_status\":null}");
  c.s.setPlace("venue");
  clipSession(c);
  std::string w = lastLine(c, ",WIFI,how=");
  c.check(w.find("ssid=Venue Guest") != std::string::npos && w.find("result=0") != std::string::npos && c.s.countLog("WIFI,list=adopted,rev=20,") == 1,
          "the list works at the venue; rev 20 adopted", "%s", w.c_str());
  // a network whose SSID arrives as raw UTF-8 bytes (not \u escaped) matches the AP byte for byte
  SimAp cafe;
  cafe.ssid = "Caf\xc3\xa9 \xe2\x80\x99Zw\xc3\xb6lf\xe2\x80\x99";
  cafe.psk = "cafe-pass-99";
  cafe.place = "venue";
  cafe.bssid[5] = 9;
  cafe.channel = 3;
  cafe.rssi = -75;
  c.s.addAp(cafe);
  c.mockConfig("{\"wifi\":{\"rev\":21},\"wifi_raw\":\"{\\\"rev\\\":21,\\\"networks\\\":[{\\\"ssid\\\":\\\"" + cafe.ssid +
               "\\\",\\\"psk\\\":\\\"cafe-pass-99\\\",\\\"prio\\\":0}]}\"}");
  clipSession(c);  // fetches rev 21 (Venue Guest is no longer listed, PV-Home stays as the built-in network)
  c.s.setApOn("Venue Guest", false);
  clipSession(c);
  w = lastLine(c, ",WIFI,how=");
  c.check(c.s.countLog("WIFI,list=adopted,rev=21,") == 1 && w.find("result=0") != std::string::npos && w.find("ssid=Caf") != std::string::npos,
          "raw UTF-8 SSID adopted and joined", "%s", w.c_str());
  std::string body = c.s.mockRequest("GET", "/__mock/status");
  c.check(body.find("\"ssid\": \"Caf\\u00e9 \\u2019Zw\\u00f6lf\\u2019\"") != std::string::npos, "status report has the exact SSID");
  c.mockConfig("{\"wifi_raw\":null}");
  c.s.reset();
  c.check(waitLog(c, "boot_n=2", 1, 10 * SEC), "rebooted");
  clipSession(c);
  c.check(mockNum(c, "wifi_rev_seen") == 21 && c.s.countLog("WIFI,list=adopted") == 3 && lastLine(c, ",WIFI,how=").find("how=last,ssid=Caf") != std::string::npos,
          "after reboot: rev 21 from NVS, straight to the cafe AP, not refetched");
}


// ---------------------------------------------------------------------------------------
// Battery: auto power-off after 4 h unused, codec standby while asleep, the day budget.
static bool offNow(Ctx &c) { return !c.s.powered(); }

void scAutoPowerOff(Ctx &c) {
  c.s.energyModel().boot_ms = 2500;  // board: ~2.5 s from power-on to READY
  c.cfg.skip_sleep_on_usb = true;    // like the board: awake on a USB host, so unplugging is seen at once
  c.check(c.boot(), "boots on battery");
  uint64_t t0 = c.s.now();
  c.s.runTo(t0 + 4 * HOUR - MIN);
  c.check(c.s.powered() && c.s.countLog("POWEROFF,auto=1,") == 0, "unused: still on 1 min before 4 h");
  bool off = c.s.runUntil([&] { return offNow(c); }, 17 * MIN);
  c.check(off && c.s.countLog("POWEROFF,auto=1,") == 1 && c.screen() == pv::Screen::Off, "off by 4 h 16 min: latch released, OFF on the panel",
          "after %.2f h, screen=%s", (c.s.now() - t0) / 3.6e6, pv::screenName(c.screen()));
  uint32_t cycles = c.s.countLog(",CYCLE,");
  double mah0 = c.s.snapshot().energy.total_mah();
  c.s.runFor(6 * HOUR);
  double mah = c.s.snapshot().energy.total_mah() - mah0;
  c.check(offNow(c) && c.s.countLog(",CYCLE,") == cycles && mah < 0.15, "stays off: no wakes, leakage only", "%.3f mAh in 6 h", mah);

  uint64_t tp = c.s.now();
  powerOn(c);
  uint64_t start_ms = c.s.now() - tp;
  c.check(c.s.powered() && c.st().state == pv::State::Ready && start_ms <= 4000, "PWR starts it: READY ~3 s after the press",
          "%llu ms incl. a 1 s hold", (unsigned long long)start_ms);

  c.s.runFor(3 * HOUR);
  c.record(2500);
  c.check(c.waitScreen(pv::Screen::Result, MIN), "memo uploaded");
  uint64_t t_rec = c.s.now();
  c.s.runTo(t_rec + 4 * HOUR - 2 * MIN);
  c.check(c.s.powered(), "a recording restarts the 4 h", "on at %.2f h after boot", (c.s.now() - tp) / 3.6e6);
  c.s.hold(pv::Button::Pwr, 200);
  uint64_t t_tap = c.s.now();
  c.s.runTo(t_tap + 4 * HOUR - 2 * MIN);
  c.check(c.s.powered(), "so does a PWR tap");
  c.check(c.s.runUntil([&] { return offNow(c); }, 20 * MIN), "then off");

  powerOn(c);
  c.s.setUsb(true);
  c.s.runFor(6 * HOUR);
  c.check(c.s.powered() && c.s.countLog("POWEROFF,auto=1,") == 2, "USB host: stays on (6 h)");
  c.s.setUsb(false);
  uint64_t t_un = c.s.now();
  c.s.runTo(t_un + 4 * HOUR - 2 * MIN);
  c.check(c.s.powered(), "unplugged: on for another 4 h");
  c.check(c.s.runUntil([&] { return offNow(c); }, 20 * MIN), "then off");

  c.s.faults().wifi_offline = true;
  powerOn(c);
  c.record(2500);
  c.check(c.waitScreen(pv::Screen::Queued, MIN), "offline: clip queued");
  uint64_t t_q = c.s.now();
  off = c.s.runUntil([&] { return offNow(c); }, 4 * HOUR + 20 * MIN);
  c.check(off && c.s.now() - t_q >= 4 * HOUR - 2 * MIN && c.s.queueFiles() == 1 && c.s.countLog("POWEROFF,auto=1,idle_min=") == 4 &&
              c.s.countLog(",queued=1") >= 1,
          "a queued clip does not keep it on: retried 4 h, then off", "after %.2f h, queue=%u", (c.s.now() - t_q) / 3.6e6, c.s.queueFiles());
  c.s.faults().wifi_offline = false;
  powerOn(c);
  c.check(c.s.runUntil([&] { return c.s.queueFiles() == 0; }, 2 * MIN), "uploaded at the next start");

  // Pending result checks keep it on past the threshold ("autooff 60": 1 min, until the next start).
  c.mockConfig("{\"process_ms\":1500,\"kind\":\"work\",\"research_ms\":1200000,\"work_outcome\":\"done\"}");
  c.s.command("autooff 60");
  c.record(2500);
  c.check(c.waitScreen(pv::Screen::Researching, 30 * SEC), "research memo: RESEARCHING");
  bool done = c.s.runUntil([&] { return offNow(c) || c.screen() == pv::Screen::WorkDone; }, HOUR);
  c.check(done && c.s.powered() && c.screen() == pv::Screen::WorkDone, "pending result checks keep it on until DONE", "screen=%s powered=%d",
          pv::screenName(c.screen()), c.s.powered());
  c.check(c.s.runUntil([&] { return offNow(c); }, 20 * MIN), "then off (1 min threshold)");
}

void scAutoOffOta(Ctx &c) {
  c.s.energyModel().boot_ms = 2500;
  c.check(c.boot(), "boots");
  c.record(2500);
  c.check(c.waitScreen(pv::Screen::Result, MIN), "day 1: memo");
  c.check(c.s.runUntil([&] { return offNow(c); }, 5 * HOUR), "day 1: off after 4 h unused");
  fwCfg(c, "{\"version\":\"1.1.0\",\"hint\":false}");
  c.s.runTo(24 * HOUR);
  powerOn(c);
  c.record(2500);
  c.check(waitValid(c, "1.1.0", 4 * HOUR), "day 2: release installed and confirmed while on (no days of uptime needed)", "%s",
          fwState(c).c_str());
  c.check(c.s.runUntil([&] { return offNow(c); }, 5 * HOUR), "then off as usual");
  // Never off while a new image is unconfirmed (a reset then = rollback): short threshold, no server.
  fwCfg(c, "{\"version\":\"1.2.0\",\"hint\":false}");
  powerOn(c);
  uint32_t pv0 = c.s.countLog("pending_verify=1"), commits0 = c.s.countLog("SIM,ota commit");
  c.s.command("ota");
  c.check(waitLog(c, "SIM,ota commit", commits0 + 1, 30 * MIN), "1.2.0 downloaded", "%s", fwState(c).c_str());
  c.s.faults().wifi_offline = true;  // the new image cannot reach the server: confirms by uptime (10 min)
  c.check(waitLog(c, "pending_verify=1", pv0 + 1, MIN), "running 1.2.0 unconfirmed", "%s", fwState(c).c_str());
  c.s.command("autooff 60");
  c.s.runFor(8 * MIN);
  c.check(c.s.powered(), "not switched off while unconfirmed (1 min threshold)");
  c.check(waitValid(c, "1.2.0", 30 * MIN), "confirmed by uptime (on the next wake), no rollback", "%s", fwState(c).c_str());
  c.check(c.s.runUntil([&] { return offNow(c); }, 20 * MIN), "then off");
}

void scCodecStandby(Ctx &c) {
  c.check(c.boot(), "boots");
  c.check(c.waitSleep(MIN), "sleeps");
  c.s.runFor(2 * HOUR);
  Sim::Snapshot sn = c.s.snapshot();
  c.check(sn.energy.codec_resumes == 0 && sn.st.stats.timer_wakes >= 7, "timer wakes leave the codec closed", "resumes=%u timer wakes=%u",
          sn.energy.codec_resumes, sn.st.stats.timer_wakes);
  uint64_t t = c.s.now();
  c.record(3000);
  int64_t beep_ms = -1;
  for (auto &b : c.s.snapshot().beeps)
    if (b.hz == 1050 && b.t >= t) { beep_ms = (int64_t)(b.t - t); break; }
  c.check(beep_ms >= 30 && beep_ms <= 40, "start beep ~30 ms after the press (codec reopen)", "%lld ms", (long long)beep_ms);
  c.check(c.waitScreen(pv::Screen::Result, MIN), "memo uploaded");
  MockState m = c.mock();
  double secs = (m.bytes - 44) / 32000.0;
  c.check(secs > 2.85 && secs < 2.92, "clip = hold minus reopen + settling drop (~110 ms)", "%.3f s for a 3.000 s hold", secs);
  c.check(c.s.snapshot().energy.codec_resumes == 1, "one reopen for beep, recording and result tone", "resumes=%u",
          c.s.snapshot().energy.codec_resumes);
  c.check(c.waitSleep(2 * MIN), "sleeps again");
  RunMetrics on = runMetrics(c);
  RunMetrics off = runVariant(c, "run_codec_on", [](Ctx &x) { x.boot(); x.waitSleep(MIN); x.s.runFor(2 * HOUR); x.record(3000); },
                              on.t, [](Ctx &x) { x.s.energyModel().codec_standby = false; });
  c.check(on.mah < off.mah, "less energy than with the codec running", "%.2f vs %.2f mAh (%+.1f %%)", on.mah, off.mah,
          100 * (on.mah - off.mah) / off.mah);
}

// Day budget (MODEL, calibrated to the board - see EnergyModel): this firmware vs the 2026-10-17 one
// (codec running while asleep, never off), one day per usage profile.
static bool g_old_fw = false;
static void bdPrep(Ctx &x) {
  x.s.energyModel().boot_ms = 2500;
  if (!g_old_fw) return;
  x.cfg.auto_off_idle_ms = 0;
  x.s.energyModel().codec_standby = false;
}
static void bdTypical(Ctx &x) {  // 5 x 10 s memos, 3 h apart, online
  x.boot();
  x.waitSleep(MIN);
  for (int i = 0; i < 5; i++) {
    x.s.runTo((uint64_t)(1 + 3 * i) * HOUR);
    if (offNow(x)) powerOn(x);
    x.record(10000);
  }
}
static void bdIdle(Ctx &x) {
  x.boot();
  x.waitSleep(MIN);
}
static void bdOffline(Ctx &x) {  // no known network, one clip stuck in the queue (2026-10-17)
  x.s.faults().wifi_offline = true;
  x.boot();
  x.record(3000);
}

void scBatteryDay(Ctx &c) {
  struct P {
    const char *name;
    void (*drive)(Ctx &);
    double max_ratio;
  } ps[] = { { "5 memos, 3 h apart", bdTypical, 0.65 }, { "idle", bdIdle, 0.2 }, { "offline, 1 clip queued", bdOffline, 0.2 } };
  c.boot();
  const double cap = c.s.energyModel().capacity_mah;
  for (auto &p : ps) {
    g_old_fw = true;
    RunMetrics o = runVariant(c, "old", p.drive, 24 * HOUR, bdPrep);
    g_old_fw = false;
    RunMetrics n = runVariant(c, "new", p.drive, 24 * HOUR, bdPrep);
    double om = o.mah / 24, nm = n.mah / 24;
    c.note("%-24s: before %.2f mA (%.1f days on %.0f mAh) -> now %.2f mA (%.1f days), %+.0f %%; starts with PWR: %u", p.name, om, cap / om / 24, cap, nm,
           cap / nm / 24, 100 * (nm - om) / om, n.boots - 1);
    c.check(nm <= p.max_ratio * om, std::string(p.name) + ": within budget", "%.2f vs %.2f mA (max %.0f %%)", nm, om, 100 * p.max_ratio);
    if (p.drive == bdTypical) c.check(n.boots == 1, "memos 3 h apart never need PWR first", "starts=%u", n.boots);
  }
  c.note("MODEL ESTIMATE: sleep floor calibrated to ~9 mA on 2026-10-17; codec share (%.1f mA) and capacity are guesses",
         c.s.energyModel().codec_ma);
}


// ---------- setup (pocketbot setup: release image + serial "prov", docs/setup.md) ----------
// The newest "@{...}" console reply after log seq `since` ("" = none).
static std::string consoleReply(Ctx &c, uint32_t since) {
  std::string out;
  for (auto &l : c.s.logSince(since, 5000)) {
    size_t at = l.second.find("] @{");
    if (at != std::string::npos) out = l.second.substr(at + 3);
  }
  return out;
}
static uint32_t logSeq(Ctx &c) {
  auto v = c.s.logSince(0, 1);
  uint32_t last = 0;
  for (auto &l : c.s.logSince(0, 100000)) last = l.first;
  (void)v;
  return last;
}
// Runs a console command and returns its "@{...}" reply.
static std::string ask(Ctx &c, const std::string &cmd) {
  uint32_t seq = logSeq(c);
  c.s.command(cmd);
  std::string r;
  c.s.runUntil([&] { return !(r = consoleReply(c, seq)).empty(); }, 3000);
  return r;
}
static bool has(const std::string &s, const std::string &needle) { return s.find(needle) != std::string::npos; }
static const char *SETUP_WIFI = "{\"rev\":3,\"networks\":[{\"ssid\":\"PV-Home\",\"psk\":\"home-secret-1\",\"prio\":0},"
                                "{\"ssid\":\"Joe\xe2\x80\x99s iPhone 15 Pro\",\"psk\":\"hotspot-pw-7\",\"prio\":9}]}";

void scSetupFreshBoard(Ctx &c) {
  c.boot();
  c.check(c.title() == "SET ME UP", "release image without setup says SET ME UP", "title=%s", c.title().c_str());
  c.shot("not set up");
  c.record(2500);
  c.s.runFor(60000);
  c.check(c.s.countLog("NET,") == 0 && c.s.snapshot().status_posts == 0, "no network without a server (clip stays queued)", "net=%u",
          c.s.countLog("NET,"));
  c.check(c.s.queueFiles() == 1, "the clip recorded before setup is kept", "q=%u", c.s.queueFiles());
  std::string info = ask(c, "info");
  c.check(has(info, "\"server\":\"\"") && has(info, "\"token\":false") && has(info, "\"net\":\"never\""), "info: not set up", "%s", info.c_str());
  std::string url = c.s.options().server_url;
  c.check(has(ask(c, "prov server " + url + "/"), "\"ok\":true"), "prov server");
  c.check(has(ask(c, "prov token " + c.s.options().token), "\"ok\":true"), "prov token");
  std::string w = ask(c, std::string("prov wifi ") + SETUP_WIFI);
  c.check(has(w, "\"ok\":true") && has(w, "\"rev\":3") && has(w, "\"count\":2"), "prov wifi (2 networks, UTF-8 hotspot name)", "%s", w.c_str());
  c.check(has(ask(c, "prov done"), "\"ok\":true"), "prov done");
  bool ok = c.s.runUntil([&] { return c.s.countLog("HELLO,ok") > 0; }, 30000);
  c.check(ok, "check-in reaches the server", "status_posts=%u", c.s.snapshot().status_posts);
  c.s.runFor(8000);
  c.check(c.s.snapshot().status_posts >= 1, "status report = the check-in");
  c.check(c.mock().tasks == 1, "queued clip went up in the check-in session", "tasks=%d", c.mock().tasks);
  info = ask(c, "info");
  c.check(has(info, "\"net\":\"ok\"") && has(info, "\"hello\":false") && has(info, "\"token\":true") && has(info, "\"wifi_rev\":3") &&
              has(info, "\"server\":\"" + url + "\"") && !has(info, c.s.options().token) && !has(info, "home-secret"),
          "info: online, server without trailing slash, no secrets printed", "%s", info.c_str());
  c.shot("set up");
  // Settings survive a reboot (NVS; the Wi-Fi list is a multi-line value) and the check-in is not repeated.
  c.s.reset();
  c.s.runFor(3000);
  info = ask(c, "info");
  c.check(has(info, "\"server\":\"" + url + "\"") && has(info, "\"token\":true") && has(info, "\"wifi_rev\":3") &&
              has(info, "\"networks\":[\"PV-Home\",\"Joe\xe2\x80\x99s iPhone 15 Pro\"]"),
          "settings survive a reboot", "%s", info.c_str());
  c.check(c.title() == "READY", "boots to READY", "title=%s", c.title().c_str());
  c.record(2500);
  c.s.runUntil([&] { return c.mock().tasks == 2; }, 20000);
  c.check(c.mock().tasks == 2 && c.s.countLog("HELLO,ok") == 1, "records + uploads with the provisioned token; one check-in only", "tasks=%d hello=%u",
          c.mock().tasks, c.s.countLog("HELLO,ok"));
}

// "wifi scan" / "wifi test" (the setup wizard proves a password before saving it).
static std::string askLong(Ctx &c, const std::string &cmd, uint32_t ms) {
  uint32_t seq = logSeq(c);
  c.s.command(cmd);
  std::string r;
  c.s.runUntil([&] { return !(r = consoleReply(c, seq)).empty(); }, ms);
  return r;
}
void scSetupWifiTest(Ctx &c) {
  c.boot();
  std::string r = askLong(c, "wifi test {\"ssid\":\"PV-Home\",\"psk\":\"home-secret-1\"}", 3000);
  c.check(has(r, "\"error\":\"no_server\""), "test needs a server first", "%s", r.c_str());
  r = askLong(c, "wifi scan", 10000);
  c.check(has(r, "\"ok\":true") && has(r, "{\"ssid\":\"PV-Home\",\"rssi\":-58,\"open\":false}"), "scan lists the home network (signal, secured)",
          "%s", r.c_str());
  c.check(!has(r, "Venue Guest") && !has(r, "iPhone"), "only networks in range (other place, hotspot off)", "%s", r.c_str());
  c.s.setPlace("venue");
  r = askLong(c, "wifi scan", 10000);
  c.check(has(r, "{\"ssid\":\"Cafe Open\",\"rssi\":-70,\"open\":true}") && r.find("Venue Guest") < r.find("Cafe Open"),
          "an open network is marked open; strongest first", "%s", r.c_str());
  c.s.setPlace("home");
  std::string url = c.s.options().server_url;
  ask(c, "prov server " + url);
  ask(c, "prov token " + c.s.options().token);
  r = askLong(c, "wifi test {\"ssid\":\"PV-Home\",\"psk\":\"not-the-password\"}", 30000);
  c.check(has(r, "\"ok\":false") && has(r, "\"error\":\"wifi_password\""), "wrong password is named", "%s", r.c_str());
  c.check(c.title() == "WI-FI", "screen stays calm (no sad face)", "title=%s", c.title().c_str());
  r = askLong(c, "wifi test {\"ssid\":\"Somewhere Else\",\"psk\":\"whatever-123\"}", 30000);
  c.check(has(r, "\"error\":\"wifi_not_found\""), "a network that isn't here is named", "%s", r.c_str());
  r = askLong(c, "wifi test {\"ssid\":\"PV-Home\",\"psk\":\"short\"}", 3000);
  c.check(has(r, "\"error\":\"bad_input\""), "a too-short password is refused before joining", "%s", r.c_str());
  r = askLong(c, "wifi test {nope", 3000);
  c.check(has(r, "\"error\":\"bad_input\""), "malformed input is refused", "%s", r.c_str());
  r = askLong(c, "wifi test {\"ssid\":\"PV-Home\",\"psk\":\"home-secret-1\"}", 30000);
  c.check(has(r, "\"ok\":true") && has(r, "\"ssid\":\"PV-Home\"") && !has(r, "home-secret"), "right password: joined and reached the server",
          "%s", r.c_str());
  c.check(c.title() == "ONLINE", "screen: ONLINE", "title=%s", c.title().c_str());
  c.shot("wifi test ok");
  std::string info = ask(c, "info");
  c.check(has(info, "\"networks\":[]") && has(info, "\"wifi_rev\":0"), "a test saves nothing", "%s", info.c_str());
  c.check(c.s.countLog("NET,") == 0, "no network session ran meanwhile", "net=%u", c.s.countLog("NET,"));
}

void scSetupProblems(Ctx &c) {
  c.boot();
  std::string url = c.s.options().server_url;
  c.check(has(ask(c, "prov server ftp://example.com"), "bad_url"), "rejects a non-http server");
  c.check(has(ask(c, "prov token has space"), "bad_token"), "rejects a malformed token");
  c.check(has(ask(c, "prov wifi {\"rev\":1,\"networks\":[{\"ssid\":\"x\",\"psk\":\"short\"}]}"), "wifi_bad_psk"), "rejects a bad Wi-Fi list");
  c.check(has(ask(c, "prov done"), "no_server"), "done needs a server");
  ask(c, "prov server " + url);
  ask(c, "prov token wrong-token-123");
  ask(c, "prov wifi {\"rev\":1,\"networks\":[{\"ssid\":\"PV-Home\",\"psk\":\"not-the-password\",\"prio\":0}]}");
  ask(c, "prov done");
  c.s.runUntil([&] { return c.s.countLog("HELLO,fail") > 0; }, 30000);
  std::string info = ask(c, "info");
  c.check(has(info, "\"net\":\"wifi_password\""), "wrong Wi-Fi password is reported as such", "%s", info.c_str());
  c.check(c.title() == "NOT ONLINE", "screen says NOT ONLINE", "title=%s", c.title().c_str());
  c.shot("wrong wifi password");
  ask(c, std::string("prov wifi ") + SETUP_WIFI);
  ask(c, "prov done");
  c.s.runUntil([&] { return c.s.countLog("HELLO,fail") > 1; }, 30000);
  info = ask(c, "info");
  c.check(has(info, "\"net\":\"server\"") && has(info, "\"net_http\":401"), "rejected token is reported (server 401)", "%s", info.c_str());
  uint32_t fails = c.s.countLog("HELLO,fail");
  c.s.runFor(20000);
  c.check(c.s.countLog("HELLO,fail") > fails, "check-in retried on its own");
  ask(c, "prov token " + c.s.options().token);
  ask(c, "prov done");
  c.check(c.s.runUntil([&] { return c.s.countLog("HELLO,ok") > 0; }, 30000), "fixed token: online");
  info = ask(c, "info");
  c.check(has(info, "\"net\":\"ok\""), "info: ok", "%s", info.c_str());
  // A sleeping board on battery wakes for the check-in retries (no USB here).
  ask(c, "prov token wrong-token-456");
  ask(c, "prov done");
  c.s.runUntil([&] { return c.s.countLog("HELLO,fail") > fails + 1; }, 30000);
  uint32_t f2 = c.s.countLog("HELLO,fail");
  c.waitSleep(120000);
  c.s.runFor(15 * 60000);
  c.check(c.s.countLog("HELLO,fail") >= f2 + 2, "retries keep going while asleep (backoff)", "fails %u -> %u", f2, c.s.countLog("HELLO,fail"));
  ask(c, "prov reset");
  info = ask(c, "info");
  c.check(has(info, "\"server\":\"\"") && has(info, "\"token\":false") && has(info, "\"hello\":false"), "prov reset forgets the setup", "%s", info.c_str());
}

void scSetupAbandoned(Ctx &c) {
  c.cfg.hello_give_up_ms = 20 * 60000;  // a day on the board; shortened here
  c.boot();
  std::string url = c.s.options().server_url;
  // A refused setting doesn't hold the board back.
  c.check(has(ask(c, "prov server ftp://example.com"), "bad_url"), "bad server refused");
  ask(c, "prov server " + url);
  ask(c, "prov token " + c.s.options().token);
  ask(c, std::string("prov wifi ") + SETUP_WIFI);
  c.record(2500);
  c.s.runFor(60000);
  c.check(c.s.countLog("UP,name=") == 0, "while setup is half done (no prov done), nothing is uploaded", "ups=%u", c.s.countLog("UP,name="));
  // The setup tool went away: after the console window the board carries on with what was saved.
  c.s.runFor(c.cfg.console_window_ms);
  c.check(c.s.countLog("PROV,abandoned=1") == 1, "abandoned setup noticed");
  c.s.runUntil([&] { return c.mock().tasks >= 1; }, 5 * 60000);
  c.check(c.mock().tasks >= 1, "the queued clip goes up with the saved settings", "tasks=%d", c.mock().tasks);
  // A check-in that can't succeed stops after the give-up time instead of draining the battery.
  ask(c, "prov token wrong-token-789");
  ask(c, "prov done");
  c.s.runUntil([&] { return c.s.countLog("HELLO,give_up") > 0; }, 30 * 60000);
  c.check(c.s.countLog("HELLO,give_up") == 1, "check-in gives up", "fails=%u", c.s.countLog("HELLO,fail"));
  uint32_t fails = c.s.countLog("HELLO,fail");
  c.s.runFor(60 * 60000);
  c.check(c.s.countLog("HELLO,fail") == fails, "no more check-in attempts after giving up", "fails %u -> %u", fails, c.s.countLog("HELLO,fail"));
  ask(c, "prov token " + c.s.options().token);
  ask(c, "prov done");
  c.check(c.s.runUntil([&] { return c.s.countLog("HELLO,ok") > 0; }, 60000), "fixing the token and prov done checks in again");
  std::string info = ask(c, "info");
  c.check(has(info, "\"token\":true") && has(info, "\"hello\":false"), "info after the fix", "%s", info.c_str());
}

const Scenario SCENARIOS[] = {
  { "record_upload", "hold BOOT 3 s -> REC -> SENDING -> routed result; sleeps after", scRecordUpload },
  { "too_short", "taps < 0.6 s -> TOO SHORT, nothing queued", scTooShort },
  { "pwr_off_battery", "PWR long-press on battery -> OFF, latch released; PWR boots again", scPwrOffBattery },
  { "pwr_off_usb", "PWR long-press on USB -> STILL ON; short press -> status", scPwrOffUsb },
  { "server_500_retry", "HTTP 500/503 then success -> retried with 30 s / 60 s backoff", scServer500 },
  { "http_4xx", "401 keeps the clip and retries; 413 sets it aside", scHttp4xx },
  { "malformed_json", "2xx with malformed / incomplete JSON -> stays queued", scMalformed },
  { "no_sd", "SD missing -> NO SD, no recording, still sleeps", scNoSd },
  { "dns_timeout", "DNS failure then HTTP timeout -> queued, retried, recovers", scDnsTimeout },
  { "bad_wifi", "wrong password / association timeout -> queued, recovers", scBadWifi },
  { "dropped_reply", "server stores clip but reply is lost -> retry gets duplicate, no double task", scDroppedReply },
  { "poison_clip", "corrupt + empty queued files are set aside, newer clips still upload", scPoisonClip },
  { "power_cut_recording", "battery cut mid-recording -> header repaired at boot, clip uploaded", scPowerCutRecording },
  { "boot_during_upload", "BOOT pressed during a multi-clip upload -> records after the in-flight request", scBootDuringUpload },
  { "soak_offline_30", "30 record cycles, 50% offline -> drains, no dups, no stuck state, heap flat", scSoak },
  { "leak_detector", "negative control: injected 450 B/Wi-Fi-cycle leak is detected", scLeakDetector },
  { "idle_day", "24 h idle with 15 min timer wakes + battery drain model", scIdleDay },
  { "auto_power_off", "battery: off 4 h after the last use (recording, PWR, start, USB); PWR starts it; pending checks keep it on; queued clips go next start", scAutoPowerOff },
  { "auto_off_ota", "used once a day, off in between: a release still installs during the on-time", scAutoOffOta },
  { "codec_standby", "codec closed while asleep: timer wakes leave it closed, BOOT reopens it (~30 ms), clip intact, less energy", scCodecStandby },
  { "battery_day", "day budget (model): 5 memos / idle / offline vs the codec-running, never-off firmware", scBatteryDay },
  { "answer_result", "a quick answer gets its own screen (up to 120 bytes); a saved item shows its list (SHOPPING)", scAnswer },
  { "async_result_quick", "202 + result ready within the ~6 s poll window -> shown at once, nothing pending, no Wi-Fi after", scAsyncQuick },
  { "result_transient_miss", "result 404s on the first scheduled checks, then appears -> still shown", scResultTransientMiss },
  { "async_result_late", "not ready -> SENT, id persisted, Wi-Fi off, result shown on the 30 s check wake", scAsyncLate },
  { "work_lifecycle", "work -> RESEARCHING -> DONE + summary; checks at 30 s/2/5/15 min; stops after", scWorkLifecycle },
  { "work_paused_budget", "work -> RESEARCHING -> PAUSED (daily budget)", scWorkPaused },
  { "work_stopped", "work -> RESEARCHING -> STOPPED (agent failed)", scWorkStopped },
  { "noise_and_unsure", "noise -> \"didn't catch that\" without success beep; unsure -> NOTE?", scNoiseUnsure },
  { "new_clip_bypasses_backoff", "a new clip uploads at once while backing off; timer retries still back off", scNewClipBypassesBackoff },
  { "legacy_sync_server", "old synchronous 200 server still works; async server without /v1/updates -> per-id GETs", scLegacySync },
  { "result_check_offline", "pending checks survive offline + reboot + GET 404/500; no duplicate upload", scResultCheckOffline },
  { "low_battery", "< 15 %: LOW warning, uploads continue, result checks stretched to 30 min", scLowBattery },
  { "critical_battery", "< 5 %: CHARGE ME, no automatic Wi-Fi, PWR forces one attempt, USB flushes", scCriticalBattery },
  { "no_refresh_while_sleeping", "0 panel refreshes while asleep / idle (bolt + classic), static READY", scNoRefreshSleeping },
  { "soak_async_50", "50 seeded cycles: all kinds, late results, work outcomes, PUT/GET faults, offline, reboots", scSoakAsync },
  { "ota_happy_path", "update found in an upload session -> installed in a quiet session -> UPDATED -> confirmed; old slot intact", scOtaHappy },
  { "ota_daily_check", "no other Wi-Fi: one dedicated firmware check per 24 h; a release is installed at the next one", scOtaDaily },
  { "ota_corrupt_hash", "corrupt bytes / wrong image -> SHA-256 mismatch, never committed, backoff 1 h / 2 h, then installs", scOtaCorruptHash },
  { "ota_truncated_download", "truncated / 404 / short length / dropped -> rejected, old firmware untouched, backoff, then installs", scOtaTruncated },
  { "ota_power_loss_mid_download", "battery pulled at 40 % -> boots the old firmware, no brick; installed later", scOtaPowerLossDownload },
  { "ota_power_loss_after_switch", "cut after the slot switch boots the new image; cut while unconfirmed rolls back; uptime confirm offline", scOtaPowerLossSwitch },
  { "ota_crash_on_boot_rolls_back", "new image crashes on boot -> bootloader rollback, UPDATE FAILED, 2 attempts max, no boot loop", scOtaCrashRollback },
  { "ota_low_battery_deferred", "< 30 % on battery: no check / download for 30 h; installed once on USB", scOtaLowBattery },
  { "ota_not_during_recording", "BOOT during the download -> recording at once, download aborted, finished >= 10 min later", scOtaNotDuringRecording },
  { "ota_queue_flushed_first", "queued clips are uploaded before any firmware download; failing uploads defer the update", scOtaQueueFirst },
  { "ota_no_downgrade", "older / same version, malformed / oversize offer, 500 / 404 -> nothing downloaded", scOtaNoDowngrade },
  { "ota_signature_invalid", "wrong key / unsigned offer refused before downloading; valid one from another host, no token", scOtaSignature },
  { "status_after_upload", "one status report per session: contract fields, awake+sleep deltas = elapsed, after the result screen", scStatusAfterUpload },
  { "status_old_server_404", "404 / 405 / 500 from /v1/status ignored: no retries, no backoff impact, deltas kept until a 2xx", scStatusOldServer },
  { "status_want_log", "server asks (body or X-PV-Want-Log header) -> next report has the log; survives a failed report", scStatusWantLog },
  { "status_after_crash", "panic / task_wdt -> first report has reset + the pre-crash lines (pinned through rotation); power cut clears", scStatusAfterCrash },
  { "status_error_attaches_log", "Wi-Fi / upload failure, display timeout -> next delivered report carries the log", scStatusErrorLog },
  { "status_not_when_recording", "BOOT down at the end of a session -> no report; all other sessions report once", scStatusNotWhenRecording },
  { "status_log_escaping", "quotes / backslashes / control chars / cut UTF-8 in log lines -> valid JSON <= 2 KB, newest lines kept", scStatusLogEscaping },
  { "status_battery_policy", "low: <= 1 report/h; critical: none except one crash report; USB: normal", scStatusBattery },
  { "status_bounded_time", "slow / dropped / stalled status server: <= 3 s, result screen not delayed, BOOT not blocked", scStatusBounded },
  { "keepalive_energy", "soak with one kept-alive connection per session vs a new TLS connection per request: session time, energy", scKeepaliveEnergy },
  { "keepalive_server_close", "server without keep-alive / dropped reply -> reconnects transparently; one connection per session otherwise", scKeepaliveServerClose },
  { "wifi_home_fast", "only the built-in network: driver finds it once, then straight to the last AP; survives a power cut", scWifiHomeFast },
  { "wifi_places_hotspot", "new place offline; list changed meanwhile; hotspot -> upload + new list same session -> venue network next", scWifiPlacesHotspot },
  { "wifi_wrong_password", "rejected network backed off 10/20 min while others exist; corrected list clears it", scWifiWrongPassword },
  { "setup_fresh_board", "release image: SET ME UP, prov server/token/wifi over serial, check-in, survives reboot", scSetupFreshBoard },
  { "setup_abandoned", "half-done setup resumes after the console window; refused settings don't block; check-in gives up, then recovers", scSetupAbandoned },
  { "setup_wifi_test", "wifi scan (one per name, strongest first, open flag) + wifi test (wrong password / not here / ok), saves nothing", scSetupWifiTest },
  { "setup_problems", "bad prov input refused; wrong Wi-Fi password / token reported by info; retries; prov reset", scSetupProblems },
  { "wifi_list_rejected", "malformed / too big / invalid lists keep the old one; raw UTF-8 SSID; reboot keeps the list", scWifiListRejected },
  { "soak_ota_40", "40 cycles: clips, server faults, 14 releases (corrupt/truncated/bad sig/404/crashing), cuts/resets mid-download + unconfirmed", scSoakOta },
};

std::string htmlEsc(const std::string &s) {
  std::string o;
  for (char ch : s) {
    if (ch == '<') o += "&lt;";
    else if (ch == '>') o += "&gt;";
    else if (ch == '&') o += "&amp;";
    else o += ch;
  }
  return o;
}

}  // namespace

int runScenarios(const Options &base, const std::vector<std::string> &names, const std::string &report_dir) {
  mkdir(report_dir.c_str(), 0775);
  std::string html =
      "<!doctype html><html><head><meta charset='utf-8'><title>pvsim scenarios</title><style>"
      "body{font:14px/1.45 system-ui,sans-serif;margin:24px;background:#f6f5f1;color:#1d1d1f}"
      "h2{margin:28px 0 4px}.pass{color:#1d7a3a}.fail{color:#c0392b}table{border-collapse:collapse}"
      "td{padding:2px 10px 2px 0;vertical-align:top}.shots{display:flex;gap:12px;flex-wrap:wrap;margin-top:8px}"
      "figure{margin:0}figcaption{font-size:12px;color:#666;text-align:center}"
      "img{image-rendering:pixelated;border:10px solid #2a2b2f;border-radius:8px}.note{color:#555}"
      "</style></head><body><h1>pocket voice simulator - scenarios</h1>";
  int failed = 0, run = 0;
  std::string summary;
  for (const Scenario &sc : SCENARIOS) {
    if (!names.empty() && std::find(names.begin(), names.end(), sc.name) == names.end()) continue;
    run++;
    std::string dir = report_dir + "/" + sc.name;
    system(("rm -rf '" + dir + "'").c_str());
    mkdir(dir.c_str(), 0775);
    Options o = base;
    o.run_dir = dir + "/run";
    o.echo_log = base.echo_log;
    o.drain = std::string(sc.name) == "idle_day";
    o.generic = std::string(sc.name).rfind("setup_", 0) == 0;  // the release image
    Sim s(o);
    s.setAudio("file:sim/audio/R0001.WAV") || s.setAudio("tone:440");
    s.mockRequest("POST", "/__mock/reset", "{}");
    Ctx c(s, o, dir);
    auto t0 = std::chrono::steady_clock::now();
    sc.fn(c);
    double wall = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
    uint64_t vt = s.now();
    s.stop();
    bool ok = !c.checks.empty();
    for (auto &k : c.checks) ok &= k.ok;
    if (!ok) failed++;
    char line[256];
    snprintf(line, sizeof(line), "%-4s %-22s %3zu checks  virtual %8.1f s  wall %5.1f s", ok ? "PASS" : "FAIL", sc.name, c.checks.size(),
             vt / 1000.0, wall);
    printf("%s\n", line);
    for (auto &k : c.checks)
      if (!k.ok) printf("       x %s  (%s)\n", k.name.c_str(), k.detail.c_str());
    for (auto &n : c.notes) printf("       - %s\n", n.c_str());
    summary += std::string(line) + "\n";
    html += "<h2 class='" + std::string(ok ? "pass" : "fail") + "'>" + (ok ? "PASS " : "FAIL ") + sc.name + "</h2><div>" + htmlEsc(sc.what) +
            "</div><table>";
    for (auto &k : c.checks)
      html += "<tr><td class='" + std::string(k.ok ? "pass" : "fail") + "'>" + (k.ok ? "&#10003;" : "&#10007;") + "</td><td>" +
              htmlEsc(k.name) + "</td><td class='note'>" + htmlEsc(k.detail) + "</td></tr>";
    html += "</table>";
    for (auto &n : c.notes) html += "<div class='note'>" + htmlEsc(n) + "</div>";
    char meta[160];
    snprintf(meta, sizeof(meta), "<div class='note'>virtual %.1f s, wall %.1f s, log: %s/run/sim.log</div>", vt / 1000.0, wall, sc.name);
    html += meta;
    html += "<div class='shots'>";
    for (auto &sh : c.shots)
      html += "<figure><img src='" + std::string(sc.name) + "/" + sh.second + "' width='400'><figcaption>" + htmlEsc(sh.first) +
              "</figcaption></figure>";
    html += "</div>";
  }
  html += "</body></html>";
  writeFile(report_dir + "/report.html", html);
  writeFile(report_dir + "/summary.txt", summary);
  printf("\n%d/%d scenarios passed. Report: %s/report.html\n", run - failed, run, report_dir.c_str());
  return failed ? 1 : 0;
}

}  // namespace sim
