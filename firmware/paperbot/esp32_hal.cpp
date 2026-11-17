#include "esp32_hal.h"
#include <Arduino.h>
#include <WiFi.h>
#include <dirent.h>
#include <math.h>
#include <sys/stat.h>
#include <unistd.h>
#include <esp_sleep.h>
#include <esp_timer.h>
#include <esp_vfs_fat.h>
#include <sdmmc_cmd.h>
#include <esp_http_client.h>
#include <esp_crt_bundle.h>
#include <esp_mac.h>
#include <esp_random.h>
#include <esp_wifi.h>
#include <esp_task_wdt.h>
#include <esp_ota_ops.h>
#include <esp_partition.h>
#include <esp_attr.h>
#include <esp_system.h>
#include <nvs.h>
#include <mbedtls/pk.h>
#include <esp_adc/adc_oneshot.h>
#include <esp_adc/adc_cali.h>
#include <esp_adc/adc_cali_scheme.h>
#include <driver/gpio.h>
#include <driver/usb_serial_jtag.h>
#include "port_i2c.h"
#include "port_display.h"
#include "epaper_config.h"
#include "src/exio/esp_io_expander_tca9554.h"
#include "src/codec_board/codec_board.h"
#include "src/codec_board/codec_init.h"
#include "pv_secrets.h"  // WIFI_SSID, WIFI_PASSWORD, DEVICE_TOKEN (secrets.h, or empty in a release build)
#include "ota_pubkey.h"  // PV_OTA_PUBKEY_DER: release signing key (tools/ota/keygen.sh)

static const uint32_t RATE = 16000;
// Device token: compiled in (secrets.h) until App::setup applies the provisioned one (setAuth).
static char auth_header[160] = "";
static void setAuthHeader(const char *token) {
  if (token && token[0]) snprintf(auth_header, sizeof(auth_header), "Bearer %s", token);
  else auth_header[0] = 0;
}
static const char *SD_ROOT = SDlist;  // "/sdcard"

static I2cMasterBus *i2c_bus = NULL;
static esp_io_expander_handle_t exio = NULL;
static esp_codec_dev_handle_t play = NULL, rec = NULL;
static adc_oneshot_unit_handle_t adc = NULL;
static adc_cali_handle_t cali = NULL;
static sdmmc_card_t *card = NULL;
static SemaphoreHandle_t ui_mux = NULL;
static TaskHandle_t beeper = NULL;
static pv::Tone tones[8];
static volatile uint8_t n_tones = 0;
static FILE *files[8];
static int16_t first_chunk[160];
static size_t first_chunk_n = 0;
static volatile uint32_t beeps_req = 0, beeps_done = 0;  // beeper idle when equal
static bool codec_standby = false;                        // closed while asleep (codecSuspend)
static int64_t codec_resumed_us = 0;

static void exioSet(uint32_t pin, int lvl) { esp_io_expander_set_level(exio, pin, lvl); }

static void path(char *out, size_t len, const char *p) { snprintf(out, len, "%s%s", SD_ROOT, p); }

// ---------------- setup ----------------
static void adcCreate() {
  adc_oneshot_unit_init_cfg_t ic = {};
  ic.unit_id = ADC_UNIT_1;
  adc_oneshot_new_unit(&ic, &adc);
  adc_oneshot_chan_cfg_t ch = {};
  ch.bitwidth = ADC_BITWIDTH_12;
  ch.atten = ADC_ATTEN_DB_12;
  adc_oneshot_config_channel(adc, ADC_CHANNEL_0, &ch);
}

// The SAR ADC reads 4095 after light sleep until the oneshot unit is re-created.
static void adcRecreate() {
  if (adc) adc_oneshot_del_unit(adc);
  adc = NULL;
  adcCreate();
}

// Opens both directions (ES8311 start + I2S on) with our format, volume and gain.
static bool codecOpen() {
  esp_codec_dev_sample_info_t fs = {};
  fs.sample_rate = RATE;
  fs.channel = 2;
  fs.bits_per_sample = 16;
  int r = esp_codec_dev_open(play, &fs);
  r |= esp_codec_dev_open(rec, &fs);
  r |= esp_codec_dev_set_out_vol(play, 60);
  r |= esp_codec_dev_set_in_gain(rec, 45.0);
  return r == 0;
}

static bool codecStart() {
  set_codec_board_type("C6_ePaper_1_54");
  codec_init_cfg_t cfg = {};
  cfg.in_mode = CODEC_I2S_MODE_TDM;
  cfg.out_mode = CODEC_I2S_MODE_TDM;
  if (init_codec(&cfg) != 0) return false;
  play = get_playback_handle();
  rec = get_record_handle();
  return codecOpen();
}

// Codec standby while asleep: close = the ES8311 suspend sequence (analog blocks, references and
// clocks off) + I2S off. The audio rail (EXIO1) stays on: with it off the codec is back-powered
// through the shared I2C pull-ups and still answers - a half-powered chip on the expander's bus.
// Measured on the board: 5 ms to suspend, 24 ms to reopen, first live samples 6 ms later, 20/20
// cycles clean. The first ~80 ms after a reopen carry the ADC high-pass settling thump.
static void codecSuspend() {
  if (codec_standby || !play || !rec) return;
  for (int i = 0; i < 150 && beeps_done != beeps_req; i++) vTaskDelay(pdMS_TO_TICKS(10));  // let a tone finish
  esp_codec_dev_close(rec);
  esp_codec_dev_close(play);
  codec_standby = true;
}

// Before any codec use (recording, tones). A failed reopen gets one full re-init.
static void codecResume() {
  if (!codec_standby) return;
  codec_standby = false;
  codec_resumed_us = esp_timer_get_time();
  if (codecOpen()) return;
  Serial.println("HAL,codec reopen failed: re-init");
  deinit_codec();
  if (!codecStart()) Serial.println("HAL,codec re-init failed");
  codec_resumed_us = esp_timer_get_time();
}

