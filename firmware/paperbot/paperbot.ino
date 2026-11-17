// Pocket voice on the hardware-independent core (firmware/core) + the ESP32-C6 HAL.
// Same behaviour as tests/power_proto (hold BOOT to record, queue on SD, upload when Wi-Fi is
// reachable, light sleep in between, PWR long-press = off) without its soak/test commands.
// Clips go to /sdcard/REC with production-style names, so this build drains the production
// firmware's queue too. Logic is exercised on the Mac by sim/ (make sim / make sim-test).
//
// Serial commands while awake (20 s after reset or a short PWR press):
//   sim [ms]   simulated recording (real mic, fake button)     stay 0|1   stay awake
//   sleep      sleep now          stat   status line            beep
//   check      check results now  ota    firmware check + install now (pv_ota.h)
//   info       @{json} device id, setup state, last network result (pocketbot setup)
//   prov server <url> | prov token <t> | prov wifi <json> | prov done | prov reset   (setup over USB)
#include <Arduino.h>
#include "pv_core.h"
#include "esp32_hal.h"
#include "pv_secrets.h"  // SERVER_URL (and Wi-Fi / token, used by the HAL); empty in a release build

// Screen layout: Bolt robot face (default) or the old text layout with -DPV_UI_CLASSIC=1.
#ifndef PV_UI_CLASSIC
#define PV_UI_CLASSIC 0
#endif

SET_LOOP_TASK_STACK_SIZE(16 * 1024);

// OTA rollback: arduino-esp32 marks a freshly installed (pending-verify) image valid in
// initArduino() unless this returns true. The core confirms it itself once healthy
// (pv::Ota::maybeConfirm); a reset before that makes the bootloader roll back.
extern "C" bool verifyRollbackLater() { return true; }

// Version marker that tools/ota/release.sh looks for in the binary before signing it.
extern "C" __attribute__((used)) const char pv_fw_tag[] = "PVFW-VERSION:" PV_FW_VERSION ";";

static Esp32Hal hal;
static pv::Config cfg;
static pv::App *app = nullptr;
static char line[2560];  // "prov wifi <json>" carries the whole Wi-Fi list (<= 2 KB)
static size_t line_len = 0;

static void pollSerial() {
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\n' || ch == '\r') {
      line[line_len] = 0;
      if (line_len) app->command(line);
      line_len = 0;
    } else if (line_len < sizeof(line) - 1) {
      line[line_len++] = ch;
    }
  }
}

void setup() {
  hal.begin();
  hal.log(pv_fw_tag);  // also keeps the marker in the image (the linker drops unreferenced data)
  cfg.queue.server_url = SERVER_URL;
  cfg.queue.rec_dir = "/REC";
  // On a computer's USB, power is free: stay awake so the console and flashing keep working
  // (light sleep stops the USB-Serial/JTAG). Wall chargers aren't USB hosts, so it still sleeps there.
  cfg.skip_sleep_on_usb = true;
  static pv::App the_app(hal, cfg);  // static: ~40 KB (ring buffer) must not live on the stack
  app = &the_app;
#if PV_UI_CLASSIC
  app->setup();
#else
  static pv::BoltLayout bolt;  // draws into the UI frame buffer (no extra RAM to speak of)
  app->setup(&bolt);
#endif
}

void loop() {
  pollSerial();
  app->loop();
}
