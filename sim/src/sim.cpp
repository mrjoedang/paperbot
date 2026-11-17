#include "sim.h"
#include <sys/select.h>
#include <termios.h>
#include <util.h>  // openpty
#include <Security/Security.h>
#include <curl/curl.h>
#include <dirent.h>
#include <math.h>
#include <sys/stat.h>
#include <unistd.h>
#include <chrono>
#include "lvgl.h"
#include "wavfile.h"
#include "../ota/test_signing_pub.h"

namespace sim {

struct SimInterrupt {
  Interrupt i;
  std::string reason;  // "" = power-on type reset (EN pin / power cut)
};

// HAL methods allocate (strings, maps); keep that out of the core's heap accounting.
struct NoTrack {
  bool prev;
  NoTrack() { prev = trackThisThread(false); }
  ~NoTrack() { trackThisThread(prev); }
};

static int pctToMv(double pct) {
  static const int V[] = { 3300, 3500, 3600, 3700, 3750, 3800, 3900, 4000, 4100, 4200 };
  static const int P[] = { 0, 5, 10, 20, 30, 45, 60, 75, 90, 100 };
  if (pct <= 0) return 3200;
  for (int i = 1; i < 10; i++)
    if (pct <= P[i]) return V[i - 1] + (int)((V[i] - V[i - 1]) * (pct - P[i - 1]) / (P[i] - P[i - 1]));
  return 4200;
}

static void mkdirs(const std::string &p) {
  std::string cur;
  for (size_t i = 0; i < p.size(); i++) {
    cur += p[i];
    if (p[i] == '/' && i) mkdir(cur.c_str(), 0775);
  }
  mkdir(p.c_str(), 0775);
}

// nvs.txt stores one key per line: "\\" and newlines in values are escaped.
static std::string nvsEscape(const std::string &v) {
  std::string o;
  for (char c : v) {
    if (c == '\\') o += "\\\\";
    else if (c == '\n') o += "\\n";
    else if (c == '\r') o += "\\r";
    else o += c;
  }
  return o;
}
static std::string nvsUnescape(const std::string &v) {
  std::string o;
  for (size_t i = 0; i < v.size(); i++) {
    if (v[i] == '\\' && i + 1 < v.size()) {
      char n = v[++i];
      o += n == 'n' ? '\n' : n == 'r' ? '\r' : n;
    } else {
      o += v[i];
    }
  }
  return o;
}

Sim::Sim(const Options &o) : opt_(o), rng_(o.seed) {
  sd_root_ = opt_.run_dir + "/sdcard";
  mkdirs(sd_root_);
  battery_mv_ = o.battery_mv;
  usb_ = o.usb;
  log_file_ = fopen((opt_.run_dir + "/sim.log").c_str(), "w");
  memset(snap_.fb, 0xff, sizeof(snap_.fb));
  flash_root_ = opt_.run_dir + "/flash";
  initFlash();
  retained_.resize(pv::LogRing::BYTES);
  wipeRetained();
  // Default Wi-Fi world: home (= the built-in network), a venue with a guest network and an
  // unknown open one, and the owner's phone hotspot (goes everywhere, off until switched on).
  auto ap = [](const std::string &ssid, const std::string &psk, const std::string &place, uint8_t id, uint8_t ch, int rssi, bool on) {
    SimAp a;
    a.ssid = ssid;
    a.psk = psk;
    a.place = place;
    uint8_t b[6] = { 0x02, 0x50, 0x56, 0x00, 0x00, id };
    memcpy(a.bssid, b, 6);
    a.channel = ch;
    a.rssi = rssi;
    a.on = on;
    return a;
  };
  aps_.push_back(ap(opt_.wifi_ssid, opt_.wifi_psk, "home", 1, 6, -58, true));
  aps_.push_back(ap("Venue Guest", "venue-pass-42", "venue", 2, 11, -62, true));
  aps_.push_back(ap("Cafe Open", "", "venue", 3, 1, -70, true));
  aps_.push_back(ap("Joe\xe2\x80\x99s iPhone 15 Pro", "hotspot-pw-7", "*", 4, 1, -45, false));
}

void Sim::setPlace(const std::string &p) {
  std::lock_guard<std::mutex> lk(aps_m_);
  place_ = p;
}
std::string Sim::place() {
  std::lock_guard<std::mutex> lk(aps_m_);
  return place_;
}
void Sim::addAp(const SimAp &a) {
  std::lock_guard<std::mutex> lk(aps_m_);
  aps_.push_back(a);
}
bool Sim::setApOn(const std::string &ssid, bool on) {
  std::lock_guard<std::mutex> lk(aps_m_);
  for (auto &a : aps_)
    if (a.ssid == ssid) {
      a.on = on;
      return true;
    }
  return false;
}
bool Sim::setApPsk(const std::string &ssid, const std::string &psk) {
  std::lock_guard<std::mutex> lk(aps_m_);
  for (auto &a : aps_)
    if (a.ssid == ssid) {
      a.psk = psk;
      return true;
    }
  return false;
}
std::vector<SimAp> Sim::aps() {
  std::lock_guard<std::mutex> lk(aps_m_);
  return aps_;
}

void Sim::wipeRetained() {
  for (auto &b : retained_) b = (uint8_t)rng_();
}

Sim::~Sim() {
  stop();
  if (log_file_) fclose(log_file_);
}

void Sim::start(const pv::Config &cfg) {
  cfg_ = cfg;
  cfg_.queue.server_url = opt_.generic ? "" : opt_.server_url.c_str();  // point into our own copy of the options
  cfg_.queue.id_prefix = opt_.id_prefix.c_str();
  app_thread_ = std::thread([this] { appThread(); });
}

void Sim::stop() {
  pacer_run_ = false;
  if (pacer_thread_.joinable()) pacer_thread_.join();
  if (app_thread_.joinable()) {
    interrupt(Interrupt::Quit);
    {
      std::lock_guard<std::mutex> lk(m_);
      limit_ = UINT64_MAX / 4;
      cv_.notify_all();
    }
    app_thread_.join();
  }
}

// ---------------- app thread ----------------
void Sim::appThread() {
  for (;;) {
    try {
      if (!powered_) waitPowerOn();
      boots_++;
      reset_reason_ = next_reset_;
      next_reset_ = "poweron";
      {
        std::lock_guard<std::mutex> lk(snap_m_);
        snap_.reset_reason = reset_reason_;
      }
      latch_ = true;  // PWR held / USB powers the board until the firmware latches
      mounted_ = false;
      wifi_on_ = wifi_conn_ = false;
      {
        std::lock_guard<std::mutex> lk(snap_m_);
        snap_.boots = boots_;
      }
      bootloader();
      if (crash_streak_ >= 20 && !bricked_) {
        bricked_ = true;  // the same image keeps crashing and the bootloader keeps starting it
        log("SIM,BRICKED: boot loop (20 crashes in a row)");
        publishFlash();
      }
      if (bricked_) brickWait();  // nothing bootable: dead until the scenario gives up
      log(("SIM,boot,fw=" + fw_version_ + ",slot=" + std::to_string(running_slot_)).c_str());
      codec_standby_ = false;  // a fresh start opens the codec
      token_ = opt_.generic ? "" : opt_.token;  // the compiled-in token; App::setup applies a provisioned one
      if (model_.boot_ms) advance(model_.boot_ms, Act::Awake);
      pv::App app(*this, cfg_);
      static pv::BoltLayout bolt;
      trackThisThread(true);
      app.setup(opt_.ui == "classic" ? nullptr : &bolt);
      for (;;) {
        std::string cmd;
        {
          std::lock_guard<std::mutex> lk(m_);
          if (!commands_.empty()) {
            cmd = commands_.front();
            commands_.pop_front();
          }
        }
        if (!cmd.empty()) app.command(cmd.c_str());
        app.loop();
      }
    } catch (SimInterrupt &e) {
      trackThisThread(false);
      closeAllFiles();
      closeSession(false);  // a reset drops the TCP/TLS connection
      if (ota_file_) fclose(ota_file_);  // a write cut short: the slot keeps whatever landed
      ota_file_ = nullptr;
      crash_at_ = 0;
      mounted_ = false;
      wifi_on_ = wifi_conn_ = false;
      led_ = false;
      ui_service_ = nullptr;
      lv_deinit();
      if (e.i == Interrupt::Quit) break;
      if (e.i == Interrupt::PowerCut || e.reason.empty()) {
        next_reset_ = "poweron";
        wipeRetained();
      } else {
        next_reset_ = e.reason;  // panic / watchdog / esp_restart: RTC no-init RAM survives
      }
      if (e.i == Interrupt::PowerCut) {
        powered_ = false;
        log("SIM,power off");
      } else {
        log("SIM,reset");
      }
    }
  }
  std::lock_guard<std::mutex> lk(m_);
  app_dead_ = true;
  cv_.notify_all();
}

void Sim::checkInterrupt() {
  if (pending_int_ == Interrupt::None) return;
  Interrupt i = pending_int_;
  pending_int_ = Interrupt::None;
  sleeping_ = false;
  throw SimInterrupt{ i, pending_reason_ };
}

void Sim::interrupt(Interrupt i, const std::string &reason) {
  std::lock_guard<std::mutex> lk(m_);
  pending_int_ = i;
  pending_reason_ = reason;
  cv_.notify_all();
}

void Sim::park(std::unique_lock<std::mutex> &lk) {
  uint64_t gen = input_gen_;
  parked_ = true;
  cv_.notify_all();
  cv_.wait(lk, [&] { return limit_ > now_ || pending_int_ != Interrupt::None || (sleeping_ && input_gen_ != gen); });
  parked_ = false;
}

void Sim::account(uint64_t ms, Act act) {
  if (!ms) return;
  std::lock_guard<std::mutex> lk(snap_m_);
  Energy &e = snap_.energy;
  double s = ms / 1000.0;
  switch (act) {
    case Act::Sleep: e.sleep_ms += ms; e.sleep_mas += s * (model_.sleep_ma - (codec_standby_ ? model_.codec_ma : 0)); break;
    case Act::Rec: e.rec_ms += ms; e.rec_mas += s * model_.rec_ma; break;
    case Act::Wifi: e.wifi_ms += ms; e.wifi_mas += s * model_.wifi_ma; break;
    case Act::Awake: e.awake_ms += ms; e.awake_mas += s * model_.awake_ma; break;
  }
}

void Sim::advance(uint64_t ms, Act act) {
  {
    std::unique_lock<std::mutex> lk(m_);
    checkInterrupt();
    uint64_t target = now_ + ms;
    while (target > limit_) {
      account(limit_ - now_, act);
      now_ = limit_;
      park(lk);
      checkInterrupt();
    }
    account(target - now_, act);
    now_ = target;
  }
  if (!latch_ && !usb_) {
    log("SIM,power cut (latch released on battery)");
    throw SimInterrupt{ Interrupt::PowerCut, "" };
  }
  if (batteryNow() < 3000 && !usb_) {
    log("SIM,brownout (battery empty)");
    throw SimInterrupt{ Interrupt::PowerCut, "" };
  }
  if (crash_at_ && now_ >= crash_at_) {
    crash_at_ = 0;
    crash_streak_++;
    log("SIM,panic: firmware crashed (image crash_ms) -> reset");
    throw SimInterrupt{ Interrupt::Reset, "panic" };
  }
  serviceUi();
}

void Sim::serviceUi() {
  if (ui_service_ && now_ >= next_ui_service_) {
    bool prev = trackThisThread(true);  // LVGL work counts as core
    uint32_t ms = ui_service_(ui_ctx_);
    trackThisThread(prev);
    next_ui_service_ = now_ + ms;
  }
}

void Sim::waitPowerOn() {
  std::unique_lock<std::mutex> lk(m_);
  sleeping_ = true;
  sleep_until_ = UINT64_MAX / 4;
  {
    std::lock_guard<std::mutex> sl(snap_m_);
    snap_.st.state = pv::State::Off;
  }
  for (;;) {
    if (pending_int_ == Interrupt::Quit) {
      checkInterrupt();
    }
    pending_int_ = Interrupt::None;  // reset / cut while off: nothing to do
    if (pwr_ || usb_) break;
    {
      std::lock_guard<std::mutex> sl(snap_m_);
      snap_.energy.off_ms += limit_ - now_;
      snap_.energy.sleep_mas += (limit_ - now_) / 1000.0 * model_.off_ma;
    }
    now_ = limit_;
    park(lk);
  }
  sleeping_ = false;
  powered_ = true;
  if (pacer_run_ && limit_ > now_) limit_ = now_;
}

// ---------------- controller side ----------------
uint64_t Sim::now() {
  std::lock_guard<std::mutex> lk(m_);
  return now_;
}

bool Sim::sleeping() {
  std::lock_guard<std::mutex> lk(m_);
  return sleeping_;
}

void Sim::runTo(uint64_t t) {
  std::unique_lock<std::mutex> lk(m_);
  if (t > limit_) limit_ = t;
  cv_.notify_all();
  cv_.wait(lk, [&] { return (parked_ && now_ >= limit_) || app_dead_; });
}

void Sim::setButton(pv::Button b, bool down) {
  std::lock_guard<std::mutex> lk(m_);
  (b == pv::Button::Boot ? boot_ : pwr_) = down;
  input_gen_++;
  cv_.notify_all();
}

void Sim::setUsb(bool on) {
  std::lock_guard<std::mutex> lk(m_);
  usb_ = on;
  input_gen_++;
  cv_.notify_all();
}

void Sim::command(const std::string &line) {
  std::lock_guard<std::mutex> lk(m_);
  commands_.push_back(line);
  input_gen_++;
  cv_.notify_all();
}

void Sim::startPacer() {
  pacer_run_ = true;
  pacer_thread_ = std::thread([this] {
    auto last = std::chrono::steady_clock::now();
    while (pacer_run_) {
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
      auto t = std::chrono::steady_clock::now();
      double wall = std::chrono::duration<double, std::milli>(t - last).count();
      last = t;
      std::lock_guard<std::mutex> lk(m_);
      if (!parked_) continue;  // app busy (e.g. real HTTP): virtual time waits for it
      double f = sleeping_ ? sleep_warp.load() : speed.load();
      if (sleeping_ && f <= 0 && sleep_until_ < UINT64_MAX / 8) limit_ = sleep_until_;
      else limit_ = now_ + (uint64_t)fmax(1.0, wall * (f <= 0 ? 1 : f));
      cv_.notify_all();
    }
  });
}

int Sim::batteryNow() {
  if (!opt_.drain) return battery_mv_;
  double used;
  {
    std::lock_guard<std::mutex> lk(snap_m_);
    used = snap_.energy.total_mah();
  }
  double start_pct = pv::batteryPercent(battery_mv_);
  return pctToMv(start_pct - 100.0 * used / model_.capacity_mah);
}

Sim::Snapshot Sim::snapshot() {
  std::lock_guard<std::mutex> lk(snap_m_);
  Snapshot s = snap_;
  return s;
}

std::vector<std::pair<uint32_t, std::string>> Sim::logSince(uint32_t seq, size_t max) {
  std::lock_guard<std::mutex> lk(snap_m_);
  std::vector<std::pair<uint32_t, std::string>> out;
  for (auto &l : log_)
    if (l.first > seq) {
      out.push_back(l);
      if (out.size() >= max) break;
    }
  return out;
}

uint32_t Sim::countLog(const std::string &needle) {
  std::lock_guard<std::mutex> lk(snap_m_);
  uint32_t n = 0;
  for (auto &l : log_)
    if (l.second.find(needle) != std::string::npos) n++;
  return n;
}

uint32_t Sim::queueFiles() {
  DIR *d = opendir((sd_root_ + cfg_.queue.rec_dir).c_str());
  if (!d) return 0;
  uint32_t n = 0;
  while (struct dirent *e = readdir(d))
    if (pv::isClipName(e->d_name)) n++;
  closedir(d);
  return n;
}

// ---------------- audio ----------------
bool Sim::setAudio(const std::string &spec) {
  std::lock_guard<std::mutex> lk(audio_m_);
  tone_hz_ = 0;
  noise_ = false;
  if (spec.rfind("file:", 0) == 0) {
    std::string path = spec.substr(5);
    std::vector<int16_t> pcm;
    if (!loadWavMono16k(path, pcm) && !(opt_.root.size() && loadWavMono16k(opt_.root + "/" + path, pcm))) return false;
    audio_ = std::move(pcm);
    audio_name_ = path.substr(path.find_last_of('/') + 1);
  } else if (spec.rfind("tone:", 0) == 0) {
    tone_hz_ = atoi(spec.c_str() + 5);
    if (tone_hz_ <= 0) tone_hz_ = 440;
    audio_name_ = "tone " + std::to_string(tone_hz_) + " Hz";
  } else if (spec == "noise") {
    noise_ = true;
    audio_name_ = "noise";
  } else {
    audio_.clear();
    audio_name_ = "silence";
  }
  audio_pos_ = 0;
  return true;
}

std::string Sim::audioName() {
  std::lock_guard<std::mutex> lk(audio_m_);
  return audio_name_;
}

// Like Esp32Hal: the codec is closed for each sleep and reopened on first use.
void Sim::codecResume() {
  if (!codec_standby_) return;
  codec_standby_ = false;
  {
    std::lock_guard<std::mutex> lk(snap_m_);
    snap_.energy.codec_resumes++;
  }
  advance(model_.codec_resume_ms, Act::Awake);
  codec_resumed_at_ = now();
}

bool Sim::audioBegin(uint32_t *stale_ms) {
  NoTrack nt;
  codecResume();
  uint64_t t = now();
  if (codec_resumed_at_ && t < codec_resumed_at_ + model_.codec_settle_ms) advance(codec_resumed_at_ + model_.codec_settle_ms - t, Act::Rec);
  std::lock_guard<std::mutex> lk(audio_m_);
  audio_pos_ = 0;  // each clip "hears" the source from its start
  if (stale_ms) *stale_ms = 0;
  return true;
}

size_t Sim::audioRead(int16_t *mono, size_t n) {
  {
    NoTrack nt;
    std::lock_guard<std::mutex> lk(audio_m_);
    for (size_t i = 0; i < n; i++, audio_pos_++) {
      if (tone_hz_) mono[i] = (int16_t)(8000 * sin(2 * M_PI * tone_hz_ * audio_pos_ / 16000.0));
      else if (noise_) mono[i] = (int16_t)((int)(rng_() % 6001) - 3000);
      else mono[i] = audio_pos_ < audio_.size() ? audio_[audio_pos_] : 0;
    }
  }
  NoTrack nt;
  advance(n / 16, Act::Rec);
  return n;
}

void Sim::playTones(const pv::Tone *seq, uint8_t n) {
  NoTrack nt;
  codecResume();
  std::lock_guard<std::mutex> lk(snap_m_);
  uint64_t t = now_;
  for (uint8_t i = 0; i < n; i++) {
    if (seq[i].hz) {
      snap_.beeps.push_back({ t, seq[i].hz, seq[i].ms });
      snap_.energy.beeps++;
      snap_.energy.beep_mas += seq[i].ms / 1000.0 * model_.beep_ma;
    }
    t += seq[i].ms;
  }
  if (snap_.beeps.size() > 32) snap_.beeps.erase(snap_.beeps.begin(), snap_.beeps.end() - 32);
  snap_.beep_seq++;
}

// ---------------- time / power / io ----------------
uint64_t Sim::millis() { return now_; }  // only the app thread writes now_

void Sim::delayMs(uint32_t ms) {
  NoTrack nt;
  advance(ms ? ms : 1, wifi_on_ ? Act::Wifi : Act::Awake);
}

pv::Wake Sim::lightSleep(uint32_t ms, bool wake_boot, bool wake_pwr) {
  NoTrack nt;
  // Model the LVGL task around the sleep: anything still pending (an invalidation, a running
  // animation timer) would hit the panel while the device sleeps / at the instant it wakes.
  // Those refreshes are counted in refreshes_asleep, which must stay 0.
  auto sleepUi = [&] {
    asleep_ui_ = true;
    next_ui_service_ = 0;
    serviceUi();
    asleep_ui_ = false;
  };
  sleepUi();
  if (model_.codec_standby) codec_standby_ = true;
  crash_streak_ = 0;  // the firmware got as far as sleeping: not a boot loop
  std::unique_lock<std::mutex> lk(m_);
  checkInterrupt();
  sleeping_ = true;
  sleep_until_ = now_ + ms;
  pv::Wake w;
  for (;;) {
    if (wake_boot && boot_) { w = pv::Wake::Boot; break; }
    if (wake_pwr && pwr_) { w = pv::Wake::Pwr; break; }
    if (!commands_.empty()) { w = pv::Wake::Other; break; }  // console input (USB) wakes the sim
    if (sleep_until_ <= limit_) {
      account(sleep_until_ - now_, Act::Sleep);
      now_ = sleep_until_;
      w = pv::Wake::Timer;
      break;
    }
    account(limit_ - now_, Act::Sleep);
    now_ = limit_;
    park(lk);
    checkInterrupt();
  }
  // Interactive pacing grants sleep time in big warp steps; do not let the unused part of a
  // step become instant awake time (a short PWR tap would turn into a 2 s long-press).
  if (pacer_run_ && limit_ > now_) limit_ = now_;
  lk.unlock();
  sleepUi();  // still flagged asleep: the LVGL task runs first after the wake
  lk.lock();
  sleeping_ = false;
  return w;
}

bool Sim::buttonDown(pv::Button b) { return b == pv::Button::Boot ? boot_.load() : pwr_.load(); }

void Sim::powerLatch(bool on) {
  NoTrack nt;
  latch_ = on;
  if (!on && !usb_) {
    log("SIM,power cut (latch released on battery)");
    throw SimInterrupt{ Interrupt::PowerCut, "" };
  }
}

void Sim::led(bool on) {
  led_ = on;
  std::lock_guard<std::mutex> lk(snap_m_);
  snap_.led = on;
}

void Sim::displayRefresh(const uint8_t *fb, int, int) {
  NoTrack nt;
  std::lock_guard<std::mutex> lk(snap_m_);
  memcpy(snap_.fb, fb, pv::FB_BYTES);
  snap_.fb_seq++;
  snap_.energy.refreshes++;
  if (asleep_ui_) snap_.energy.refreshes_asleep++;
  snap_.energy.epd_mas += model_.epd_refresh_ms / 1000.0 * model_.epd_ma;
}

void Sim::startUiTask(uint32_t (*service)(void *), void *ctx) {
  ui_service_ = service;
  ui_ctx_ = ctx;
  next_ui_service_ = now_;
}

void Sim::log(const char *line) {
  NoTrack nt;
  std::lock_guard<std::mutex> lk(snap_m_);
  char t[32];
  snprintf(t, sizeof(t), "[%9.3f] ", now_ / 1000.0);
  std::string s = std::string(t) + line;
  log_.emplace_back(++log_seq_, s);
  if (log_.size() > 50000) log_.pop_front();
  if (log_file_) {
    fputs(s.c_str(), log_file_);
    fputc(10, log_file_);
    fflush(log_file_);
  }
  if (opt_.echo_log) printf("%s\n", s.c_str());
  if (pty_master_ >= 0) {  // raw line, as the board's serial console prints it (no sim timestamp)
    std::string l = std::string(line) + "\r\n";
    (void)!write(pty_master_, l.data(), l.size());
  }
}

std::string Sim::openSerialPty() {
  int m = -1, sl = -1;
  char name[256];
  if (openpty(&m, &sl, name, nullptr, nullptr) != 0) return "";
  struct termios t;
  if (tcgetattr(sl, &t) == 0) {
    cfmakeraw(&t);  // no echo, no line editing: a serial port
    tcsetattr(sl, TCSANOW, &t);
  }
  fcntl(m, F_SETFL, fcntl(m, F_GETFL) | O_NONBLOCK);  // nobody reading: drop console output
  pty_slave_ = sl;  // kept open so the pty survives a client closing it
  pty_master_ = m;
  pty_thread_ = std::thread([this] {
    std::string cur;
    char buf[512];
    for (;;) {
      fd_set fds;
      FD_ZERO(&fds);
      FD_SET(pty_master_, &fds);
      struct timeval tv = { 0, 200000 };
      if (select(pty_master_ + 1, &fds, nullptr, nullptr, &tv) <= 0) continue;
      ssize_t n = read(pty_master_, buf, sizeof(buf));
      if (n <= 0) continue;
      for (ssize_t i = 0; i < n; i++) {
        if (buf[i] == '\n' || buf[i] == '\r') {
          if (!cur.empty()) command(cur);
          cur.clear();
        } else if (cur.size() < 4096) {
          cur += buf[i];
        }
      }
    }
  });
  pty_thread_.detach();
  return name;
}

uint32_t Sim::heapFree() {
  NoTrack nt;
  // Modelled ESP32-C6 free heap: a fixed budget minus what core/LVGL-task code allocated with
  // new (tracked), open files and the Wi-Fi stack while up, plus any injected Wi-Fi leak.
  int64_t h = 210000 - trackedBytes() - (int64_t)files_.size() * 600 - (wifi_on_ ? 60000 : 0) - (int64_t)leaked_;
  if (h < 0) h = 0;
  if ((uint32_t)h < heap_min_) heap_min_ = (uint32_t)h;
  return (uint32_t)h;
}

void Sim::onStatus(const pv::AppStatus &st) {
  NoTrack nt;
  lv_mem_monitor_t mon;
  lv_mem_monitor(&mon);
  uint32_t hf = heapFree();
  std::lock_guard<std::mutex> lk(snap_m_);
  snap_.st = st;
  snap_.lvgl_used = (uint32_t)(mon.total_size - mon.free_size);
  snap_.lvgl_frag = mon.frag_pct;
  snap_.heap_free = hf;
  snap_.heap_min = heap_min_;
  snap_.open_files = (uint32_t)files_.size();
  snap_.wifi_on = wifi_on_;
  snap_.tracked_bytes = trackedBytes();
}

// ---------------- file system ----------------
bool Sim::fsMount() {
  NoTrack nt;
  advance(120, Act::Awake);
  if (faults_.sd_missing) {
    log("SIM,sd mount failed (fault: sd_missing)");
    mounted_ = false;
    return false;
  }
  mkdirs(sd_root_);
  mounted_ = true;
  return true;
}

int Sim::fsOpen(const char *path, const char *mode) {
  NoTrack nt;
  if (!mounted_) return -1;
  bool writing = strpbrk(mode, "wa+") != nullptr;
  if (writing && faults_.sd_write_fail) return -1;
  FILE *f = fopen((sd_root_ + path).c_str(), mode);
  if (!f) return -1;
  int fd = next_fd_++;
  files_[fd] = f;
  return fd;
}

int Sim::fsRead(int fd, void *buf, size_t n) {
  NoTrack nt;
  auto it = files_.find(fd);
  return it == files_.end() ? -1 : (int)fread(buf, 1, n, it->second);
}

int Sim::fsWrite(int fd, const void *buf, size_t n) {
  NoTrack nt;
  auto it = files_.find(fd);
  if (it == files_.end()) return -1;
  if (faults_.sd_write_fail) return 0;
  return (int)fwrite(buf, 1, n, it->second);
}

bool Sim::fsSeek(int fd, uint32_t off) {
  NoTrack nt;
  auto it = files_.find(fd);
  return it != files_.end() && fseek(it->second, off, SEEK_SET) == 0;
}

int32_t Sim::fsSize(int fd) {
  NoTrack nt;
  auto it = files_.find(fd);
  if (it == files_.end()) return -1;
  fflush(it->second);
  struct stat st;
  return fstat(fileno(it->second), &st) == 0 ? (int32_t)st.st_size : -1;
}

bool Sim::fsClose(int fd, bool sync) {
  NoTrack nt;
  auto it = files_.find(fd);
  if (it == files_.end()) return false;
  bool ok = fflush(it->second) == 0;
  if (sync) fsync(fileno(it->second));
  ok &= fclose(it->second) == 0;
  files_.erase(it);
  return ok;
}

void Sim::closeAllFiles() {
  for (auto &f : files_) fclose(f.second);
  files_.clear();
}

bool Sim::fsRemove(const char *path) {
  NoTrack nt;
  return mounted_ && unlink((sd_root_ + path).c_str()) == 0;
}

bool Sim::fsRename(const char *from, const char *to) {
  NoTrack nt;
  return mounted_ && rename((sd_root_ + from).c_str(), (sd_root_ + to).c_str()) == 0;
}

bool Sim::fsMkdir(const char *path) {
  NoTrack nt;
  return mounted_ && (mkdir((sd_root_ + path).c_str(), 0775) == 0 || errno == EEXIST);
}

int Sim::fsList(const char *dir, void (*cb)(const pv::FsEntry &e, void *ctx), void *ctx) {
  NoTrack nt;
  if (!mounted_) return -1;
  std::string base = sd_root_ + dir;
  DIR *d = opendir(base.c_str());
  if (!d) return -1;
  int n = 0;
  while (struct dirent *e = readdir(d)) {
    struct stat st;
    if (stat((base + "/" + e->d_name).c_str(), &st) || !S_ISREG(st.st_mode)) continue;
    pv::FsEntry fe;
    snprintf(fe.name, sizeof(fe.name), "%s", e->d_name);
    fe.size = (uint32_t)st.st_size;
    cb(fe, ctx);
    n++;
  }
  closedir(d);
  return n;
}

// ---------------- network ----------------
// Wi-Fi: a join costs wifi_fast_ms with BSSID + channel (no scan), wifi_connect_ms without
// (the driver scans); missing AP -> NoSsid, wrong password -> Failed, fault wifi_hang -> Timeout.
// wifi_offline / wifi_bad_pass apply to every AP.
pv::WifiResult Sim::wifiJoin(const char *ssid, const char *psk, const uint8_t *bssid, uint8_t channel, uint32_t timeout_ms,
                             bool (*abort)(void *), void *ctx, pv::WifiAp *joined) {
  NoTrack nt;
  wifi_on_ = true;
  wifi_conn_ = false;
  SimAp ap;
  bool found = false;
  {
    std::lock_guard<std::mutex> lk(aps_m_);
    for (auto &a : aps_)
      if (a.on && (a.place == "*" || a.place == place_) && a.ssid == ssid && (!bssid || !memcmp(a.bssid, bssid, 6)) &&
          (!found || a.rssi > ap.rssi)) {
        ap = a;
        found = true;
      }
  }
  if (faults_.wifi_offline) found = false;
  uint32_t need;
  pv::WifiResult result;
  bool fast = bssid && channel;
  if (!found) { need = fast ? 1000 : 2500; result = pv::WifiResult::NoSsid; }
  else if (faults_.wifi_bad_pass || ap.psk != psk) { need = fast ? 2500 : 4000; result = pv::WifiResult::Failed; }
  else if (faults_.wifi_hang) { need = timeout_ms; result = pv::WifiResult::Timeout; }
  else { need = fast ? faults_.wifi_fast_ms : faults_.wifi_connect_ms; result = pv::WifiResult::Ok; }
  if (need > timeout_ms) { need = timeout_ms; result = pv::WifiResult::Timeout; }
  for (uint32_t t = 0; t < need; t += 10) {
    if (abort && abort(ctx)) return pv::WifiResult::Aborted;
    advance(10, Act::Wifi);
  }
  wifi_conn_ = result == pv::WifiResult::Ok;
  if (wifi_conn_ && joined) {
    snprintf(joined->ssid, sizeof(joined->ssid), "%s", ap.ssid.c_str());
    memcpy(joined->bssid, ap.bssid, 6);
    joined->channel = ap.channel;
    joined->rssi = (int8_t)ap.rssi;
  }
  std::lock_guard<std::mutex> lk(snap_m_);
  snap_.wifi_ssid = wifi_conn_ ? ap.ssid : "";
  return result;
}

int Sim::wifiScan(pv::WifiAp *out, int max) {
  NoTrack nt;
  wifi_on_ = true;
  wifi_conn_ = false;
  advance(faults_.wifi_scan_ms, Act::Wifi);
  if (faults_.wifi_offline) return 0;
  std::lock_guard<std::mutex> lk(aps_m_);
  int n = 0;
  for (auto &a : aps_) {
    if (n >= max || !a.on || !(a.place == "*" || a.place == place_)) continue;
    snprintf(out[n].ssid, sizeof(out[n].ssid), "%s", a.ssid.c_str());
    memcpy(out[n].bssid, a.bssid, 6);
    out[n].channel = a.channel;
    out[n].rssi = (int8_t)a.rssi;
    out[n].open = a.psk.empty();
    n++;
  }
  return n;
}

bool Sim::wifiBuiltin(char *ssid, size_t ssid_cap, char *psk, size_t psk_cap) {
  if (opt_.generic) return false;
  snprintf(ssid, ssid_cap, "%s", opt_.wifi_ssid.c_str());
  snprintf(psk, psk_cap, "%s", opt_.wifi_psk.c_str());
  return !opt_.wifi_ssid.empty();
}

void Sim::closeSession(bool leak) {
  if (!sess_curl_) return;
  if (leak) {
    log("SIM,WARNING: HTTP connection still open when Wi-Fi went off (httpSessionEnd missing)");
    std::lock_guard<std::mutex> lk(snap_m_);
    snap_.conn_leaks++;
  }
  curl_easy_cleanup((CURL *)sess_curl_);
  sess_curl_ = nullptr;
}

void Sim::httpSessionEnd() {
  NoTrack nt;
  closeSession(false);
}

void Sim::wifiOff() {
  NoTrack nt;
  closeSession(true);
  if (wifi_on_) leaked_ += faults_.wifi_leak_bytes;
  wifi_on_ = wifi_conn_ = false;
  {
    std::lock_guard<std::mutex> lk(snap_m_);
    snap_.wifi_ssid = "";
  }
  advance(20, Act::Awake);
}

namespace {
struct Collect {
  std::string body;
  long latency = 0, kbps = 0;
  std::string fw_latest;
  bool want_log = false;
  uint32_t wifi_rev = 0;
};
size_t writeCb(char *p, size_t s, size_t n, void *ud) {
  ((Collect *)ud)->body.append(p, s * n);
  return s * n;
}
size_t headerCb(char *p, size_t s, size_t n, void *ud) {
  std::string h(p, s * n);
  Collect *c = (Collect *)ud;
  if (strncasecmp(h.c_str(), "X-Sim-Latency-Ms:", 17) == 0) c->latency = atol(h.c_str() + 17);
  if (strncasecmp(h.c_str(), "X-Sim-Kbps:", 11) == 0) c->kbps = atol(h.c_str() + 11);
  if (strncasecmp(h.c_str(), "X-PV-Want-Log:", 14) == 0) c->want_log = atoi(h.c_str() + 14) == 1;
  if (strncasecmp(h.c_str(), "X-PV-Wifi-Rev:", 14) == 0) c->wifi_rev = (uint32_t)strtoul(h.c_str() + 14, nullptr, 10);
  if (strncasecmp(h.c_str(), "X-PV-FW-Latest:", 15) == 0) {
    std::string v = h.substr(15);
    while (!v.empty() && (v[0] == ' ' || v[0] == '\t')) v.erase(0, 1);
    while (!v.empty() && (v.back() == '\r' || v.back() == '\n' || v.back() == ' ')) v.pop_back();
    c->fw_latest = v;
  }
  return s * n;
}
}  // namespace

pv::HttpResult Sim::http(const char *method, const char *url, const std::vector<uint8_t> *data, const char *ctype, char *body,
                         size_t cap, uint32_t timeout_ms) {
  pv::HttpResult r;
  if (cap) body[0] = 0;
  if (!wifi_conn_) {
    advance(10, Act::Wifi);
    r.status = pv::HTTP_ERR_CONNECT;
    return r;
  }
  if (faults_.dns_fail) {
    advance(300, Act::Wifi);
    r.status = pv::HTTP_ERR_DNS;
    return r;
  }
  if (faults_.http_timeout) {
    advance(timeout_ms, Act::Wifi);
    r.status = pv::HTTP_ERR_TIMEOUT;
    return r;
  }
  // Keep-alive like the board: one connection per session (closed by httpSessionEnd / wifiOff);
  // curl reconnects by itself when the server closed it. CURLINFO_NUM_CONNECTS tells whether
  // this request paid a new (TLS) connection.
  bool keep = !faults_.no_keepalive;
  CURL *c = keep && sess_curl_ ? (CURL *)sess_curl_ : curl_easy_init();
  if (keep) {
    if (sess_curl_) curl_easy_reset(c);
    sess_curl_ = c;
  }
  Collect col;
  struct curl_slist *hdr = nullptr;
  std::string wrev = "X-PV-Wifi-Rev: " + std::to_string(wifi_rev_);
  hdr = curl_slist_append(hdr, wrev.c_str());
  std::string auth = "Authorization: Bearer " + token_;
  hdr = curl_slist_append(hdr, auth.c_str());
  // Virtual clock for the mock (processing / research delays run in simulated time). Real
  // servers ignore it; the board never sends it.
  std::string vt = "X-Sim-Now-Ms: " + std::to_string(now_);
  hdr = curl_slist_append(hdr, vt.c_str());
  std::string fw = "X-PV-FW: " + fw_version_;
  hdr = curl_slist_append(hdr, fw.c_str());
  std::string batt = "X-PV-Batt: " + std::to_string(batteryNow()), usb = std::string("X-PV-USB: ") + (usb_ ? "1" : "0");
  hdr = curl_slist_append(hdr, batt.c_str());
  hdr = curl_slist_append(hdr, usb.c_str());
  hdr = curl_slist_append(hdr, "Expect:");
  if (ctype) hdr = curl_slist_append(hdr, (std::string("Content-Type: ") + ctype).c_str());
  curl_easy_setopt(c, CURLOPT_URL, url);
  curl_easy_setopt(c, CURLOPT_HTTPHEADER, hdr);
  curl_easy_setopt(c, CURLOPT_CUSTOMREQUEST, method);
  if (data) {
    curl_easy_setopt(c, CURLOPT_POSTFIELDS, data->data());
    curl_easy_setopt(c, CURLOPT_POSTFIELDSIZE, (long)data->size());
  }
  curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, writeCb);
  curl_easy_setopt(c, CURLOPT_WRITEDATA, &col);
  curl_easy_setopt(c, CURLOPT_HEADERFUNCTION, headerCb);
  curl_easy_setopt(c, CURLOPT_HEADERDATA, &col);
  curl_easy_setopt(c, CURLOPT_TIMEOUT_MS, (long)(timeout_ms < 90000 ? timeout_ms : 90000));
  curl_easy_setopt(c, CURLOPT_CONNECTTIMEOUT_MS, 5000L);
  curl_easy_setopt(c, CURLOPT_NOSIGNAL, 1L);
  auto t0 = std::chrono::steady_clock::now();
  CURLcode rc = curl_easy_perform(c);
  uint64_t wall = (uint64_t)std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
  long status = 0, nconn = 0;
  curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &status);
  curl_easy_getinfo(c, CURLINFO_NUM_CONNECTS, &nconn);
  curl_slist_free_all(hdr);
  if (!keep) curl_easy_cleanup(c);
  else if (rc != CURLE_OK) {  // a failed transfer: the board drops that connection too
    curl_easy_cleanup(c);
    sess_curl_ = nullptr;
  }
  {
    std::lock_guard<std::mutex> lk(snap_m_);
    snap_.http_requests++;
    if (nconn > 0) snap_.http_handshakes++;
    snap_.wifi_rev_sent = wifi_rev_;
  }
  // Virtual cost: wall time + reported server latency + injected slowness + radio throughput +
  // ~80 ms per request + a TLS handshake when the request needed a new connection.
  uint64_t cost = wall + col.latency + faults_.slow_ms + (data ? data->size() * 1000 / (60 * 1024) : 0) + 80 +
                  (nconn > 0 ? faults_.tls_handshake_ms : 0);
  if (rc == CURLE_OPERATION_TIMEDOUT || cost > timeout_ms) {
    advance(timeout_ms, Act::Wifi);
    r.status = pv::HTTP_ERR_TIMEOUT;
    return r;
  }
  advance(cost, Act::Wifi);
  if (rc == CURLE_COULDNT_RESOLVE_HOST) r.status = pv::HTTP_ERR_DNS;
  else if (rc == CURLE_COULDNT_CONNECT) r.status = pv::HTTP_ERR_CONNECT;
  else if (rc != CURLE_OK) r.status = pv::HTTP_ERR_IO;
  else r.status = (int)status;
  size_t n = col.body.size() < cap - 1 ? col.body.size() : cap - 1;
  memcpy(body, col.body.data(), n);
  body[n] = 0;
  r.body_len = (int)n;
  snprintf(r.fw_latest, sizeof(r.fw_latest), "%s", col.fw_latest.c_str());
  r.want_log = col.want_log;
  r.wifi_rev = col.wifi_rev;
  return r;
}

