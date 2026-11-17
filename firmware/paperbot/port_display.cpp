#include <stdio.h>
#include <string.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <esp_log.h>
#include <esp_heap_caps.h>
#include <driver/spi_master.h>
#include <driver/gpio.h>
#include <esp_lcd_panel_io.h>
#include <esp_lcd_panel_vendor.h>
#include <esp_lcd_panel_ops.h>
#include <esp_timer.h>
#include "port_display.h"
#include "epaper_config.h"

#define TAG "display"
#define BUFFER_SIZE (EPD_WIDTH * EPD_HEIGHT / 8)

static uint8_t *buffer = NULL;
static esp_lcd_panel_io_handle_t io_handle;

const uint8_t WF_Full_1IN54[159] = {
  0x80, 0x48, 0x40, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0,
  0x40, 0x48, 0x80, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0,
  0x80, 0x48, 0x40, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0,
  0x40, 0x48, 0x80, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0,
  0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0xA,
  0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x8, 0x1, 0x0, 0x8, 0x1, 0x0, 0x2,
  0xA, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0,
  0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0,
  0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0,
  0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0,
  0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0, 0x0,
  0x0, 0x0, 0x0, 0x0, 0x0, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x0,
  0x0, 0x0, 0x22, 0x17, 0x41, 0x0, 0x32, 0x20
};

unsigned char WF_PARTIAL_1IN54[159] = {
  0x0,
  0x40,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x80,
  0x80,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x40,
  0x40,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x80,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0xF,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x1,
  0x1,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x0,
  0x22,
  0x22,
  0x22,
  0x22,
  0x22,
  0x22,
  0x0,
  0x0,
  0x0,
  0x02,
  0x17,
  0x41,
  0xB0,
  0x32,
  0x28,
};

void set_rst_1() {
  gpio_set_level(EPD_RST_PIN, 1);
}
void set_rst_0() {
  gpio_set_level(EPD_RST_PIN, 0);
}

// paperbot: bounded wait. The original loops forever if BUSY never drops, which
// would wedge the LVGL task while it holds the UI lock (suspected power_proto sleep hang).
volatile uint32_t epd_busy_timeouts = 0;
void read_busy() {
  int64_t t0 = esp_timer_get_time();
  while (gpio_get_level(EPD_BUSY_PIN) == 1) {  //LOW: idle, HIGH: busy
    if (esp_timer_get_time() - t0 > 4000000) {  // full refresh is ~2 s
      epd_busy_timeouts = epd_busy_timeouts + 1;
      return;
    }
    vTaskDelay(pdMS_TO_TICKS(5));
  }
}

// Copies a 200x200 1-bit frame (same layout as the driver buffer: row-major, MSB = left,
// 1 = white) into the panel buffer.
void EPD_CopyFrame(const uint8_t *fb, int y1, int y2) {
  if (!buffer || y1 < 0 || y2 >= EPD_HEIGHT || y1 > y2) return;
  memcpy(buffer + y1 * (EPD_WIDTH / 8), fb + y1 * (EPD_WIDTH / 8), (y2 - y1 + 1) * (EPD_WIDTH / 8));
}

void PortDisplay_Init() {
  buffer = (uint8_t *)heap_caps_malloc(BUFFER_SIZE, MALLOC_CAP_DEFAULT);
  ESP_LOGI(TAG, "Initialize SPI");
  esp_err_t ret;
  spi_bus_config_t buscfg = {};
  buscfg.miso_io_num = EPD_MISO_PIN;
  buscfg.mosi_io_num = EPD_MOSI_PIN;
  buscfg.sclk_io_num = EPD_SCK_PIN;
  buscfg.quadwp_io_num = -1;
  buscfg.quadhd_io_num = -1;
  buscfg.max_transfer_sz = EPD_WIDTH * EPD_HEIGHT;
  ret = spi_bus_initialize((spi_host_device_t)EPD_SPI_NUM, &buscfg, SPI_DMA_CH_AUTO);
  ESP_ERROR_CHECK(ret);

  esp_lcd_panel_io_spi_config_t io_config = {};
  io_config.dc_gpio_num = EPD_DC_PIN;
  io_config.cs_gpio_num = EPD_CS_PIN;
  io_config.pclk_hz = 40 * 1000 * 1000;
  io_config.lcd_cmd_bits = 8;
  io_config.lcd_param_bits = 8;
  io_config.spi_mode = 0;
  io_config.trans_queue_depth = 2;
  ESP_ERROR_CHECK(esp_lcd_new_panel_io_spi((esp_lcd_spi_bus_handle_t)EPD_SPI_NUM, &io_config, &io_handle));


  gpio_config_t gpio_conf = {};
  gpio_conf.intr_type = GPIO_INTR_DISABLE;
  gpio_conf.mode = GPIO_MODE_OUTPUT;
  gpio_conf.pin_bit_mask = (0x1ULL << EPD_RST_PIN);
  gpio_conf.pull_down_en = GPIO_PULLDOWN_DISABLE;
  gpio_conf.pull_up_en = GPIO_PULLUP_ENABLE;
  ESP_ERROR_CHECK_WITHOUT_ABORT(gpio_config(&gpio_conf));

  gpio_conf.mode = GPIO_MODE_INPUT;
  gpio_conf.pin_bit_mask = (0x1ULL << EPD_BUSY_PIN);
  ESP_ERROR_CHECK_WITHOUT_ABORT(gpio_config(&gpio_conf));

  set_rst_1();
}

