# Pocket voice simulator

Runs the real device logic (`firmware/core`, the same C++ that `firmware/paperbot`
builds for the ESP32-C6) on the Mac against a virtual board: virtual clock with time warp,
folder SD card, WAV/tone "microphone", real HTTP with fault injection, battery/energy model,
heap accounting, and the LVGL screen rendered to the same 1-bit frame the e-paper gets.

```sh
make sim          # mock server + simulator, opens http://localhost:8090
make sim-test     # 65 headless scenarios -> build/sim-test/report.html
make sim-test SCENARIO="soak_offline_30 idle_day"   # just some
make core-esp32   # compile firmware/paperbot for the board (no flashing)
sh sim/tools/bolt_compare.sh   # Bolt layout vs design/bolt-variations.html, pixel by pixel (needs node)
```

The device talks the **planned async server contract** (PUT → 202 receipt, result via GET; see
[`docs/device-api.md`](../docs/device-api.md)) and still works with the current synchronous server.

Requirements: Xcode clang, `make`, `python3` (stdlib only). libcurl and zlib come with macOS.
First build compiles LVGL (~10 s with `-j`).

Setup testing: `build/sim/pvsim --serve --generic --usb --serial-pty build/sim-serial --server <worker>` starts
a board with the release image (no server / token / Wi-Fi) whose serial console is a pseudo-terminal;
`make e2e` sets one up through `/setup`, its console bridged to the page's `navigator.serial`
(tools/e2e/accounts.mjs, docs/setup.md). Scenarios named `setup_*` run as the release image too.

## Layout

