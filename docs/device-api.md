# Device ↔ server API (planned async contract)

What the pocket-voice firmware (`firmware/core`) expects from the server. The current production
Worker (`server/src/index.ts`) implements the **legacy** subset (synchronous `PUT` → 200 task);
the device supports both, so the server can be migrated without a firmware change.
Reference implementation for tests: `sim/mock_server.py`.

**Base URL (production): `https://app.paperbot.ca`** (Worker `paperbot`, `server/`).
The old `https://pocket-voice.mrjoedang.workers.dev` and `https://pocketbot.mrjoedang.workers.dev` proxy `/v1/*` to it, so devices on old firmware keep
working; dev: `https://dev.paperbot.ca`. Boards use the server they were set up
with (`prov server`), e.g. `https://app.paperbot.ca`.

All device requests: `Authorization: Bearer <device token>`. Ids are the clip file names without
`.wav`: `[prefix]<12 hex MAC>-<6 digit seq>-<8 hex random>` (≤ 47 chars, `[A-Za-z0-9_-]`).
Keep every response body **≤ 2 KB** (the device's reply buffer is 2048 bytes).

## 1. Upload: `PUT /v1/recordings/:id`

Body: the WAV file (16 kHz mono 16-bit PCM, `Content-Type: audio/wav`).

| Reply | Meaning for the device |
|---|---|
| `202 {"id","status":"processing"}` | **The audio is durably stored** (e.g. R2 put has completed). The device deletes its local clip and starts waiting for the result. Only send 202 after the write is durable. |
| `202 {..., "duplicate": true}` | Same id uploaded before (the device retries when a reply is lost). Return the **same record** in its current state (`status` + result fields if finished). Never create a second task. |
| `200 {id, kind, title, due, ...}` | Legacy synchronous reply (current production). Treated as a finished result; `"duplicate": true` allowed. |
| `400 / 413 / 415 / 422` | The file will never be accepted: the device moves it to `/REC_BAD` (not retried). |
| `401 / 403 / 404 / 408 / 429 / 5xx`, timeout, broken JSON, 2xx without `status`/`kind` | Clip kept, retried with backoff (30 s, doubling, max 15 min). |

The device deletes the clip on any 2xx with a parseable body that has a `status` or a task
(`kind` + `title`). A 2xx like `{}` is **not** a receipt.

## 2. Result: `GET /v1/recordings/:id`

```json
{"id":"…","status":"done","kind":"todo","title":"Buy AA batteries","due":null}
{"id":"…","status":"researching","kind":"work","title":"Research e-paper fonts"}
{"id":"…","status":"done","kind":"work","title":"…","summary":"3 good bitmap fonts found"}
{"id":"…","status":"paused_budget","kind":"work","title":"…"}
{"id":"…","status":"stopped","kind":"work","title":"…","error":"agent failed"}
{"id":"…","status":"error","error":"transcription failed"}
{"id":"…","status":"processing"}
```

| field | values |
|---|---|
| `status` | `processing` → `done` · work: `processing` → `researching` → `done` / `paused_budget` / `stopped` · `error` |
| `kind` | a saved item's list: `todo`, `shopping`, `reminder`, `note`, or `done` / `removed` (an item checked off or taken out); `answer` (firmware ≥ 1.2.0; older firmware gets `work`); `work` (research or an app); `noise` (ignored: nothing meant for paperbot). Older servers also sent `unsure` |
| `title` | ≤ 96 bytes UTF-8 (shown in a 5×7 ASCII font: accents are folded, other symbols become `?`) |
| `due` | ISO date/time or `null` (shown as `MM-DD HH:MM`) |
| `summary` | `done` only: the work's result line (**≤ 60 chars**) or the answer (**≤ 120 bytes**, firmware ≥ 1.2.0 via `X-PV-FW`) |
| `error` | optional short reason (`stopped`, `error`) |

- `404` = unknown / not visible yet. Tolerated: in the poll window it means "not ready"; on
  scheduled checks the id is dropped after 6 consecutive 404s.
- Unknown `status` strings are treated as "still processing" (forward compatible); `done`
  without `kind` + `title` likewise.
- Legacy replies (no `status`, or `status:"open"`) are final and shown as plain results, also for
  `kind:"work"` (no research phase). Legacy `kind:"inbox"` → `unsure`, or `noise` when the title is
  `(no speech)`.

## 3. Batch: `GET /v1/updates?ids=a,b,c` (optional, recommended)

`{"items":[<objects as in §2>]}` for the known ids; unknown ids are simply omitted (= 404 for
that id). The device sends ≤ 6 ids per request. One TLS handshake for all pending items instead
of one per item (~1–2 s of radio each on the C6).

If the endpoint is missing (`404`, `405`, `400`, `501`) the device falls back to per-id GETs until
the next reboot. A `since=` cursor was considered and rejected: the device knows exactly which ids
it waits for, an `ids=` query is stateless for the server and cannot return items the device
does not care about.

## 4. Device behaviour (for server planning)

- **Poll window**: after a 202 the device keeps Wi-Fi up and GETs at +0.5, +1.5, +3.5, +5.5 s
  (≤ 6 s total). If finished by then it is shown at once; otherwise the screen says **SENT ✓** and
  the id goes into a persisted pending list (≤ 8 ids, on the SD card, survives reboots).
  → Aim for ≤ 5 s server-side for note/todo/reminder to get the "instant" experience.
- **Scheduled checks** while anything is pending: 30 s, 2 min, 5 min, 15 min after the 202, then
  every 30 min; given up after 24 h. Wi-Fi is on only for these checks; with nothing pending and
  nothing queued the device never turns Wi-Fi on (timer wakes every 15 min stay radio-off).
  Low battery (< 15 %): checks at most every 30 min. Critical (< 5 %): no checks.
- A work item is shown as RESEARCHING (static) until a check sees `done` (DONE + summary),
  `paused_budget` (PAUSED: daily budget) or `stopped` (STOPPED). Hands-off: there is no approval
  step and no device-side control of the agent; budgets are enforced by the server.
- Results that arrive on timer wakes are shown silently (no beep in the pocket). `noise` shows
  "didn't catch that" with no success beep.
- **Idempotency is required**: the device may PUT the same id again (lost reply, reboot between
  the 202 and deleting the clip). Same id → same record, never a second task.
- Server load per clip: 1 PUT, ≤ 4 poll GETs, then ≤ ~52 scheduled GETs over 24 h in the worst
  case (one batched request per check wake for all pending ids).

## 5. Migration checklist for `server/`

1. PUT: write audio to R2, insert the record (`status:"processing"`), return **202** before
   transcription; run transcription/routing in the background (Workflow / queue / waitUntil).
2. Duplicate PUT returns the existing record's current view with `duplicate:true`.
3. GET `/v1/recordings/:id` returns the view above; add `/v1/updates?ids=`.
4. Map routing confidence to `unsure`, the noise gate to `noise`, work agents' terminal states
   to `done` (+ `summary` ≤ 60) / `paused_budget` / `stopped`.
5. Until then the device keeps working against the synchronous server (scenario
   `legacy_sync_server`).

## 6. Firmware update (OTA)

*Owned by the firmware side (`firmware/core/src/pv_ota.*`). Reference: `sim/mock_server.py`
(`fw` config); device behaviour is covered by the `ota_*` scenarios in `sim/`.*

### 6.1 Version reporting and hint (all endpoints)

- Every device request carries **`X-PV-FW: <MAJOR.MINOR.PATCH>`** (running firmware). Log it per
  device; it is how you see a rollout land (the first request after an update reports the new version).
- Any `/v1/` reply **may** carry **`X-PV-FW-Latest: <version>`** = newest release meant for this
  device. If it is newer than the running version, the device asks `GET /v1/firmware` in the
  same Wi-Fi session (no extra radio time). Optional: without it the device still checks ≤ once a day.

### 6.2 `GET /v1/firmware?current=<ver>&device=<12 hex MAC>` (Bearer token)

| Reply | Meaning |
|---|---|
| `204` | Nothing newer for this device. |
| `200 {"version","size","sha256","sig","url"}` | Offer (≤ 2 KB). Fields below. Extra members are ignored. |
| `404 / 405 / 501` | Server has no OTA: the device asks again in 24 h. |
| other / timeout | Retried later (1 h). |

| field | value |
|---|---|
| `version` | `MAJOR.MINOR.PATCH` (each 0–9999, no suffix). Must be **newer** than `current`; the device refuses anything else (no downgrades, no reinstall). |
| `size` | image size in bytes (≤ 3 MB = 0x300000, the OTA slot). |
| `sha256` | 64 lowercase hex chars, SHA-256 of the whole image. |
| `sig` | hex DER ECDSA P-256 signature (SHA-256) over the manifest text below. Required. |
| `url` | `/v1/firmware/<ver>.bin` (same host: the device sends its token) or an absolute `https://` URL on another host, e.g. a public R2 domain (the device then sends **no** token). |

Signed manifest text (exact bytes, `\n` line ends): `pocket-voice-fw/1\n<version>\n<size>\n<sha256>\n`.
`tools/ota/release.sh` writes it (`manifest.txt`) and the ready-made 200 body (`manifest.json`, which
also has informational `key` / `built_at`). **Serve the fields unchanged** – any edit breaks the signature.

### 6.3 Image download: `GET <url>`

`200`, `Content-Type: application/octet-stream`, **`Content-Length` = `size`** (the device aborts
on a different length), the exact bytes of `paperbot-<ver>.bin`. Streamed straight into
flash in 4 KB pieces; slow is fine (≤ 5 min total), no `Range` needed (an interrupted download
starts again from zero next time). Anything else (`404`, short body, dropped connection) is a
failed attempt: nothing is installed.

### 6.4 Device behaviour (for server planning)

- **When it checks**: at the end of a Wi-Fi session that is up anyway (upload / result check), at
  most once per 24 h, or at once when `X-PV-FW-Latest` is newer. If no session ran the check for 24 h,
  a timer wake does a dedicated one (Wi-Fi ~2 s). A failed download is retried after 1 h, 2 h, 4 h … (≤ 24 h).
- **Gates**: never with clips queued (they upload first, same session), never below 30 % battery
  unless on USB, never while recording (BOOT aborts the download at once), never while the running
  image is unconfirmed. When the session just showed the user something new (a result, a new
  recording, a PWR press) the device only checks and installs ≥ 10 min later in a quiet session.
- **Install**: offer must be newer, signed with the release key compiled into the firmware, fit the
  slot, and not be a version that already rolled back twice on this device. The image streams into
  the slot the device is **not** running from; only if size and SHA-256 match is that slot made
  the boot slot. Then the screen shows `UPDATING n%` → restart → `UPDATED v<ver>`.
- **Confirm / rollback**: the new image boots "pending verify" and confirms itself once the app is
  up, the SD card mounted (or confirmed absent), the display refreshed and **one request reached
  the server** (it sends `GET /v1/firmware?current=<new>` right after booting; answer it normally),
  or after 10 min uptime when offline. A reset / crash / watchdog before that → the bootloader
  starts the previous image again; the device shows `UPDATE FAILED` and reports the old version in
  `X-PV-FW`. A version that rolled back twice is never installed again on that device: ship a new
  patch version instead.
- **Load**: one `GET /v1/firmware` per device per day (+ one after each install); one image
  download per device per release (more only after failures).

### 6.5 Publishing a release (suggested for `server/`; the firmware only needs 6.2 + 6.3)

1. `sh tools/ota/release.sh 1.1.0` → `dist/fw/1.1.0/{paperbot-1.1.0.bin, manifest.json, …}`
   (builds with the version baked in, checks the image, signs with `.secrets/ota_signing_key.pem`).
2. Store in R2: `firmware/1.1.0.bin` and `firmware/1.1.0.json` (= `manifest.json`).
3. Point the channel: `firmware/latest.json` = `{"version":"1.1.0"}` (optionally
   `"devices":["<id>",…]` for a canary first).
4. Worker: `GET /v1/firmware` reads `latest.json`; if `version` > `current` (numeric compare) and
   the device is eligible → reply the stored `firmware/<ver>.json` (204 otherwise). `GET
   /v1/firmware/:ver.bin` streams the R2 object (`Content-Length` from the object size). Add
   `X-PV-FW-Latest` to replies if cheap (e.g. cached `latest.json`).
5. Watch `X-PV-FW` per device; a device that keeps reporting the old version after downloading
   rolled back (crash on boot) – fix and publish a higher version.

Key handling: the private key never leaves `.secrets/` (back it up). Devices only trust the
public key they were built with (`firmware/paperbot/ota_pubkey.h`, `tools/ota/keygen.sh`);
rotating it needs one release signed with the old key that contains the new public key.

## 7. Device status

*Device side owned by the firmware (`firmware/core/src/pv_status.*`, `App::statusReport` in
`pv_app.cpp`). Reference: `sim/mock_server.py` (`POST /v1/status`, validator `check_status`);
behaviour is covered by the `status_*` scenarios in `sim/`. Server side: see 7.4.*

### 7.1 `POST /v1/status` (Bearer token, `Content-Type: application/json`)

Same headers as every device request (`Authorization`, `X-PV-FW`, `X-PV-Batt`, `X-PV-USB`).
Body ≤ **2048 bytes**, UTF-8, one object:

```json
{"v":1,"id":"5100c0ffee01","fw":"1.0.0","slot":0,"reset":"poweron","boot_n":12,"up_s":3600,
 "batt_mv":4130,"usb":1,"rssi":-44,"connect_ms":1150,"heap":191000,"heap_min":64000,"q":0,"pending":1,
 "awake_ms":52000,"sleep_ms":3540000,
 "stats":{"clips":5,"uploads":5,"upload_fail":0,"wifi_fail":0,"dups":0,"quarantined":0,"dropped_bytes":0,
          "too_short":1,"epd_timeouts":0,"results":5,"check_fail":0},
 "log":["181,4671181,NET,reason=new_clip,wifi=0,...","182,4671181,UI,screen=RESULT,..."]}
```

| Field | Meaning |
|---|---|
| `v` | Format version (1). Ignore unknown fields; new ones may appear. |
| `id`, `fw`, `slot` | Device id (Wi-Fi MAC, 12 hex), running firmware, OTA slot (0/1, -1 = none). |
| `reset` | Why this boot started: `poweron` (also the RESET button and any power loss) · `sw` (restart, e.g. after an OTA install) · `panic` · `int_wdt` · `task_wdt` · `wdt` · `brownout` · `usb` · `deepsleep` · `other`. Stays the same for every report of one boot. |
| `boot_n` | Boot counter, persisted in NVS (survives power loss and SD swaps). A jump between two reports = reboots in between. |
| `up_s` | Seconds since this boot. |
| `batt_mv`, `usb` | Battery (mV, -1 unknown) and USB host seen (1/0) at report time. |
| `ssid` | Network this session used (exact UTF-8, JSON-escaped; §9). Added with the Wi-Fi list; `""` before the first connect. |
| `rssi`, `connect_ms` | Wi-Fi signal and association time of this session (`connect_ms` includes every network tried). |
| `heap`, `heap_min` | Free heap now (Wi-Fi up) and the minimum since boot (bytes). |
| `q`, `pending` | Clips still queued on the card; results still awaited. |
| `awake_ms`, `sleep_ms` | Awake / light-sleep time **since the previous successful (2xx) report of this boot** (since boot for the first one). Their sum = wall time between the two reports. Not carried over a reboot. |
| `stats` | Counters **since boot** (cumulative; reset at reboot - use `boot_n` to detect that). `uploads` = clips accepted by the server, `upload_fail` = failed upload attempts, `wifi_fail` = sessions whose Wi-Fi did not connect, `quarantined` = clips set aside (rejected 4xx / broken), `dropped_bytes` = audio lost to a slow SD card, `epd_timeouts` = e-paper BUSY waits that hit their bound, `results` = final results received, `check_fail` = failed result checks. |
| `log` | Optional, ≤ 40 strings of ≤ 160 chars: the device log lines (`<seq>,<ms since boot>,<event>,...`, same as the SD log `pv_log.txt` without the `*XX` checksum, cut at 146 bytes), oldest first, consecutive except where pinned lines are kept (below). Lines are dropped from the oldest end to stay ≤ 2 KB, so typically 10-20 lines. Broken UTF-8 (a line cut mid-character) is sent as `?`. |

When the device attaches `log`:
- the server asked for it in the previous reply (7.2);
- an error happened since the last delivered report: upload / result-check failure, Wi-Fi
  failure, a clip set aside, SD error, e-paper timeout, OTA failure or rollback. The ~9 lines
  around the **first** such error are kept until a report carried them;
- first report after a crash-type reset (`panic`, `int_wdt`, `task_wdt`, `wdt`, `brownout`): the
  last 8 lines **before the crash** are kept (the log ring lives in RTC no-init RAM on the board,
  which survives a panic / watchdog reset but not a power loss), followed by the newest ones.

### 7.2 Reply

| Reply | Device does |
|---|---|
| `204` (or any 2xx) | Delivered: the `awake_ms`/`sleep_ms` deltas restart, the error / crash log is considered reported. |
| `200 {"want_log":true}` or header `X-PV-Want-Log: 1` on a 2xx | As above, and the **next** report carries `log`. |
| `404` / `405` (older server), other 4xx / 5xx, timeout, dropped | Ignored: counted, nothing retried, nothing else changes. The deltas keep growing and a pending log is sent with the next report. |

Keep the handler fast (the device gives up after 2.5 s) and never return a large body (the device reads ≤ 127 bytes).

### 7.3 When the device sends it (battery rules)

- Only at the **end of a network session that happened anyway** (upload, result check, firmware
  check), after the session's work and after the result is on screen, before Wi-Fi goes off. The
  device **never turns Wi-Fi on for a report**: no session, no report (an idle device reports nothing).
- At most **one POST per session**, one attempt, ≤ 2.5 s, never retried.
- Skipped when: BOOT is held (the user is recording); the session already failed to reach the
  server (transport error - it would only cost another timeout); battery low (< 15 %, not on USB):
  at most one report per hour; battery critical (< 5 %, not on USB): none, except one crash report
  after a crash-type reset. On USB the battery rules do not apply.
- After an OTA install the device restarts inside the session, so that session sends no report;
  the new firmware reports `reset:"sw"` in its next one.
- Expect one report per upload / check session: a few to a few dozen per device per day.

### 7.4 Server (`server/`)

*Server side owned by `server/` (`src/index.ts` `handleStatus`, `src/logic.ts` `parseStatus` /
`statusHealth` / `batteryTrend` / `deviceAlerts`, `Inbox.deviceStatus`).*

- **Validation**: body read as text, `> 16 KB` → `413` (tolerant of the 2 KB contract), not JSON or not
  an object → `400`. Unknown fields ignored, missing fields stored as `null`, numbers outside sane
  ranges dropped (`batt_mv:-1`, `slot:-1` → unknown), unknown `reset` → `other`, `log` cut to the last
  40 lines × 160 chars with control characters removed. Log text is untrusted: the web app shows it as
  text only.
- **Reply**: `204`; `200 {"want_log":true}` **and** `X-PV-Want-Log: 1` while the owner has pressed
  "request logs" in the web app. The flag stays set until a report with `log` arrives.
- **Storage** (Inbox Durable Object, SQLite): every report as a history row (`device_status`, kept
  30 days), the latest one on the device row, battery samples (`batt_samples`: every report + the
  `X-PV-Batt` header at most every 5 min or on a USB change, kept 30 days), derived events
  (`device_events`, kept 90 days):
  - `crash`: first report of a new `boot_n` whose `reset` is `panic` / `int_wdt` / `task_wdt` / `wdt` /
    `brownout` (the attached `log` = what the device did before the crash),
  - `boot`: any other new `boot_n`; `firmware`: `fw` changed; `log`: a report carried `log` otherwise.
- **Derived** (shown live in the web app, recomputed per change): battery % (same curve as
  `pv_util batteryPercent`), drain trend (least-squares mV/h over the newest stretch off USB, needs
  ≥ 3 samples over ≥ 2 h; days left = time to 3.3 V), duty cycle (`awake_ms / (awake_ms + sleep_ms)`,
  last report and 24 h), Wi-Fi health (`connect_ms` average, `wifi_fail` deltas per boot over 24 h).
- **Alerts** (Bolt worries out loud): not heard from for > 24 h; battery < 15 % off USB; a crash /
  brownout the owner has not looked at yet (opening the health view acknowledges it); ≥ 3 Wi-Fi
  failures in 24 h; e-paper timeouts since boot.
- Every change is pushed to open web apps over the live WebSocket (`device`, `device_event` events).

## 8. Telemetry headers (every request)

Every device request carries, besides `Authorization` and `X-PV-FW` (6.1):

| Header | Value |
|---|---|
| `X-PV-Batt` | Battery voltage in mV (integer), e.g. `3950`. |
| `X-PV-USB` | `1` = USB host seen (charging / powered), `0` = on battery. |
| `X-PV-Wifi-Rev` | Revision of the Wi-Fi list the device has (§9), `0` = none. Optional until the firmware syncs Wi-Fi. |

Server (`server/`): recorded per device (key = the MAC in the clip ids / `?device=`) with last
seen, last request type (upload / result / updates / firmware / status / wifi), results still
awaited (`ids=` count of `/v1/updates`), firmware, battery % (`pv_util batteryPercent` curve:
3300 mV = 0 %, 4200 mV = 100 %), USB. Unchanged values are throttled (one Durable Object write per
15 s per isolate; one live broadcast per 10 s). Headers are optional: requests without them
(scripts, tests) are not counted as a device. The simulator also sends `X-Sim-Now-Ms` (marks the
device as `sim`).

## 9. Wi-Fi networks

The owner manages the networks in the web app ("Places"); the device fetches the list when it is
online anyway.

### 9.1 Revision hint (all `/v1` replies)

The device sends `X-PV-Wifi-Rev: <n>` (§8) with every request. When the server's list revision is
newer than `n` (a missing header counts as `0`), **every** `/v1` reply (recordings, updates, status,
firmware, wifi) carries `X-PV-Wifi-Rev: <m>`. The device then calls `GET /v1/wifi` in the same Wi-Fi
session (no extra radio time). No header in the reply = the device is up to date.
A device that reports a **higher** revision than the server's (its list came from another server,
e.g. the dev Worker) would never be offered this one: the server then sets its revision to the
device's + 1 and replies with that, so the device re-syncs.

