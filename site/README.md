# paperbot.ca

Static site for paperbot: `index.html`, `style.css`, `main.js`, no build step.

- `make site`: preview at http://localhost:8411 (never cached)
- `make site-check`: pre-deploy checks · `make site-preview`: safe preview URL on workers.dev
- `make site-deploy`: deploy to paperbot.ca (committed changes only), then checks the live site
- `make site-rollback` / `make site-status`
- Agents: `.agents/skills/deploy-site/SKILL.md`
- Old domains, outside this repo (Cloudflare redirect rules on each zone): pocketbot.ca, www.pocketbot.ca and
  paperbot.dev 301 to https://paperbot.ca with the path kept.

## Assets
- `assets/paperbot.glb`: the 3D device, compressed (1.04 MB → 224 KB) with
  `npx @gltf-transform/cli@4.1.1 optimize in.glb paperbot.glb --compress meshopt --texture-compress webp --simplify false --instance false`.
  Meshopt needs `vendor/meshopt_decoder.js` (meshoptimizer 0.22, MIT), set via `self.ModelViewerElement` in index.html.
  Originally: the 3D device (1 BU = 1 mm in Blender, exported in metres). It is built by
  `tools/render3d/export_web.py` from the Blender model (`tools/render3d/build.py`), with
  textures from `tools/render3d/web_tex.py` (simulator frames → e-paper screens, icon normal maps).
- `assets/bolt/*.png`: 200×200 1-bit Bolt frames from `make sim-test` (test suffixes like "#1" erased). `screen.js`
  turns them into the 3D screen's texture at runtime (live REC timer, e-paper style refresh flash).
  `work-*.png` / `done-*.png` (the research demo) were drawn with the firmware's own `pv::BoltLayout::render`
  (Researching / WorkDone screens with new text), linked against the simulator's build objects.
- `assets/img/illus-*.webp`: desk scenes for the benefit columns and the open-source section, rendered in Blender with the real
  model (`tools/render3d/illus.py` renders each scene twice: the objects, then only their shadow from one big soft light;
  `compose_illus.py` lays a soft warm shadow under the objects. Props: phone, mug, USB-C cable, screwdriver).
- `assets/img/poster.webp`: still of the opening view (captured from the viewer, 1.4:1, full stage height). The page shows
  it at once and fades it out when the 3D device has drawn its first frame; the device's size follows the stage height,
  so the still lines up at any window size. Recapture it if the camera, model or opening screen changes.
- `assets/img/`:, og:image (`og-v4.jpg`, 1200×630; bump the version in the file name when it changes, since Slack and iMessage cache previews), and the web app screenshots
  (`app-list-phone-v2.webp`: the List tab, in the "It lands in one quiet list" row): `make site-shots` against
  `sh tools/local-worker.sh` and a local OpenBelt shoots the real app with sample list items
  (`tools/e2e/site-shots.mjs`). Rerun it when the app's look changes, with a new version in the file name.
- `vendor/model-viewer.min.js`: @google/model-viewer 4.1.0 (BSD-3-Clause).
- Fonts: Fraunces (headlines, "SOFT" axis at 100) and Figtree (text), both OFL, self-hosted in `fonts/`.
  Geist files are only used by the mock-ups in `concepts/` (not deployed).
- Look: warm white `#f8f6f1`, soft charcoal `#3b3a35`. The 3D device leads; one hold-to-talk button under it.
- `_headers`: Cloudflare cache rules (assets 1 day, fonts and vendor 30 days; code always revalidates).