// Plays queued tones with the speaker amp (EXIO3) enabled only while sounding.
static void beepTask(void *) {
  static int16_t buf[160 * 2];
  for (;;) {
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    uint32_t req = beeps_req;
    uint8_t n = n_tones;
    pv::Tone seq[8];
    memcpy(seq, tones, sizeof(seq));
    exioSet(IO_EXPANDER_PIN_NUM_3, 1);
    // The speaker amp needs a moment after enable: ~30 ms of silence first, or short tones get swallowed.
    memset(buf, 0, sizeof(buf));
    for (int i = 0; i < 3; i++) esp_codec_dev_write(play, buf, sizeof(buf));
    for (uint8_t t = 0; t < n; t++) {
      uint32_t total = RATE * seq[t].ms / 1000;
      int phase = 0;
      for (uint32_t off = 0; off < total; off += 160) {
        for (int i = 0; i < 160; i++, phase++) {
          float env = fminf(1.0f, fminf((float)phase, (float)((int)total - phase)) / 80.0f);  // 5 ms ramps: no click
          int16_t v = seq[t].hz ? (int16_t)(6000 * fmaxf(env, 0) * sinf(2 * M_PI * seq[t].hz * phase / RATE)) : 0;
          buf[2 * i] = buf[2 * i + 1] = v;
        }
        esp_codec_dev_write(play, buf, sizeof(buf));
      }
    }
    memset(buf, 0, sizeof(buf));
    for (int i = 0; i < 4; i++) esp_codec_dev_write(play, buf, sizeof(buf));  // flush DMA with silence
    exioSet(IO_EXPANDER_PIN_NUM_3, 0);
    beeps_done = req;
  }
}

bool Esp32Hal::begin() {
  setAuthHeader(DEVICE_TOKEN);
  // Latch battery power first: on battery the board only stays on while PWR is held until EXIO5 is high.
  i2c_bus = I2cMasterBus::requestInstance(ESP32_I2C_SCL_PIN, ESP32_I2C_SDA_PIN, ESP32_I2C_DEV_NUM);
  ESP_ERROR_CHECK(esp_io_expander_new_i2c_tca9554(i2c_bus->Get_I2cBusHandle(), ESP_IO_EXPANDER_I2C_TCA9554_ADDRESS_000, &exio));
  // EXIO0 EPD_PWR, EXIO1 Audio_PWR, EXIO3 PA_CTRL (amp), EXIO4 LED (active low), EXIO5 BAT_Control.
  esp_io_expander_set_dir(exio, IO_EXPANDER_PIN_NUM_0 | IO_EXPANDER_PIN_NUM_1 | IO_EXPANDER_PIN_NUM_3 | IO_EXPANDER_PIN_NUM_4 | IO_EXPANDER_PIN_NUM_5,
                          IO_EXPANDER_OUTPUT);
  esp_io_expander_set_level(exio, IO_EXPANDER_PIN_NUM_5, 1);
  esp_io_expander_set_level(exio, IO_EXPANDER_PIN_NUM_0 | IO_EXPANDER_PIN_NUM_1 | IO_EXPANDER_PIN_NUM_4, 1);
  esp_io_expander_set_level(exio, IO_EXPANDER_PIN_NUM_3, 0);
  Serial.setTxBufferSize(4096);
  Serial.setRxBufferSize(4096);  // "prov wifi <json>" from pocketbot setup is one line of up to ~2 KB
  Serial.begin(921600);     // HWCDC drops output (no blocking) while no USB host is attached
  Serial.setTxTimeoutMs(20);  // never stall the app on a host that stopped reading
  pinMode(BOOT_BUTTON_PIN, INPUT_PULLUP);
  pinMode(PWR_BUTTON_PIN, INPUT_PULLUP);
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  snprintf(device_id_, sizeof(device_id_), "%02x%02x%02x%02x%02x%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  adc_cali_curve_fitting_config_t cc = {};
  cc.unit_id = ADC_UNIT_1;
  cc.atten = ADC_ATTEN_DB_12;
  cc.bitwidth = ADC_BITWIDTH_12;
  adc_cali_create_scheme_curve_fitting(&cc, &cali);
  adcCreate();
  codec_ok_ = codecStart();
  ui_mux = xSemaphoreCreateMutex();
  PortLvgl_Start_Init();  // e-paper init; creates the shared SPI bus (must precede the SD mount)
  WiFi.mode(WIFI_OFF);
  xTaskCreate(beepTask, "beep", 3 * 1024, NULL, 9, &beeper);
  // Watchdog on the app (loop) task: a hang anywhere in a cycle reboots with reset reason
  // TASK_WDT instead of sitting dead in a pocket. Fed from delayMs/audioRead/lightSleep.
  esp_task_wdt_config_t wdt = {};
  wdt.timeout_ms = 90000;
  wdt.trigger_panic = true;
  if (esp_task_wdt_reconfigure(&wdt) != ESP_OK) esp_task_wdt_init(&wdt);
  esp_task_wdt_add(NULL);
  uint32_t w0 = ::millis();
  while (!Serial && ::millis() - w0 < 1500) delay(10);
  char line[128];
  snprintf(line, sizeof(line), "HAL,reset=%d,codec=%d,usb=%d,fw=%s,slot=%d,pending_verify=%d,key=%s", (int)esp_reset_reason(), codec_ok_,
           (int)usb_serial_jtag_is_connected(), PV_FW_VERSION, otaRunningSlot(), otaPendingVerify(), PV_OTA_KEY_FINGERPRINT);
  log(line);
  return true;
}

// ---------------- time / power ----------------
uint64_t Esp32Hal::millis() { return esp_timer_get_time() / 1000; }

void Esp32Hal::delayMs(uint32_t ms) {
  esp_task_wdt_reset();
  TickType_t t = pdMS_TO_TICKS(ms);
  vTaskDelay(t ? t : 1);
}

pv::Wake Esp32Hal::lightSleep(uint32_t ms, bool wake_boot, bool wake_pwr) {
  gpio_wakeup_enable(BOOT_BUTTON_PIN, GPIO_INTR_LOW_LEVEL);
  if (wake_pwr) gpio_wakeup_enable(PWR_BUTTON_PIN, GPIO_INTR_LOW_LEVEL);
  esp_sleep_enable_gpio_wakeup();
  esp_sleep_enable_timer_wakeup((uint64_t)ms * 1000);
  esp_task_wdt_delete(NULL);  // a 15 min sleep must not count against the 90 s watchdog
  codecSuspend();  // reopened on demand (audioBegin / playTones)
  esp_light_sleep_start();
  esp_task_wdt_add(NULL);
  esp_sleep_wakeup_cause_t c = esp_sleep_get_wakeup_cause();
  bool boot = gpio_get_level(BOOT_BUTTON_PIN) == 0, pwr = gpio_get_level(PWR_BUTTON_PIN) == 0;
  gpio_wakeup_disable(BOOT_BUTTON_PIN);
  gpio_wakeup_disable(PWR_BUTTON_PIN);
  esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_ALL);
  adcRecreate();
  (void)wake_boot;
  if (c == ESP_SLEEP_WAKEUP_TIMER) return pv::Wake::Timer;
  if (c == ESP_SLEEP_WAKEUP_GPIO) return boot ? pv::Wake::Boot : pwr ? pv::Wake::Pwr : pv::Wake::Gpio;
  return pv::Wake::Other;
}

