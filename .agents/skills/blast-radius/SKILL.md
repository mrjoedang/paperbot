---
name: blast-radius
description: Before landing a change to paperbot surfaces others depend on (the device API, firmware stored formats, Durable Object RPC and tables, auth and setup flows, MCP tools, wrangler config and migrations), find what else it could break and prove the one fact that makes it safe by running something. Use when a change touches anything boards in the field, stored data, agents or other people's setups depend on.
---

# Blast radius

Grep shows callers. The job is the breakage grep won't show.

## High-risk surfaces in paperbot

- **The device API** (`server/src/index.ts` `/v1/*`, `docs/device-api.md`): boards in the field run the
  firmware they were flashed with and update only through OTA. Every reply shape, status code and header
  must keep working for the oldest firmware still out there. The device reads at most 2 KB.
- **Firmware stored state**: NVS keys and value formats (`wifi`, `srv_url`, `dev_tok`, `hello`, `boot_n`,
  OTA notes), the SD card's pending-results list and queue file names. A new firmware boots on old data;
  an old firmware may boot on new data after an OTA rollback.
- **Durable Objects**: Inbox / Directory / WorkAgent tables and RPC methods. Objects created before the
  change must still open; during a deploy old and new code can meet. New classes need a wrangler
  migration tag in both environments.
- **Accounts and auth**: board tokens (hashed in the Directory), Better Auth tables in D1 (users, sessions,
  passkeys, device codes, OAuth clients / consents / tokens), the owner mapping (`OWNER_EMAIL`). A change
  can sign people out, orphan a board, or let one account reach another's inbox.
- **R2 keys** (`audio/...`, `reports/...`, `setup/`): records point at them.
- **MCP tools** (`server/src/mcp.ts`): connectors cache the tool list; descriptions are what the model reads.
- **wrangler.jsonc**: bindings, routes, custom domains, migrations, vars. Production has its own copy.

## Steps

1. Read the change, including what it implies beyond the diff (defaults, ordering, sizes, encodings).
2. Name the **one fact** the change is safe because of. Example: "firmware 1.0.0 still parses the new
   result reply because the added field is ignored by `pv_json` and the reply stays under 2 KB."
3. Look past grep: the oldest firmware's request and parser, data written by the previous version, a
   board mid-OTA, a /setup page loaded before the deploy, the production config.
4. Rate each risk: likelihood and impact, with file:line.
5. Prove the fact. Weakest to strongest: assertion < code citation < failure-path argument <
   **executable check** < **verified on a live instance**. Aim for the last two: a simulator scenario
   with the old firmware's behavior (the `legacy_*` scenarios are the pattern), data written by the old
   code read back by the new one on the dev Worker.

## Output

What changed; the safety fact and the proof level reached; confirmed risks (location, severity); cleared
items; the check to add before landing.
