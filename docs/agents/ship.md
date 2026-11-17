# Shipping paperbot

The facts the general `create-pr`, `babysit-pr`, `full-send` and `quick-send` skills need here. Where
this page and a skill differ, this page wins.

## Proof (the gate)

paperbot has no CI yet: the proof is the gate, run before the merge, because after it the change goes
straight to people's boards, accounts and setups.

- `prove-it-works` with `verify-paperbot`: the scenarios, requests and runs that show the change works.
- `make sim-test`, the server typecheck, and the builds the change touches.
- A change to `/setup` (`server/public/setup*`): `make setup-screens` and `make e2e`.
- The device API, auth, setup, stored data or Durable Objects: `blast-radius` first. Boards in the
  field run old firmware.
- The dev Worker (dev.paperbot.ca) is fair game for verification; production is not.

## The PR

- Title and body: `create-pr`. Evidence: the `before-after` skill fills the block between
  `<!-- before-after:start -->` and `<!-- before-after:end -->`.
- Merge policy: squash, unless the owner says otherwise:
  `gh pr merge <pr> --squash --match-head-commit <sha>`.
- A merge deploys nothing.

## Deploy (quick-send)

Production is the `paperbot` Worker, https://app.paperbot.ca. The dev Worker is not deployed.

1. Note what production runs, for a rollback:
   `npx wrangler deployments list --env production` (the current version id).
2. From a clean checkout of `origin/main` (a detached worktree, `git diff origin/main` empty):
   `cd server && npm ci && npm run -s types && npx tsc -p . && npx wrangler deploy --env production`
   (`npm run types` writes the gitignored `worker-configuration.d.ts` the typecheck needs). A new
   Durable Object class or database: check its migration and bindings are in the `production` env of
   `wrangler.jsonc` first.
3. Confirm:
   - The owner's device token still gets `200` on `/v1/wifi` at https://app.paperbot.ca.
   - The change's own behavior works, and `npx wrangler tail --env production` shows no new errors.
   - New auth tables: `POST /admin/auth-migrate`. Don't create test accounts on production.
   - A change to `/setup`: https://app.paperbot.ca/setup loads with no page errors
     (`make setup-screens SERVER=...` only against dev).

### When it fails

- **The deploy fails:** read the error (bindings, migrations, bundle size). Nothing changed on
  production if the upload failed. Fix it through a PR.
- **The smoke test fails after shipping:** roll back at once,
  `npx wrangler rollback <version-id> --env production` with the version from step 1, then check
  `/v1/wifi` is `200` again. A rollback restores code, not data: say if the bad version wrote anything.

### Not authorized

Publishing firmware (`setup-bundle.sh`) or a production OTA release. Firmware reaches boards only by
flashing or a production OTA release; quick-send does neither, and the report says so.

### Report

The deployed commit, the Worker version and the one before it, the smoke results, and anything not
verified on a board or not shipped (firmware). Production: https://app.paperbot.ca.
