// Over-the-air firmware update (docs/device-api.md section 6).
//
//  - Check: GET /v1/firmware?current=<ver>&device=<id> -> 200 offer | 204. Piggybacked on a
//    Wi-Fi session that is up anyway, at most once per check_interval (24 h); sooner when a
//    reply carried X-PV-FW-Latest newer than the running version. If no session ran the check
//    for 24 h, a timer wake does a dedicated one.
//  - Gates: never with clips queued (upload first), battery >= min_batt_pct or USB, never while
//    recording (BOOT aborts the download), never while the running image is unconfirmed.
//  - The offer must be newer, signed (ECDSA P-256 over the manifest digest), fit the slot and not
//    be a version that already rolled back max_attempts times. The image streams into the slot
//    we are NOT running from while its SHA-256 is computed; only if size + hash match is the
//    slot committed (bootloader switches to it) and the device restarts. Any failure before the
//    commit leaves the running firmware and the boot slot untouched.
//  - The new image boots "pending verify" and confirms itself (otaMarkValid) once the app is up,
//    the SD card mounted or confirmed absent, the display refreshed, and a server request
//    succeeded (or verify_uptime_ms passed). A reset before that = bootloader rollback.
#pragma once
#include "pv_hal.h"
#include "pv_sha256.h"

// Firmware version of this build ("MAJOR.MINOR.PATCH"). firmware/build.sh
// generates pv_fw_version.h from PV_FW_VERSION / firmware/paperbot/fw_version.txt.
#if defined(__has_include)
#if __has_include(<pv_fw_version.h>)
#include <pv_fw_version.h>
#endif
#endif
#ifndef PV_FW_VERSION
#define PV_FW_VERSION "1.0.0"
#endif

namespace pv {

class UploadQueue;

struct FwVersion {
  int major = -1, minor = 0, patch = 0;
  bool valid() const { return major >= 0; }
};
// "1.2.3" or "v1.2.3" (parts 0..9999); anything else (suffixes, missing parts) is invalid.
FwVersion parseFwVersion(const char *s);
int compareFwVersion(const FwVersion &a, const FwVersion &b);  // <0, 0, >0
bool fwNewer(const char *offered, const char *current);         // both valid and offered > current

struct FwOffer {
  char version[16] = "";
  char url[192] = "";
  uint32_t size = 0;
  uint8_t sha256[32] = {};
  uint8_t sig[80] = {};
  uint8_t sig_len = 0;  // 0 = unsigned
};
// Strict: valid version, non-empty url, 0 < size, sha256 = 64 hex chars, optional sig = hex DER
// (<= 80 bytes). Unknown members are ignored.
bool parseFwOffer(const char *json, FwOffer *o);
// SHA-256 of the signed manifest "pocket-voice-fw/1\n<version>\n<size>\n<sha256 hex>\n".
void fwManifestDigest(const FwOffer &o, uint8_t out[32]);

struct OtaConfig {
  bool enabled = true;
  uint32_t check_interval_ms = 24 * 3600000u;  // firmware check at most this often
  uint32_t retry_base_ms = 3600000;            // after a failed attempt: 1 h, 2 h, 4 h ... <= interval
  uint32_t quiet_ms = 10 * 60000;              // install this long after a session with news / BOOT
  int min_batt_pct = 30;                       // below (and not on USB): no download
  uint32_t verify_uptime_ms = 10 * 60000;      // confirm without a server reply after this uptime
  uint8_t max_attempts = 2;                    // installs of a version that rolled back, then skipped
  bool require_signature = true;
  uint32_t meta_timeout_ms = 15000, download_timeout_ms = 300000;
};

// Callbacks into the app (log line, progress screen, BOOT pressed?).
struct OtaIo {
  void (*log)(void *ctx, const char *line) = nullptr;
  void (*progress)(void *ctx, const char *version, int pct) = nullptr;  // pct -1 = done, restarting
  bool (*abort)(void *ctx) = nullptr;
  void *ctx = nullptr;
};

enum class OtaOutcome : uint8_t { None, UpToDate, NoServerSupport, Deferred, Later, Rejected, Failed, Aborted, Installed };
const char *otaOutcomeName(OtaOutcome o);

class Ota {
 public:
  enum class BootEvent : uint8_t { None, Updated, RolledBack };
  Ota(Hal &hal, const OtaConfig &cfg) : hal_(hal), cfg_(cfg) {}

  // At setup: reads the notes kept in NVS across the install reboot and the bootloader state.
  BootEvent boot(uint64_t now, const OtaIo &io);
  const char *eventVersion() const { return event_version_; }  // version updated to / rolled back from
  bool verifying() const { return verifying_; }

  // Health: base_ok = app up + SD mounted/confirmed absent + display refreshed. Returns true
  // when it confirmed the running image just now.
  bool maybeConfirm(uint64_t now, bool base_ok, bool server_ok);

  // A Wi-Fi session is up: should it ask for firmware? (piggyback)
  bool checkDue(uint64_t now, const char *hint) const;
  // Nothing else brought Wi-Fi up: dedicated session for the daily check / a postponed install.
  bool dedicatedDue(uint64_t now, bool batt_ok) const;
  // A freshly installed image: one early session to reach the server (confirms it).
  bool verifyPingDue() const { return verifying_ && !ping_done_; }
  void pingDone() { ping_done_ = true; }
  // The session meant for the check could not reach the network / was cut short.
  void noNetwork(uint64_t now, bool user_busy);
  void forceCheck(uint64_t now) { install_at_ms_ = now ? now : 1; }  // dedicated check + install now

  // Check (+ download + commit). may_install = false (the user is looking at fresh news): only
  // check, install on a later quiet session. On Installed the caller restarts.
  OtaOutcome run(UploadQueue &q, uint64_t now, bool queue_empty, bool batt_ok, bool may_install, const OtaIo &io);
  const char *lastReason() const { return reason_; }
  const char *offerVersion() const { return offer_version_; }
  bool downloadStarted() const { return dl_started_; }

  uint32_t attempts(const char *version);  // rolled-back installs of version (NVS)

 private:
  void schedule(uint64_t now, uint32_t delay_ms);
  OtaOutcome reject(uint64_t now, const char *reason, const OtaIo &io);
  void logf(const OtaIo &io, const char *fmt, ...);

  Hal &hal_;
  const OtaConfig &cfg_;
  bool verifying_ = false, ping_done_ = false;
  char event_version_[16] = "";
  char handled_hint_[16] = "";
  char offer_version_[16] = "";
  const char *reason_ = "";
  bool dl_started_ = false;
  uint64_t boot_ms_ = 0, last_check_ms_ = 0, next_check_ms_ = 0, install_at_ms_ = 0;
  uint32_t fails_ = 0;
};

}  // namespace pv