bool Esp32Hal::buttonDown(pv::Button b) {
  return gpio_get_level(b == pv::Button::Boot ? BOOT_BUTTON_PIN : PWR_BUTTON_PIN) == 0;
}

void Esp32Hal::powerLatch(bool on) { exioSet(IO_EXPANDER_PIN_NUM_5, on); }

// The SOF-based monitor blips "disconnected" now and then (and for ~2.6 s while the host re-enumerates
// after a light sleep). One blip would put a USB-powered board to sleep, and asleep it stops answering
// USB for good. So: connected = a host was seen within the last 60 s.
bool Esp32Hal::usbConnected() {
  static uint32_t last_seen_ms;
  static bool seen = false;
  uint32_t now = millis();
  if (usb_serial_jtag_is_connected()) {
    last_seen_ms = now;
    seen = true;
  }
  return seen && now - last_seen_ms < 60000;
}

int Esp32Hal::batteryMv() {
  long sum = 0;
  int n = 0;
  for (int i = 0; i < 16; i++) {
    int raw = 0, mv = 0;
    if (adc_oneshot_read(adc, ADC_CHANNEL_0, &raw) != ESP_OK) continue;
    if (cali) adc_cali_raw_to_voltage(cali, raw, &mv);
    sum += mv;
    n++;
  }
  return n ? (int)(2 * sum / n) : -1;  // x2 divider
}

void Esp32Hal::led(bool on) { exioSet(IO_EXPANDER_PIN_NUM_4, !on); }  // active low

uint32_t Esp32Hal::random32() { return esp_random(); }

// ---------------- audio ----------------
bool Esp32Hal::audioBegin(uint32_t *stale_ms) {
  static int16_t st[160 * 2];
  vTaskPrioritySet(NULL, 10);  // above LVGL (5) and the SD writer (8) while capturing
  codecResume();
  // Right after a reopen: drop the settling thump (under the start beep anyway).
  while (esp_timer_get_time() - codec_resumed_us < 80000) esp_codec_dev_read(rec, st, sizeof(st));
  // Discard stale DMA audio: reads that return almost instantly were buffered before/while
  // sleeping; the first read that has to wait is live audio.
  uint32_t stale = 0;
  bool live = false;
  for (int i = 0; i < 40; i++) {
    int64_t t = esp_timer_get_time();
    esp_codec_dev_read(rec, st, sizeof(st));
    if (esp_timer_get_time() - t > 4000) { live = true; break; }
    stale += 10;
  }
  for (int i = 0; i < 160; i++) first_chunk[i] = st[2 * i];  // the first live chunk counts as audio
  first_chunk_n = 160;
  if (stale_ms) *stale_ms = stale;
  return live;
}

size_t Esp32Hal::audioRead(int16_t *mono, size_t samples) {
  static int16_t st[160 * 2];
  esp_task_wdt_reset();
  if (first_chunk_n && samples >= first_chunk_n) {
    memcpy(mono, first_chunk, first_chunk_n * 2);
    size_t n = first_chunk_n;
    first_chunk_n = 0;
    return n;
  }
  if (samples > 160) samples = 160;
  esp_codec_dev_read(rec, st, samples * 4);
  for (size_t i = 0; i < samples; i++) mono[i] = st[2 * i];  // mic on the left channel
  return samples;
}

void Esp32Hal::audioEnd() { vTaskPrioritySet(NULL, 1); }

void Esp32Hal::playTones(const pv::Tone *seq, uint8_t n) {
  if (n > 8) n = 8;
  codecResume();
  memcpy(tones, seq, n * sizeof(pv::Tone));
  n_tones = n;
  beeps_req = beeps_req + 1;
  xTaskNotifyGive(beeper);
}

// ---------------- file system (SD over SPI, FAT) ----------------
// Every FAT call may talk to the card over the SPI bus it shares with the e-paper.
extern "C" void pv_spi_lock();
extern "C" void pv_spi_unlock();
namespace {
struct SpiGuard {
  SpiGuard() { pv_spi_lock(); }
  ~SpiGuard() { pv_spi_unlock(); }
};
}  // namespace

bool Esp32Hal::fsMount() {
  SpiGuard g;
  esp_vfs_fat_sdmmc_mount_config_t mc = {};
  mc.format_if_mount_failed = false;  // never format the user's card
  mc.max_files = 4;
  mc.allocation_unit_size = 16 * 1024;
  sdspi_device_config_t slot = SDSPI_DEVICE_CONFIG_DEFAULT();
  slot.gpio_cs = SD_CS_PIN;
  slot.host_id = EPD_SPI_NUM;
  sdmmc_host_t host = SDSPI_HOST_DEFAULT();
  host.slot = EPD_SPI_NUM;
  esp_err_t err = esp_vfs_fat_sdspi_mount(SD_ROOT, &host, &slot, &mc, &card);
  if (err != ESP_OK) {
    char line[80];
    snprintf(line, sizeof(line), "HAL,sd mount failed: %s", esp_err_to_name(err));
    log(line);
    card = NULL;
  }
  mounted_ = card != NULL;
  return mounted_;
}

