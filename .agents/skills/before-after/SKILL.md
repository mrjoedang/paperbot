---
name: before-after
description: Put before/after evidence in a paperbot pull request: the PR's base and head driven by the same steps, shown side by side (e-paper frames from the simulator, web screenshots, HTTP transcripts). Use when opening or updating a PR (create-pr), or when asked for before/after evidence.
---

# Before/after for a PR

Every PR body carries a block between `<!-- before-after:start -->` and `<!-- before-after:end -->` that
shows the change twice: on the PR's base and on its head, driven the same way.

## Get both sides

```sh
base=$(git merge-base origin/main HEAD)
git worktree add --detach <scratch>/before "$base"     # the base, in its own checkout
```

Run the same steps in both checkouts (build each one there: `make sim-build`, ...). Remove
the worktree afterwards (`git worktree remove <scratch>/before`).

## What to show, by change

- **Device behavior / screens:** a simulator scenario run on both sides; its frames are PNGs in
  `build/sim-test/<scenario>/`. Put the matching frames side by side (before | after) with one caption
  saying what changed. A screen the base doesn't have is still a valid "before": say so.
- **Web app:** headless Chrome on the base and the head (`verify-paperbot`), the same page at desktop
  (1280x800) and phone (390x844) width, side by side.
- **Setup page:** `make setup-screens` on both sides (base and head deployed to dev, or a local Worker), the
  changed screens side by side.
- **Server / device API:** the request and both responses (`curl -si`), tokens redacted.
- **Board-only changes** (drivers, power): the log lines from the board, or say there is no local
  before/after and why. The block is never left out.

Images go in the PR via `gh` attachments or a comment; keep each under 10 MB. Never include a token,
password, Wi-Fi password or personal recording in the evidence. The repo is public: shoot web pages
against a localhost Worker, never a tailnet address (`*.ts.net` shows up in the MCP command on Research),
and look at every image for hostnames, personal email addresses and `/Users/...` paths before attaching
it. A PR body's edit history keeps every image ever posted.

## The block

```markdown
<!-- before-after:start -->
**Before** (<base sha>) | **After** (<head sha>)
<image or transcript diff, in <details> if long>
<one or two sentences: what to look at>
<!-- before-after:end -->
```
