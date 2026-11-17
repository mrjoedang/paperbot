// The pocket voice application: hold BOOT to record, release to save, upload the queue
// (oldest first) when Wi-Fi is reachable, collect the server's result (async contract,
// docs/device-api.md), light-sleep in between. Port of tests/power_proto onto the HAL; see
// sim/README.md for the list of behaviour changes.
//
// Network policy:
//  - a new recording is uploaded at once, even while backing off; timer retries back off
//  - after a 202 receipt the result is polled for result_window_ms (0.5/1/2/2 s gaps); if not
//    ready the device shows SENT and keeps the id in a persisted pending list
//  - pending ids are checked on a timer schedule (30 s, 2 min, 5 min, 15 min, then 30 min;
//    given up after 24 h), Wi-Fi on only for those checks; nothing pending = no Wi-Fi
//  - battery critical (< crit_pct, not on USB): no automatic Wi-Fi at all; clips stay queued
//    on the card until charging (or a short PWR press forces one attempt)
//  - status report (pv_status.h, docs/device-api.md section 7): one small POST at the end of a
//    session that is up anyway (never its own Wi-Fi), <= 2.5 s, no retries; low battery: <= 1/h,
//    critical: never (except one crash report)
//  - Wi-Fi (pv_wifi.h): last network first (no scan), else one scan + known networks; a newer
//    list advertised by the server (X-PV-Wifi-Rev) is fetched in the same session
//  - one kept-alive connection per session (Hal::httpSessionEnd closes it before Wi-Fi off)
//  - firmware update (pv_ota.h): checked at the end of a session that is up anyway (<= daily, or
//    when the server advertises a newer version), installed only with an empty queue, >= 30 %
//    battery or USB, and not right after showing the user something new
#pragma once
#include "pv_hal.h"
#include "pv_ota.h"
#include "pv_queue.h"
#include "pv_results.h"
#include "pv_status.h"
#include "pv_wifi.h"
#include "pv_recorder.h"
#include "pv_ui.h"
#include "pv_util.h"

