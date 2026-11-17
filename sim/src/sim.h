// Host simulator for the pocket voice core: implements pv::Hal on macOS with a virtual clock,
// a folder SD card, WAV/tone audio, real HTTP (libcurl) with fault injection, a battery /
// energy model and heap accounting. The app runs on its own thread; time only moves when a
// controller (interactive pacer or scenario runner) raises the clock limit.
#pragma once
#include <atomic>
#include <condition_variable>
#include <deque>
#include <map>
#include <mutex>
#include <random>
#include <string>
#include <thread>
#include <vector>
#include "pv_core.h"

namespace sim {

struct Faults {
  bool sd_missing = false;      // mount fails (takes effect at next boot)
  bool sd_write_fail = false;   // opening for write fails
  bool wifi_offline = false;    // AP not found  -> NoSsid after ~2.5 s
  bool wifi_bad_pass = false;   // auth fails    -> Failed after ~4 s
  bool wifi_hang = false;       // never associates -> Timeout
  bool dns_fail = false;        // HTTP: name resolution fails
  bool http_timeout = false;    // HTTP: no reply until the timeout
  uint32_t slow_ms = 0;         // HTTP: extra virtual latency per request
  uint32_t wifi_connect_ms = 1500;   // join without BSSID (driver scans for the SSID)
  uint32_t wifi_fast_ms = 700;       // join with BSSID + channel (no scan)
  uint32_t wifi_scan_ms = 1500;      // one explicit scan
  bool no_keepalive = false;         // HAL opens a new connection per request (the old behaviour)
  uint32_t tls_handshake_ms = 720;   // extra cost of a new TLS connection (a reused one: ~80 ms per request)
  uint32_t wifi_leak_bytes = 0; // emulate a per-Wi-Fi-cycle heap leak (to test the detector)
  // firmware update
  uint32_t dl_kbps = 0;              // streamed-download throughput override (default 120 KB/s or the mock's X-Sim-Kbps)
  bool ota_cut_after_commit = false; // power cut right after the new slot is selected (before the restart)
  bool ota_flash_fail = false;       // otaBegin fails (flash error)
  uint32_t epd_timeouts = 0;         // e-paper BUSY timeouts the board reports (Hal::displayTimeouts)
};

// Simulated firmware image (what the sim "flashes"): 256-byte text header
// "PVSIMFW1 version=<v> crash_ms=<n>\n" (NUL padded), filler, then SHA-256 of everything before
// (like the digest esptool appends). crash_ms > 0: the image panics that long after boot.
std::string makeSimImage(const std::string &version, uint32_t size, uint32_t crash_ms);
bool parseSimImage(const std::string &img, std::string *version, uint32_t *crash_ms);  // false = invalid image
// ECDSA P-256 check with macOS Security.framework (pub = DER SubjectPublicKeyInfo).
bool verifyP256(const uint8_t *pub_der, size_t pub_len, const uint8_t digest[32], const uint8_t *sig, size_t sig_len);

// Average currents (mA) per activity. ESTIMATES ONLY - replace with board measurements.
// sleep_ma is calibrated to the board (2026-10-18): ~9 mA average over an offline day with the codec
// left running (90 % -> 30 % of ~400 mAh in a day). ~2.5 mA of it is hardware: EXIO5 drives the
// battery latch transistor's base through 1 kOhm. codec_ma (the part codec standby removes) is a guess.
struct EnergyModel {
  double sleep_ma = 8.6;     // light sleep: latch, SD card, chip, rails, codec running
  double codec_ma = 2.0;     // of sleep_ma: the codec running (none in standby)
  bool codec_standby = true; // the HAL closes the codec for each sleep, reopens it on demand
  uint32_t codec_resume_ms = 30;  // reopen + first live samples (board: 24 + 6 ms)
  uint32_t codec_settle_ms = 80;  // audioBegin drops this much after a reopen (ADC settling thump)
  double off_ma = 0.015;     // latch released: battery divider, charger, protection IC
  uint32_t boot_ms = 0;      // power-on -> app start (board: ~2.5 s to READY; 0 = instant)
  double awake_ma = 25;      // CPU awake, radio off
  double rec_ma = 35;        // awake + codec/mic streaming + SD writes
  double wifi_ma = 95;       // radio on (connect + upload average)
  double epd_ma = 8;         // extra during an e-paper refresh
  uint32_t epd_refresh_ms = 350;
  double beep_ma = 60;       // extra while the speaker amp plays
  double capacity_mah = 400;
};

struct Energy {
  double sleep_mas = 0, awake_mas = 0, rec_mas = 0, wifi_mas = 0, epd_mas = 0, beep_mas = 0;  // mA*s
  uint64_t sleep_ms = 0, awake_ms = 0, rec_ms = 0, wifi_ms = 0;
  uint32_t refreshes = 0, beeps = 0;
  uint32_t refreshes_asleep = 0;  // panel refreshes while the device was in light sleep (must stay 0)
  uint32_t codec_resumes = 0;
  uint64_t off_ms = 0;  // board switched off (latch released, no USB)
  double total_mah() const { return (sleep_mas + awake_mas + rec_mas + wifi_mas + epd_mas + beep_mas) / 3600.0; }
};

struct Beep {
  uint64_t t;
  uint16_t hz, ms;
};

struct Options {
  std::string run_dir = "build/sim/run";  // sdcard/ lives inside
  std::string server_url = "http://127.0.0.1:8788";
  std::string token = "sim-token";        // never logged
  std::string id_prefix = "";
  std::string root;                        // project root (for audio file lookup)
  uint32_t seed = 1;
  bool echo_log = false;
  int battery_mv = 3950;
  bool usb = false;
  bool drain = false;  // battery voltage follows the energy model
  std::string ui = "bolt";  // screen layout: bolt | classic (applies at the next boot)
  std::string fw_version = PV_FW_VERSION;  // version of the factory image on a fresh flash
  std::string wifi_ssid = "PV-Home", wifi_psk = "home-secret-1";  // the "secrets.h" network
  // The release image (no secrets.h): no server URL, token or built-in network until it is set up
  // (serial "prov" / NVS). server_url stays the mock's address for the controller side.
  bool generic = false;
};

// A simulated access point. Present when on and at the device's place ("*" = goes with you).
struct SimAp {
  std::string ssid, psk, place;
  uint8_t bssid[6] = {};
  uint8_t channel = 1;
  int rssi = -60;
  bool on = true;
};

enum class Interrupt { None, Reset, PowerCut, Quit };

class Sim : public pv::Hal {
 public:
  explicit Sim(const Options &o);
  ~Sim();
  void start(const pv::Config &cfg);  // launches the app thread (powered on)
  void stop();