int Esp32Hal::fsOpen(const char *p, const char *mode) {
  SpiGuard g;
  if (!mounted_) return -1;
  for (int fd = 0; fd < 8; fd++)
    if (!files[fd]) {
      char full[160];
      path(full, sizeof(full), p);
      files[fd] = fopen(full, mode);
      return files[fd] ? fd : -1;
    }
  return -1;
}

static FILE *fileOf(int fd) { return fd >= 0 && fd < 8 ? files[fd] : NULL; }

int Esp32Hal::fsRead(int fd, void *buf, size_t n) { SpiGuard g; return fileOf(fd) ? (int)fread(buf, 1, n, fileOf(fd)) : -1; }
int Esp32Hal::fsWrite(int fd, const void *buf, size_t n) { SpiGuard g; return fileOf(fd) ? (int)fwrite(buf, 1, n, fileOf(fd)) : -1; }
bool Esp32Hal::fsSeek(int fd, uint32_t off) { SpiGuard g; return fileOf(fd) && fseek(fileOf(fd), off, SEEK_SET) == 0; }

int32_t Esp32Hal::fsSize(int fd) {
  SpiGuard g;
  FILE *f = fileOf(fd);
  if (!f) return -1;
  long pos = ftell(f);
  fseek(f, 0, SEEK_END);
  long len = ftell(f);
  fseek(f, pos, SEEK_SET);
  return (int32_t)len;
}

bool Esp32Hal::fsClose(int fd, bool sync) {
  SpiGuard g;
  FILE *f = fileOf(fd);
  if (!f) return false;
  bool ok = fflush(f) == 0;
  if (sync) fsync(fileno(f));
  ok &= fclose(f) == 0;
  files[fd] = NULL;
  return ok;
}

bool Esp32Hal::fsRemove(const char *p) {
  SpiGuard g;
  char full[160];
  path(full, sizeof(full), p);
  return mounted_ && unlink(full) == 0;
}

bool Esp32Hal::fsRename(const char *from, const char *to) {
  SpiGuard g;
  char a[160], b[160];
  path(a, sizeof(a), from);
  path(b, sizeof(b), to);
  return mounted_ && rename(a, b) == 0;
}

bool Esp32Hal::fsMkdir(const char *p) {
  SpiGuard g;
  char full[160];
  path(full, sizeof(full), p);
  return mounted_ && (mkdir(full, 0775) == 0 || errno == EEXIST);
}

int Esp32Hal::fsList(const char *dir, void (*cb)(const pv::FsEntry &e, void *ctx), void *ctx) {
  SpiGuard g;
  if (!mounted_) return -1;
  char full[160];
  path(full, sizeof(full), dir);
  DIR *d = opendir(full);
  if (!d) return -1;
  int n = 0;
  while (struct dirent *e = readdir(d)) {
    if (e->d_type != DT_REG) continue;
    pv::FsEntry fe;
    snprintf(fe.name, sizeof(fe.name), "%s", e->d_name);
    char fp[240];
    struct stat st;
    snprintf(fp, sizeof(fp), "%s/%s", full, e->d_name);
    fe.size = stat(fp, &st) == 0 ? (uint32_t)st.st_size : 0;
    cb(fe, ctx);
    n++;
  }
  closedir(d);
  return n;
}

// ---------------- network ----------------
static bool radio_up = false;
static void keepClose();

// The driver's last disconnect reason (ESP-IDF event task). Arduino's WiFi.status() never reports a wrong
// password: on WPA2 the router drops us with 4WAY_HANDSHAKE_TIMEOUT (~3 s, seen on a real router) and the core just
// retries, so the status stays WL_DISCONNECTED until the timeout. The reason is the only signal. One such drop can
// also be a lost handshake frame on a weak link, so it takes two in one attempt (~6 s) to call it a wrong password:
// a Failed join puts the network in backoff (pv_wifi.cpp).
static volatile uint8_t sta_reason = 0;
static volatile uint32_t sta_disconnects = 0;
static void staEvent(void *, esp_event_base_t, int32_t id, void *data) {
  if (id != WIFI_EVENT_STA_DISCONNECTED || !data) return;
  sta_reason = ((wifi_event_sta_disconnected_t *)data)->reason;
  sta_disconnects = sta_disconnects + 1;  // one writer (the event task)
}
static bool authFailed(uint8_t r) {
  return r == WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT || r == WIFI_REASON_HANDSHAKE_TIMEOUT || r == WIFI_REASON_AUTH_FAIL ||
         r == WIFI_REASON_MIC_FAILURE || r == WIFI_REASON_802_1X_AUTH_FAILED;
}

static void radioOn() {
  if (radio_up) return;
  WiFi.mode(WIFI_STA);
  static bool hooked = false;  // after WiFi.mode(): the default event loop exists only once Arduino created it
  if (!hooked) hooked = esp_event_handler_register(WIFI_EVENT, WIFI_EVENT_STA_DISCONNECTED, staEvent, NULL) == ESP_OK;
#if !PV_WIFI_DEINIT
  // wifiOff() stops the radio behind Arduino's back; WiFi.mode() still believes it is in STA mode
  // and won't restart it, so every session after the first would time out.
  esp_wifi_start();
#endif
  radio_up = true;
}