| Path | What |
|---|---|
| `firmware/core/src/` | Portable core (Arduino library + host build). `pv_hal.h` HAL, `pv_app.*` state machine + network policy, `pv_recorder.*` ring → WAV writer, `pv_queue.*` upload queue / ids / repair, `pv_results.*` result replies + persisted pending-results list + check schedule, `pv_util.*` battery % / level, backoff, WAV header, SPSC ring, sleep decision, `pv_json.*` strict no-alloc JSON reader, `pv_status.*` status report (crash-surviving log ring + ≤ 2 KB JSON builder), `pv_wifi.*` Wi-Fi list (NVS) + connect strategy, `pv_ui.*` screen model + LVGL + 1-bit flush, `pv_bolt.*` Bolt layout, `pv_gfx.*` 1-bit drawing (port of the design's JS) + 5×7 font |
| `firmware/paperbot/` | Sketch: `esp32_hal.*` (power_proto's hardware paths behind the HAL) + `build.sh` |
| `sim/src/sim.*` | Simulator HAL (virtual clock, buttons, audio, FS, curl, faults, energy, heap) |
| `sim/src/web.cpp`, `sim/web/index.html` | Browser UI + JSON API (cpp-httplib, localhost only) |
| `sim/src/scenarios.cpp` | Headless scenarios with assertions + PNG screenshots |
| `sim/mock_server.py` | Stand-in for the server: async contract (and legacy sync mode), virtual-time processing / research, PUT + GET fault scripting |
| `sim/tools/bolt_compare.sh` | Renders the design's `drawV1()` in node and diffs it with `pvsim --bolt-dump` |
| `sim/third_party/cpp-httplib` | Vendored v0.18.3 (MIT, LICENSE included) |

## Browser UI

- Screen: the exact 1-bit frame (black when the RGB565 value < 0x7fff, as in the firmware flush).
- BOOT / PWR support press-and-hold (mouse, touch, or keys **space** = BOOT, **p** = PWR); RESET reboots
  (SD card contents survive, like the board).
- Time: awake speed (virtual ms per wall ms) and sleep warp (600x = a 15 min sleep in 1.5 s; "jump").
- Audio source: files in `sim/audio/`, tones, noise, silence. Each clip hears
  the source from its start.
- Power: USB flag (keeps the board alive after the latch is released), battery voltage slider.
- Device faults: Wi-Fi AP missing / wrong password / association hang, DNS failure, HTTP timeout,
  extra latency, SD missing (applies on RESET), SD write failure, emulated Wi-Fi heap leak.
- Layout: Bolt (default) or classic text; switching re-boots the device (SD kept).
- Mock server · contract: async (202 + GET) or legacy sync (200 task), `/v1/updates` on/off, kind
  (rotate / note / todo / reminder / shopping / done / removed / answer / work / unsure / noise / error), processing time (1.5 s = inside
  the device's poll window, 20 s = late, 5 min, 1 h), work research time and outcome (done /
  paused: budget / stopped), "GET 404 for N ms after the PUT" (eventual consistency). All times are
  virtual: the sim sends its clock in `X-Sim-Now-Ms`, so a 10 min research takes 10 virtual minutes.
- Mock server · faults: next PUT 500/401/400/bad JSON/dropped reply, always 503; next GET
  500/404/dropped, slow GETs (20 s), GETs always 503; status: want log / 404 (old server) / slow
  (20 s); healthy; reset. The panel lists recent server records with their current status.
- Wi-Fi places: where the device is (home / venue / street), the access points (home = the
  built-in network, "Venue Guest", an unknown open "Cafe Open", the phone hotspot "Joe’s iPhone 15 Pro"
  that goes everywhere) with on/off switches, which one is joined, HTTP requests vs TLS handshakes,
  a keep-alive switch, and mock presets for the server's Wi-Fi list (rev 1 / rev 2 / malformed).
- Panels: state (incl. waiting results, next check, battery level, check counters, **refreshes
  asleep** - must stay 0), "Waiting for results" (the persisted pending list), queue, counters,
  modelled heap / LVGL pool / open files, energy estimate, SD files, log, **Status reports**
  (count sent / ok / failed / skipped, reset reason, the last body as sent incl. its log lines).

API (for scripts): `GET /api/state`, `GET /api/frame` (5000 bytes) or `/api/frame.png?scale=3`,
`GET /api/log?since=N`, `POST /api/button?name=boot|pwr|reset&action=down|up`,
`POST /api/set?key=...&value=...` (keys as in the UI: `usb`, `battery_mv`, `speed`, `sleep_warp`,
`wifi_offline`, `dns_fail`, `audio`, `ui` (bolt|classic), `cmd` (e.g. `check` = check results now), ...),
`GET|POST /api/mock` (mock control proxy; POST body = JSON merged into the mock config, see the
header of `sim/mock_server.py`).
With curl send a body on POSTs (`curl -d '' ...`), otherwise the server waits for one.

Example (what was used to check the loop end-to-end):

```sh
B=http://localhost:8090
curl -d '' "$B/api/button?name=boot&action=down"; sleep 3; curl -d '' "$B/api/button?name=boot&action=up"
sleep 4; curl -s $B/api/state | python3 -m json.tool | head; curl -s "$B/api/frame.png" -o screen.png
```

## Targets other than the mock

- `SIM_ARGS="--server http://127.0.0.1:8787 --token-env PV_TOKEN" make sim` - `wrangler dev` of `server/`
  (token from the environment variable you name).
- `SIM_ARGS="--prod" make sim` - the production Worker. Reads `DEVICE_TOKEN` from `.secrets.env` at
  runtime (never printed or written) and prefixes clip ids with `sim-` so they are recognisable.
  This creates real tasks and Workers AI usage; scenarios are meant for the mock only.

## Scenarios (`make sim-test`)

| Scenario | Checks |
|---|---|
| record_upload | READY → REC → SENDING → routed result; WAV length = hold; header patched; deleted after 2xx; sleeps; beeps |
| too_short | 0.3 s and 0.59 s taps → TOO SHORT, nothing queued/uploaded; 0.7 s accepted |
| pwr_off_battery | PWR ≥ 2 s → OFF, latch released → power cut; stays off; PWR boots again (power-on hold not a press) |
| pwr_off_usb | same on USB → STILL ON; short PWR → status |
| server_500_retry | 500, 503, then OK; retries at +30 s and +60 s; one task; backoff reset |
| http_4xx | 401 keeps the clip and retries; 413 sets it aside |
| malformed_json | truncated JSON / `{}` with 200 keep the clip; backoff grows; recovers; server dedupes |
| no_sd | NO SD screen; BOOT ignored; still sleeps with only timer wakes; RESET after insert → READY |
| dns_timeout | DNS failure and HTTP timeout → QUEUED, retried, recovers |
| bad_wifi | wrong password / association hang → QUEUED; recovers |
| dropped_reply | server stores but the reply is lost → retry gets `duplicate`, one task, clip deleted |
| poison_clip | non-WAV and empty files in the queue are set aside; newer clips still upload |
| power_cut_recording | battery cut mid-recording → header repaired at boot → uploaded with the audio |
| boot_during_upload | BOOT during a 3-clip upload session → recording starts after the in-flight request |
| soak_offline_30 | 30 cycles, 50 % offline: no stuck state, queue drains, every clip once, heap + LVGL pool flat, no open files |
| leak_detector | negative control: injected 450 B / Wi-Fi session is flagged by the same heap check |
| idle_day | 24 h idle in < 1 s: 96 timer wakes, battery drain model, refreshes only on footer change, energy estimate |
| auto_power_off | battery, 4 h unused (no recording / PWR / start / USB host) → OFF, latch released, leakage only; PWR → READY ~3 s; a recording, a PWR tap, USB restart the 4 h; a queued clip does not keep it on (uploaded at the next start); pending result checks do |
| auto_off_ota | used once a day, off in between: a release still installs during the on-time; never off while a new image is unconfirmed |
| codec_standby | timer wakes leave the codec closed; BOOT reopens it (start beep +30 ms), clip = hold − ~110 ms, one reopen per use, less energy than codec running |
| battery_day | day budget (model, calibrated to the board's 9 mA): 5 memos 3 h apart / idle / offline vs the codec-running never-off firmware |
| async_result_quick | 202 + result within the ~6 s poll window → TODO shown at once, success beep, nothing pending, no Wi-Fi for 3 h after |
| async_result_late | not ready → SENT ✓, id persisted, clip deleted, Wi-Fi off; result shown at the 30 s check wake, silently; no more checks |
| work_lifecycle | work → RESEARCHING (static) → DONE + ≤ 60-char summary; checks exactly at +0:30/2:30/7:30/22:30; unchanged checks cause no refresh; stops checking |
| work_paused_budget / work_stopped | RESEARCHING → PAUSED (daily budget) / STOPPED; pending cleared, no more checks |
| noise_and_unsure | noise → "didn't catch that", no success beep; unsure → NOTE? with success beep |
| answer_result | answer → ANSWER screen with the whole answer (past 60 bytes); a saved item → SHOPPING |
| new_clip_bypasses_backoff | during a 30 s backoff a new clip uploads at once (fails → 60 s); timer retries wait for the backoff |
| legacy_sync_server | old 200 replies (incl. legacy work, duplicate after a lost reply); async server without `/v1/updates` → per-id GETs |
| result_check_offline | pending checks fail offline (schedule advances), list survives a reboot, GET 404 + 500 tolerated, result arrives, 1 PUT only |
| low_battery | 12 %: "LOW 12%", uploads continue, result checks ≥ 30 min apart |
| critical_battery | 3 %: CHARGE ME, recording works ("charge to send"), no Wi-Fi for 2 h, PWR forces one upload, USB flushes, recovers at 20 % |
| no_refresh_while_sleeping | READY 6 h idle: 0 refreshes; 24 h after a work result: 0 refreshes; 0 refreshes asleep; same with the classic layout |
| ota_* / soak_ota_40 | firmware update - see [Firmware update (OTA)](#firmware-update-ota) below |
| soak_async_50 | 50 seeded cycles: all kinds, 1 s–200 s processing, work outcomes, PUT 500/drop, GET 500/drop/slow/404, offline, DNS, reboots → one record per clip, a final result per clip, nothing repeated / given up / set aside, pending empty, heap + LVGL flat, 0 refreshes asleep |

| status_* / status in soak_offline_30, idle_day | status reports - see [Status reports](#status-reports) below |
| keepalive_*, wifi_* | connection reuse and Wi-Fi places - see [Connections and Wi-Fi places](#connections-and-wi-fi-places) below |

Each scenario gets its own SD card and log in `build/sim-test/<name>/run/` (`sim.log`, `sdcard/pv_log.txt`).

## Status reports

Contract: [`docs/device-api.md` section 7](../docs/device-api.md). Core: `firmware/core/src/pv_status.*`
(log ring with per-line checksums + pinning, JSON builder: escaping, UTF-8 repair, 2 KB cap cutting
the oldest lines) and `App::statusReport` (policy). One POST at the end of a session that is up
anyway, after the result is on screen (footer updated first, so no extra e-paper refresh),
before Wi-Fi off; ≤ 2.5 s, never retried.

The sim models `esp_reset_reason()` and the **RTC no-init RAM** that holds the log ring:
`Sim::crash("panic"|"task_wdt"|...)` resets with that reason and keeps the ring, `restart()` = `sw`
(ring kept), RESET button / power cut = `poweron` with the ring filled with garbage (the core
must reject it). `faults.epd_timeouts` feeds `Hal::displayTimeouts()`. Mock: `status_script` /
`status_always` (`{"want_log":"body"|"header"}`, `{"status":404}`, `{"latency_ms":20000}`,
`{"real_delay_ms":N}`, `{"drop":true}`), every report validated (`check_status`) and kept:
`GET /__mock/status`.

| Scenario | Checks |
|---|---|
| status_after_upload | one report per session; all fields (id, fw, slot, reset, boot_n, rssi, connect_ms, heap, counters); no log without a reason; result on screen before the report; awake_ms + sleep_ms = time since the previous report (±20 ms) |
| status_old_server_404 | 404 / 405 / 500 ignored: one attempt per session, no retries, uploads + 30 s backoff unchanged; ok / 500 / ok → the third report's deltas span both |
| status_want_log | `{"want_log":true}` or `X-PV-Want-Log: 1` → next report has the log, then none; the request survives a failed report |
| status_after_crash | panic → `reset:"panic"`, `boot_n` 2, log = pre-crash lines then this session's; task_wdt + 12 h quiet (ring rotated) → the 8 pinned pre-crash lines still there; power cut → ring rebuilt empty, no log; `boot_n` in NVS |
| status_error_attaches_log | Wi-Fi failure → no report (no Wi-Fi), next one has the log with the failed `NET` line; upload 500 → that session's report has it; e-paper timeout → log + `epd_timeouts`; clean sessions → no log |
| status_log_escaping | titles with quotes, backslashes, tab, U+0001, €, emoji, 2-byte characters cut by the 146-byte line limit → every report strict JSON + UTF-8 ≤ 2 KB, the title round-trips, log = newest consecutive lines |
| status_not_when_recording | BOOT down at the end of a session → no report; every other connected session reports once |
| status_battery_policy | 12 %: 1 report for 4 sessions in < 1 h, the next after 1 h; 3 %: none on a PWR-forced session, exactly one crash report after a brownout reset; USB: normal |
| status_bounded_time | status server 20 s slow (virtual), dropped, stalled 4 s (wall): each ≤ 2.5 s, result screen not delayed, BOOT → REC at once, uploads unaffected |
| soak_offline_30, idle_day | every connected session reports exactly once (minus deliberate skips), all valid; the same run with `Config::status_report = false` (twin device): same wakes, sessions, e-paper refreshes, energy within 1 % (soak: +0.30 %, 34 reports, +3.1 s Wi-Fi; idle day: 0 reports, identical) |

Mutation checks (each made the named scenarios fail, then reverted): restart the deltas on a failed
report → `status_old_server_404`; no crash pin → `status_after_crash`; no crash log →
`status_after_crash`, `status_battery_policy`; HTTP timeout 15 s instead of 2.5 s →
`status_bounded_time`; no low-battery limit → `status_battery_policy`; report before the result
screen → `status_after_upload`, `status_bounded_time`; a timer that turns Wi-Fi on for a report →
`idle_day`. The twin comparison also caught a real bug during development: the report between
`show()` and the footer update split one e-paper refresh into two.

Energy: the report rides on the session's kept-alive connection (~80 ms in the model, no extra
TLS handshake), so its cost stays at ~+0.3 % with the handshake model too - measure on the board.

## Connections and Wi-Fi places

Contract: [`docs/device-api.md` sections 9 and 10](../docs/device-api.md). Core: `pv_wifi.*`
(list in NVS, validation, connect strategy, per-network back-off), `App::fetchWifiList`,
`App::netOff` (`Hal::httpSessionEnd` before `wifiOff`). ESP32: one kept `esp_http_client` handle per
session (`esp32_hal.cpp`), `WiFi.begin(ssid, psk, channel, bssid)` fast connect, `scanNetworks`.

Sim model: requests reuse one libcurl handle per session (curl's own connection reuse /
reconnect); a request that needed a new connection costs `tls_handshake_ms` (720 ms) on top of the
~80 ms per request; `faults.no_keepalive` = the old one-connection-per-request behaviour. Wi-Fi:
`SimAp` list + `place`: a join costs 0.7 s with BSSID + channel, 1.5 s without (driver scan), a scan
1.5 s; absent AP → NoSsid, wrong psk → Failed. A connection still open at `wifiOff()` is counted as a
leak. Mock: `wifi` (list; `X-PV-Wifi-Rev` while the device is behind), `wifi_raw`, `wifi_status`,
`conn_close`.

| Scenario | Checks |
|---|---|
| keepalive_energy | soak (30 clips, 50 % offline, 5 h) with keep-alive vs a handshake per request: one handshake per connected session, nothing left open; connected session 3.27 s vs 3.90 s (−16 %), Wi-Fi time 154 s vs 200 s, energy −4.4 % (model) |
| keepalive_server_close | `Connection: close` server → a new connection per request, uploads fine; dropped reply → fresh connection, delivered; otherwise one per session |
| wifi_home_fast | built-in network only: 1st session driver join 1.5 s, then straight to the last AP 0.7 s, never a scan; `ssid` in the status report; `X-PV-Wifi-Rev: 0`; last AP in NVS survives a power cut |
| wifi_places_hotspot | home: list rev 1 fetched in the first session; venue: last AP + one scan, nothing known → QUEUED; list rev 2 (adds the venue) while offline → nothing; hotspot on → upload + rev 2 fetched in that session; next session the venue network (prio 2) beats the hotspot (prio 9), then straight to it; reboot keeps list + AP |
| wifi_wrong_password | wrong venue password → backed off 10, then 20 min (not every retry); corrected list via the hotspot clears it → venue works at once |
| wifi_list_rejected | malformed, > 2 KB (cut), 9 networks, 33-byte SSID, 17 × U+00E9 (34 bytes), 7-char psk, prio 12 → old list kept, NVS unchanged, that rev not refetched; HTTP 500 → refetched; raw UTF-8 SSID adopted and joined, exact bytes in the status report; reboot keeps rev 21 |

Mutation checks (each failed the named scenario, then reverted): no "last AP" fast path →
`wifi_home_fast`; adopt the valid part of a bad list → `wifi_list_rejected`; no per-network back-off
→ `wifi_wrong_password`; no `httpSessionEnd` → `keepalive_energy`, `keepalive_server_close`;
order by signal only (hotspot first) → `wifi_places_hotspot`.

## Firmware update (OTA)

Contract: [`docs/device-api.md` section 6](../docs/device-api.md). Core: `firmware/core/src/pv_ota.*`
(check / gates / signed offer / streamed download with SHA-256 / commit / confirm), `pv_sha256.*`.

The sim models the **flash and the ESP-IDF bootloader with rollback**: `<run>/flash/slot0.bin`,
`slot1.bin` (3 MB slots like `app3M_fat9M_16MB`), `otadata.txt` (boot slot + per-slot state
`undefined/new/pending/valid/aborted`), `nvs.txt` (the core's install notes). A fresh run dir gets
a factory image `PV_FW_VERSION` (1.0.0, `--fw-version`) in slot 0. At every boot the sim's
bootloader does what the real one does: `new` → `pending`; still `pending` → `aborted` and boot the
other slot (rollback); an invalid image is skipped; nothing bootable = **BRICKED** (also after 20
crash-boots in a row). Images are simulator images (`sim::makeSimImage`: header with the version and
an optional `crash_ms`, filler, appended SHA-256 like esptool's); one with `crash_ms` panics that
long after booting. Signatures are real ECDSA P-256 (macOS Security.framework) with the **test** key
`sim/ota/test_signing_key.pem` (the board uses the release key from `tools/ota/keygen.sh`).
Downloads stream in 4 KB chunks paced in virtual time (120 KB/s, or the mock's `kbps`), so power
cuts / BOOT presses land mid-download. Faults: `ota_cut_after_commit`, `ota_flash_fail`, `dl_kbps`.

Mock: `{"fw":{"version":"1.1.0","size":1800000,"crash_ms":0,"kbps":120,"hint":true,"fault":...}}`
with faults `corrupt`, `wrong_hash`, `truncated`, `short_length`, `drop`, `bin_404`, `bin_500`,
`meta_404`, `meta_500`, `meta_malformed`, `bad_sig`, `unsigned`, `downgrade`, `oversize`, plus
`fw_bin_script` for one-shot download faults and `{"fw":{"release":"dist/fw/1.0.1"}}` to serve a
real signed release (board test). Browser UI: **ota** button (= serial `ota`: check + install now),
firmware / slot / rollback rows in the state panel.

| Scenario | Checks |
|---|---|
| ota_happy_path | update found in the upload session via `X-PV-FW-Latest` (no extra Wi-Fi), postponed while the result is on screen, installed ≥ 10 min later in a quiet session: UPDATING 0..90 % → restart → UPDATED v1.1.0 (pending verify) → confirmed via the server; slot 0 byte-identical; server sees `X-PV-FW: 1.1.0`; one download, ~daily checks after |
| ota_daily_check | nothing recorded for 74 h: exactly one dedicated check per 24 h (no other Wi-Fi); a release is installed at the next one |
| ota_corrupt_hash | flipped bytes, then a *valid* image that is not the offered one → SHA-256 mismatch, never committed, no restart, slot 0 intact, UPDATE FAILED; retry after 1 h, then 2 h; installs when fixed |
| ota_truncated_download | 60 % then dropped; 404; short `Content-Length`; dropped at 0 → all rejected with the partial image only in the inactive slot; backoff 1/2/4 h; one commit |
| ota_power_loss_mid_download | battery pulled at 40 % → boots 1.0.0, no install note, no brick; a later session installs |
| ota_power_loss_after_switch | cut right after the slot switch → next power-on boots the new image and confirms; a cut while a new image is unconfirmed → rollback, UPDATE FAILED, attempt counted, 2nd attempt allowed; offline → confirmed after 10 min uptime |
| ota_crash_on_boot_rolls_back | image panics 0.8 s after boot → bootloader rollback ×2 → refused afterwards (no boot/download loop for 3 days), clips still delivered; fixed 1.1.1 installs |
| ota_low_battery_deferred | 24 %: no check, no download, no dedicated session for 30 h; on USB → installed |
| ota_not_during_recording | BOOT at 20 % of a download → REC within < 1 s, download abandoned, Wi-Fi off; finished ≥ 10 min later |
| ota_queue_flushed_first | 3 offline clips + failing uploads → no download (deferred, not even checked); all uploads before the download |
| ota_no_downgrade | older / same version (server bug), malformed, oversize, 500, 404 → nothing downloaded, slot 1 never written; 1.0.5 offered to 1.1.0 refused |
| ota_signature_invalid | other key / unsigned → refused before downloading; valid offer with an absolute URL on another host installs without sending the device token there |
| soak_ota_40 | 40 seeded cycles with clips, PUT 500s, offline, 14 releases (corrupt / truncated / bad sig / 404 / crashing) and power cuts + resets aimed at downloads and unconfirmed images → never bricked, no crashing release ever confirmed, every clip delivered once, ends on the final release, heap flat |

Mutation check (each patched into `pv_ota.cpp`, then restored): skip the SHA-256 check →
`ota_corrupt_hash` fails; confirm without the health conditions → `ota_power_loss_after_switch`
fails; confirm right at boot → `ota_crash_on_boot_rolls_back` fails (boot loop, BRICKED); write the
running slot → 8 scenarios fail; skip the signature → `ota_signature_invalid`; ignore battery →
`ota_low_battery_deferred`; ignore the queue → `ota_queue_flushed_first`; no version check →
`ota_no_downgrade`; retry rolled-back versions → `ota_crash_on_boot_rolls_back`.

Board specifics the sim cannot show: the sketch overrides `verifyRollbackLater()` (else
arduino-esp32 confirms every new image in `initArduino()`), `esp_ota_*` with sequential erase,
mbedTLS ECDSA, NVS, TLS heap during a 1.7 MB download.

## Simulated vs not

Simulated faithfully (same code as the board): state machine, recording pipeline and WAV
writer, queue order / ids / deletion rules / backoff, reply parsing, battery % mapping, sleep
decisions and wake handling, LVGL layout and the 1-bit threshold, SD event log.

Modelled (approximations): time costs (Wi-Fi connect 1.5 s, missing AP 2.5 s, upload at 60 KB/s,
~80 ms per request + 720 ms per new TLS connection, Wi-Fi join / scan times, mock latency header),
reset reasons + RTC no-init RAM, e-paper refresh energy, currents (sleep 8.6 mA calibrated to the board's
~9 mA day, of which the codec 2.0 is a guess; awake 25, recording 35, Wi-Fi 95; 400 mAh; off 15 µA -
**estimates, measure on the board** and edit `EnergyModel` in `sim/src/sim.h`), codec standby (reopen
30 ms + 80 ms settling drop), boot time (`boot_ms`, 2.5 s in the battery scenarios),
heap (fixed budget minus tracked `new` on the app thread, open files, Wi-Fi), SD writes are inline
(the board uses a writer task), audio stale-DMA discard is a no-op.

Not simulated: ES8311/I2S timing and levels, real SD latency/stalls, e-paper BUSY timing and
ghosting, HWCDC/USB behaviour, Wi-Fi/lwIP/mbedTLS memory, light-sleep electrical behaviour, live
Mac microphone.

## Bugs found while porting power_proto (fixed in the core)

Each fix is covered by a scenario; with the old behaviour patched back in, `poison_clip`,
`boot_during_upload` and `power_cut_recording` fail.

1. **Poison clip blocks the queue forever** - any non-2xx was "retry", so a file the server rejects
   (400 for an empty/non-WAV file, 413) stayed at the head of the queue and newer clips never
   uploaded. Now 400/413/415/422 move the clip to `/REC_BAD`; files shorter than a header are set
   aside at boot.
2. **Power cut mid-recording leaves `data` size 0 in the WAV header** - decoders then read no audio
   (likely "(no speech)" on the server). Headers are now repaired from the file size at boot.
3. **Upload session blocks recording** - power_proto uploaded the whole queue (up to 60 s per request)
   before BOOT was looked at again. Now Wi-Fi connect and the clip loop stop when BOOT is pressed
   (no backoff penalty) and recording starts after the in-flight request.
4. **PWR wake disabled forever** after 5 spurious wakes (e.g. quick taps). Now re-enabled after 1 h.
5. **Unbounded waits** on the recording finalize semaphore and the LVGL lock before sleeping; now
   5 s timeouts (logged) so a wedged SD card / display cannot hang the device.

Policy changed (decided): a clip recorded while backing off is uploaded at once; timer retries
still back off (`new_clip_bypasses_backoff`). A short PWR press retries immediately.

## Async results, power and refresh policy (planned behaviour, implemented in the core)

- Upload: 202 receipt → clip deleted (the id is written to `/pv_pending.txt` *before* the clip is
  deleted, so a power cut in between re-uploads and the server dedupes). Poll `GET
  /v1/recordings/:id` at +0.5/1.5/3.5/5.5 s; not ready → **SENT ✓** and keep the id.
- Pending ids (≤ 8, persisted via write-temp + rename) are checked at 30 s, 2 min, 5 min, 15 min,
  then every 30 min, given up after 24 h; batched through `/v1/updates?ids=` when available.
  Nothing pending → no Wi-Fi except queue retries. Results found on timer wakes are shown
  silently (no beep in a pocket).
- Battery: footer/Bolt show `%`; **< 15 %** "LOW n%" and result checks at most every 30 min;
  **< 5 %** (leave at ≥ 8 %, hysteresis) "CHARGE ME", no automatic Wi-Fi at all (an upload at
  95 mA on an empty cell risks a brownout loop; clips are safe on the card), recording still works,
  a short PWR press forces one attempt, USB (charging) resumes everything.
- No animation while idle: only REC (mouth, antenna, waves, seconds) and SENDING (eyes, antenna,
  "thinking...") animate, at 1 frame/s. All other screens are one static frame; the layout only
  invalidates 20-row bands whose pixels changed. The sim services the UI "on behalf of" the
  sleeping device at sleep entry and wake and counts any panel refresh there as
  `refreshes_asleep`, which every scenario that checks it requires to be 0.

## Layouts

`App::setup(layout)`: `nullptr` = classic text labels, `pv::BoltLayout` = Bolt (refined) from
`design/bolt-variations.html`. The sketch uses Bolt unless built with `-DPV_UI_CLASSIC=1`; the sim
uses Bolt unless the UI toggle / `--ui` says otherwise. Bolt draws with `pv::Gfx`, a C++ port of
the design's bitmap class (same rasterisation, 5×7 font, 16×16 icons) directly into the 5 KB
panel frame the UI already has - no LVGL images (LVGL 9.3 would decode a 1-bit full-screen image
to A8/ARGB8888, 40-160 KB) and no extra buffer. `sim/tools/bolt_compare.sh` shows 0 differing
pixels against the design's own drawing code for all 10 design states (head + status bar; the
text area too except "sending", whose text differs on purpose).

## Hardware-only hypotheses (verify on the board)

- **Heap loss ~450 B per Wi-Fi cycle**: not in the core - the sim shows zero tracked allocations and
  a flat LVGL pool over 30 cycles, and the core allocates nothing at runtime. Suspects: Wi-Fi driver
  init/deinit per session (`WiFi.mode(WIFI_OFF)`), lwIP TIME_WAIT PCBs (should plateau after ~2 min),
  esp_http_client/mbedTLS. `esp32_hal.cpp` defaults to `PV_WIFI_DEINIT 0` (`esp_wifi_stop()`, driver
  kept); compare `heap_delta=` in the `CYCLE` log lines with `-DPV_WIFI_DEINIT=1`.
- **Hang after INBOX inside lightSleep()**: the most likely culprit is `read_busy()` in the e-paper
  driver, which loops forever if BUSY never drops; the LVGL task then holds the UI mutex and
  `uiSettle()` (lock with no timeout) blocks the main task. The core sketch bounds BUSY to 4 s
  (counted in `epd_busy_timeouts`), the settle lock to 5 s, and adds a 90 s task watchdog (reset
  reason shows up in the `HAL,reset=` line). `Serial.flush()` on HWCDC is already bounded by the TX
  timeout in arduino-esp32 3.3.0; it is now skipped without a USB host and the TX timeout set to
  20 ms. The SD log write in `endCycle()` shares the SPI bus with the panel - if hangs persist with
  the above, log BUSY timeouts and SD write durations around sleep.

## Adding another layout

The app only produces a `ScreenModel` (`Screen` id, title, detail, footer, kind, due, battery %,
battery level, queued, pending results, USB). Implement `pv::UiLayout` (`build()` once, `apply()`
per update; `drawsFrame()`/`setFrame()` to draw the 1-bit frame yourself as Bolt does), pass it to
`App::setup(&layout)`, keep `screenAnimates()` the only animated screens, then run `make sim-test`
and look at `build/sim-test/report.html`. Mind the threshold for LVGL widgets: colours are
compared as raw RGB565 values, so e.g. pure red renders white - draw in black/white.
