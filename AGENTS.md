# paperbot

A pocket push-to-talk voice-memo gadget (Waveshare ESP32-C6 1.54" e-paper board, "Bolt" UI).
Hold ☀, talk, let go: the clip goes to a Cloudflare Worker, gets transcribed, and a router (one Haiku call) picks
ignore / answer / save / research / app: answers go back to the screen, saved items to the person's OpenBelt list
(`server/src/items.ts`), research and apps to the agent. People set a board up in the browser
at app.paperbot.ca/setup (Web Serial: flash, sign in, Wi-Fi).

## Layout

```
firmware/core/      device logic shared by the board and the simulator (pv_app.* state machine, queue,
                    results, OTA, status, Wi-Fi, setup over serial: info / prov)
firmware/paperbot/ the board: ESP32 HAL (esp32_hal.*), drivers, pv_secrets.h (secrets.h or release image)
sim/                simulator: firmware/core on the Mac with fake hardware, browser UI, mock server, scenarios
server/             Cloudflare Worker: device API (/v1), web app (public/), Inbox / Directory / WorkAgent DOs, MCP
tools/              serial tools, ota/, setup-bundle.sh (release firmware), cli-release.sh, hooks/
docs/               device-api.md (device <-> server contract), setup.md, hardware.md (board quirks, recovery)
```

## Commands

| | |
|---|---|
| `make sim-test` / `make sim-test SCENARIO="a b"` | simulator scenarios, report in `build/sim-test/report.html` |
| `make sim` | simulator in the browser (http://localhost:8090) |
| `make firmware` / `PV_GENERIC=1 sh firmware/build.sh` | board firmware / release image (no secrets) |
| `cd server && npx tsc -p .` | server typecheck |
| `sh tools/local-worker.sh` | the Worker locally (no AI binding), for setup / account flows |
| `make deploy-dev` | the dev Worker (`paperbot-dev`, https://dev.paperbot.ca) |
| `make shots` / `make shots SCREENS="login settings"` | screenshots of every web screen, light/dark, desktop/phone, against `sh tools/local-worker.sh`; contact sheet `build/shots/index.html`, one `<screen>.sheet.png` per screen |
| `make e2e` | a new person's whole journey on dev (sign-up, passkey, /setup on the simulator, research, delete) |
| `make setup-screens` | every /setup screen and error state with a scripted board (no hardware) |

## Rules

- **No unit tests.** Prove behavior on the real thing: simulator scenarios, the dev Worker, /setup
  against the simulator, the board. See `prove-it-works` and `verify-paperbot`.
- **Secrets never get printed or committed.** They live in gitignored files in the main checkout
  (`.secrets.env`, `.secrets/`, `server/.dev.vars`, `server/.secrets`, `firmware/paperbot/secrets.h`);
  the worktree hook links them into worktrees.
- **Production** (`make deploy`, the `paperbot` Worker, R2 `paperbot`) changes only when the
  owner says so ("quick send" counts). The dev Worker (dev.paperbot.ca) is fair game for verification.
- **The repo is public (MIT).** Commits, PR bodies and screenshots are public: no personal email
  addresses, tailnet URLs, tokens or real memos in them. History before 2026-11-17 (PRs #1-34) is in the
  private `mrjoedang/paperbot-history`.
- **Boards in the field run old firmware.** Device API changes stay compatible with firmware already
  out there (`blast-radius`).
- Battery first on the device: no feature that keeps Wi-Fi or the CPU awake without a reason.

## Skills (`.agents/skills/`)

paperbot's own: `prove-it-works`, `verify-paperbot`, `blast-radius`, `before-after`,
`frontend-design`, `deploy-site` (the paperbot.ca marketing site, `site/`), `boundary-discipline`,
`make-operations-idempotent`.

## Agent skills

The general skills (`quick-send`, `full-send` and "full stop", `create-pr`, `babysit-pr`, `council`
and its "sol loop", `fix-root-causes`, `attack-the-premise`, `subtract-before-you-add`,
`cut-over-completely`, `encode-lessons-in-structure`) live in the owner's home repo, linked into every
harness. They read paperbot's facts from here:

- **Prove a change:** `prove-it-works` with `verify-paperbot`; `make sim-test` and the server typecheck.
- **Ship it** (the gate, merge policy, deploy, rollback, what's not authorized):
  [docs/agents/ship.md](docs/agents/ship.md).