pv::HttpResult Sim::httpPostJson(const char *url, const char *json, size_t len, char *reply, size_t reply_cap, uint32_t timeout_ms) {
  NoTrack nt;
  std::vector<uint8_t> data(json, json + len);
  uint64_t t = now_;
  pv::HttpResult r = http("POST", url, &data, "application/json", reply, reply_cap, timeout_ms);
  std::lock_guard<std::mutex> lk(snap_m_);
  snap_.status_posts++;
  snap_.status_last.assign(json, len);
  snap_.status_last_code = r.status;
  snap_.status_last_t = t;
  return r;
}

pv::HttpResult Sim::httpPutFile(const char *url, const char *path, const char *content_type, char *body, size_t body_cap,
                                uint32_t timeout_ms) {
  NoTrack nt;
  std::vector<uint8_t> data;
  FILE *f = mounted_ ? fopen((sd_root_ + path).c_str(), "rb") : nullptr;
  if (!f) {
    pv::HttpResult r;
    r.status = pv::HTTP_ERR_NO_FILE;
    return r;
  }
  uint8_t buf[8192];
  size_t n;
  while ((n = fread(buf, 1, sizeof(buf), f)) > 0) data.insert(data.end(), buf, buf + n);
  fclose(f);
  return http("PUT", url, &data, content_type, body, body_cap, timeout_ms);
}

