# Setting up a paperbot

## In the browser (`/setup`)

For someone with the board and a computer with Chrome, Edge or Firefox (Web Serial; Safari and phones can't):
**app.paperbot.ca/setup** (`server/public/setup.html`, `server/public/setup/`). The page talks to the board over USB
itself, with no install:

1. **Plug it in → Connect**: Chrome's picker (Espressif boards only, listed as "USB JTAG/serial debug unit"). One
   connection for the whole run: opening the port resets the board (`board.js`).
2. **Make it yours**: sign in (Google, a passkey; a new passkey makes a new account) in a popup, so the page keeps its
   connection. Before it closes, the popup connects OpenBelt, where saved items live: `/setup/signed-in` sends it through
   Connect OpenBelt once. OpenBelt's page names paperbot, so Continue with Google (or the email code) is also Allow, and
   a new person's workspace is made there. Connecting deploys the list app. If the person cancels or OpenBelt can't be
   reached, the popup closes all the same and saved items wait for Connect in Settings.
   Meanwhile the release image downloads (from page load) and installs if the board's is older
   (esptool-js, ~10 s); the board restarts on it by itself. Already signed in when the page opened: it asks **Use this
   account?** (Continue / Use another account) first; signing in in the popup is the choice already. Then `POST /v1/setup/claim` (same-origin session) → a board
   token, `prov server` / `prov token`, and the account's saved Wi-Fi (`GET /v1/wifi` → `prov wifi`).
3. **Wi-Fi**: the board's own scan. A network the account has is tried by itself; otherwise pasting the password is the
   whole step (also a `WIFI:` QR text or a picture of the QR code). "Copy it from Wi-Fi settings" opens macOS Wi-Fi
   settings and a guide (Mac / iPhone); in Chrome / Edge the link opens a small always-on-top window instead, whose
   first step opens Settings (Document Picture-in-Picture: the guide and the paste field; the flow stays in the page).
   The board proves it (`wifi test`) before it's saved (`POST /v1/config`, then `prov wifi`). **Use another network**
   on the Connected screen goes back to the list (that one isn't tried again by itself).
4. **Hold ☀ and say**: `prov done` (check-in); the 3D board turns to the ☀ button; the first memo, read from the
   board's console. Then the app.

The 3D board shows the step: its screen uses the page's own frames (`pvsim --setup-frames`, `tools/render3d/frames.py`)
or the board's real ones, and a USB-C cable plugs in (`tools/render3d/make_setup_glb.sh`). The opening still is
`tools/render3d/poster.mjs`.

Tests: `node tools/e2e/setup-screens.mjs --server <test server>` (every screen and error state, a scripted board, no
hardware); `node tools/e2e/web-setup.mjs --server <test server> --psk-from-config` (the real board, from factory
firmware; the port picker needs a click the first time per address).

## Testing setup again

Start over like someone who just got the board (`tools/fresh.sh`; destructive steps ask first):

| | |
|---|---|
| `make fresh` (`SERVER=prod` for production) | back up + factory-reset the board, then open that server's `/setup` |
| `make board-reset` | back up, then erase the board and write Waveshare's factory firmware (like out of the box) |
| `make board-backup` / `make board-restore FILE=…` | the whole 16 MB flash (firmware, settings, Wi-Fi) to/from `~/src/projects/paperbot-hw-backup/` |
| `sh tools/fresh.sh status` | what's on USB |
| `WIZ_SSID=… WIZ_PSK=… make e2e-setup` | `/setup` driven end to end on the plugged-in board via dev (a throwaway account; hold ☀ when asked) |
| `make setup-screens` | every `/setup` screen and error state with a scripted board (no hardware) → `build/e2e/screens/sheet.png` |

Backups hold the board's token and Wi-Fi passwords (kept mode 600). The SD card is never touched.

## Accounts and who pays

Anyone can sign up (Better Auth, `server/src/auth.ts`). paperbot pays for transcription and a few app builds a
month (below).

- One **Inbox Durable Object per person** (`idFromName`): the owner (`OWNER_EMAIL`, signed in with Google)
  keeps `default`, everyone else gets `u:<user id>`. The **Directory** Durable Object maps board tokens
  (SHA-256 only) to accounts.
- **Owner**: research included (server-side agent, budgets as before).
- **Everyone else** (`GUEST_CONFIG` in `server/src/inbox.ts`): transcription capped at 30 audio
  minutes per 24 h. Each reprocess counts again (the clip's length, at least a minute); a clip over the
  cap gets a "daily limit" record and its audio is not kept. Work memos are researched one of two ways (Settings → Research):
  - **their own API key** (Anthropic): checked once, stored sealed in their Inbox, and put on each model
    call by the gateway proxy (`server/src/agent.ts`); if it is removed or rejected, research stops
    instead of falling back to the owner's billing. $5/day cap.
  - **their own assistant** (Claude Code, claude.ai, ChatGPT connectors): OAuth to `POST /v1/mcp`; it calls
    `list_memos` / `get_memo` / `complete_research` / `update_memo` (`server/src/mcp.ts`). The board shows
    RESEARCHING until the result arrives, then DONE + summary.
- **App memos** ("build me an app that…", "change my chore app so…"): routing marks them (Clef `is_build`,
  `intent = "build"`, kind `work`), and the WorkAgent builds them in the person's own **OpenBelt** workspace
  (`OPENBELT_URL`, openbelt.com for dev too) with OpenBelt's app tools over MCP (its `search` and `call`; a build
  may call only the app operations in `BUILD_OPERATIONS`) and no web tools
  (`server/src/openbelt.ts`, `agent.ts` build mode: 24 turns, 300 s, $0.25 per build).
  - **Connect OpenBelt** (in setup's sign-in popup; later, Settings → Apps or the card on a waiting memo): paperbot registers itself as an
    OAuth client and sends the person to OpenBelt's own sign-in (an email code; `login_hint` fills in their
    email). The tokens are stored sealed in their Inbox; OpenBelt never trusts paperbot to say who someone is.
    Disconnect (or deleting the account) signs paperbot out on OpenBelt; the apps stay theirs.
  - **List** and **Apps** in the web app (`server/public/belt.js`, `GET /api/belt`) show what is in their OpenBelt, read
    again as them on each look: the items by list (checking one off writes `done` back), and their apps with the picture
    OpenBelt's home page shows (`app_picture` over MCP, `GET /api/belt/apps/<app>/picture`, kept 5 minutes). paperbot keeps
    no copy. Test: `node tools/e2e/belt.mjs --openbelt <workspace URL>` against a local OpenBelt (the script says how).
  - Until it is connected, an app memo waits (`agent_state = needs_openbelt`; the board shows RESEARCHING) and
    builds as soon as it is.
  - Who pays: included research (owner), their own key, or one of `free_builds_month` (20) free builds a
    month on paperbot's account; with none left it goes to their own assistant like research.
- Audio and reports of other accounts are stored under `audio/u:<user id>/…` (the owner's keys are
  unchanged). Settings → Account: download my data, delete account (boards revoked, R2 objects, inbox and
  sign-in records deleted).

## Release image

`sh tools/setup-bundle.sh` builds the firmware without `secrets.h` (`PV_GENERIC=1`) and writes
`dist/setup/<version>/` (bootloader, partition table, otadata, app + `manifest.json`).
`--publish [--env production]` uploads it to the Worker's R2 (`setup/`), served at
`/v1/setup/firmware/*`; `/setup` installs the version listed there.

A board without setup shows **SET ME UP**; it records and keeps clips on the card, but never turns
Wi-Fi on until it has a server.

## Server endpoints

| | Auth | |
|---|---|---|
| `GET /v1/ping` | none | 204 (the board's `wifi test`) |
| `POST /v1/setup/claim` `{device}` | session, same origin | `{token, email}`: a board token for this person (re-running retires the board's previous token) |
| `GET /v1/setup/claim?device=` | session | `{online, seen_at, fw}`: has the board checked in |
| `GET /setup` | none | the setup page (`/setup/signed-in`: the sign-in popup's last page, session required) |
| `GET /v1/setup/firmware/<file>` | none | the release image |
| `GET /install` | none | 301 to `/setup` (the old CLI installer's address) |
| `POST /v1/config` `{tz, wifi:[{ssid, psk \| open, fallback}]}` | device token | merges networks, sets time zone; returns the board's Wi-Fi list |
| `POST /v1/mcp` | OAuth access token | MCP (JSON-RPC, stateless) |
| `GET /admin/accounts` | owner token | accounts, configs, tokens |

## Board serial commands

`info` → `@{"id","fw","server","token":bool,"wifi_rev","networks":[ssids],"hello","net","net_http","net_age_s","ssid","sd","batt_mv","usb","state"}`
(`net`: `never`, `ok`, `server`, `wifi_password`, `wifi_not_found`, `no_wifi`, `aborted`). Never prints the token or passwords.

`prov server <url>` · `prov token <token>` · `prov wifi <GET /v1/wifi body>` (replaces the list, any revision) ·
`prov done` (check in now; also uploads clips recorded before setup) · `prov reset` → `@{"ok":true|false,...}`.
`wifi scan` → `@{"ok":true,"what":"scan","nets":[{"ssid","rssi","open"}]}` (one per name, strongest first) ·
`wifi test {"ssid","psk"}` → joins, then `GET <server>/v1/ping`; nothing saved →
`@{"ok":true,"what":"test","ssid","rssi","ms"}` or `@{"ok":false,"what":"test","error":"wifi_password|wifi_not_found|no_wifi|server|no_server|bad_input"}`.
A wrong password comes from the driver's disconnect reason (4-way handshake timeout etc.; Arduino's status never says
so). The board reads the console only between network sessions: allow ~45 s for an answer.
No network sessions run between the first `prov` and `prov done`. Settings live in NVS (`srv_url`,
`dev_tok`, `wifi`, `hello`) and replace the ones compiled in.

## Tested

- Simulator: `setup_fresh_board`, `setup_problems`, `setup_wifi_test` (make sim-test).
- `/setup` on the real board (2026-11-15): from Waveshare's factory firmware, via a local Worker and via
  dev.paperbot.ca: flash ~7 s (esptool-js), restart by itself, sign-in in the popup, wrong then right Wi-Fi password,
  check-in, ~42 s machine time in all (`tools/e2e/web-setup.mjs`, 13/13).
- Every screen and error state: `tools/e2e/setup-screens.mjs` (picker cancelled, port busy, install failed, network not
  found, wrong password, the password guide, the first memo).
- End to end: `make e2e` against https://dev.paperbot.ca: sign-up, passkey, `/setup` on a fresh simulated board (its
  console bridged to the page's `navigator.serial`), real transcription, research by real Claude Code over OAuth,
  own-key routing (a fake key must be refused by Anthropic), disconnect, remove board, delete account
  (tools/e2e/README.md).