// The SD card shares this SPI bus (driven from other tasks). The SPI driver does not serialise
// the e-paper's queued (DMA) transfers against the SD driver's polling ones, so every e-paper
// transfer holds pv_spi_lock() and bulk writes wait for completion before releasing it.
// BUSY waits (read_busy) stay outside the lock so SD writes continue during a refresh.
static SemaphoreHandle_t spi_mux;

extern "C" void pv_spi_lock() {
  if (!spi_mux) spi_mux = xSemaphoreCreateRecursiveMutex();
  xSemaphoreTakeRecursive(spi_mux, portMAX_DELAY);
}

extern "C" void pv_spi_unlock() { xSemaphoreGiveRecursive(spi_mux); }

void EPD_SendData(uint8_t data) {
  pv_spi_lock();
  ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(io_handle, -1, &data, 1));
  pv_spi_unlock();
}

void EPD_SendCommand(uint8_t command) {
  pv_spi_lock();
  ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(io_handle, command, NULL, 0));
  pv_spi_unlock();
}

void writeBytes(uint8_t *buffer, int len) {
  pv_spi_lock();
  ESP_ERROR_CHECK(esp_lcd_panel_io_tx_color(io_handle, -1, buffer, len));
  ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(io_handle, -1, NULL, 0));  // no-op that waits for the queued DMA
  pv_spi_unlock();
}

void writeBytes(const uint8_t *buffer, int len) {
  pv_spi_lock();
  ESP_ERROR_CHECK(esp_lcd_panel_io_tx_color(io_handle, -1, buffer, len));
  ESP_ERROR_CHECK(esp_lcd_panel_io_tx_param(io_handle, -1, NULL, 0));  // no-op that waits for the queued DMA
  pv_spi_unlock();
}

void EPD_SetWindows(uint16_t Xstart, uint16_t Ystart, uint16_t Xend, uint16_t Yend) {
  EPD_SendCommand(0x44);  // SET_RAM_X_ADDRESS_START_END_POSITION
  EPD_SendData((Xstart >> 3) & 0xFF);
  EPD_SendData((Xend >> 3) & 0xFF);

  EPD_SendCommand(0x45);  // SET_RAM_Y_ADDRESS_START_END_POSITION
  EPD_SendData(Ystart & 0xFF);
  EPD_SendData((Ystart >> 8) & 0xFF);
  EPD_SendData(Yend & 0xFF);
  EPD_SendData((Yend >> 8) & 0xFF);
}

void EPD_SetCursor(uint16_t Xstart, uint16_t Ystart) {
  EPD_SendCommand(0x4E);  // SET_RAM_X_ADDRESS_COUNTER
  EPD_SendData(Xstart & 0xFF);

  EPD_SendCommand(0x4F);  // SET_RAM_Y_ADDRESS_COUNTER
  EPD_SendData(Ystart & 0xFF);
  EPD_SendData((Ystart >> 8) & 0xFF);
}

void EPD_SetLut(const uint8_t *lut) {
  EPD_SendCommand(0x32);
  writeBytes(lut, 153);
  read_busy();

  EPD_SendCommand(0x3f);
  EPD_SendData(lut[153]);

  EPD_SendCommand(0x03);
  EPD_SendData(lut[154]);

  EPD_SendCommand(0x04);
  EPD_SendData(lut[155]);
  EPD_SendData(lut[156]);
  EPD_SendData(lut[157]);

  EPD_SendCommand(0x2c);
  EPD_SendData(lut[158]);
}