pv::HttpResult Sim::httpGet(const char *url, char *body, size_t body_cap, uint32_t timeout_ms) {
  NoTrack nt;
  return http("GET", url, nullptr, nullptr, body, body_cap, timeout_ms);
}

std::string Sim::mockRequest(const char *method, const std::string &path, const std::string &body) {
  NoTrack nt;
  CURL *c = curl_easy_init();
  Collect col;
  struct curl_slist *hdr = curl_slist_append(nullptr, "Content-Type: application/json");
  std::string url = opt_.server_url + path;
  curl_easy_setopt(c, CURLOPT_URL, url.c_str());
  curl_easy_setopt(c, CURLOPT_CUSTOMREQUEST, method);
  curl_easy_setopt(c, CURLOPT_HTTPHEADER, hdr);
  if (strcmp(method, "GET")) {
    curl_easy_setopt(c, CURLOPT_POSTFIELDS, body.c_str());
    curl_easy_setopt(c, CURLOPT_POSTFIELDSIZE, (long)body.size());
  }
  curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, writeCb);
  curl_easy_setopt(c, CURLOPT_WRITEDATA, &col);
  curl_easy_setopt(c, CURLOPT_TIMEOUT_MS, 5000L);
  curl_easy_setopt(c, CURLOPT_NOSIGNAL, 1L);
  CURLcode rc = curl_easy_perform(c);
  curl_slist_free_all(hdr);
  curl_easy_cleanup(c);
  return rc == CURLE_OK ? col.body : std::string();
}

}  // namespace sim

