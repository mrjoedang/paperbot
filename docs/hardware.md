# Hardware notes

Waveshare **ESP32-C6 1.54" e-Paper AIoT board** (ESP32-C6, 16 MB flash, no PSRAM, 200×200 1-bit
e-paper, ES8311 codec + onboard mic + speaker amp, TCA9554 I/O expander, microSD, ETA6098 charger,
MX1.25 battery — believed 400 mAh). Docs: https://docs.waveshare.com/ESP32-C6-ePaper-1.54,
schematic: `vendor/waveshare/04_Schematic/`.

## Buttons

| Case symbol | Name | GPIO | Use |
|---|---|---|---|
| ☀ | BOOT | 9 | hold to record; held at power-on = download mode |
| ⏻ | PWR | 2 | tap = sync/retry now (+ wakes 20 s); hold ≥2 s = power off (on battery); when off (held off, or 4 h unused): press until it starts (~3 s to READY) |

There is **no RESET button**.

## Pins / power

- I²C SDA 18 / SCL 8 · I²S MCLK 19, BCLK 21, WS 22, DIN 20, DOUT 23 (ES8311).
- E-paper and SD share SPI2: SCK 6, MOSI 5, MISO 4; EPD CS 7, DC 15, RST 11, BUSY 10; SD CS 3.
- Expander: EXIO0 EPD power, EXIO1 audio power, EXIO3 speaker amp (on only while beeping),
  EXIO4 LED (active low), EXIO5 battery latch (must be set high at boot or the board only
  stays on while ⏻ is held on battery).
- Battery voltage: GPIO0 (ADC1 ch0, 12 dB, ×2 divider). Re-create the ADC unit after light sleep.

## Quirks learned the hard way

- **USB-Serial/JTAG + opening the port:** opening it with DTR asserted plus an RTS edge drops
  the chip into download mode, and the strap stays latched until a real power cycle.
  `tools/bootlog.py` / `devcmd.py` open with DTR/RTS released — use them, not a generic monitor.
- **Light sleep turns USB off**, so a sleeping board can't be flashed. The firmware never
  sleeps while a USB host has been seen in the last 60 s; if it fell asleep anyway, tap ⏻.
- **SD + e-paper share SPI.** The SPI driver doesn't serialise the e-paper's queued DMA against
  the SD driver; every access takes `pv_spi_lock()` (crash otherwise: `spi_hal_setup_trans`).
- **Wi-Fi restart:** the HAL stops the radio with `esp_wifi_stop()` between sessions; it must call
  `esp_wifi_start()` again before `WiFi.begin()` (Arduino thinks it's still in STA mode).
- TLS needs ~45 KB; min free heap during uploads is ~60–75 KB. Keep RAM growth small.
- BOOT (GPIO9) can't wake from deep sleep (only LP GPIO 0–7), hence light sleep.
- **Battery latch costs ~2.5 mA** whenever it runs on battery: EXIO5 drives T2's base through R64
  (1 kΩ, R66 10 kΩ to GND). Only a resistor swap fixes it (≤ ~33 kΩ, or T2 no longer switches).
- **Audio rail (EXIO1) off ≠ codec off:** the ES8311 is back-powered through the shared I2C pull-ups
  and keeps answering on the bus. The firmware uses codec standby instead (close/open: 5 ms / 24 ms,
  first live samples 6 ms later; the first ~80 ms after a reopen carry a settling thump).

## Recovery (board not showing up on USB)

1. Unplug USB **and** the battery connector (the latch can keep it powered), wait 5 s.
2. Reconnect the battery. **Hold ☀**, plug USB into the Mac, keep holding ~2 s, release.
3. It's now in download mode (`/dev/cu.usbmodem*` appears): `make flash`.
4. After flashing, power-cycle once (unplug/replug, no buttons) — a soft reset keeps the
   download-mode strap latched.

A full factory image is in Waveshare's repo: `vendor/waveshare/03_Firmware/`.
