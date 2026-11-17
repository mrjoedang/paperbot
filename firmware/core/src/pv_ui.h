// LVGL UI for the 200x200 1-bit e-paper. The app only sets a ScreenModel; a UiLayout turns
// it into pixels. ClassicLayout (text labels) matches firmware/paperbot; BoltLayout
// (pv_bolt.h, design/bolt-variations.html "Bolt (refined)") draws the robot face.
//
// No-animation rule: a layout may only run timers / change pixels on its own while the model
// is an "awake + busy" screen (Rec, Sending). Every other screen is one static frame, so a
// sleeping device never refreshes the panel (checked by the sim's no_refresh_while_sleeping).
//
// Flush: LVGL renders RGB565 strips; each pixel becomes black when its raw RGB565 value is
// < 0x7fff (exactly the firmware's threshold - note it compares the raw 16-bit value, not
// luminance, so e.g. pure red 0xF800 renders WHITE). The 1-bit frame is handed to the HAL.
#pragma once
#include <stdint.h>
#include "lvgl.h"
#include "pv_hal.h"

namespace pv {

enum class Screen : uint8_t {
  Boot, Ready, Rec, Saved, TooShort, Sending, Result, Sent, Queued, NoSd, SdError, BadClip, Off, StillOn, Status,
  // async results (docs/device-api.md)
  Noise,        // server heard nothing usable ("didn't catch that")
  Researching,  // work item: agent running
  WorkDone,     // work item finished: detail = <=60-char summary
  Answer,       // a quick question answered: detail = the answer (<=120 bytes)
  WorkPaused,   // work item paused: daily budget hit
  WorkStopped,  // work item: agent failed / stopped
  ResultError,  // server could not process the clip (audio is safe on the server)
  ChargeMe,     // battery critical
  // firmware update (pv_ota.h)
  Updating,     // download into the other slot: detail = "v<ver>\n<n>%" (or "restarting")
  Updated,      // first boot of a new firmware: detail = "v<ver>"
  UpdateFailed, // download / install failed, or the new firmware rolled back
};
static const int SCREEN_COUNT = (int)Screen::UpdateFailed + 1;
// True for the only screens that may animate (awake and busy).
inline bool screenAnimates(Screen s) { return s == Screen::Rec || s == Screen::Sending; }

enum class BattLevel : uint8_t { Ok, Low, Critical };
const char *screenName(Screen s);

struct ScreenModel {
  Screen id = Screen::Boot;
  char title[24] = "";
  char detail[128] = "";
  char footer[48] = "";
  char kind[12] = "";      // Result: note / todo / reminder / work / unsure
  char due[24] = "";       // Result (reminder/todo): due text from the server
  int battery_pct = -1;
  uint32_t queued = 0;
  uint8_t pending = 0;     // results the device is still waiting for
  BattLevel batt = BattLevel::Ok;
  bool usb = false;
};

class UiLayout {
 public:
  virtual ~UiLayout() {}
  virtual void build(lv_obj_t *scr) = 0;              // create objects once
  virtual void apply(const ScreenModel &m, bool footer_only) = 0;  // update them
  // A layout that draws every pixel itself (no LVGL widgets) gets the panel frame buffer
  // (FB_BYTES, 1 = white) before build(), draws into it and invalidates the changed areas;
  // the flush then only hands those rows to the panel (no copy, no extra 5 KB buffer).
  virtual bool drawsFrame() const { return false; }
  virtual void setFrame(uint8_t *fb) { (void)fb; }
  virtual const char *name() const = 0;
};

// Title / detail / footer labels, as in firmware/paperbot.
class ClassicLayout : public UiLayout {
 public:
  void build(lv_obj_t *scr) override;
  void apply(const ScreenModel &m, bool footer_only) override;
  const char *name() const override { return "classic"; }

 private:
  lv_obj_t *title_ = nullptr, *detail_ = nullptr, *footer_ = nullptr;
};

static const int EPD_W = 200, EPD_H = 200, FB_BYTES = EPD_W * EPD_H / 8;

class Ui {
 public:
  bool begin(Hal &hal, UiLayout *layout = nullptr);
  void show(Screen id, const char *title, const char *detail, const char *kind = "", const char *due = "");
  // Footer + status bits; no-op if unchanged.
  void setFooter(const char *footer, int battery_pct, uint32_t queued, uint8_t pending, BattLevel batt, bool usb);
  void settle();         // render pending changes now (blocks for the e-paper refresh)
  uint32_t service();    // LVGL timer handler; returns ms until next call
  const ScreenModel &model() const { return model_; }
  const uint8_t *frame() const { return fb_; }
  uint32_t refreshes() const { return refreshes_; }
  const UiLayout *layout() const { return layout_; }

 private:
  static void flushCb(lv_display_t *disp, const lv_area_t *area, uint8_t *px);
  static uint32_t serviceCb(void *self) { return ((Ui *)self)->service(); }
  Hal *hal_ = nullptr;
  UiLayout *layout_ = nullptr;
  ClassicLayout classic_;
  ScreenModel model_;
  uint8_t fb_[FB_BYTES];
  int dirty_y1_ = EPD_H, dirty_y2_ = -1;
  uint32_t refreshes_ = 0;
};

}  // namespace pv