### 9.2 `GET /v1/wifi` (Bearer token)

```json
{"rev":7,"networks":[{"ssid":"Home","psk":"correct horse battery","prio":0},
                     {"ssid":"Joe’s iPhone 15 Pro","psk":"…","prio":9}]}
```

| Field | Value |
|---|---|
| `rev` | List revision (increments on every change that matters to the device). Store it; send it back in `X-PV-Wifi-Rev`. |
| `networks` | ≤ 8 entries, sorted by `prio` (try in this order). Body ≤ 2 KB. |
| `ssid` | The network name as **exact UTF-8 bytes**, ≤ 32 bytes. Never normalise: `Joe’s iPhone 15 Pro` uses U+2019 (`e2 80 99`), not an ASCII apostrophe. JSON escapes (`\"`, `\\`) are the only transformation. |
| `psk` | WPA2 passphrase, 8–63 printable ASCII characters, or `""` for an open network. |
| `prio` | `0`–`8` = try order; `9` = fallback (e.g. the phone hotspot), tried last. |

Networks the owner has added without a password yet ("needs password") are **left out** of the
list. The device should replace its stored list with this one atomically (an empty list = forget
all but whatever the firmware keeps as a factory default).

### 9.3 Device behaviour (firmware)

*`firmware/core/src/pv_wifi.*` + `App::fetchWifiList`; scenarios `wifi_*` in `sim/`.*