// One network. bssid + channel: WiFi.begin() goes straight to that AP on that channel (no
// all-channel scan); otherwise the driver scans for the SSID.
pv::WifiResult Esp32Hal::wifiJoin(const char *ssid, const char *psk, const uint8_t *bssid, uint8_t channel, uint32_t timeout_ms,
                                  bool (*abort)(void *), void *ctx, pv::WifiAp *joined) {
  int64_t t0 = esp_timer_get_time();
  keepClose();
  radioOn();
  WiFi.disconnect(false, false);  // drop a previous attempt (no-op otherwise)
  WiFi.begin(ssid, psk && psk[0] ? psk : NULL, bssid && channel ? channel : 0, bssid && channel ? bssid : NULL, true);
  wl_status_t ws;
  uint32_t seen = sta_disconnects;
  int auth_fails = 0;
  bool refused = false;
  while ((ws = WiFi.status()) != WL_CONNECTED && esp_timer_get_time() - t0 < timeout_ms * 1000LL) {
    // Give up early when the AP is not there or refused us (saves radio time).
    if (ws == WL_NO_SSID_AVAIL || ws == WL_CONNECT_FAILED) break;
    if (sta_disconnects != seen) {
      seen = sta_disconnects;
      if (authFailed(sta_reason) && ++auth_fails >= 2) { refused = true; break; }
    }
    if (abort && abort(ctx)) return pv::WifiResult::Aborted;
    delayMs(5);
  }
  ws = WiFi.status();
  if (refused && ws != WL_CONNECTED) {
    WiFi.disconnect(false, false);  // stop the core's automatic retries
    return pv::WifiResult::Failed;
  }
  if (ws == WL_CONNECTED) {
    if (joined) {
      snprintf(joined->ssid, sizeof(joined->ssid), "%s", ssid);
      const uint8_t *b = WiFi.BSSID();
      if (b) memcpy(joined->bssid, b, 6);
      joined->channel = (uint8_t)WiFi.channel();
      joined->rssi = (int8_t)WiFi.RSSI();
    }
    return pv::WifiResult::Ok;
  }
  if (ws == WL_NO_SSID_AVAIL) return pv::WifiResult::NoSsid;
  if (ws == WL_CONNECT_FAILED) return pv::WifiResult::Failed;
  return pv::WifiResult::Timeout;
}

// Blocking active scan, 100 ms per channel (~1.5 s for the C6's 13 channels).
int Esp32Hal::wifiScan(pv::WifiAp *out, int max) {
  keepClose();
  radioOn();
  WiFi.disconnect(false, false);  // a scan is refused while a connect attempt is pending
  int16_t n = WiFi.scanNetworks(false, false, false, 100);
  // Right after a join that timed out, the driver may still be connecting and refuses the scan: wait and retry.
  for (int t = 1; n < 0 && t <= 3; t++) {
    WiFi.scanDelete();
    delayMs(200 * t);
    n = WiFi.scanNetworks(false, false, false, 100);
  }
  esp_task_wdt_reset();
  if (n < 0) {
    WiFi.scanDelete();
    return -1;
  }
  int k = 0;
  for (int i = 0; i < n && k < max; i++) {
    String s = WiFi.SSID(i);
    if (s.length() == 0 || s.length() > 32) continue;  // hidden / invalid
    memcpy(out[k].ssid, s.c_str(), s.length() + 1);
    const uint8_t *b = WiFi.BSSID(i);
    if (b) memcpy(out[k].bssid, b, 6);
    out[k].channel = (uint8_t)WiFi.channel(i);
    out[k].rssi = (int8_t)WiFi.RSSI(i);
    out[k].open = WiFi.encryptionType(i) == WIFI_AUTH_OPEN;
    k++;
  }
  WiFi.scanDelete();
  return k;
}

bool Esp32Hal::wifiBuiltin(char *ssid, size_t ssid_cap, char *psk, size_t psk_cap) {
  snprintf(ssid, ssid_cap, "%s", WIFI_SSID);
  snprintf(psk, psk_cap, "%s", WIFI_PASSWORD);
  return ssid[0] != 0;
}

void Esp32Hal::wifiOff() {
  keepClose();  // normally already done by httpSessionEnd()
#if PV_WIFI_DEINIT
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
#else
  WiFi.disconnect(false, false);
  esp_wifi_stop();  // radio off, driver/netif kept (avoids per-session init/deinit allocations)
#endif
  radio_up = false;
}

static int mapErr(esp_err_t e) {
  if (e == ESP_ERR_HTTP_CONNECT) return pv::HTTP_ERR_CONNECT;
  if (e == ESP_ERR_HTTP_EAGAIN || e == ESP_ERR_TIMEOUT) return pv::HTTP_ERR_TIMEOUT;
  return pv::HTTP_ERR_IO;
}

static uint8_t chunk[4096];  // upload / download buffer (one request at a time, app task only)

// Device telemetry for the web app's live device panel (docs/device-api.md): battery and USB.
static int tele_batt_mv;  // sampled by the Esp32Hal::http* entry points
static bool tele_usb;
static uint32_t wifi_rev;  // X-PV-Wifi-Rev (docs/device-api.md section 8)
static bool srv_close;     // the reply said "Connection: close" (this IDF has no is_persistent_connection())

static void setTelemetryHeaders(esp_http_client_handle_t client, int batt_mv, bool usb) {
  char v[12];  // esp_http_client copies header values
  snprintf(v, sizeof(v), "%d", batt_mv);
  esp_http_client_set_header(client, "X-PV-Batt", v);
  esp_http_client_set_header(client, "X-PV-USB", usb ? "1" : "0");
}

// Captures X-PV-FW-Latest (the server's newest firmware), X-PV-Want-Log (status report: attach
// the log next time) and X-PV-Wifi-Rev (a newer Wi-Fi list) into the HttpResult.
static esp_err_t onHttpEvent(esp_http_client_event_t *e) {
  if (e->event_id != HTTP_EVENT_ON_HEADER || !e->user_data) return ESP_OK;
  pv::HttpResult *r = (pv::HttpResult *)e->user_data;
  if (strcasecmp(e->header_key, "X-PV-FW-Latest") == 0) snprintf(r->fw_latest, sizeof(r->fw_latest), "%s", e->header_value);
  else if (strcasecmp(e->header_key, "X-PV-Want-Log") == 0) r->want_log = atoi(e->header_value) == 1;
  else if (strcasecmp(e->header_key, "X-PV-Wifi-Rev") == 0) r->wifi_rev = (uint32_t)strtoul(e->header_value, NULL, 10);
  else if (strcasecmp(e->header_key, "Connection") == 0 && strcasecmp(e->header_value, "close") == 0) srv_close = true;
  return ESP_OK;
}