namespace sim {

// ---------------- firmware images ----------------
std::string makeSimImage(const std::string &version, uint32_t size, uint32_t crash_ms) {
  if (size < 512) size = 512;
  std::string img(size - 32, '\0');
  char hdr[256];
  snprintf(hdr, sizeof(hdr), "PVSIMFW1 version=%s crash_ms=%u\n", version.c_str(), (unsigned)crash_ms);
  memcpy(&img[0], hdr, strlen(hdr));
  uint32_t x = 2166136261u;  // filler: deterministic per version (FNV of the version, then LCG)
  for (char ch : version) x = (x ^ (uint8_t)ch) * 16777619u;
  for (size_t i = 256; i < img.size(); i++) {
    x = x * 1664525u + 1013904223u;
    img[i] = (char)(x >> 24);
  }
  uint8_t d[32];
  pv::sha256(img.data(), img.size(), d);
  img.append((const char *)d, 32);
  return img;
}

bool parseSimImage(const std::string &img, std::string *version, uint32_t *crash_ms) {
  if (img.size() < 512 || img.compare(0, 9, "PVSIMFW1 ") != 0) return false;
  uint8_t d[32];
  pv::sha256(img.data(), img.size() - 32, d);
  if (memcmp(d, img.data() + img.size() - 32, 32) != 0) return false;
  char v[32] = "";
  unsigned c = 0;
  if (sscanf(img.c_str(), "PVSIMFW1 version=%31s crash_ms=%u", v, &c) != 2) return false;
  if (version) *version = v;
  if (crash_ms) *crash_ms = c;
  return true;
}

bool verifyP256(const uint8_t *pub_der, size_t pub_len, const uint8_t digest[32], const uint8_t *sig, size_t sig_len) {
  if (pub_len < 65 || !sig_len) return false;
  // SecKeyCreateWithData wants the raw X9.63 point (04 || X || Y): the tail of the SPKI DER.
  CFDataRef key_data = CFDataCreate(nullptr, pub_der + pub_len - 65, 65);
  int bits = 256;
  CFNumberRef nbits = CFNumberCreate(nullptr, kCFNumberIntType, &bits);
  const void *keys[] = { kSecAttrKeyType, kSecAttrKeyClass, kSecAttrKeySizeInBits };
  const void *vals[] = { kSecAttrKeyTypeECSECPrimeRandom, kSecAttrKeyClassPublic, nbits };
  CFDictionaryRef attrs = CFDictionaryCreate(nullptr, keys, vals, 3, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  SecKeyRef key = SecKeyCreateWithData(key_data, attrs, nullptr);
  bool ok = false;
  if (key) {
    CFDataRef d = CFDataCreate(nullptr, digest, 32), sg = CFDataCreate(nullptr, sig, (CFIndex)sig_len);
    ok = SecKeyVerifySignature(key, kSecKeyAlgorithmECDSASignatureDigestX962SHA256, d, sg, nullptr);
    CFRelease(d);
    CFRelease(sg);
    CFRelease(key);
  }
  CFRelease(attrs);
  CFRelease(nbits);
  CFRelease(key_data);
  return ok;
}

// ---------------- flash: two OTA slots + otadata + NVS ----------------
static bool readAll(const std::string &path, std::string *out) {
  FILE *f = fopen(path.c_str(), "rb");
  if (!f) return false;
  out->clear();
  char buf[65536];
  size_t n;
  while ((n = fread(buf, 1, sizeof(buf), f)) > 0) out->append(buf, n);
  fclose(f);
  return true;
}

static void writeAtomic(const std::string &path, const std::string &data) {
  std::string tmp = path + ".tmp";
  FILE *f = fopen(tmp.c_str(), "wb");
  if (!f) return;
  fwrite(data.data(), 1, data.size(), f);
  fflush(f);
  fsync(fileno(f));
  fclose(f);
  rename(tmp.c_str(), path.c_str());  // like the two-sector otadata / NVS: old or new, never half
}

std::string Sim::readSlot(int slot) {
  std::string img;
  readAll(flash_root_ + "/slot" + std::to_string(slot) + ".bin", &img);
  return img;
}

std::string Sim::slotSha(int slot) {
  std::string img;
  if (!readAll(flash_root_ + "/slot" + std::to_string(slot) + ".bin", &img)) return "";
  uint8_t d[32];
  char hex[65];
  pv::sha256(img.data(), img.size(), d);
  pv::hexEncode(d, 32, hex);
  return hex;
}

void Sim::loadOtadata() {
  od_boot_ = 0;
  od_state_[0] = "undefined";
  od_state_[1] = "empty";
  std::string t;
  if (!readAll(flash_root_ + "/otadata.txt", &t)) return;
  char a[16] = "", b[16] = "";
  int boot = 0;
  if (sscanf(t.c_str(), "boot=%d s0=%15s s1=%15s", &boot, a, b) == 3) {
    od_boot_ = boot == 1 ? 1 : 0;
    od_state_[0] = a;
    od_state_[1] = b;
  }
}

void Sim::saveOtadata() {
  writeAtomic(flash_root_ + "/otadata.txt", "boot=" + std::to_string(od_boot_) + " s0=" + od_state_[0] + " s1=" + od_state_[1] + "\n");
}

void Sim::initFlash() {
  mkdirs(flash_root_);
  std::string t;
  if (!readAll(flash_root_ + "/otadata.txt", &t)) {
    // Fresh board: the factory image (flashed over USB) in slot 0.
    writeAtomic(flash_root_ + "/slot0.bin", makeSimImage(opt_.fw_version, 64 * 1024, 0));
    unlink((flash_root_ + "/slot1.bin").c_str());
    od_boot_ = 0;
    od_state_[0] = "undefined";
    od_state_[1] = "empty";
    saveOtadata();
  }
  if (readAll(flash_root_ + "/nvs.txt", &t)) {
    size_t p = 0;
    while (p < t.size()) {
      size_t e = t.find('\n', p);
      if (e == std::string::npos) e = t.size();
      std::string l = t.substr(p, e - p);
      size_t eq = l.find('=');
      if (eq != std::string::npos) kv_[l.substr(0, eq)] = nvsUnescape(l.substr(eq + 1));
      p = e + 1;
    }
  }
  loadOtadata();
  publishFlash();
}

void Sim::publishFlash() {
  Snapshot &sn = snap_;
  std::lock_guard<std::mutex> lk(snap_m_);
  sn.fw = fw_version_;
  sn.slot = running_slot_;
  sn.boot_slot = od_boot_;
  sn.bricked = bricked_;
  sn.rollbacks = rollbacks_;
  for (int i = 0; i < 2; i++) {
    sn.slot_state[i] = od_state_[i];
    std::string v;
    sn.slot_fw[i] = parseSimImage(readSlot(i), &v, nullptr) ? v : "";
  }
}

// ESP-IDF bootloader with CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE: an image still "pending verify"
// at boot did not confirm itself -> ABORTED, boot the other slot; "new" -> "pending verify";
// an invalid / aborted image is skipped; nothing bootable = brick.
void Sim::bootloader() {
  loadOtadata();
  int sel = od_boot_;
  if (od_state_[sel] == "pending") {
    char l[120];
    snprintf(l, sizeof(l), "SIM,bootloader: slot %d still pending verify -> aborted, rollback to slot %d", sel, 1 - sel);
    log(l);
    od_state_[sel] = "aborted";
    sel = 1 - sel;
    od_boot_ = sel;
    rollbacks_++;
  } else if (od_state_[sel] == "new") {
    od_state_[sel] = "pending";
  }
  std::string ver;
  uint32_t crash = 0;
  auto bootable = [&](int s) { return od_state_[s] != "aborted" && od_state_[s] != "invalid" && parseSimImage(readSlot(s), &ver, &crash); };
  if (!bootable(sel)) {
    char l[120];
    snprintf(l, sizeof(l), "SIM,bootloader: slot %d (%s) has no valid image", sel, od_state_[sel].c_str());
    log(l);
    if (bootable(1 - sel)) {
      sel = 1 - sel;
      od_boot_ = sel;
    } else {
      bricked_ = true;
      running_slot_ = -1;
      fw_version_ = "";
      log("SIM,BRICKED: no bootable app slot");
      saveOtadata();
      publishFlash();
      return;
    }
  }
  saveOtadata();
  bricked_ = false;
  running_slot_ = sel;
  fw_version_ = ver;
  crash_at_ = crash ? now_ + crash : 0;
  publishFlash();
}

void Sim::brickWait() {
  std::unique_lock<std::mutex> lk(m_);
  sleeping_ = true;
  sleep_until_ = UINT64_MAX / 4;
  for (;;) {
    if (pending_int_ != Interrupt::None) checkInterrupt();
    now_ = limit_;
    park(lk);
  }
}

bool Sim::otaBegin(int slot, uint32_t size) {
  NoTrack nt;
  if ((slot != 0 && slot != 1) || ota_file_) return false;
  if (faults_.ota_flash_fail) {
    log("SIM,ota begin failed (fault: ota_flash_fail)");
    return false;
  }
  if (slot == running_slot_) log("SIM,WARNING: OTA writes the RUNNING slot (its image is being destroyed)");
  ota_file_ = fopen((flash_root_ + "/slot" + std::to_string(slot) + ".bin").c_str(), "wb");  // = erase
  ota_slot_ = slot;
  advance(50, Act::Awake);
  return ota_file_ != nullptr;
}

bool Sim::otaWrite(const void *data, size_t n) {
  NoTrack nt;
  if (!ota_file_) return false;
  bool ok = fwrite(data, 1, n, ota_file_) == n;
  fflush(ota_file_);  // what was written survives a power cut (it is flash)
  return ok;
}

bool Sim::otaEnd(bool commit) {
  NoTrack nt;
  if (!ota_file_) return false;
  fclose(ota_file_);
  ota_file_ = nullptr;
  int slot = ota_slot_;
  if (!commit) {
    log(("SIM,ota abandoned (slot " + std::to_string(slot) + " holds a partial image)").c_str());
    publishFlash();
    return true;
  }
  std::string ver;
  if (!parseSimImage(readSlot(slot), &ver, nullptr)) {  // esp_ota_end: image validation
    log("SIM,ota end: image validation failed");
    publishFlash();
    return false;
  }
  od_boot_ = slot;  // esp_ota_set_boot_partition
  od_state_[slot] = "new";
  saveOtadata();
  log(("SIM,ota commit: slot " + std::to_string(slot) + " = " + ver + " (new), boot slot switched").c_str());
  publishFlash();
  if (faults_.ota_cut_after_commit) {
    faults_.ota_cut_after_commit = false;
    log("SIM,power cut right after the commit (fault)");
    throw SimInterrupt{ Interrupt::PowerCut, "" };
  }
  return true;
}

bool Sim::otaPendingVerify() { return running_slot_ >= 0 && od_state_[running_slot_] == "pending"; }

bool Sim::otaMarkValid() {
  NoTrack nt;
  if (running_slot_ < 0) return false;
  if (od_state_[running_slot_] == "pending") {
    od_state_[running_slot_] = "valid";
    saveOtadata();
    log("SIM,ota: running image marked valid (rollback cancelled)");
    publishFlash();
  }
  return true;
}

bool Sim::otaVerifySignature(const uint8_t digest[32], const uint8_t *sig, size_t sig_len) {
  NoTrack nt;
  return verifyP256(PV_OTA_PUBKEY_DER, sizeof(PV_OTA_PUBKEY_DER), digest, sig, sig_len);
}

void Sim::restart() {
  NoTrack nt;
  log("SIM,restart (esp_restart)");
  throw SimInterrupt{ Interrupt::Reset, "sw" };
}

bool Sim::kvGet(const char *key, char *out, size_t cap) {
  NoTrack nt;
  auto it = kv_.find(key);
  if (cap) out[0] = 0;
  if (it == kv_.end()) return false;
  if (it->second.size() >= cap) return false;  // like nvs_get_str: ESP_ERR_NVS_INVALID_LENGTH, nothing read
  snprintf(out, cap, "%s", it->second.c_str());
  return true;
}

bool Sim::kvSet(const char *key, const char *value) {
  NoTrack nt;
  if (value[0]) kv_[key] = value;
  else kv_.erase(key);
  std::string t;
  for (auto &e : kv_) t += e.first + "=" + nvsEscape(e.second) + "\n";  // one line per key (values may hold newlines)
  writeAtomic(flash_root_ + "/nvs.txt", t);
  return true;
}

std::string Sim::kvValue(const std::string &key) {
  auto it = kv_.find(key);
  return it == kv_.end() ? "" : it->second;
}

// Streams a GET into sink in 4 KB chunks, paced in virtual time (default 120 KB/s, or the mock's
// X-Sim-Kbps, or faults.dl_kbps). The body is fetched with curl first; what the server sent
// before dropping the connection is still delivered (then HTTP_ERR_IO).
pv::HttpResult Sim::httpGetStream(const char *url, bool auth, bool (*sink)(void *, const uint8_t *, size_t), void *ctx, uint32_t timeout_ms,
                                  int32_t *content_length) {
  NoTrack nt;
  pv::HttpResult r;
  if (content_length) *content_length = -1;
  closeSession(false);  // like the board: the download gets the (one) TLS context
  if (!wifi_conn_) {
    advance(10, Act::Wifi);
    r.status = pv::HTTP_ERR_CONNECT;
    return r;
  }
  if (faults_.dns_fail) {
    advance(300, Act::Wifi);
    r.status = pv::HTTP_ERR_DNS;
    return r;
  }
  if (faults_.http_timeout) {
    advance(timeout_ms, Act::Wifi);
    r.status = pv::HTTP_ERR_TIMEOUT;
    return r;
  }
  CURL *c = curl_easy_init();
  Collect col;
  struct curl_slist *hdr = nullptr;
  std::string a = "Authorization: Bearer " + token_, vt = "X-Sim-Now-Ms: " + std::to_string(now_), fw = "X-PV-FW: " + fw_version_;
  if (auth) hdr = curl_slist_append(hdr, a.c_str());
  hdr = curl_slist_append(hdr, vt.c_str());
  hdr = curl_slist_append(hdr, fw.c_str());
  curl_easy_setopt(c, CURLOPT_URL, url);
  curl_easy_setopt(c, CURLOPT_HTTPHEADER, hdr);
  curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, writeCb);
  curl_easy_setopt(c, CURLOPT_WRITEDATA, &col);
  curl_easy_setopt(c, CURLOPT_HEADERFUNCTION, headerCb);
  curl_easy_setopt(c, CURLOPT_HEADERDATA, &col);
  curl_easy_setopt(c, CURLOPT_TIMEOUT_MS, 60000L);
  curl_easy_setopt(c, CURLOPT_CONNECTTIMEOUT_MS, 5000L);
  curl_easy_setopt(c, CURLOPT_NOSIGNAL, 1L);
  CURLcode rc = curl_easy_perform(c);
  long status = 0;
  curl_off_t clen = -1;
  curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &status);
  curl_easy_getinfo(c, CURLINFO_CONTENT_LENGTH_DOWNLOAD_T, &clen);
  curl_slist_free_all(hdr);
  curl_easy_cleanup(c);
  uint64_t spent = col.latency + faults_.slow_ms + 300;  // TLS handshake + headers
  advance(spent, Act::Wifi);
  if (rc == CURLE_COULDNT_RESOLVE_HOST) { r.status = pv::HTTP_ERR_DNS; return r; }
  if (rc == CURLE_COULDNT_CONNECT) { r.status = pv::HTTP_ERR_CONNECT; return r; }
  if (!status) { r.status = rc == CURLE_OPERATION_TIMEDOUT ? pv::HTTP_ERR_TIMEOUT : pv::HTTP_ERR_IO; return r; }
  r.status = (int)status;
  snprintf(r.fw_latest, sizeof(r.fw_latest), "%s", col.fw_latest.c_str());
  if (status != 200) return r;
  if (content_length) *content_length = clen >= 0 && clen < INT32_MAX ? (int32_t)clen : -1;
  double kbps = faults_.dl_kbps ? faults_.dl_kbps : col.kbps ? col.kbps : 120;
  for (size_t off = 0; off < col.body.size(); off += 4096) {
    size_t n = col.body.size() - off < 4096 ? col.body.size() - off : 4096;
    uint64_t ms = (uint64_t)(n / (kbps * 1.024)) + 1;
    if (spent + ms > timeout_ms) {
      advance(timeout_ms > spent ? timeout_ms - spent : 1, Act::Wifi);
      r.status = pv::HTTP_ERR_TIMEOUT;
      return r;
    }
    spent += ms;
    advance(ms, Act::Wifi);
    if (!sink(ctx, (const uint8_t *)col.body.data() + off, n)) {
      r.status = pv::HTTP_ERR_IO;
      return r;
    }
  }
  if (rc != CURLE_OK) r.status = pv::HTTP_ERR_IO;  // connection dropped mid-body
  return r;
}

}  // namespace sim