  // ---------- controller side (scenario runner / web / pacer) ----------
  uint64_t now();
  bool sleeping();
  bool powered() { return powered_; }
  void runTo(uint64_t t);  // let the app run until virtual time t
  void runFor(uint64_t ms) { runTo(now() + ms); }
  template <class F> bool runUntil(F pred, uint64_t max_ms);
  void setButton(pv::Button b, bool down);
  bool button(pv::Button b) { return b == pv::Button::Boot ? boot_ : pwr_; }
  void hold(pv::Button b, uint64_t ms) { setButton(b, true); runFor(ms); setButton(b, false); }
  void reset() { interrupt(Interrupt::Reset); }  // RESET button (EN pin): "poweron", retained RAM lost
  // Panic / watchdog reset now (reason as esp_reset_reason: "panic", "task_wdt", "int_wdt", ...);
  // retained RAM (the core's log ring) survives it like RTC no-init RAM on the board.
  void crash(const std::string &reason) { interrupt(Interrupt::Reset, reason); }
  void cutPower() { interrupt(Interrupt::PowerCut); }
  void setUsb(bool on);
  // Wi-Fi world: access points and where the device is
  void setPlace(const std::string &p);
  std::string place();
  void addAp(const SimAp &ap);
  bool setApOn(const std::string &ssid, bool on);
  bool setApPsk(const std::string &ssid, const std::string &psk);
  std::vector<SimAp> aps();
  void setBatteryMv(int mv) { battery_mv_ = mv; }
  void setUi(const std::string &ui) { opt_.ui = ui; }  // takes effect at the next boot / RESET
  std::string ui() const { return opt_.ui; }
  void command(const std::string &line);  // runs App::command on the app thread
  Faults &faults() { return faults_; }
  EnergyModel &energyModel() { return model_; }
  // audio: "file:<path>" | "tone:<hz>" | "silence" | "noise"; returns false if unusable
  bool setAudio(const std::string &spec);
  std::string audioName();

