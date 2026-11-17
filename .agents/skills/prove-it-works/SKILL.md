---
name: prove-it-works
description: Use before saying any paperbot task is done, fixed, or working. Requires checking the real artifact (simulator scenarios, /setup against the simulator or a scripted board, real HTTP against the local or dev Worker, a browser, the board itself) instead of proxies like "it compiles" or "the code looks right". paperbot has no unit tests; this is how correctness is shown.
---

# Prove it works

Check the real thing. Don't infer from proxies, self-reports or "it builds". paperbot has **no unit
tests**: proof comes from driving the real firmware logic, the real Worker, the real setup page.

## Not evidence

- a build or typecheck passing (`make firmware`, `npx tsc -p .`): necessary, never enough
- reading the code and concluding it's right
- a subagent or an earlier message saying it works
- an old report, log or screenshot from before the change

## Evidence by change

| change | proof |
|---|---|
| device logic (`firmware/core`) | a simulator scenario that exercises it (`make sim-test SCENARIO="..."`), plus the whole suite still passing; e-paper frames in `build/sim-test/<scenario>/*.png` |
| board-only code (`firmware/paperbot`: HAL, drivers, power) | it builds (`make firmware`, and `PV_GENERIC=1` for the release image), then on the board (`make flash`, `make logs`). Without a board say "builds, not run on hardware" |
| device <-> server contract | the simulator against the real Worker (`verify-paperbot`): uploads, results, status, Wi-Fi list |
| server routes, Durable Objects | requests against the local Worker or the dev Worker, reading the result back the way a user or device would (`/v1/...` with a device token, `/admin/records`, the web API) |
| web app, sign-in pages | `make shots` against the local Worker: look at the changed screens in light and dark, desktop and phone (`build/shots/<screen>.sheet.png`), and the contact sheet shows no console errors or failed requests 
| /setup | `make setup-screens` (every screen and error state, scripted board), `make e2e` (the simulator), `make e2e-setup` (the board); failure paths too (wrong Wi-Fi password, board not answering) |
| MCP connector | a real client: `claude mcp add` + `claude mcp login`, then a tool call (`verify-paperbot`) |
| AI pipeline (transcription, routing, research) | the dev Worker with real clips (`server/test/run.mjs` from the main checkout's test clips) |

## How

1. Run the change the way a person, an agent or the board would.
2. Compare against **literal expected values** the user would see ("screen=WORK_DONE", "title=Buy AA
   batteries", HTTP 401), never against values computed by the code under test.
3. Keep the evidence (the report path, the log lines, the command and its output).
4. If the proof will be useful again, keep it: a scenario in `sim/src/scenarios.cpp` or a script in
   `tools/`. A check anyone can rerun beats a one-off.

## A check proves something only if it can fail

- Would it still pass if the code did nothing? Then it checks nothing.
- Revert the fix, run the check, watch it fail, restore. A check never seen failing is a hope.
- Cover the neighbours: the case beside the bug (a second network, a reboot after the fix, the old
  firmware's request shape).

When a check fails, doubt your observation first (an old `pvsim` or `wrangler dev` still running, the
wrong port, a stale `~/.pocketbot`, the dev Worker on a different branch) before doubting the system.

## Report

Say what you ran, what you saw and where the evidence is. "Done, not verified on the board because X"
is a fine answer; "done" without proof isn't.
