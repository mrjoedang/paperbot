# Decisions (and the evidence behind them)

Built 2026-10-17. Inspired by Scott Tolinski's push-to-talk device (ESP32-S3 → R2 → Mac mini
transcription → Durable Objects task queue → Pi agents); this one runs entirely on Cloudflare.

## Pipeline
- **Upload contract:** device PUTs the WAV, gets a 202 receipt once it's in R2, deletes its copy,
  polls briefly, else picks the result up on a later wake (docs/device-api.md).
- **Processing inline (~1.8 s), Workflow only as durable fallback** — a Workflow-only pipeline
  measured ~4.6 s.
- **Routing (2026-11-16): one Claude Haiku 5.5 call picks an action, not a category:** ignore, answer,
  save, research or app, with the title, due date and (for a quick question) the answer itself. It reads
  the time and place, the memos of the last 3 minutes and the person's open items and app names. Replayed on
  243 real memos (Oct 17 to Nov 16) against hand labels: 98 % right, p50 1.2 s, ~$0.17 per 1000 memos.
  The Clef + Qwen + thresholds pipeline it replaced scored 31 % (its "unsure" bucket and no "ignore" or
  "answer"); Clef with the five actions as criteria 94 % at 0.4 s; a three-way ignore/answer/agent split
  90 % (it sent weather questions to the agent). Lab: `~/src/tries/2026-11-16-paperbot-router`.
- **Saved items live in the person's OpenBelt workspace**, in one fixed app paperbot deploys there
  (`server/src/inbox-app/`, collection `items`, id = memo id), written directly by the pipeline. An
  OpenBelt agent per memo was tried (12-memo dogfood): 5x slower, 35x the cost, and 3 of 12 memos landed
  in a collection its own app never showed. A fixed schema never does that.
- **Answers** come from the router when it can answer without the web, else one more Haiku call with
  up to 2 web searches (1-3 s). Firmware 1.2.0 shows up to 120 bytes on an ANSWER screen; older
  firmware gets them as a `work` summary (60).
- **Noise:** loudness/length gate before Whisper, `vad_filter` and a short hallucination list
  ("thank you"…); the router ignores the rest. Unreadable uploads are accepted and discarded so a bad
  file can never block the device queue.

## Research agents (research and app memos)
- **Fully hands-off, no approval step** (owner's call). Safety comes from what the agent can do:
  research-only tools (web search via Exa, web fetch incl. PDFs, scratch filesystem), per-task
  budget (8 web calls, 12 turns, 120 s, $0.15), max 2 concurrent, $2/day, plus a $5/day AI Gateway
  backstop. Citations not actually fetched are marked unverified; hedging → "unsure".
- **Model: Claude Sonnet 5.5, Haiku 5.5 fallback** — 0 confident errors in testing; GLM-5.3 and
  GPT-6 Luna each produced confident wrong answers.
- Gotchas: Pi's tool results must be returned as `output` (adapter in server/src/agent.ts);
  third-party models need the Unified-Billing wrapper; set max tokens explicitly.

## Device
- **Light sleep, BOOT wake** → recording starts at once. Wi-Fi only for uploads/result checks.
  Stays awake ≥5 s after any wake, 30 s after a recording, never on a USB host.
- **Battery (2026-10-18):** the first firmware drew ~9 mA on average (90 % → 30 % of ~400 mAh in a
  day), almost all of it while asleep. ~2.5 mA of that is hardware (EXIO5 drives the battery-latch
  transistor through 1 kΩ — fixable only by swapping R64, ~22 kΩ). Deep sleep would not help: only ⏻
  can wake it, and the latch, SD card and rails stay powered anyway. So:
  - **Codec standby while asleep** (ES8311 suspend + I2S off, reopened on first use: the start beep
    comes ~30 ms after ☀). Not the audio rail: with EXIO1 off the codec is back-powered through the
    shared I2C pull-ups and still answers — a half-powered chip on the expander's bus.
  - **Auto power-off after 4 h unused** on battery (no recording, ⏻ press, start or USB host), once
    no result checks are pending. ⏻ starts it again (~3 s); queued clips go at the next start.
  - Model (sim `battery_day`, calibrated to the 9 mA): 5 memos 3 h apart 1.9 → ~3.4 days; idle or
    offline days ~14 days. The codec's share is a guess — not measured yet.
  - Not done: full power-off between memos (~2 months, but ~3 s before each recording), e-paper
    rail off and rarer wakes (≤ 3 %).
- **Status reports** ride existing Wi-Fi sessions (~0.3 % energy), carry a crash-surviving log ring.
- **One TLS connection per session** (keep-alive) for all requests.
- **Wi-Fi at new places:** networks added in the web app (Places) sync to the device; the iPhone
  hotspot is a permanent fallback. Last-good network is tried first without a scan.
- **OTA:** signed (ECDSA P-256), two slots with bootloader rollback; key in `.secrets/`.
- **UI:** Bolt robot, 1-bit pixel art drawn by hand (anti-aliased shapes turn to mush on e-paper),
  buttons shown by their case symbols (☀ / ⏻), minimal text, no animation while asleep.

## Setup
- **In the browser, not a CLI (2026-11-15):** `/setup` does the whole setup over Web Serial (esptool-js flashes,
  the page talks to the board's console), so there's no install, no Terminal and no sign-in handoff between a CLI
  and the browser. The Rust CLI (`pocketbot setup/status/wifi/claude`), its installer and the device-code /
  loopback sign-ins were removed. Costs: Chrome, Edge or Firefox only (no Safari), a person must pick the port
  once, and the page can't read the Mac's Keychain (paste instead, with a guide). Boards ship with Waveshare's
  firmware, so one USB flash from a computer is unavoidable; phone-only setup (BLE, Matter) was considered and left
  for later.

## Process
- No unit tests (owner preference). Behaviour is verified with simulator scenarios (with mutation
  checks), end-to-end runs against deployed Workers, browser screenshots and on-board soak tests —
  the board-only bugs (SPI clash, Wi-Fi restart, USB sleep) were all caught on hardware.