// Keep-alive: requests to our server within one network session share ONE esp_http_client
// handle, i.e. one TCP + TLS connection (a TLS handshake is ~0.5-1 s of radio on the C6). Same
// peak RAM as before (one TLS context, mbedTLS 16 KB in/out buffers) - it is just held between
// the requests of a session. Closed by httpSessionEnd() / wifiOff() / a firmware download, and
// whenever a request fails or the server does not keep the connection.
static esp_http_client_handle_t keep = NULL;
static char keep_origin[96];

static void keepClose() {
  if (!keep) return;
  esp_http_client_close(keep);
  esp_http_client_cleanup(keep);
  keep = NULL;
  keep_origin[0] = 0;
}

static void originOf(const char *url, char *out, size_t cap) {  // "https://host:port"
  const char *p = strstr(url, "://");
  p = p ? p + 3 : url;
  const char *e = strchr(p, '/');
  snprintf(out, cap, "%.*s", (int)(e ? e - url : (long)strlen(url)), url);
}

// The request itself on `c`. true = a status line arrived (the server answered).
static bool request(esp_http_client_handle_t c, FILE *f, const char *mem, long len, char *body, size_t cap, pv::HttpResult &r,
                    bool *drained) {
  *drained = false;
  if (f) fseek(f, 0, SEEK_SET);
  esp_err_t err = esp_http_client_open(c, f || mem ? len : 0);
  if (err != ESP_OK) {
    r.status = mapErr(err);
    return false;
  }
  long sent = 0;
  size_t n;
  while (f && (n = fread(chunk, 1, sizeof(chunk), f)) > 0) {
    esp_task_wdt_reset();
    if (esp_http_client_write(c, (const char *)chunk, n) != (int)n) break;
    sent += n;
  }
  if (mem && len > 0) sent = esp_http_client_write(c, mem, len);
  if ((f || mem) && sent != len) {
    r.status = pv::HTTP_ERR_IO;
    return false;
  }
  if (esp_http_client_fetch_headers(c) < 0) {
    r.status = pv::HTTP_ERR_TIMEOUT;
    return false;
  }
  r.status = esp_http_client_get_status_code(c);
  int got = 0, k;
  while (got < (int)cap - 1 && (k = esp_http_client_read(c, body + got, cap - 1 - got)) > 0) got += k;
  body[got] = 0;
  r.body_len = got;
  // The rest of a long reply must be read off the connection before it can carry another request.
  *drained = esp_http_client_is_complete_data_received(c) || esp_http_client_flush_response(c, NULL) == ESP_OK;
  return true;
}

// One request to our server (token + X-PV-* headers). Body: the open file f (len bytes, streamed
// in 4 KB chunks), or mem (len bytes), or none. On the kept connection when there is one; if that
// connection turns out dead before any reply (server closed it while idle), once more on a fresh
// one within what is left of timeout_ms.
static pv::HttpResult http(const char *url, esp_http_client_method_t method, FILE *f, const char *mem, long len, const char *ctype,
                           char *body, size_t cap, uint32_t timeout_ms) {
  pv::HttpResult r;
  char origin[96];
  originOf(url, origin, sizeof(origin));
  int64_t t0 = esp_timer_get_time();
  for (int attempt = 0; attempt < 2; attempt++) {
    r = pv::HttpResult();
    if (cap) body[0] = 0;
    uint32_t to = timeout_ms;
    if (attempt) {
      int64_t spent = (esp_timer_get_time() - t0) / 1000;
      if (spent + 1000 > (int64_t)timeout_ms) break;  // no time left for a new handshake
      to = timeout_ms - (uint32_t)spent;
    }
    bool reused = keep && strcmp(origin, keep_origin) == 0;
    if (keep && !reused) keepClose();
    if (!keep) {
      esp_http_client_config_t cfg = {};
      cfg.url = url;
      cfg.method = method;
      cfg.timeout_ms = to;
      cfg.crt_bundle_attach = esp_crt_bundle_attach;
      cfg.buffer_size_tx = 1024;
      cfg.event_handler = onHttpEvent;
      cfg.user_data = &r;
      keep = esp_http_client_init(&cfg);
      if (!keep) return r;
      snprintf(keep_origin, sizeof(keep_origin), "%s", origin);
      if (auth_header[0]) esp_http_client_set_header(keep, "Authorization", auth_header);
      esp_http_client_set_header(keep, "X-PV-FW", PV_FW_VERSION);
    } else {
      esp_http_client_set_url(keep, url);
      esp_http_client_set_method(keep, method);
      esp_http_client_set_timeout_ms(keep, to);
      esp_http_client_set_user_data(keep, &r);
    }
    setTelemetryHeaders(keep, tele_batt_mv, tele_usb);
    char rev[12];
    snprintf(rev, sizeof(rev), "%u", (unsigned)wifi_rev);
    esp_http_client_set_header(keep, "X-PV-Wifi-Rev", rev);
    if (ctype) esp_http_client_set_header(keep, "Content-Type", ctype);
    else esp_http_client_delete_header(keep, "Content-Type");
    bool drained = false;
    srv_close = false;
    bool replied = request(keep, f, mem, len, body, cap, r, &drained);
    if (!replied || !drained || srv_close) keepClose();
    if (replied || !reused) return r;
  }
  return r;
}

void Esp32Hal::httpSessionEnd() { keepClose(); }
void Esp32Hal::setWifiRev(uint32_t rev) { wifi_rev = rev; }

void Esp32Hal::setAuth(const char *token) {
  keepClose();  // the kept connection carries the old header
  setAuthHeader(token && token[0] ? token : DEVICE_TOKEN);
}

pv::HttpResult Esp32Hal::httpPutFile(const char *url, const char *p, const char *content_type, char *body, size_t body_cap,
                                     uint32_t timeout_ms) {
  tele_batt_mv = batteryMv();
  tele_usb = usbConnected();
  char full[160];
  path(full, sizeof(full), p);
  FILE *f = fopen(full, "rb");
  if (!f) {
    pv::HttpResult r;
    r.status = pv::HTTP_ERR_NO_FILE;
    return r;
  }
  fseek(f, 0, SEEK_END);
  long len = ftell(f);
  fseek(f, 0, SEEK_SET);
  pv::HttpResult r = http(url, HTTP_METHOD_PUT, f, NULL, len, content_type, body, body_cap, timeout_ms);
  fclose(f);
  return r;
}

