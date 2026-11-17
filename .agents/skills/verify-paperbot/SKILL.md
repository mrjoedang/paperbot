---
name: verify-paperbot
description: How to run paperbot's pieces for real and drive them: the simulator (scenarios, a fresh board with a serial console), the Worker locally or on the test deployment, /setup against a scripted board, the simulator or the board, the web pages in headless Chrome, a real MCP client, and the board. Use when proving a change (prove-it-works), reproducing a bug, or collecting evidence for a PR.
---

# Verify paperbot

Everything here runs from the checkout. Never verify on production (`paperbot` Worker,
paperbot.mrjoedang.workers.dev, paperbot.ca) unless the owner asks.

## Simulator

```sh
make sim-test                                  # all scenarios -> build/sim-test/report.html (frames as PNG)
make sim-test SCENARIO="setup_fresh_board"     # some
make sim                                       # interactive, http://localhost:8090
```

The simulator runs `firmware/core` with fake hardware and a virtual clock, against `sim/mock_server.py`
(started by `sim/test.sh`) or any real server (`--server URL`). A new device behavior gets a scenario in
`sim/src/scenarios.cpp`: drive it (`c.record(ms)`, `c.s.command("...")`, `c.s.reset()`, `c.s.cutPower()`,
faults in `c.s.faults()`), then `c.check(literal condition, "what it proves", ...)`.

**A fresh board** (the release image: no server, token or Wi-Fi) with its console on a pty:

```sh
build/sim/pvsim --serve --port 8091 --generic --usb --server <worker url> \
  --run-dir build/sim-e2e --serial-pty build/sim-serial     # log: build/sim-e2e/sim.log
curl -X POST localhost:8091/api/set -d key=cmd -d 'value=sim 4000'      # record 4 s
curl -X POST localhost:8091/api/set -d key=audio -d 'value=file:<path.wav>'   # what the mic hears
```

Device log lines to read: `SETUP,`, `PROV,`, `HELLO,`, `NET,`, `UP,`, `STATUS,`, `UI,screen=...`.

## /setup against a board

- **No hardware, every screen:** `make setup-screens` (or `node tools/e2e/setup-screens.mjs --server <url>`): the real
  page with a scripted board (navigator.serial replaced) and a fake flasher; error states included.
  Screenshots + `build/e2e/screens/sheet.png`.
- **The simulator** (the real firmware logic): `make e2e` bridges `pvsim --serial-pty` to the page's
  `navigator.serial` (tools/e2e/accounts.mjs, step 3).
- **The board:** `WIZ_SSID=… WIZ_PSK=… make e2e-setup` (tools/e2e/web-setup.mjs, real Chrome; the port picker needs a
  person's click the first time per server address). `make board-reset` first for the out-of-the-box path.

## The Worker

- **Locally:** `sh tools/local-worker.sh` serves the Worker on http://127.0.0.1:8787 with its own D1/DO
  state under `build/`, without the AI binding (Workers AI can't be reached from local dev here), so
  transcription fails: fine for setup, accounts, Wi-Fi, MCP and anything not needing AI.
- **Dev deployment:** `make deploy-dev` -> https://dev.paperbot.ca (Worker `paperbot-dev`, its own R2, D1 and
  Durable Objects; anyone can sign up). `TEST_HOOKS=1` there: email + password sign-in (scripts), fake
  `sk-ant-test-…` research keys, `X-Test-Text` / `X-Test-Fail` / `X-Test-Agent` on uploads, `/admin/test/*`.
  Deploying replaces whatever branch was there: redeploy the branch under review when you're done if you
  deployed another.
- **A new person's whole journey:** `make e2e` (`tools/e2e/accounts.mjs`): sign-up, passkey, CLI setup of a
  fresh simulated board with the device code, a recording, research by real Claude Code over OAuth, own-key
  routing, disconnect, remove board, delete account. Results in `build/e2e/results.json`.
- **Tokens:** the owner's device token is `DEV_TOKEN` in `server/.secrets` (dev) and `DEVICE_TOKEN` in
  `.secrets.env` (production). Read them into a variable; never print them.
- **Real clips through the pipeline:** `server/test/run.mjs` (clips are in the main checkout's
  `server/test/wav/`, gitignored): kind accuracy, latency, research end to end.

## Browser

**Screenshots of the web app:** `sh tools/local-worker.sh &` then `make shots` (or `node tools/e2e/shots.mjs
settings inbox --phone`). It signs up a throwaway account, fills it with memos in every state (waiting for the
assistant, researched, stopped, reminders...), links a board, and shoots every screen in light and dark on a
desktop and a phone: `build/shots/<screen>.<desktop|phone>.<light|dark>.png`, a `<screen>.sheet.png` with the four
side by side, and `build/shots/index.html` with each page's console errors and failed requests. The local Worker
serves `server/public` live, so edit CSS and rerun one screen. Look at the pictures before saying a UI change works;
add a screen to `shots.mjs` when you add one to the app. `--server https://dev.paperbot.ca` shoots dev.

For anything else, use a headless Chrome from Playwright (`playwright-core` with
`executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`) in a scratch dir: it
starts clean every run, can add a WebAuthn virtual authenticator for passkeys
(`WebAuthn.addVirtualAuthenticator` over CDP), and never touches the owner's browser. Check for console
errors, take screenshots for the PR. The owner's real Chrome (the `browse` tools) is for things that
need their accounts, e.g. adding a connector in claude.ai; undo what you add.

## MCP clients

Claude Code against a server, without touching the user's global config:

```sh
cd <scratch dir>
claude mcp add -s local --transport http pbtest <url>/v1/mcp
claude mcp login pbtest --no-browser    # needs a tty: drive it from a pty; prints the sign-in URL
claude -p "<task using the tools>" --allowedTools mcp__pbtest__list_memos,...
claude mcp logout pbtest && claude mcp remove -s local pbtest
```

## The board

`make flash` (USB, board awake), `make logs`, `uv run tools/devcmd.py 20 "info" "stat"` (serial commands).
It has no RESET button and USB disappears in light sleep: see `docs/hardware.md` for recovery before
assuming a firmware bug. Hardware runs need the owner present.
Starting over (a board like out of the box, a Mac that never saw paperbot): `sh tools/fresh.sh` (`make fresh`,
`make board-reset`, `make board-backup`, `make board-restore FILE=…`; docs/setup.md "Testing setup again"). Back the
owner's board up before erasing it. The setup page on the real board: `WIZ_SSID=… WIZ_PSK=… make e2e-wizard`.

## Clean up

Stop what you started (`pkill -f "pvsim --serve --port <port>"`, the `wrangler dev` you launched),
remove MCP entries and connectors you added, and delete test resources you created (D1 databases,
secrets). Say what is left behind on the test deployment.
