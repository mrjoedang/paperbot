# paperbot (server)

Async device contract ([`docs/device-api.md`](../docs/device-api.md)) + live web app.

| | Worker | URL | Deploy |
|---|---|---|---|
| **Production** | `paperbot` | https://app.paperbot.ca (+ app.pocketbot.ca: `/v1` and `/admin` for boards set up with it, web pages 301 to app.paperbot.ca) | `npx wrangler deploy --env production` (owner says so) |
| Dev | `paperbot-dev` | https://dev.paperbot.ca | `npx wrangler deploy` (`make deploy-dev`) |
| Old URLs | `pocket-voice`, `paperbot` | https://pocket-voice.mrjoedang.workers.dev, https://pocketbot.mrjoedang.workers.dev | shims in `legacy-shim/` (`/v1/*` passed to paperbot, web 301 to app.paperbot.ca) |

| Path | What |
|---|---|
| `src/index.ts` | Routing, auth, device API (`/v1/*`), web API (`/api/*`), admin + test hooks (`/admin/*`) |
| `src/inbox.ts` | `Inbox` Durable Object: records, agent coordinator, **live hub** (hibernatable WebSockets), device telemetry / status / health, Wi-Fi networks |
| `src/agent.ts` | `WorkAgent` (research agent), streams its steps to the hub |
| `src/pipeline.ts` | Whisper → Clef + Qwen routing (inline + Workflow fallback) |
| `src/auth.ts` | Better Auth: sign-in (Google, passkeys), OAuth for assistants (`/v1/mcp`) |
| `src/directory.ts` | `Directory` Durable Object: accounts (one Inbox per person), board tokens |
| `src/mcp.ts` | MCP server (`POST /v1/mcp`) for a person's own Claude: list / read memos, deliver research |
| `src/logic.ts` | Pure helpers: telemetry parsing, PATCH / status / Wi-Fi validation, battery trend, alerts |
| `public/` | Web app (vanilla ES modules, no build): `app.js` inbox + Bolt + live socket, `bolt.js` 1-bit Bolt / device mirror (port of `firmware/core/src/pv_bolt.cpp`), `health.js`, `settings.js` (the Settings window: a sidebar of pages, a menu of its own on a phone), `account.js` (its pages: research, recording, devices, apps, assistants, account; the setup card), `places.js` (its Wi-Fi page), `auth-pages.js` (`/login`, `/consent`), `setup.html` + `setup/` (`/setup`: setup over Web Serial), `md.js` (escape-first Markdown), `wifiqr.js`, `vendor/jsQR.js` (Apache-2.0) |

Deploy: `npx wrangler deploy` (from `server/`, the dev Worker). Secrets: `DEVICE_TOKEN`, `WIFI_KEY`,
`BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_SECRET`, `OWNER_EMAIL` (values in `.secrets`, gitignored: `DEV_TOKEN`, `DEV_WIFI_KEY`,
`DEV_BETTER_AUTH_SECRET`; Google in `../.secrets/google-oauth.env`).

## Live updates

`GET /api/live` (WebSocket) → the `Inbox` DO (`ctx.acceptWebSocket`, hibernation; `ping`→`pong` is an
auto-response so heartbeats never wake it). On connect: `snapshot` (records, budget, devices, Wi-Fi).
Then compact events: `incoming` (upload headers seen, body still streaming), `rec` (any record change:
created, transcript heard, routed, edited, agent state), `step` (research log line + turn/cost
counters from the WorkAgent), `device`, `device_event` (crash/boot/log), `budget`, `wifi`, `resync`.
Client: reconnect with exponential backoff + jitter (0.5 s … 15 s), heartbeat every 20 s (dead link
after 10 s without pong), falls back to polling `GET /api/snapshot` every 5 s after 3 failed
connects, resyncs from the snapshot on every reconnect.

## Auth