- **Fetch**: when a reply's `X-PV-Wifi-Rev` is newer than the stored one, `GET /v1/wifi` once in that
  session (after uploads and result checks, before the firmware check). Adopted only if the whole
  body is valid: JSON object, `rev` integer > stored, `networks` ≤ 8 objects, `ssid` 1–32 bytes,
  `psk` `""` or 8–64 characters, `prio` integer 0–9 (missing = 5). Then it is written to NVS as one
  entry (old or new, never half) and used. Anything else - malformed, cut off at 2 KB, too many,
  bad field - keeps the old list, and that revision is not fetched again for 6 h (a new revision is
  fetched at once). `404` / `405` / `501` = server without the endpoint: no more fetches until reboot;
  `5xx` / timeout: tried again next session. The list survives reboots and power loss.
- **Built-in network**: the network compiled into the firmware (`secrets.h`) stays a permanent
  extra entry with prio 8 (after listed networks, before hotspots); if the list has the same SSID,
  the list entry wins.
- **Connecting** (whole budget 12 s per session, battery first):
  1. the network that worked last time, directly to its AP (BSSID + channel kept in NVS, no scan;
     ~0.7 s) - skipped when that was a prio-9 network and others are known (prefer the real one);
  2. only one known network: the driver looks for it (as before lists existed);
  3. otherwise one scan (~1.5 s), then the known networks that are in range: `prio` ascending, then
     signal; each attempt ≤ 6 s.
  A network that rejects its password is skipped for 10 min, then 20, 40 … up to 6 h (only while
  another network is known); a new list clears this. No known network in range = the session ends
  (clips stay queued, retried with the upload back-off).
