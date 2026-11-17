// pv::Hal for the Waveshare ESP32-C6 1.54" e-paper board. Hardware code paths are those of
// tests/power_proto (EXIO latch, ES8311 codec, SDSPI, light sleep, esp_http_client).
#pragma once
#include "pv_core.h"

// 1 = full Wi-Fi driver deinit after each session (power_proto behaviour); 0 = esp_wifi_stop
// only, driver stays initialised. Try 0 if the ~450 B/session heap loss reproduces.
#ifndef PV_WIFI_DEINIT
#define PV_WIFI_DEINIT 0
#endif

class Esp32Hal : public pv::Hal {
 public:
  bool begin();  // power latch, EXIO, buttons, ADC, codec, e-paper + SPI bus, beeper task
  bool codecOk() const { return codec_ok_; }

  uint64_t millis() override;
  void delayMs(uint32_t ms) override;
  pv::Wake lightSleep(uint32_t ms, bool wake_boot, bool wake_pwr) override;
  bool buttonDown(pv::Button b) override;
  void powerLatch(bool on) override;
  bool usbConnected() override;
  int batteryMv() override;
  void led(bool on) override;
  uint32_t random32() override;
  const char *deviceId() override { return device_id_; }
  bool audioBegin(uint32_t *stale_ms) override;
  size_t audioRead(int16_t *mono, size_t samples) override;
  void audioEnd() override;
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
  void setWifiRev(uint32_t rev) override;
  void setAuth(const char *token) override;
  pv::HttpResult httpPutFile(const char *url, const char *path, const char *content_type, char *body, size_t body_cap,
                             uint32_t timeout_ms) override;
  pv::HttpResult httpGet(const char *url, char *body, size_t body_cap, uint32_t timeout_ms) override;
  pv::HttpResult httpGetStream(const char *url, bool auth, bool (*sink)(void *, const uint8_t *, size_t), void *ctx, uint32_t timeout_ms,
                               int32_t *content_length) override;
  pv::HttpResult httpPostJson(const char *url, const char *json, size_t len, char *reply, size_t reply_cap, uint32_t timeout_ms) override;
  // OTA: esp_ota_* on the app3M_fat9M_16MB slots (app0 = ota_0, app1 = ota_1), rollback by the
  // ESP-IDF bootloader (CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y in the arduino-esp32 3.3.0 libs).
  const char *fwVersion() override { return PV_FW_VERSION; }
  int otaRunningSlot() override;
  uint32_t otaSlotSize(int slot) override;
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
  bool uiLock(int timeout_ms) override;
  void uiUnlock() override;
  void startUiTask(uint32_t (*service)(void *), void *ctx) override;
  bool startWorker(uint32_t (*work)(void *), void *ctx) override;
  const char *resetReason() override;
  void *retainedRam(size_t *size) override;  // RTC no-init RAM (LP SRAM), see esp32_hal.cpp
  uint32_t displayTimeouts() override;
  void log(const char *line) override;
  void logFlush() override;
  uint32_t heapFree() override;
  uint32_t heapMinFree() override;

 private:
  bool codec_ok_ = false, mounted_ = false;
  char device_id_[13] = "000000000000";
};