  // interactive pacing
  void startPacer();
  std::atomic<double> speed{1.0};        // awake: virtual ms per wall ms
  std::atomic<double> sleep_warp{600.0}; // asleep: virtual ms per wall ms (0 = jump)

  // ---------- observation ----------
  struct Snapshot {
    pv::AppStatus st;
    uint8_t fb[pv::FB_BYTES];
    uint32_t fb_seq = 0;
    Energy energy;
    std::vector<Beep> beeps;  // recent
    uint32_t beep_seq = 0;
    bool led = false, wifi_on = false;
    uint32_t heap_free = 0, heap_min = 0, lvgl_used = 0, lvgl_frag = 0, open_files = 0;
    uint32_t boots = 0;
    int64_t tracked_bytes = 0;
    // flash / bootloader
    std::string fw;            // running firmware version ("" = not booted)
    int slot = -1, boot_slot = -1;
    std::string slot_state[2]; // undefined | new | pending | valid | aborted | invalid | empty
    std::string slot_fw[2];    // version in each slot ("" = no valid image)
    bool bricked = false;
    uint32_t rollbacks = 0;
    // status reports (POST /v1/status) as sent by the device
    uint32_t status_posts = 0;
    int status_last_code = 0;
    uint64_t status_last_t = 0;
    std::string status_last;  // body
    std::string reset_reason;  // of the running boot
    // HTTP connections (keep-alive model) and Wi-Fi
    uint32_t http_requests = 0, http_handshakes = 0, conn_leaks = 0;
    std::string wifi_ssid;     // AP joined ("" = none)
    uint32_t wifi_rev_sent = 0;
  };
  Snapshot snapshot();
  std::vector<std::pair<uint32_t, std::string>> logSince(uint32_t seq, size_t max = 500);
  uint32_t countLog(const std::string &needle);
  std::string sdPath(const std::string &p) { return sd_root_ + p; }
  std::string flashPath(const std::string &p) { return flash_root_ + p; }
  std::string slotSha(int slot);  // hex SHA-256 of a slot's contents ("" if empty)
  std::string kvValue(const std::string &key);
  uint32_t queueFiles();
  const Options &options() const { return opt_; }
  int batteryNow();
  std::string mockRequest(const char *method, const std::string &path, const std::string &body = "");

