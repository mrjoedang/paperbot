# End-to-end: a new person's whole journey

`accounts.mjs` drives everything a new person does, for real, against a deployment with `TEST_HOOKS=1`
(default https://dev.paperbot.ca; it refuses paperbot.ca):

1. Sign up (email + password, dev only), the first-visit setup card, Settings data (`/api/me`).
2. Add a passkey, sign out, sign back in with only the passkey (CDP virtual authenticator).
3. `/setup` on a fresh simulated board (`pvsim --generic --serial-pty`, its console bridged to the page's
   `navigator.serial`): already signed in, so it asks "Use this account?", then Wi-Fi; pasting the password connects; the board checks in.
4. A recording (real Whisper + routing) shows on the board and in this person's inbox, not the owner's.
5. A work memo waits for their assistant; real Claude Code connects (discovery, registration, PKCE, consent),
   researches it with one Haiku call, and the board shows the result.
6. A fake own API key (`sk-ant-test-…`, saved unchecked on dev) is put on the next work memo's model calls:
   it must stop with Anthropic's auth error, never succeed on the owner's billing.
7. Disconnect the assistant, remove the board (its token stops working), delete the account (`--keep` skips this).

`setup-openbelt.mjs` is /setup for someone new with OpenBelt connected in the sign-in popup (sign-up, "Connect paperbot
to OpenBelt", Continue with Google, Wi-Fi, a spoken memo saved in their OpenBelt list), against a local Worker, a local
OpenBelt and a stand-in Google (its header has the commands). It goes on through Continue into the List tab (a tick there
is written to OpenBelt) and the Apps tab. It writes a screenshot of each step and one video, `build/e2e-openbelt/seamless.mp4`. `--manual` opens a visible Chrome on the
same simulated board for a person to click through, with a panel that says a sentence to the board and holds ☀. `--throwaway` signs up with the page's
throwaway button; `--via email --openbelt-log <platform.log>` signs in to OpenBelt with an emailed code (read from the
local OpenBelt's log, which `--manual` also shows and fills in).

```sh
make sim-test               # builds build/sim/pvsim
make e2e                    # builds the simulator, installs playwright-core, runs it
node tools/e2e/accounts.mjs --server http://127.0.0.1:8787   # another deployment (sh tools/local-worker.sh has no AI)
```

Needs Google Chrome, `claude` (Claude Code, signed in) and `python3`. The clips come from `server/test/wav/`.
Nothing touches your browser profile or your Claude Code config (the connector is added with
`--scope local` in `build/e2e/cc` and removed afterwards). Output: `build/e2e/results.json`; exit 1 if a step failed.
