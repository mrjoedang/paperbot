// Hardware abstraction for the pocket voice core. Everything the core needs from the
// board goes through this interface; firmware/paperbot implements it on the
// ESP32-C6, sim/ implements it on the host (virtual clock, folder SD card, real HTTP).
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace pv {

enum class Button : uint8_t { Boot, Pwr };
enum class Wake : uint8_t { Timer, Boot, Pwr, Gpio, Other };
enum class WifiResult : uint8_t { Ok, NoSsid, Failed, Timeout, Aborted };

// HTTP outcome. status: HTTP status code, or <0 for a transport error (see HttpErr).
struct HttpResult {
  int status = -1;
  int body_len = 0;  // bytes stored in the caller's body buffer (always NUL-terminated)
  // Value of the X-PV-FW-Latest response header ("" if absent): the server advertises the
  // newest firmware it has (docs/device-api.md section 6). Requests carry X-PV-FW: <fwVersion()>.
  char fw_latest[16] = "";
  // The server asked for the device log in the next status report (X-PV-Want-Log: 1 response
  // header, docs/device-api.md section 7). The {"want_log":true} body form is parsed by the core.
  bool want_log = false;
  // X-PV-Wifi-Rev response header (0 = absent): revision of the server's Wi-Fi list for this
  // device (docs/device-api.md section 8). Requests carry X-PV-Wifi-Rev: <rev set by setWifiRev>.
  uint32_t wifi_rev = 0;
};
enum HttpErr : int { HTTP_ERR_IO = -1, HTTP_ERR_DNS = -2, HTTP_ERR_TIMEOUT = -3, HTTP_ERR_CONNECT = -4, HTTP_ERR_NO_FILE = -5 };

struct Tone {
  uint16_t hz;  // 0 = silence (gap)
  uint16_t ms;
};

struct AppStatus;  // pv_app.h

// One access point (scan result or the AP actually joined). ssid: exact bytes (UTF-8), NUL-terminated.
struct WifiAp {
  char ssid[33] = "";
  uint8_t bssid[6] = {};
  uint8_t channel = 0;
  int8_t rssi = 0;
  bool open = false;  // scan: no password (open network)
};

struct FsEntry {
  char name[64];
  uint32_t size;
};

class Hal {
 public:
  virtual ~Hal() {}

  // ---- time ----
  virtual uint64_t millis() = 0;           // monotonic, keeps counting through light sleep
  virtual void delayMs(uint32_t ms) = 0;   // cooperative wait (other tasks run)
  // Light sleep for up to ms; wakes early on a pressed BOOT/PWR when enabled. Never returns
  // before ms unless a wake source fired. Returns the cause.
  virtual Wake lightSleep(uint32_t ms, bool wake_boot, bool wake_pwr) = 0;

  // ---- inputs / power ----
  virtual bool buttonDown(Button b) = 0;
  virtual void powerLatch(bool on) = 0;  // EXIO5 BAT_Control: false cuts battery power
  virtual bool usbConnected() = 0;
  virtual int batteryMv() = 0;  // -1 = unknown
  virtual void led(bool on) = 0;
  virtual uint32_t random32() = 0;
  virtual const char *deviceId() = 0;  // 12 hex chars (Wi-Fi MAC)

  // ---- audio (16 kHz mono int16) ----
  virtual bool audioBegin(uint32_t *stale_ms) = 0;  // discard stale buffered audio; true if live
  virtual size_t audioRead(int16_t *mono, size_t samples) = 0;  // blocks ~samples/16 ms
  virtual void audioEnd() {}                                    // capture finished
  virtual void playTones(const Tone *seq, uint8_t n) = 0;       // non-blocking

  // ---- file system (SD card; paths are relative to the card root, e.g. "/REC/x.wav") ----
  virtual bool fsMount() = 0;
  virtual bool fsMounted() = 0;
  virtual int fsOpen(const char *path, const char *mode) = 0;  // fopen modes; returns fd or -1
  virtual int fsRead(int fd, void *buf, size_t n) = 0;
  virtual int fsWrite(int fd, const void *buf, size_t n) = 0;
  virtual bool fsSeek(int fd, uint32_t off) = 0;
  virtual int32_t fsSize(int fd) = 0;
  virtual bool fsClose(int fd, bool sync) = 0;  // sync = flush + fsync before closing
  virtual bool fsRemove(const char *path) = 0;
  virtual bool fsRename(const char *from, const char *to) = 0;
  virtual bool fsMkdir(const char *path) = 0;
  // Calls cb for each regular file in dir; returns the number of entries or -1.
  virtual int fsList(const char *dir, void (*cb)(const FsEntry &e, void *ctx), void *ctx) = 0;

  // ---- network ----
  // Joins one network (turns the radio on if needed; a previous attempt is dropped first).
  // bssid + channel given: straight to that AP without a scan ("fast connect"); else the driver
  // looks for the SSID itself. psk "" = open network. abort() is polled while waiting.
  // On Ok, *joined = the AP (bssid, channel, rssi). Failed = rejected (wrong password).
  virtual WifiResult wifiJoin(const char *ssid, const char *psk, const uint8_t *bssid, uint8_t channel, uint32_t timeout_ms,
                              bool (*abort)(void *), void *ctx, WifiAp *joined) = 0;
  // One bounded scan (radio on, not connected). Returns the APs written (<= max) or -1.
  virtual int wifiScan(WifiAp *out, int max) = 0;
  // The network compiled into the firmware (secrets.h): a permanent fallback. false = none.
  virtual bool wifiBuiltin(char *ssid, size_t ssid_cap, char *psk, size_t psk_cap) = 0;
  virtual void wifiOff() = 0;  // radio off (also closes a kept HTTP connection)
  // Requests to our server reuse one kept-alive connection (one TLS handshake per session);
  // this closes it. The core calls it at the end of every network session, before wifiOff().
  virtual void httpSessionEnd() {}
  virtual void setWifiRev(uint32_t rev) {}  // sent as X-PV-Wifi-Rev on every request to our server
  // Device token provisioned at setup (NVS "dev_tok", serial "prov token"): replaces the token
  // compiled into the firmware for every later request. nullptr / "" = back to the compiled-in one.
  // Never logged.
  virtual void setAuth(const char *token) {}
  // PUT the file at path to url with the device bearer token (added by the HAL, never logged).
  virtual HttpResult httpPutFile(const char *url, const char *path, const char *content_type,
                                 char *body, size_t body_cap, uint32_t timeout_ms) = 0;
  virtual HttpResult httpGet(const char *url, char *body, size_t body_cap, uint32_t timeout_ms) = 0;
  // GET whose body is streamed to sink(ctx, data, n) in chunks of <= 4 KB (nothing is buffered
  // whole). sink returns false to abort (the result is then HTTP_ERR_IO). auth: send the device
  // token (only for our own server, never for a third-party download URL). *content_length:
  // the announced length or -1. Default: unsupported.
  virtual HttpResult httpGetStream(const char *url, bool auth, bool (*sink)(void *ctx, const uint8_t *data, size_t n), void *ctx,
                                   uint32_t timeout_ms, int32_t *content_length) {
    HttpResult r;
    r.status = HTTP_ERR_IO;
    if (content_length) *content_length = -1;
    return r;
  }

  // POST a small JSON body (<= 2 KB, Content-Type: application/json) with the device token and
  // the usual X-PV-* headers; the reply body goes to reply (NUL-terminated, may be cut). Used for
  // the status report: timeout_ms is short and nothing is retried. Default: unsupported.
  virtual HttpResult httpPostJson(const char *url, const char *json, size_t len, char *reply, size_t reply_cap, uint32_t timeout_ms) {
    HttpResult r;
    r.status = HTTP_ERR_IO;
    if (reply_cap) reply[0] = 0;
    return r;
  }

  // ---- firmware update (OTA) ----
  // Two app slots (0 / 1). The bootloader boots the selected slot; an image that was just
  // installed boots in "pending verify" and, if the device resets before otaMarkValid(), the
  // bootloader goes back to the other slot (rollback). Defaults: no OTA support.
  virtual const char *fwVersion() { return "0.0.0"; }  // running firmware, "MAJOR.MINOR.PATCH"
  virtual int otaRunningSlot() { return -1; }           // -1 = no OTA
  virtual uint32_t otaSlotSize(int slot) { return 0; }
  // Prepares slot for an image of size bytes (erases as it goes). The core only ever passes the
  // slot it is NOT running from.
  virtual bool otaBegin(int slot, uint32_t size) { return false; }
  virtual bool otaWrite(const void *data, size_t n) { return false; }
  // Ends the write. commit: validate the image and make its slot the boot slot (it boots as
  // "pending verify" after the next reset). !commit: abandon (the slot holds garbage; the boot
  // slot is unchanged).
  virtual bool otaEnd(bool commit) { return false; }
  virtual bool otaPendingVerify() { return false; }  // running image not confirmed yet
  virtual bool otaMarkValid() { return false; }      // confirm the running image (cancel rollback)
  // ECDSA P-256 signature (DER) over a SHA-256 digest, checked with the release public key
  // compiled into the firmware.
  virtual bool otaVerifySignature(const uint8_t digest[32], const uint8_t *sig, size_t sig_len) { return false; }
  virtual void restart() {}  // reboot now (does not return)
  // Small persistent key/value store in internal flash (NVS); survives resets and SD swaps.
  virtual bool kvGet(const char *key, char *out, size_t cap) {
    if (cap) out[0] = 0;
    return false;
  }
  virtual bool kvSet(const char *key, const char *value) { return false; }  // "" deletes

  // ---- display / UI task ----
  // 1-bit frame (200x200, MSB first, 1 = white, rows of 25 bytes). Called once per LVGL
  // refresh after the last strip. y1..y2 = rows touched by this refresh.
  virtual void displayRefresh(const uint8_t *fb, int y1, int y2) = 0;
  virtual bool uiLock(int timeout_ms) = 0;  // LVGL mutex (no-op when single-threaded)
  virtual void uiUnlock() = 0;
  // Run service(ctx) periodically in the background (LVGL timer handler). service returns
  // the ms until it wants to run again.
  virtual void startUiTask(uint32_t (*service)(void *), void *ctx) = 0;
  // Run work(ctx) in a background task (SD writer); returns false if the platform has no
  // threads, in which case the core calls the work function inline.
  virtual bool startWorker(uint32_t (*work)(void *), void *ctx) = 0;

  // ---- diagnostics ----
  // Why the chip last reset: "poweron" | "sw" | "panic" | "int_wdt" | "task_wdt" | "wdt" |
  // "brownout" | "usb" | "deepsleep" | "other".
  virtual const char *resetReason() { return "other"; }
  // RAM that keeps its contents across software / crash / watchdog resets but not a power loss
  // (ESP32-C6: RTC no-init RAM). The core keeps its log ring there (pv_status.h) and validates it
  // itself. Returns nullptr when the platform has none (*size = 0).
  virtual void *retainedRam(size_t *size) {
    *size = 0;
    return nullptr;
  }
  virtual uint32_t displayTimeouts() { return 0; }  // e-paper BUSY waits that hit their bound
  virtual void log(const char *line) = 0;    // console line (no newline)
  virtual void logFlush() = 0;              // must not block forever (USB may be gone)
  virtual uint32_t heapFree() = 0;
  virtual uint32_t heapMinFree() = 0;

  // Optional: status snapshot for observers (sim UI / tests). Default: ignored.
  virtual void onStatus(const AppStatus &) {}
};

}  // namespace pv