  // ---------- pv::Hal ----------
  uint64_t millis() override;
  void delayMs(uint32_t ms) override;
  pv::Wake lightSleep(uint32_t ms, bool wake_boot, bool wake_pwr) override;
  bool buttonDown(pv::Button b) override;
  void powerLatch(bool on) override;
  bool usbConnected() override { return usb_; }
  int batteryMv() override { return batteryNow(); }
  void led(bool on) override;
  uint32_t random32() override { return (uint32_t)rng_(); }
  const char *deviceId() override { return "5100c0ffee01"; }
  bool audioBegin(uint32_t *stale_ms) override;
  size_t audioRead(int16_t *mono, size_t samples) override;
  void playTones(const pv::Tone *seq, uint8_t n) override;
  bool fsMount() override;
  bool fsMounted() override { return mounted_; }
  int fsOpen(const char *path, const char *mode) override;
  int fsRead(int fd, void *buf, size_t n) override;
  int fsWrite(int fd, const void *buf, size_t n) override;
  bool fsSeek(int fd, uint32_t off) override;
  int32_t fsSize(int fd) override;
  bool fsClose(int fd, bool sync) override;
  bool fsRemove(const char *path) override;
  bool fsRename(const char *from, const char *to) override;
  bool fsMkdir(const char *path) override;
  int fsList(const char *dir, void (*cb)(const pv::FsEntry &e, void *ctx), void *ctx) override;
  pv::WifiResult wifiJoin(const char *ssid, const char *psk, const uint8_t *bssid, uint8_t channel, uint32_t timeout_ms,
                           bool (*abort)(void *), void *ctx, pv::WifiAp *joined) override;
  int wifiScan(pv::WifiAp *out, int max) override;
  bool wifiBuiltin(char *ssid, size_t ssid_cap, char *psk, size_t psk_cap) override;
  void wifiOff() override;
  void httpSessionEnd() override;
  void setWifiRev(uint32_t rev) override { wifi_rev_ = rev; }
  void setAuth(const char *token) override { token_ = token && token[0] ? token : (opt_.generic ? "" : opt_.token); }
  // Serial console on a pseudo-terminal (like the board's USB serial): log lines go out raw,
  // lines typed in become app commands. Returns the slave device path ("" on failure).
  std::string openSerialPty();
  pv::HttpResult httpPutFile(const char *url, const char *path, const char *content_type, char *body, size_t body_cap,
                             uint32_t timeout_ms) override;
  pv::HttpResult httpGet(const char *url, char *body, size_t body_cap, uint32_t timeout_ms) override;
  pv::HttpResult httpGetStream(const char *url, bool auth, bool (*sink)(void *, const uint8_t *, size_t), void *ctx, uint32_t timeout_ms,
                               int32_t *content_length) override;
  pv::HttpResult httpPostJson(const char *url, const char *json, size_t len, char *reply, size_t reply_cap, uint32_t timeout_ms) override;
  const char *resetReason() override { return reset_reason_.c_str(); }
  void *retainedRam(size_t *size) override {
    *size = retained_.size();
    return retained_.data();
  }
  uint32_t displayTimeouts() override { return faults_.epd_timeouts; }
  const char *fwVersion() override { return fw_version_.c_str(); }
  int otaRunningSlot() override { return running_slot_; }
  uint32_t otaSlotSize(int slot) override { return slot == 0 || slot == 1 ? 0x300000 : 0; }  // app3M_fat9M_16MB
  bool otaBegin(int slot, uint32_t size) override;
  bool otaWrite(const void *data, size_t n) override;
  bool otaEnd(bool commit) override;
  bool otaPendingVerify() override;
  bool otaMarkValid() override;
  bool otaVerifySignature(const uint8_t digest[32], const uint8_t *sig, size_t sig_len) override;
  void restart() override;
  bool kvGet(const char *key, char *out, size_t cap) override;
  bool kvSet(const char *key, const char *value) override;
  void displayRefresh(const uint8_t *fb, int y1, int y2) override;
  bool uiLock(int) override { return true; }
  void uiUnlock() override {}
  void startUiTask(uint32_t (*service)(void *), void *ctx) override;
  bool startWorker(uint32_t (*)(void *), void *) override { return false; }
  void log(const char *line) override;
  void logFlush() override {}
  uint32_t heapFree() override;
  uint32_t heapMinFree() override { return heap_min_; }
  void onStatus(const pv::AppStatus &st) override;

 private:
  enum class Act { Awake, Rec, Wifi, Sleep };
  void appThread();
  void advance(uint64_t ms, Act act);  // app thread: move virtual time (may park at the limit)
  void park(std::unique_lock<std::mutex> &lk);
  void checkInterrupt();
  void interrupt(Interrupt i, const std::string &reason = "");
  void wipeRetained();  // power loss: no-init RAM comes up as garbage
  void account(uint64_t ms, Act act);
  void closeAllFiles();
  void waitPowerOn();
  void serviceUi();
  pv::HttpResult http(const char *method, const char *url, const std::vector<uint8_t> *data, const char *ctype, char *body,
                      size_t cap, uint32_t timeout_ms);
  // flash / bootloader
  void initFlash();
  void bootloader();  // picks the slot like the ESP-IDF bootloader with rollback enabled
  void brickWait();
  void loadOtadata();
  void saveOtadata();
  void publishFlash();
  std::string readSlot(int slot);
  void publishLocked();