pv::HttpResult Esp32Hal::httpGet(const char *url, char *body, size_t body_cap, uint32_t timeout_ms) {
  tele_batt_mv = batteryMv();
  tele_usb = usbConnected();
  return http(url, HTTP_METHOD_GET, NULL, NULL, 0, NULL, body, body_cap, timeout_ms);
}

// Status report (docs/device-api.md section 7): <= 2 KB JSON from RAM, one attempt. timeout_ms
// bounds each socket step (connect, TLS records, reply), so a dead server costs ~timeout_ms.
pv::HttpResult Esp32Hal::httpPostJson(const char *url, const char *json, size_t len, char *reply, size_t reply_cap, uint32_t timeout_ms) {
  tele_batt_mv = batteryMv();
  tele_usb = usbConnected();
  return http(url, HTTP_METHOD_POST, NULL, json, (long)len, "application/json", reply, reply_cap, timeout_ms);
}

// Streamed GET (firmware image): 4 KB at a time from the TLS socket to sink, nothing buffered
// whole. timeout_ms bounds the whole transfer; each socket read is bounded by 15 s.
pv::HttpResult Esp32Hal::httpGetStream(const char *url, bool auth, bool (*sink)(void *, const uint8_t *, size_t), void *ctx,
                                       uint32_t timeout_ms, int32_t *content_length) {
  tele_batt_mv = batteryMv();
  tele_usb = usbConnected();
  pv::HttpResult r;
  if (content_length) *content_length = -1;
  keepClose();  // the download gets the one TLS context (RAM)
  esp_http_client_config_t cfg = {};
  cfg.url = url;
  cfg.method = HTTP_METHOD_GET;
  cfg.timeout_ms = 15000;
  cfg.crt_bundle_attach = esp_crt_bundle_attach;
  cfg.buffer_size = 1536;  // response headers (object stores send a few hundred bytes)
  cfg.buffer_size_tx = 1024;
  cfg.event_handler = onHttpEvent;
  cfg.user_data = &r;
  esp_http_client_handle_t client = esp_http_client_init(&cfg);
  if (!client) return r;
  if (auth && auth_header[0]) esp_http_client_set_header(client, "Authorization", auth_header);  // own server only
  esp_http_client_set_header(client, "X-PV-FW", PV_FW_VERSION);
  setTelemetryHeaders(client, tele_batt_mv, tele_usb);
  int64_t t0 = esp_timer_get_time();
  esp_err_t err = esp_http_client_open(client, 0);
  if (err != ESP_OK) {
    r.status = mapErr(err);
  } else {
    int64_t cl = esp_http_client_fetch_headers(client);
    if (cl < 0) {
      r.status = pv::HTTP_ERR_TIMEOUT;
    } else {
      r.status = esp_http_client_get_status_code(client);
      if (r.status == 200) {
        if (content_length) *content_length = esp_http_client_is_chunked_response(client) || cl > INT32_MAX ? -1 : (int32_t)cl;
        for (;;) {
          esp_task_wdt_reset();
          if (esp_timer_get_time() - t0 > (int64_t)timeout_ms * 1000) { r.status = pv::HTTP_ERR_TIMEOUT; break; }
          int n = esp_http_client_read(client, (char *)chunk, sizeof(chunk));
          if (n < 0) { r.status = pv::HTTP_ERR_IO; break; }
          if (n == 0) {
            if (!esp_http_client_is_complete_data_received(client)) r.status = pv::HTTP_ERR_IO;  // connection closed early
            break;
          }
          if (!sink(ctx, chunk, (size_t)n)) { r.status = pv::HTTP_ERR_IO; break; }
        }
      }
    }
  }
  esp_http_client_close(client);
  esp_http_client_cleanup(client);
  return r;
}

// ---------------- firmware update (OTA) ----------------
static esp_ota_handle_t ota_handle = 0;
static const esp_partition_t *ota_part = NULL;

static const esp_partition_t *slotPartition(int slot) {
  if (slot != 0 && slot != 1) return NULL;
  return esp_partition_find_first(ESP_PARTITION_TYPE_APP, (esp_partition_subtype_t)(ESP_PARTITION_SUBTYPE_APP_OTA_0 + slot), NULL);
}

int Esp32Hal::otaRunningSlot() {
  const esp_partition_t *p = esp_ota_get_running_partition();
  if (!p || p->subtype < ESP_PARTITION_SUBTYPE_APP_OTA_0 || p->subtype > ESP_PARTITION_SUBTYPE_APP_OTA_1) return -1;
  return p->subtype - ESP_PARTITION_SUBTYPE_APP_OTA_0;
}

uint32_t Esp32Hal::otaSlotSize(int slot) {
  const esp_partition_t *p = slotPartition(slot);
  return p ? p->size : 0;
}

bool Esp32Hal::otaBegin(int slot, uint32_t size) {
  if (ota_handle) return false;
  ota_part = slotPartition(slot);
  // esp_ota_begin also refuses the running partition (ESP_ERR_OTA_PARTITION_CONFLICT).
  if (!ota_part || ota_part == esp_ota_get_running_partition() || size > ota_part->size) return false;
  // Sequential writes: erase sector by sector as data arrives (no multi-second erase up front).
  esp_err_t e = esp_ota_begin(ota_part, OTA_WITH_SEQUENTIAL_WRITES, &ota_handle);
  if (e != ESP_OK) {
    char line[80];
    snprintf(line, sizeof(line), "HAL,ota begin failed: %s", esp_err_to_name(e));
    log(line);
    ota_handle = 0;
    return false;
  }
  return true;
}

bool Esp32Hal::otaWrite(const void *data, size_t n) {
  esp_task_wdt_reset();
  return ota_handle && esp_ota_write(ota_handle, data, n) == ESP_OK;
}