- `X-PV-Wifi-Rev` is sent with every request to our server (`0` = no list yet), the network used
  is in the status report (`ssid`, §7.1).

Server (`server/`): networks live in the Inbox Durable Object, passwords encrypted at rest
(AES-GCM, key = Worker secret `WIFI_KEY`, 32 random bytes base64). The web API never returns
passwords (only `has_psk` / `needs_psk`; "replace password" overwrites). The web app shows "Bolt has
the latest list" when the device's last `X-PV-Wifi-Rev` ≥ the server revision, "got it, confirming"
after a `GET /v1/wifi` of the current revision, otherwise "waiting for Bolt to come online".

## 10. Connection reuse (device)

Within one network session the device sends all requests to the server (uploads, result checks,
`/v1/updates`, `/v1/firmware`, `/v1/wifi`, `/v1/status`) over **one** kept-alive HTTPS connection:
one TLS handshake per session instead of one per request (~0.5–1 s of radio each on the C6). The
connection is closed at the end of the session, before Wi-Fi goes off, and whenever a request
fails or a reply says `Connection: close` (the next request opens a new one; a kept connection the
server closed while idle is retried once on a fresh one). Firmware image downloads use their own
connection. Servers need nothing special - HTTP/1.1 keep-alive; `Connection: close` works too, it
only costs more radio time.

## 11. Setup and accounts

Setup in the browser (`/setup`: per-person device tokens, `POST /v1/config`, the `info` / `prov`
serial commands, MCP): see [setup.md](setup.md). Device tokens minted by setup look like `pb_d_…`;
the owner's original `DEVICE_TOKEN` keeps working and maps to the owner's inbox.