namespace pv {

struct Config {
  QueueConfig queue;
  OtaConfig ota;
  const char *log_path = "/pv_log.txt";
  const char *pending_path = "/pv_pending.txt";
  uint32_t log_max_bytes = 512 * 1024;  // then rotated to <log_path>.old
  uint32_t rate = 16000;
  float min_clip_s = 0.6f;
  uint32_t idle_wake_s = 15 * 60;    // periodic timer wake (battery / queue check)
  uint32_t boot_window_ms = 20000;   // stay awake after reset (console)
  uint32_t status_window_ms = 20000; // stay awake after a short PWR press
  uint32_t wake_grace_ms = 5000;     // minimum awake time after any wake (USB re-enumerates in ~2.6 s)
  uint32_t activity_grace_ms = 30000; // stay awake after a recording before sleeping again
  uint32_t console_window_ms = 300000; // stay awake after a serial command
  uint32_t wifi_timeout_ms = 12000;  // whole connect budget (all networks tried in a session)
  uint32_t wifi_test_ms = 15000;     // serial "wifi test": one network (a wrong password fails in ~6 s)
  uint32_t wifi_test_http_ms = 10000;  // ... then one request to the server
  uint32_t wifi_list_retry_ms = 6 * 3600000;  // a rejected Wi-Fi list (same rev) is fetched again after this
  uint32_t backoff_base_ms = 30000, backoff_cap_ms = 15 * 60000;
  // Setup check-in ("hello", NVS "hello" = "1"): after provisioning the device reports to the
  // server once (POST /v1/status) so setup can confirm it is online. Retried 15 s, 30 s, ... 10 min.
  uint32_t hello_retry_ms = 15000, hello_retry_cap_ms = 10 * 60000;
  uint32_t hello_give_up_ms = 24 * 3600000;  // then wait for a recording, a ⏻ press or a reboot
  uint32_t pwr_long_ms = 2000;
  uint32_t pwr_spurious_max = 5;                  // spurious PWR wakes before disabling PWR wake
  uint32_t pwr_wake_reenable_ms = 60 * 60000;     // ...for this long
  uint32_t finalize_timeout_ms = 5000;
  uint32_t result_window_ms = 6000;       // poll for the result this long after a 202
  uint32_t check_timeout_ms = 15000;      // HTTP timeout of result GETs
  uint8_t result_miss_limit = 6;          // scheduled 404s before an id is dropped
  int low_pct = 15, crit_pct = 5, crit_exit_pct = 8;
  uint32_t low_check_min_ms = 30 * 60000; // low battery: result checks at most every 30 min
  bool skip_sleep_on_usb = false;
  bool sd_log = true;
  bool status_report = true;                // POST /v1/status at the end of connected sessions
  uint32_t status_timeout_ms = 2500;        // bounds the whole report; failures are not retried
  uint32_t status_low_min_ms = 60 * 60000;  // low battery (not on USB): at most one report per hour
  bool beeps = true;
  // On battery, switch the board off (latch released; PWR starts it again) after this long unused -
  // no recording, PWR press, start or USB host - once no result checks are pending. Queued clips do
  // not keep it on: they go at the next start. 0 = never.
  uint32_t auto_off_idle_ms = 4 * 3600000;
  int quiet_peak = 1500;
};

// Outcome of the last network session ("info" -> pocketbot setup explains what went wrong).
enum NetResult : int { NET_OK = 0, NET_HTTP, NET_WIFI_PASSWORD, NET_WIFI_NOT_FOUND, NET_WIFI, NET_ABORTED };
const char *netResultName(int r);  // -1 = "never"

enum class State : uint8_t { Boot, Ready, Recording, Saving, Sending, Sleeping, Off };
const char *stateName(State s);

struct Stats {
  uint32_t clips = 0, too_short = 0, uploaded = 0, dups = 0, upload_fail = 0, wifi_fail = 0, quarantined = 0;
  uint32_t sessions = 0, wakes = 0, timer_wakes = 0, boot_wakes = 0, pwr_wakes = 0, spurious_pwr = 0;
  uint32_t dropped_bytes = 0;
  uint32_t accepted = 0, results = 0, checks = 0, check_fail = 0, gets = 0, gave_up = 0, noise = 0;
  uint64_t awake_ms = 0, sleep_ms = 0;
  uint32_t status_sent = 0, status_fail = 0, status_skipped = 0;  // POST /v1/status: 2xx / other / not sent
  uint32_t heap_boot = 0, heap_last_cycle = 0;
  int32_t heap_cycle_delta = 0;  // heap change over the last cycle (end-to-end)
};

struct AppStatus {
  State state = State::Boot;
  ScreenModel screen;
  uint32_t queued = 0;
  uint32_t cycle = 0;
  uint32_t backoff_ms = 0;
  uint64_t next_retry_ms = 0;
  uint64_t next_check_ms = 0;
  uint32_t pending = 0;  // results still expected
  BattLevel batt = BattLevel::Ok;
  bool sd_ok = false;
  bool pwr_wake_enabled = true;
  const char *last_event = "";
  const char *fw = "";       // running firmware version
  bool fw_verifying = false; // new firmware not confirmed yet (a reset now = rollback)
  Stats stats;
};

class App {
 public:
  App(Hal &hal, const Config &cfg);
  void setup(UiLayout *layout = nullptr);
  void loop();

  // Fake a BOOT hold of ms on the next loop (serial "sim" command / soak tests).
  void requestRecording(uint32_t ms) { sim_rec_ms_ = ms; }
  void setStay(bool on) { stay_ = on; }
  // sim [ms] | stay 0|1 | sleep | stat | beep | check | ota | autooff <s> | info | prov ...
  // "info" and "prov" answer with one machine-readable line "@{json}" (setup tool, sim/README.md).
  void command(const char *line);
  void stayAwake(uint32_t ms);     // extend the awake window (never shortens it)
  const AppStatus &status() const { return st_; }
  Ui &ui() { return ui_; }