Sign-in is [Better Auth](https://better-auth.com) (`src/auth.ts`, users and sessions in D1 `AUTH_DB`). Anyone can sign up.

- **Web app** (`/`, assets, `/api/*` incl. the WebSocket, `/audio/*`): session cookie. Sign in on `/login` with
  Google or a passkey (email + password only where `TEST_HOOKS=1`, for scripts). No session: pages redirect to
  `/login?next=…`, `/api/*` answers 401. Mutating requests must be same-origin; HTML gets a strict CSP.
- **Setup** (`/setup`): the page, signed in, calls `POST /v1/setup/claim {device}` (same origin), which mints a
  board token (`pb_d_…`, SHA-256 in the `Directory` DO) for that person's inbox and writes it to the board over
  Web Serial.
- **Boards** (`/v1/*`): `DEVICE_TOKEN` (owner, inbox `default`) or a board token. Removing a board in Settings → Devices
  revokes its token (other isolates cache tokens for up to 60 s).
- **Assistants** (`/v1/mcp`): OAuth 2.1 (Better Auth MCP plugin): discovery (`/.well-known/oauth-protected-resource/v1/mcp`,
  RFC 9728), dynamic client registration, PKCE, consent on `/consent`. Access tokens are JWTs for `<origin>/v1/mcp`
  (1 h); disconnecting in Settings → Assistants deletes the consent and refresh tokens.
- **`/admin/*`**: the owner's `DEVICE_TOKEN`. `POST /admin/auth-migrate` creates / updates the auth tables after a
  deploy that adds some.
- **One Inbox per person**: `OWNER_EMAIL` signed in with a verified address (Google) → `default` (research
  included); everyone else → `u:<user id>` (`GUEST_CONFIG`: 30 audio min and $0.50 of routing and answers / 24 h, 4× with their own key; research with their own API key,
  stored sealed in their Inbox and used by the gateway proxy per request, or by their own assistant over MCP,
  `src/mcp.ts`). The cron sweeper visits every inbox, then checks alerts (`src/alerts.ts`).
- **Alerts** (`src/alerts.ts`): mails to the owner through `ALERT_URL` (secret, with `ALERT_TOKEN`): paperbot's AI
  spend over the last 24 h at 50% and 100% of `ALERT_SPEND_USD` (the gateway's spend limit), 30+ new accounts in an
  hour, and the AI Gateway refusing calls (spend or rate limit). Each at most once per few hours.
- **`TEST_HOOKS=1` (dev only)**: email + password sign-in, fake `sk-ant-test-…` keys saved unchecked, `X-Test-*`
  upload headers, `X-Test-At` on `/v1/status`, `/admin/test/{seed,record,purge,devices,drop}`.

## Production (`paperbot`)

Config: `env.production` in `wrangler.jsonc` (bindings are repeated there; `TEST_HOOKS` is not set, so the
email + password sign-in, `/admin/test/*`, `X-Test-*` and `X-Test-At` do not exist).

- R2 `paperbot` (copied from the old `pocket-voice-audio` on 2026-11-16; migrated tasks keep their `audio/<id>.wav`).
- Durable Objects: `Inbox`, `WorkAgent` (+ empty `TaskList`); Workflow `paperbot-pipeline`; cron sweeper every minute.
- AI Gateway `paperbot`: logs on, rate limit 60 req/min (sliding), spend limit $5 per 24 h (backstop over the
  app's own $2/day agent budget, `/admin/config`).
- D1 `paperbot-auth` (accounts, sessions, passkeys, OAuth clients). Google OAuth client in Google Cloud project
  `pocketbot-514715` (redirect `https://app.paperbot.ca/api/auth/callback/google`). The old Cloudflare Access app must
  be removed when this ships, or it keeps everyone else out.
- Secrets (`--env production`): `DEVICE_TOKEN` = the production device token (`../.secrets.env` `DEVICE_TOKEN`),
  `WIFI_KEY` (`../.secrets.env` `PAPERBOT_WIFI_KEY`; losing it means re-entering Wi-Fi passwords and own API keys),
  `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_SECRET` (`../.secrets/google-oauth.env`).

Deploy a change: `npx tsc -p . && npx wrangler deploy` (dev) → check (`tools/e2e/accounts.mjs`) → `npx wrangler deploy --env production`.

Admin (Bearer device token): `GET /admin/records`, `GET|DELETE /admin/records/:id[?audio]`, `DELETE /admin/devices/:key`,
`GET|POST /admin/config` (budgets), `POST /admin/import-legacy` (rows of the old `GET /v1/export`, idempotent),
`POST /admin/sweep`.

Migration done 2026-10-17: 69 tasks from the old `pocket-voice` (`GET /v1/export` → `POST /admin/import-legacy`;
43 legacy "(no speech)" → `noise`, 20 note, 3 reminder, 2 work, 1 todo). v2-test data was not imported.

Tear down the old test deployment: `sh teardown.sh`.