bool Esp32Hal::otaEnd(bool commit) {
  if (!ota_handle) return false;
  esp_ota_handle_t h = ota_handle;
  ota_handle = 0;
  if (!commit) {
    esp_ota_abort(h);  // the boot partition is not touched
    return true;
  }
  esp_err_t e = esp_ota_end(h);  // validates the image (segments, checksum, appended SHA-256)
  if (e == ESP_OK) e = esp_ota_set_boot_partition(ota_part);  // otadata: new image, state NEW
  if (e != ESP_OK) {
    char line[80];
    snprintf(line, sizeof(line), "HAL,ota end failed: %s", esp_err_to_name(e));
    log(line);
  }
  return e == ESP_OK;
}

bool Esp32Hal::otaPendingVerify() {
  esp_ota_img_states_t st;
  return esp_ota_get_state_partition(esp_ota_get_running_partition(), &st) == ESP_OK && st == ESP_OTA_IMG_PENDING_VERIFY;
}

bool Esp32Hal::otaMarkValid() { return esp_ota_mark_app_valid_cancel_rollback() == ESP_OK; }

bool Esp32Hal::otaVerifySignature(const uint8_t digest[32], const uint8_t *sig, size_t sig_len) {
  mbedtls_pk_context pk;
  mbedtls_pk_init(&pk);
  bool ok = mbedtls_pk_parse_public_key(&pk, PV_OTA_PUBKEY_DER, sizeof(PV_OTA_PUBKEY_DER)) == 0 &&
            mbedtls_pk_can_do(&pk, MBEDTLS_PK_ECKEY) && mbedtls_pk_verify(&pk, MBEDTLS_MD_SHA256, digest, 32, sig, sig_len) == 0;
  mbedtls_pk_free(&pk);
  return ok;
}

void Esp32Hal::restart() {
  logFlush();
  esp_restart();
}

bool Esp32Hal::kvGet(const char *key, char *out, size_t cap) {
  if (cap) out[0] = 0;
  nvs_handle_t h;
  if (nvs_open("pvota", NVS_READONLY, &h) != ESP_OK) return false;
  size_t len = cap;
  bool ok = nvs_get_str(h, key, out, &len) == ESP_OK;
  nvs_close(h);
  if (!ok && cap) out[0] = 0;
  return ok;
}

bool Esp32Hal::kvSet(const char *key, const char *value) {
  nvs_handle_t h;
  if (nvs_open("pvota", NVS_READWRITE, &h) != ESP_OK) return false;
  esp_err_t e = value[0] ? nvs_set_str(h, key, value) : nvs_erase_key(h, key);
  if (e == ESP_ERR_NVS_NOT_FOUND) e = ESP_OK;
  if (e == ESP_OK) e = nvs_commit(h);
  nvs_close(h);
  return e == ESP_OK;
}

// ---------------- display / tasks ----------------
void Esp32Hal::displayRefresh(const uint8_t *fb, int y1, int y2) {
  EPD_CopyFrame(fb, y1, y2);
  EPD_DisplayPart();  // partial refresh (~0.3 s); BUSY wait is bounded in port_display.cpp
}

bool Esp32Hal::uiLock(int timeout_ms) {
  return xSemaphoreTake(ui_mux, timeout_ms < 0 ? portMAX_DELAY : pdMS_TO_TICKS(timeout_ms)) == pdTRUE;
}

void Esp32Hal::uiUnlock() { xSemaphoreGive(ui_mux); }

struct TaskArg {
  uint32_t (*fn)(void *);
  void *ctx;
};

static void serviceTask(void *a) {
  TaskArg *t = (TaskArg *)a;
  for (;;) {
    uint32_t ms = t->fn(t->ctx);
    if (ms) vTaskDelay(pdMS_TO_TICKS(ms) ? pdMS_TO_TICKS(ms) : 1);
    else taskYIELD();
  }
}

void Esp32Hal::startUiTask(uint32_t (*service)(void *), void *ctx) {
  static TaskArg arg;
  arg = { service, ctx };
  xTaskCreate(serviceTask, "LVGL", 8 * 1024, &arg, 5, NULL);
}

bool Esp32Hal::startWorker(uint32_t (*work)(void *), void *ctx) {
  static TaskArg arg;
  arg = { work, ctx };
  return xTaskCreate(serviceTask, "sdwriter", 4 * 1024, &arg, 8, NULL) == pdPASS;
}

// ---------------- diagnostics ----------------
const char *Esp32Hal::resetReason() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON: return "poweron";  // also the RESET (EN) button on the C6
    case ESP_RST_SW: return "sw";
    case ESP_RST_PANIC: return "panic";
    case ESP_RST_INT_WDT: return "int_wdt";
    case ESP_RST_TASK_WDT: return "task_wdt";  // our 90 s loop watchdog panics -> may also show as "panic"
    case ESP_RST_WDT: return "wdt";
    case ESP_RST_BROWNOUT: return "brownout";
    case ESP_RST_USB: return "usb";
    case ESP_RST_DEEPSLEEP: return "deepsleep";
    default: return "other";
  }
}

// The core's log ring (pv::LogRing, ~6 KB) in RTC no-init RAM: LP SRAM at 0x5000_0000 (16 KB on
// the C6, otherwise almost unused), so it costs no main SRAM and survives panic / watchdog /
// esp_restart resets (not a power loss). The core validates it (magic + per-line checksums).
RTC_NOINIT_ATTR static uint8_t pv_log_ring[pv::LogRing::BYTES] __attribute__((aligned(4)));

void *Esp32Hal::retainedRam(size_t *size) {
  *size = sizeof(pv_log_ring);
  return pv_log_ring;
}

uint32_t Esp32Hal::displayTimeouts() { return epd_busy_timeouts; }

void Esp32Hal::log(const char *line) { Serial.println(line); }

void Esp32Hal::logFlush() {
  // HWCDC::flush() is bounded by the TX timeout, but skip it entirely without a USB host:
  // after light sleep the CDC "connected" flag can be stale.
  if (usb_serial_jtag_is_connected()) Serial.flush();
}

uint32_t Esp32Hal::heapFree() { return ESP.getFreeHeap(); }
uint32_t Esp32Hal::heapMinFree() { return ESP.getMinFreeHeap(); }