 private:
  bool recordClip(uint32_t sim_ms);
  void netSession(const char *reason, bool upload, bool check, bool fw = false, bool hello = false);
  void provision(const char *args);  // serial "prov <what> <value>"
  void info();                       // serial "info"
  void wifiCmd(const char *args);    // serial "wifi scan" | "wifi test {...}" (setup wizard)
  void reply(const char *json);      // "@<json>" console line (not in the SD log)
  bool provisioned() const { return queue_.serverUrl()[0] != 0; }
  bool otaStep(const char *reason, bool busy);  // false: nothing could be tried
  bool otaBattOk();
  OtaIo otaIo();
  static void otaProgress(void *self, const char *version, int pct);
  void pollFresh(uint64_t deadline);
  void checkPending(bool fresh_only);
  void handleReply(const char *id, int http_status, const ResultReply *r, bool scheduled);
  void noteUpdate(const ResultReply &r);
  void showUpdate(const ResultReply &r);
  void updateBattery();
  bool netAllowed();
  bool handlePwr();
  void powerOff();
  void autoOff();
  void lightSleep(uint32_t ms);
  void endCycle();
  void updateFooter(bool force = false);
  void show(Screen s, const char *title, const char *detail, const char *kind = "", const char *due = "");
  void setState(State s);
  void publish();
  void beep(const Tone *t, uint8_t n);
  void plog(const char *fmt, ...);
  bool statusReport(int rssi, uint32_t connect_ms);  // true: the server took it (2xx)
  void statusError();  // something went wrong: the next report carries the log
  void fetchWifiList();
  void netOff();       // end of a session: close the kept connection, radio off
  static void logCb(void *self, const char *line) { ((App *)self)->plog("%s", line); }
  static bool abortOnBoot(void *self);

  Hal &hal_;
  const Config &cfg_;
  uint32_t auto_off_idle_ms_;  // cfg_.auto_off_idle_ms; serial "autooff <s>" changes it until the next start
  uint64_t used_ms_ = 0;       // last use (auto_off_idle_ms_)
  Ui ui_;
  UploadQueue queue_;
  PendingResults results_;
  Ota ota_;
  uint8_t ring_buf_[32 * 1024];
  Recorder rec_;
  bool inline_writer_ = true;
  bool sd_ok_ = false;
  Backoff backoff_;
  AppStatus st_;
  int batt_level_ = 0;
  bool force_net_ = false, updates_api_ = true;
  // per session
  uint32_t updates_ = 0;
  ResultReply last_update_;
  bool stay_ = false, pwr_released_ = false, pwr_wake_ok_ = true;
  uint64_t pwr_wake_off_until_ = 0;
  uint64_t awake_until_ms_ = 0, last_wake_ms_ = 0, last_footer_ms_ = 0;
  uint32_t sim_rec_ms_ = 0;
  uint64_t last_batt_ms_ = 0;
  uint32_t log_seq_ = 0;
  // Wi-Fi places (pv_wifi.h)
  WifiPlaces places_;
  bool wifi_api_ = true;
  uint32_t wifi_bad_rev_ = 0;
  uint64_t wifi_bad_until_ = 0;
  // status report (pv_status.h)
  LogRing ring_;
  const char *reset_ = "other";
  uint32_t boot_n_ = 0, epd_seen_ = 0;
  uint64_t boot_ms_ = 0, rep_awake_ = 0, rep_sleep_ = 0, rep_try_ms_ = 0;  // totals at the last successful report
  bool rep_tried_ = false, want_log_ = false, err_since_rep_ = false, crash_unreported_ = false, crash_crit_tried_ = false;
  // setup (provisioning over USB / NVS image)
  char server_url_[128] = "";
  bool hello_due_ = false;
  bool prov_busy_ = false;  // a setting was changed over USB and "prov done" hasn't come yet: no sessions
  uint64_t prov_busy_since_ = 0;
  bool hello_kv_ = false;          // NVS "hello" = "1": the check-in hasn't reached the server yet
  uint64_t hello_started_ms_ = 0;  // first failed check-in attempt (give up after hello_give_up_ms)
  uint64_t hello_next_ms_ = 0;
  uint32_t hello_wait_ms_ = 0;
  // last network session, for "info": -1 never, else a NetResult
  int net_last_ = -1, net_last_http_ = 0;
  uint64_t net_last_ms_ = 0;
  // per cycle
  const char *cause_ = "boot";
  uint32_t slept_ms_ = 0, refresh_at_wake_ = 0;
};

}  // namespace pv