void EPD_TurnOnDisplay() {
  EPD_SendCommand(0x22);
  EPD_SendData(0xc7);
  EPD_SendCommand(0x20);
  read_busy();
}

void EPD_TurnOnDisplayPart() {
  EPD_SendCommand(0x22);
  EPD_SendData(0xcf);
  EPD_SendCommand(0x20);
  read_busy();
}

void EPD_Init() {
  set_rst_1();
  vTaskDelay(pdMS_TO_TICKS(50));
  set_rst_0();
  vTaskDelay(pdMS_TO_TICKS(20));
  set_rst_1();
  vTaskDelay(pdMS_TO_TICKS(50));

  read_busy();
  EPD_SendCommand(0x12);  //SWRESET
  read_busy();

  EPD_SendCommand(0x01);  //Driver output control
  EPD_SendData(0xC7);
  EPD_SendData(0x00);
  EPD_SendData(0x01);

  EPD_SendCommand(0x11);  //data entry mode
  EPD_SendData(0x01);

  EPD_SetWindows(0, EPD_WIDTH - 1, EPD_HEIGHT - 1, 0);

  EPD_SendCommand(0x3C);  //BorderWavefrom
  EPD_SendData(0x01);

  EPD_SendCommand(0x18);
  EPD_SendData(0x80);

  EPD_SendCommand(0x22);  //Load Temperature and waveform setting.
  EPD_SendData(0XB1);
  EPD_SendCommand(0x20);

  EPD_SetCursor(0, EPD_HEIGHT - 1);
  read_busy();

  EPD_SetLut(WF_Full_1IN54);
}

void EPD_Clear() {
  memset(buffer, 0xff, BUFFER_SIZE);
}

void EPD_Display() {
  EPD_SendCommand(0x24);
  assert(buffer);
  writeBytes(buffer, BUFFER_SIZE);
  EPD_TurnOnDisplay();
}

void EPD_DisplayPartBaseImage() {
  EPD_SendCommand(0x24);
  assert(buffer);
  writeBytes(buffer, BUFFER_SIZE);
  EPD_SendCommand(0x26);
  writeBytes(buffer, BUFFER_SIZE);
  EPD_TurnOnDisplay();
}

void EPD_Init_Partial() {
  set_rst_1();
  vTaskDelay(pdMS_TO_TICKS(50));
  set_rst_0();
  vTaskDelay(pdMS_TO_TICKS(20));
  set_rst_1();
  vTaskDelay(pdMS_TO_TICKS(50));

  read_busy();

  EPD_SetLut(WF_PARTIAL_1IN54);

  EPD_SendCommand(0x37);
  EPD_SendData(0x00);
  EPD_SendData(0x00);
  EPD_SendData(0x00);
  EPD_SendData(0x00);
  EPD_SendData(0x00);
  EPD_SendData(0x40);
  EPD_SendData(0x00);
  EPD_SendData(0x00);
  EPD_SendData(0x00);
  EPD_SendData(0x00);

  EPD_SendCommand(0x3C);  //BorderWavefrom
  EPD_SendData(0x80);

  EPD_SendCommand(0x22);
  EPD_SendData(0xc0);
  EPD_SendCommand(0x20);
  read_busy();
}

void EPD_DisplayPart() {
  EPD_SendCommand(0x24);
  assert(buffer);
  writeBytes(buffer, 5000);
  EPD_TurnOnDisplayPart();
}

void EPD_DrawColorPixel(uint16_t x, uint16_t y, uint8_t color) {
  if (x >= EPD_WIDTH || y >= EPD_HEIGHT) {
    ESP_LOGE("EPD", "Out of bounds pixel: (%d,%d)", x, y);
    return;
  }

  uint16_t index = y * 25 + (x >> 3);  //25是200/8
  uint8_t bit = 7 - (x & 0x07);
  if (color == DRIVER_COLOR_WHITE) {
    buffer[index] |= (0x01 << bit);
  } else {
    buffer[index] &= ~(0x01 << bit);
  }
}


void PortLvgl_Start_Init() {
  PortDisplay_Init();
  EPD_Init();
  EPD_Clear();
  EPD_DisplayPartBaseImage();
  EPD_Init_Partial();  //局部刷新初始化
}