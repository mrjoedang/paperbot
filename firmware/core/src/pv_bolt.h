// "Bolt (refined)" layout from design/bolt-variations.html (variant V1): robot head with an
// expression per state, cloud / queue status top-left, battery % top-right, text in the bottom
// third in the design's 5x7 pixel font. Drawn with pv::Gfx (a port of the design's drawing
// code) straight into the Ui's 1-bit panel frame; only changed 20-row bands are invalidated,
// so e.g. a battery % change is a small partial refresh.
//
// Animation (frames advance once per second) only on Rec (talking mouth, blinking antenna,
// sound waves, seconds counter) and Sending (looking eyes, signal antenna, "thinking..."). The
// timer is paused on every other screen: READY is one static frame (closed eyes + "z z Z").
//
// RAM: 40 B band hashes + the model copy (~250 B); no LVGL widgets, no extra frame buffer.
#pragma once
#include "pv_gfx.h"
#include "pv_ui.h"

namespace pv {

class BoltLayout : public UiLayout {
 public:
  void build(lv_obj_t *scr) override;
  void apply(const ScreenModel &m, bool footer_only) override;
  bool drawsFrame() const override { return true; }
  void setFrame(uint8_t *fb) override { fb_ = fb; }
  const char *name() const override { return "bolt"; }
  uint32_t frame() const { return frame_; }

  // Renders model m (animation frame f, recording seconds sec) into a 1-bit buffer
  // (FB_BYTES; 1 = black, or 1 = white for the panel frame). Pure: layout, tests, tools.
  static void render(uint8_t *bits, const ScreenModel &m, uint32_t f, uint32_t sec, bool white_is_1 = false);

 private:
  void redraw();
  static void timerCb(lv_timer_t *t);
  uint8_t *fb_ = nullptr;
  static const int BANDS = 10, BAND_ROWS = EPD_H / BANDS;
  uint32_t band_hash_[BANDS] = {};
  bool drawn_ = false;
  lv_obj_t *scr_ = nullptr;
  lv_timer_t *timer_ = nullptr;
  ScreenModel m_;
  uint32_t frame_ = 0, rec_start_ = 0;
};

}  // namespace pv
