// Durable upload queue: clips are WAV files in rec_dir, uploaded oldest first and deleted
// only after a 2xx reply the server sends once the audio is durably stored (202 receipt, or
// a legacy 200 task). Permanently rejected clips are moved to bad_dir.
#pragma once
#include "pv_hal.h"
#include "pv_results.h"
#include "pv_util.h"

namespace pv {

struct QueueConfig {
  const char *rec_dir = "/REC";
  const char *bad_dir = "/REC_BAD";
  const char *id_prefix = "";  // e.g. "sim-" so test clips are recognisable on a real server
  const char *server_url = "";
  uint32_t http_timeout_ms = 60000;
  uint32_t rate = 16000;
};

struct UploadOutcome {
  UploadVerdict verdict = UploadVerdict::Retry;
  int status = 0;  // HTTP status or HttpErr
  bool reply_ok = false;
  ResultReply reply;
  uint32_t ms = 0;
};

class UploadQueue {
 public:
  UploadQueue(Hal &hal, const QueueConfig &cfg) : hal_(hal), cfg_(cfg) {}
  // Creates dirs, repairs headers of clips cut short by a power loss, sets aside empty files.
  void init(void (*log)(void *, const char *), void *ctx);
  uint32_t pending(char *oldest = nullptr, size_t len = 0);  // count + oldest name
  void newClipName(char *name, size_t len);                 // "<prefix><mac>-<seq6>-<rand8>.wav"
  void path(const char *name, char *out, size_t len) const;
  UploadOutcome upload(const char *name);
  bool remove(const char *name);
  bool quarantine(const char *name);
  // GET server_url + path (e.g. "/v1/recordings/<id>") into the shared reply buffer.
  HttpResult get(const char *path, uint32_t timeout_ms);
  const char *body() const { return body_; }
  // POST server_url + path with a JSON body (e.g. the status report). reply: caller's buffer.
  HttpResult postJson(const char *path, const char *json, size_t len, char *reply, size_t cap, uint32_t timeout_ms);
  // The reply buffer (2 KB) as scratch space between requests (the status report body is built
  // in it: no extra RAM). Its contents are gone after the next upload / get.
  char *scratch(size_t *cap) {
    *cap = sizeof(body_);
    return body_;
  }
  // Status of the last request since sessionStart() (0 = none yet; < 0 = transport error).
  void sessionStart() { last_status_ = 0; }
  int lastStatus() const { return last_status_; }
  const char *serverUrl() const { return url_ ? url_ : cfg_.server_url; }
  // Server URL provisioned at setup (NVS "srv_url", serial "prov server"): replaces
  // QueueConfig::server_url. The string must outlive the queue. nullptr = back to the config.
  void setServerUrl(const char *url) { url_ = url; }
  // Newest firmware advertised by the server (X-PV-FW-Latest of the last reply that had it).
  const char *fwLatest() const { return fw_latest_; }
  // True once any request got an HTTP reply 200..499 (the server was reached: Wi-Fi, DNS, TLS
  // and HTTP all work) - the health signal a freshly installed firmware waits for.
  bool reached() const { return reached_; }
  // Highest X-PV-Wifi-Rev the server sent (0 = none): a newer Wi-Fi list is waiting.
  uint32_t wifiRevSeen() const { return wifi_rev_seen_; }

 private:
  void note(const HttpResult &r);
  Hal &hal_;
  const QueueConfig &cfg_;
  const char *url_ = nullptr;
  uint32_t seq_ = 0;
  char body_[2048];
  char fw_latest_[16] = "";
  bool reached_ = false;
  int last_status_ = 0;
  uint32_t wifi_rev_seen_ = 0;
};

bool isClipName(const char *name);

}  // namespace pv
