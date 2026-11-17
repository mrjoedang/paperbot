---
name: make-operations-idempotent
description: Principle. Design paperbot's state-changing steps (uploads, result checks, setup, token minting, the check-in, Wi-Fi list adoption, OTA, Durable Object startup) so running them twice, concurrently, or after a crash or power cut at any point ends in the same correct state. Use when adding or changing any step that mutates state or retries.
---

# Make operations idempotent

Boards lose power mid-write, replies get lost, setup gets re-run, Durable Objects restart, cron runs
every minute. Every state-changing step answers three questions before it ships:

1. What happens if it runs twice in a row?
2. What happens if two run at once?
3. What happens if the previous run died at each point?

## Patterns paperbot already uses

- **The clip id is the idempotency key.** A re-uploaded clip returns the same record (`duplicate: true`),
  never a second task. The device remembers the id before deleting the clip, so a power cut in between
  re-uploads instead of losing the result.
- **Old or new, never half.** The Wi-Fi list is validated completely, then saved as one NVS entry; OTA
  writes the other slot and switches only after size and SHA-256 match; DO tables are created with
  `IF NOT EXISTS` on every start.
- **Re-runnable setup.** `/setup` keeps nothing in the browser: what it set is on the board (`prov`) and the
  account (Wi-Fi). Running it again skips an install that's done, claims a new token (retiring the old one) and
  tries the account's saved Wi-Fi by itself.
- **Re-check at the moment of acting.** A result check that finds the record changed acts on what it
  finds, not on what it expected.
- **When a step can't be idempotent, say so** and make the second run detectable (minting a board token
  retires the board's previous one).

## Prove it

Run the step twice and compare the end state to a literal expected value; cut power or reset in the
simulator at the awkward moment (`c.s.cutPower()`, `c.s.reset()` in scenarios); fire two requests at once
against the dev Worker and count the side effects.
