---
name: deploy-site
description: Preview, deploy, check or roll back the paperbot.ca marketing site (site/). Use when asked to ship, publish, deploy, preview or roll back paperbot.ca or the landing page. Not for the web app or server (that's `make deploy`).
---

# Deploying paperbot.ca

`site/` is a static site (no build step) served by the Cloudflare Worker `paperbot-site` on paperbot.ca and
www.paperbot.ca. It is separate from the web app/server (`server/`, `make deploy`); never mix them up.

## Steps

1. **Check locally**: `make site-check`. Fails on missing files the page references, demo screens without a
   matching image, missing/invalid link-preview tags, an og:image over 300 KB or with the wrong size.
2. **Look at it**: `make site` serves it at http://localhost:8411 (never cached). Check desktop and phone widths.
3. **Preview online** (optional, safe): `make site-preview` deploys the same files to a separate
   `paperbot-site-preview.*.workers.dev` URL and checks it. It never touches paperbot.ca. Share that URL.
4. **Commit** the changes in `site/` (prod refuses uncommitted changes so every deploy maps to a commit).
5. **Ask the user before deploying to production** unless they explicitly said to ship it. Then:
   `make site-deploy`. It runs the check, deploys with the commit in the message, then checks the live site
   (page, link-preview tags, model, scripts, og:image, and that `concepts/` is not public).
6. **Report** the URL and the commit that went out.

If something is wrong after a deploy: `make site-rollback` (previous version), `make site-status` (history).

## Good to know

- Auth: wrangler's own login (already set up on Joe's Mac; `npx wrangler whoami` to confirm). Elsewhere set
  `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ACCOUNT_ID`). Never print or commit tokens.
- `site/.assetsignore` keeps `concepts/` (design mock-ups), the README and the config out of the upload.
- `site/_headers` sets caching: assets 1 day, fonts and vendor 30 days. File names aren't hashed, so if you
  change an image people may see the old one for up to a day; give changed key images a new name
  (e.g. `og-v2.jpg` → `og-v3.jpg`, and update the tags).
- After changing the link-preview image or tags, check paperbot.ca in LinkedIn's Post Inspector and
  Facebook's Sharing Debugger. Slack and iMessage cache previews; a new image file name forces a refresh.
- How the 3D model, screens, illustrations and fonts are made: `site/README.md`.