  Options opt_;
  pv::Config cfg_;
  std::string sd_root_;
  std::thread app_thread_, pacer_thread_;
  std::atomic<bool> pacer_run_{false};

  // clock (guarded by m_)
  std::mutex m_;
  std::condition_variable cv_;
  uint64_t now_ = 0, limit_ = 0;
  bool parked_ = false, sleeping_ = false, app_dead_ = false;
  uint64_t sleep_until_ = 0;
  bool asleep_ui_ = false;  // UI serviced on behalf of a sleeping device (refreshes counted as asleep)
  uint64_t input_gen_ = 0;
  Interrupt pending_int_ = Interrupt::None;
  std::string pending_reason_;
  std::atomic<bool> boot_{false}, pwr_{false}, usb_{false};
  std::deque<std::string> commands_;

  // device state (app thread)
  std::atomic<bool> powered_{true};
  bool latch_ = false, mounted_ = false, wifi_on_ = false, wifi_conn_ = false, led_ = false;
  std::atomic<int> battery_mv_{3950};
  std::mt19937 rng_;
  Faults faults_;
  EnergyModel model_;
  bool codec_standby_ = false;
  uint64_t codec_resumed_at_ = 0;
  void codecResume();
  std::map<int, FILE *> files_;
  int next_fd_ = 3;
  uint32_t (*ui_service_)(void *) = nullptr;
  void *ui_ctx_ = nullptr;
  uint64_t next_ui_service_ = 0;
  uint32_t heap_min_ = 0xffffffff;
  uint64_t leaked_ = 0;
  uint32_t boots_ = 0;
  // flash: <run_dir>/flash/{slot0.bin,slot1.bin,otadata.txt,nvs.txt}
  std::string flash_root_;
  int od_boot_ = 0;
  std::string od_state_[2];
  int running_slot_ = -1;
  std::string fw_version_;
  uint64_t crash_at_ = 0;
  bool bricked_ = false;
  uint32_t rollbacks_ = 0;
  uint32_t crash_streak_ = 0;  // panics in a row without reaching light sleep (boot loop detector)
  FILE *ota_file_ = nullptr;
  int ota_slot_ = -1;
  std::map<std::string, std::string> kv_;
  // reset reason + RTC no-init RAM model
  std::string reset_reason_ = "poweron", next_reset_ = "poweron";
  // Wi-Fi world (guarded by aps_m_) + the kept HTTP connection (app thread)
  std::mutex aps_m_;
  std::vector<SimAp> aps_;
  std::string place_ = "home";
  void *sess_curl_ = nullptr;
  uint32_t wifi_rev_ = 0;
  void closeSession(bool leak);
  std::vector<uint8_t> retained_;

  // audio
  std::mutex audio_m_;
  std::vector<int16_t> audio_;
  size_t audio_pos_ = 0;
  std::string audio_name_ = "silence";
  int tone_hz_ = 0;
  bool noise_ = false;

  // snapshot (guarded by snap_m_)
  std::mutex snap_m_;
  Snapshot snap_;
  std::deque<std::pair<uint32_t, std::string>> log_;
  uint32_t log_seq_ = 0;
  FILE *log_file_ = nullptr;
  std::string token_;  // device token of this boot (Options::token, or the provisioned one)
  int pty_master_ = -1, pty_slave_ = -1;
  std::thread pty_thread_;
};

template <class F>
bool Sim::runUntil(F pred, uint64_t max_ms) {
  uint64_t deadline = now() + max_ms;
  for (;;) {
    if (pred()) return true;
    uint64_t t = now();
    if (t >= deadline) return false;
    uint64_t next;
    {
      std::lock_guard<std::mutex> lk(m_);
      next = sleeping_ ? sleep_until_ : t + 10;
    }
    if (next > deadline) next = deadline;
    if (next <= t) next = t + 1;
    runTo(next);
  }
}

// Heap tracking (operator new/delete on the app thread).
int64_t trackedBytes();
bool trackThisThread(bool on);  // returns the previous setting

}  // namespace sim
