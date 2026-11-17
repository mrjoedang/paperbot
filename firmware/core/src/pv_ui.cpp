#include "pv_ui.h"
#include <stdio.h>
#include <string.h>

LV_FONT_DECLARE(lv_font_montserratMedium_25)
LV_FONT_DECLARE(lv_font_montserratMedium_16)

namespace pv {

const char *screenName(Screen s) {
  static const char *names[] = { "BOOT",  "READY",       "REC",       "SAVED",       "TOO_SHORT",    "SENDING",
                                 "RESULT", "SENT",       "QUEUED",    "NO_SD",       "SD_ERROR",     "BAD_CLIP",
                                 "OFF",   "STILL_ON",    "STATUS",    "NOISE",       "RESEARCHING",  "WORK_DONE",   "ANSWER",
                                 "WORK_PAUSED", "WORK_STOPPED", "RESULT_ERROR", "CHARGE_ME",
                                 "UPDATING", "UPDATED", "UPDATE_FAILED" };
  static_assert(sizeof(names) / sizeof(names[0]) == SCREEN_COUNT, "screen names");
  return names[(int)s];
}

// ---------- classic layout ----------
static lv_obj_t *makeLabel(lv_obj_t *scr, const lv_font_t *font, int y) {
  lv_obj_t *label = lv_label_create(scr);
  lv_obj_set_style_text_font(label, font, 0);
  lv_obj_set_style_text_color(label, lv_color_hex(0x000000), 0);
  lv_obj_set_width(label, 190);
  lv_obj_set_style_text_align(label, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_align(label, LV_ALIGN_TOP_MID, 0, y);
  return label;
}

void ClassicLayout::build(lv_obj_t *scr) {
  title_ = makeLabel(scr, &lv_font_montserratMedium_25, 20);
  detail_ = makeLabel(scr, &lv_font_montserratMedium_16, 60);
  lv_label_set_long_mode(detail_, LV_LABEL_LONG_DOT);
  lv_obj_set_height(detail_, 110);
  footer_ = makeLabel(scr, &lv_font_montserratMedium_16, 176);
  lv_label_set_text(title_, "");
  lv_label_set_text(detail_, "");
  lv_label_set_text(footer_, "");
}

void ClassicLayout::apply(const ScreenModel &m, bool footer_only) {
  if (!footer_only) {
    lv_label_set_text(title_, m.title);
    lv_label_set_text(detail_, m.detail);
  }
  lv_label_set_text(footer_, m.footer);
}

// ---------- Ui ----------
static Hal *tick_hal = nullptr;
static uint32_t tickCb() { return (uint32_t)tick_hal->millis(); }

alignas(4) static uint8_t draw_buf[EPD_W * 40 * 2];  // 40-row RGB565 strips (saves RAM for Wi-Fi/TLS)

bool Ui::begin(Hal &hal, UiLayout *layout) {
  hal_ = &hal;
  layout_ = layout ? layout : &classic_;
  memset(fb_, 0xff, sizeof(fb_));
  tick_hal = &hal;
  lv_init();
  lv_tick_set_cb(tickCb);
  lv_display_t *disp = lv_display_create(EPD_W, EPD_H);
  lv_display_set_user_data(disp, this);
  lv_display_set_flush_cb(disp, flushCb);
  lv_display_set_buffers(disp, draw_buf, NULL, sizeof(draw_buf), LV_DISPLAY_RENDER_MODE_PARTIAL);
  lv_obj_t *scr = lv_obj_create(NULL);
  lv_obj_set_style_bg_color(scr, lv_color_hex(0xffffff), 0);
  lv_obj_set_scrollbar_mode(scr, LV_SCROLLBAR_MODE_OFF);
  if (layout_->drawsFrame()) layout_->setFrame(fb_);
  layout_->build(scr);
  lv_screen_load(scr);
  hal.startUiTask(serviceCb, this);
  return true;
}

void Ui::flushCb(lv_display_t *disp, const lv_area_t *area, uint8_t *px) {
  Ui *ui = (Ui *)lv_display_get_user_data(disp);
  const uint16_t *p = (const uint16_t *)px;
  if (!ui->layout_->drawsFrame())  // else the layout already drew into fb_
    for (int y = area->y1; y <= area->y2; y++)
      for (int x = area->x1; x <= area->x2; x++, p++) {
        if (x < 0 || y < 0 || x >= EPD_W || y >= EPD_H) continue;
        uint8_t bit = 0x80 >> (x & 7);
        uint8_t &b = ui->fb_[y * (EPD_W / 8) + x / 8];
        if (*p < 0x7fff) b &= ~bit;  // black
        else b |= bit;               // white
      }
  if (area->y1 < ui->dirty_y1_) ui->dirty_y1_ = area->y1;
  if (area->y2 > ui->dirty_y2_) ui->dirty_y2_ = area->y2;
  if (lv_display_flush_is_last(disp)) {
    ui->refreshes_++;
    ui->hal_->displayRefresh(ui->fb_, ui->dirty_y1_ < 0 ? 0 : ui->dirty_y1_, ui->dirty_y2_ >= EPD_H ? EPD_H - 1 : ui->dirty_y2_);
    ui->dirty_y1_ = EPD_H;
    ui->dirty_y2_ = -1;
  }
  lv_display_flush_ready(disp);
}

void Ui::show(Screen id, const char *title, const char *detail, const char *kind, const char *due) {
  model_.id = id;
  snprintf(model_.title, sizeof(model_.title), "%s", title);
  snprintf(model_.detail, sizeof(model_.detail), "%s", detail);
  snprintf(model_.kind, sizeof(model_.kind), "%s", kind ? kind : "");
  snprintf(model_.due, sizeof(model_.due), "%s", due ? due : "");
  if (hal_->uiLock(-1)) {
    layout_->apply(model_, false);
    hal_->uiUnlock();
  }
}

void Ui::setFooter(const char *footer, int battery_pct, uint32_t queued, uint8_t pending, BattLevel batt, bool usb) {
  if (!strcmp(footer, model_.footer) && battery_pct == model_.battery_pct && queued == model_.queued && pending == model_.pending &&
      batt == model_.batt && usb == model_.usb)
    return;
  snprintf(model_.footer, sizeof(model_.footer), "%s", footer);
  model_.battery_pct = battery_pct;
  model_.queued = queued;
  model_.pending = pending;
  model_.batt = batt;
  model_.usb = usb;
  if (hal_->uiLock(-1)) {
    layout_->apply(model_, true);
    hal_->uiUnlock();
  }
}

void Ui::settle() {
  // Bounded wait: if the UI task is stuck in an e-paper refresh we would rather skip a
  // frame than hang before sleeping (suspected cause of the power_proto sleep hang).
  if (hal_->uiLock(5000)) {
    lv_refr_now(NULL);
    hal_->uiUnlock();
  } else {
    hal_->log("WARN,ui settle lock timeout");
  }
}

uint32_t Ui::service() {
  uint32_t ms = 500;
  if (hal_->uiLock(-1)) {
    ms = lv_timer_handler();
    hal_->uiUnlock();
  }
  if (ms > 500) ms = 500;
  if (ms < 50) ms = 50;
  return ms;
}

}  // namespace pv
