// List and Apps end to end: a throwaway paperbot account linked to an OpenBelt workspace (a local one: `bun run dev` in an
// OpenBelt checkout), driven in headless Chrome. Proves the web app shows the OpenBelt list and apps, a check-off here is
// written there, a change made there shows here, a memo that saves refreshes the list by itself, and app pictures load.
//
//   sh tools/local-worker.sh --var OPENBELT_URL:https://acme.dev.openbelt.dev:8471 &
//   OPENBELT_TOKEN_FILE=<file with the dev server's token> node tools/e2e/belt.mjs --openbelt https://acme.dev.openbelt.dev:8471
//
// Results: build/e2e/belt/results.json and screenshots (list, apps, not connected; desktop and phone, light and dark).
import { chromium } from "playwright-core";
import { mcpClient, openbeltArgs, seedList } from "./openbelt.mjs";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = `${ROOT}/build/e2e/belt`;
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const B = (opt("--server") ?? "http://127.0.0.1:8787").replace(/\/$/, "");
if (/paperbot\.ca$|workers\.dev$/.test(B) && !/dev\.paperbot\.ca$/.test(B)) { console.error("Not against production."); process.exit(2); }
const { url: OB, token: OB_TOKEN } = openbeltArgs(args);
const mcp = mcpClient(OB, OB_TOKEN, "belt-e2e");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const ownerToken = () => {
  const m = readFileSync(`${ROOT}/build/.dev.vars`, "utf8").match(/^DEVICE_TOKEN=(.+)$/m);
  if (!m) throw new Error("no DEVICE_TOKEN in build/.dev.vars (run tools/local-worker.sh)");
  return m[1].trim();
};
const admin = (path, inbox, body) => fetch(`${B}${path}?inbox=${encodeURIComponent(inbox)}`, { method: "POST", headers: { authorization: `Bearer ${ownerToken()}`, "content-type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => { if (!r.ok) throw new Error(`${path} ${r.status} ${await r.text()}`); return r.json(); });

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail: String(detail).slice(0, 300) }); console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : `  ${String(detail).slice(0, 300)}`}`); };
const until = async (f, ms = 15_000, step = 250) => { const end = Date.now() + ms; for (;;) { const v = await f().catch(() => null); if (v || Date.now() > end) return v; await new Promise((r) => setTimeout(r, step)); } };

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const accounts = [];

async function account(name) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await page.goto(B + "/login");
  const email = `belt-${name}-${Date.now()}@example.com`;
  const su = await page.evaluate(async ([e, p]) => (await fetch("/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: e, password: p, name: "Sam Rivera" }) })).status, [email, crypto.randomUUID()]);
  if (su !== 200) throw new Error(`sign-up ${su} (local: POST /admin/auth-migrate once)`);
  const uid = await page.evaluate(async () => (await (await fetch("/api/auth/get-session")).json()).user.id);
  await page.goto(B + "/");
  await page.waitForTimeout(600);
  const a = { ctx, page, box: `u:${uid}`, errors, state: await ctx.storageState() };
  accounts.push(a);
  return a;
}

/** Record a page with Chrome's screencast at full device pixels; stop(file) writes an mp4 (ffmpeg) and removes the frames. */
async function screencast(page, dir, width, height) {
  mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on("Page.screencastFrame", ({ data, metadata, sessionId }) => {
    const file = `${dir}/${String(frames.length).padStart(5, "0")}.jpg`;
    writeFileSync(file, Buffer.from(data, "base64"));
    frames.push({ file, at: metadata.timestamp ?? Date.now() / 1000 });
    cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
  return {
    async stop(out) {
      const end = Date.now() / 1000;
      await cdp.send("Page.stopScreencast").catch(() => {});
      if (!frames.length) throw new Error("screencast: no frames");
      // each frame is shown until the next one came (the screencast sends frames only when the page changes)
      const list = frames.map((f, i) => `file '${f.file}'\nduration ${Math.max(0.001, (frames[i + 1]?.at ?? end) - f.at).toFixed(3)}`).join("\n") + `\nfile '${frames.at(-1).file}'\n`;
      writeFileSync(`${dir}/frames.txt`, "ffconcat version 1.0\n" + list);
      const { spawnSync } = await import("node:child_process");
      const r = spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", `${dir}/frames.txt`, "-vf", `fps=30,scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=white,format=yuv420p`,
        "-c:v", "libx264", "-crf", "18", "-movflags", "+faststart", out], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`ffmpeg: ${r.stderr}`);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function shots(state, name, path, ready) {
  for (const v of [{ vp: "desktop", w: 1280, hgt: 860, s: 1 }, { vp: "phone", w: 390, hgt: 844, s: 2, mobile: true }]) for (const theme of ["light", "dark"]) {
    const ctx = await browser.newContext({ viewport: { width: v.w, height: v.hgt }, deviceScaleFactor: v.s, isMobile: !!v.mobile, hasTouch: !!v.mobile, colorScheme: theme, reducedMotion: "reduce", storageState: state });
    if (theme === "dark") await ctx.addInitScript(() => { try { localStorage.setItem("pv-theme", "dark"); } catch {} });
    const p = await ctx.newPage();
    await p.goto(B + path, { waitUntil: "networkidle" }).catch(() => {});
    await p.waitForSelector(ready, { timeout: 15_000 }).catch(() => {});
    if (name === "memos") await p.locator(".done-fold .fold-toggle").click({ timeout: 10_000 }).catch(() => {}); // Done open, to show a done memo
    if (name === "apps") await p.waitForFunction(() => [...document.querySelectorAll(".belt-pic img")].every((i) => i.complete), null, { timeout: 15_000 }).catch(() => {});
    await p.waitForTimeout(300);
    const scrolls = await p.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (scrolls) check(`${name} ${v.vp} ${theme}: no sideways scroll`, false, "the page is wider than the screen");
    await p.screenshot({ path: `${OUT}/${name}.${v.vp}.${theme}.png`, fullPage: true });
    await ctx.close();
  }
}

try {
  // ---- OpenBelt: the list app paperbot deploys, items in every list, two other apps ----
  const tomorrow = new Date(Date.now() + 86_400_000); tomorrow.setHours(9, 0, 0, 0);
  const local = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const seed = [
    ["m-dentist", "reminder", "Call the dentist", local(tomorrow), false], ["m-plumber", "todo", "Book the plumber", null, false],
    ["m-oat", "shopping", "Oat milk", null, false], ["m-aa", "shopping", "AA batteries", null, false],
    ["m-wink", "note", "Bolt should wink when a memo is saved", null, false], ["m-plants", "todo", "Water the plants", null, true],
  ];
  await seedList(mcp, ROOT, seed);
  const page = (title, bg, fg) => `<!doctype html><title>${title}</title><style>body{margin:0;padding:48px;font:600 56px system-ui;background:${bg};color:${fg}}li{font:400 28px system-ui;margin:14px 0}@media (prefers-color-scheme:dark){body{background:#151515;color:${bg}}}</style><h1>${title}</h1><ul><li>One</li><li>Two</li><li>Three</li></ul>`;
  await mcp("deploy_app", { app: "chores", description: "Who does which chore this week", files: [{ path: "index.html", content: page("Chores", "#ffd8a8", "#7a3b00") }] });
  await mcp("deploy_app", { app: "reading-log", description: "Books Max read, and how many pages a day", files: [{ path: "index.html", content: page("Reading log", "#c3f0ca", "#0b5b1c") }] });

  // ---- an account linked to that workspace ----
  const A = await account("linked");
  await admin("/admin/test/openbelt", A.box, { token: OB_TOKEN, workspace: "acme" });
  const { page: p } = A;

  // the Memos tab is the inbox as before
  await p.goto(B + "/");
  check("Memos: the inbox's search and filters show, the List isn't", await until(() => p.evaluate(() => getComputedStyle(document.querySelector(".toolbar")).display !== "none" && document.getElementById("belt").hidden)));

  // ---- List ----
  const t0 = Date.now();
  await p.goto(B + "/#list");
  await p.waitForSelector(".belt-item", { timeout: 15_000 });
  const shown = await p.evaluate(() => ({ groups: [...document.querySelectorAll(".belt-group h2")].map((e) => e.textContent), items: [...document.querySelectorAll(".belt-group .belt-title")].map((e) => e.textContent),
    due: document.querySelector(".belt-due")?.textContent, done: document.querySelector(".belt-done-toggle")?.textContent, toolbar: getComputedStyle(document.querySelector(".toolbar")).display }));
  check(`List shows the OpenBelt items by list: Reminders, Todo, Shopping, Notes (${Date.now() - t0} ms)`, JSON.stringify(shown.groups) === '["Reminders","Todo","Shopping","Notes"]' && shown.items.length === 5, JSON.stringify(shown));
  check("a due item shows when (tomorrow 9:00)", /tomorrow 9:00/.test(shown.due ?? ""), shown.due);
  check("done items are folded under Done (1)", /Done\s*1/.test(shown.done ?? ""), shown.done);
  check("the inbox's search and filters hide on List", shown.toolbar === "none", shown.toolbar);

  // a check-off here is written there
  const oat = p.locator(".belt-item", { hasText: "Oat milk" }).locator(".check");
  await oat.click();
  const oatDoc = async () => (await mcp("collection_list", { app: "paperbot", collection: "items", limit: 50 })).docs.find((d) => d.id === "m-oat")?.data;
  const written = await until(async () => (await oatDoc())?.done === true, 10_000);
  const kept = await oatDoc().catch(() => null);
  check("…and the check-off keeps the item's title and list in OpenBelt", kept?.title === "Oat milk" && kept?.list === "shopping", JSON.stringify(kept));
  check("checking off Oat milk here marks it done in OpenBelt", written);
  check("…and it moves under Done", await until(() => p.evaluate(() => ![...document.querySelectorAll(".belt-group .belt-title")].some((e) => e.textContent === "Oat milk") && /Done\s*2/.test(document.querySelector(".belt-done-toggle")?.textContent ?? ""))));

  // a change made in OpenBelt shows here (the page reads OpenBelt again when it comes back into view)
  await mcp("collection_add", { app: "paperbot", collection: "items", data: { list: "shopping", title: "Eggs", due: null, done: false } });
  await mcp("collection_update", { app: "paperbot", collection: "items", id: "m-plumber", data: { done: true } });
  await p.reload();
  check("an item added in OpenBelt shows here, and one checked off there leaves the open list", await until(() => p.evaluate(() => {
    const t = [...document.querySelectorAll(".belt-group .belt-title")].map((e) => e.textContent); return t.includes("Eggs") && !t.includes("Book the plumber"); })));

  // a memo that saves refreshes an open List by itself (no reload)
  await mcp("collection_add", { app: "paperbot", collection: "items", id: "m-bread", data: { list: "shopping", title: "Bread", due: null, done: false, memo: "m-bread" } });
  await admin("/admin/test/record", A.box, { id: "m-bread", kind: "save", title: "Bread", items: [{ op: "add", list: "shopping", title: "Bread", due: null, id: null, ok: true, why: null, app_url: null }], received_at: Date.now(), transcript: "Add bread to my shopping list.", seconds: 2 });
  const live = Date.now();
  check("a saved memo shows on an open List without a reload", await until(() => p.evaluate(() => [...document.querySelectorAll(".belt-title")].some((e) => e.textContent === "Bread")), 8000), `${Date.now() - live} ms`);

  // the memo's own page sends you to the List here, not out to OpenBelt
  await p.goto(B + "/#item/m-bread");
  const openList = p.locator(".item-page a.report-launch", { hasText: "Open your list" });
  check("a saved memo's page links to the List tab (#list)", (await openList.getAttribute("href", { timeout: 10_000 }).catch(() => null)) === "#list");
  await openList.click();
  check("…and a tap shows the List with the saved item", await until(() => p.evaluate(() => location.hash === "#list" && !document.getElementById("belt").hidden && [...document.querySelectorAll(".belt-title")].some((e) => e.textContent === "Bread")), 8000));

  // ---- Memos: nothing to tick; a saved memo is done when all its List items are, and folds under Done ----
  const add = (title) => ({ op: "add", list: "shopping", title, due: null, id: null, ok: true, why: null, app_url: null });
  await admin("/admin/test/record", A.box, { id: "m-two", kind: "save", title: "Rice and beans", items: [add("Rice"), add("Beans")], received_at: Date.now(), transcript: "Add rice and beans.", seconds: 2 });
  await mcp("collection_add", { app: "paperbot", collection: "items", docs: [{ id: "m-two", data: { list: "shopping", title: "Rice", due: null, done: false, memo: "m-two" } }, { id: "m-two-2", data: { list: "shopping", title: "Beans", due: null, done: false, memo: "m-two" } }] });
  const memoState = () => p.evaluate(() => {
    const c = document.querySelector('#sections .card[data-id="m-two"]');
    return { shown: !!c, done: !!c?.classList.contains("is-done"), inFold: !!c?.closest(".done-fold"), fold: document.querySelector(".done-fold .fold-toggle")?.textContent ?? null, checks: document.querySelectorAll("#sections button.check").length };
  });
  await p.goto(B + "/");
  const m0 = await until(async () => { const m = await memoState(); return m.shown ? m : null; });
  check("Memos: no memo has a check-off button", m0?.checks === 0, JSON.stringify(m0));
  check("a saved memo with open items is not done", m0 && !m0.done && !m0.inFold, JSON.stringify(m0));
  await mcp("collection_update", { app: "paperbot", collection: "items", id: "m-two", data: { done: true } });
  await p.reload(); await until(async () => (await memoState()).shown);
  const m1 = await memoState();
  check("one of its two items checked off on the List: still not done", !m1.done && !m1.inFold, JSON.stringify(m1));
  await mcp("collection_update", { app: "paperbot", collection: "items", id: "m-two-2", data: { done: true } });
  await p.reload();
  const fold = await until(async () => { const m = await memoState(); return m.fold ? m : null; });
  check("both checked off: the memo leaves Today and folds under Done", fold && !fold.shown && /Done\s*\d/.test(fold.fold), JSON.stringify(fold));
  await p.locator(".done-fold .fold-toggle").click();
  const m2 = await until(async () => { const m = await memoState(); return m.shown ? m : null; });
  check("…and shows with a check when Done is opened", m2?.done && m2?.inFold && (await p.locator('.card[data-id="m-two"] .lead[role="img"]').count()) === 1, JSON.stringify(m2));
  const refused = await p.evaluate(async () => (await fetch("/api/tasks/m-two", { method: "PATCH", headers: { "content-type": "application/json" }, body: '{"state":"done"}' })).status);
  check("a memo can't be set to the old \"done\" state", refused === 400, refused);

  // the archive and ignored clips live in the ⋮ menu; the archive shows as a chip that leads back
  await p.goto(B + "/"); await p.waitForSelector("#sections .card");
  await p.locator(".list-actions-menu summary").click();
  await p.locator(".list-actions-popover button", { hasText: /^Archive$/ }).click();
  check("⋮ > Archive shows the archive, with an Archive chip", await until(() => p.evaluate(() => [...document.querySelectorAll("#chips .chip")].some((c) => c.textContent.startsWith("Archive")) && /archive is empty/.test(document.getElementById("sections").textContent))));
  await p.locator("#chips .chip", { hasText: "Archive" }).click();
  check("…and the chip leads back to the memos", await until(() => p.evaluate(() => !!document.querySelector('#sections .card[data-id="m-bread"]') && ![...document.querySelectorAll("#chips .chip")].some((c) => c.textContent.startsWith("Archive")))));

  // ---- Apps ----
  await p.goto(B + "/#apps");
  await p.waitForSelector(".belt-app", { timeout: 15_000 });
  const cards = await p.evaluate(() => [...document.querySelectorAll(".belt-app strong")].map((e) => e.textContent));
  check("Apps lists the workspace's apps, without the list app itself", cards.includes("chores") && cards.includes("reading-log") && !cards.includes("paperbot"), JSON.stringify(cards));
  const pics = await until(async () => { await p.reload(); await p.waitForSelector(".belt-app"); await p.waitForTimeout(1500);
    return p.evaluate(() => [...document.querySelectorAll(".belt-pic")].filter((e) => e.classList.contains("has-pic")).length >= 2); }, 90_000, 3000);
  check("each app card shows the app's picture (from OpenBelt's app_picture)", pics);
  const pic = await p.evaluate(async () => { const r = await fetch("/api/belt/apps/chores/picture"); const etag = r.headers.get("etag"); const b = new Uint8Array(await r.arrayBuffer());
    const again = await fetch("/api/belt/apps/chores/picture", { headers: { "if-none-match": etag }, cache: "no-store" });
    const none = await fetch("/api/belt/apps/no-such-app/picture");
    return { status: r.status, type: r.headers.get("content-type"), webp: String.fromCharCode(...b.slice(8, 12)), cache: r.headers.get("cache-control"), again: again.status, none: none.status }; });
  check("the picture is a WebP, kept 5 minutes, and a 304 for the same tag", pic.status === 200 && pic.type === "image/webp" && pic.webp === "WEBP" && /max-age=300/.test(pic.cache) && pic.again === 304, JSON.stringify(pic));
  check("an app that isn't there has no picture (404)", pic.none === 404, JSON.stringify(pic));
  check("an item id OpenBelt wouldn't take is refused", (await p.evaluate(async () => (await fetch("/api/belt/items/has%20space", { method: "POST", headers: { "content-type": "application/json" }, body: '{"done":true}' })).status)) === 400);

  // ---- not connected ----
  const C = await account("unlinked");
  await C.page.goto(B + "/#list");
  const inv = await C.page.waitForSelector(".belt-invite", { timeout: 15_000 }).then(() => C.page.evaluate(() => document.querySelector(".belt-invite a")?.getAttribute("href"))).catch(() => null);
  check("without OpenBelt, List offers Connect straight to OpenBelt's sign-in, back to the List", /api\/openbelt\/connect\?next=%2F%23list$/.test(inv ?? ""), inv);
  check("…and says what it's for", (await C.page.evaluate(() => document.querySelector(".belt-invite strong")?.textContent)) === "Connect to OpenBelt to manage your list");

  for (const a of [A, C]) check(`no page errors (${a.box.slice(0, 6)}…)`, !a.errors.length, a.errors.join(" | "));

  // --video: a recorded walkthrough per screen size (build/e2e/belt/tour.<desktop|phone>.mp4), at a pace a person can follow.
  // Chrome's own screencast at the device's pixels (Playwright's recordVideo draws a 2x phone at 1x in a corner), made into
  // an mp4 by ffmpeg with each frame held until the next.
  if (args.includes("--video")) for (const [vp, w, hgt, tick, added, scale, mobile] of [["desktop", 1280, 800, "AA batteries", "Coffee beans", 1, false], ["phone", 390, 844, "Eggs", "Bananas", 2, true]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: hgt }, deviceScaleFactor: scale, isMobile: mobile, hasTouch: mobile, storageState: A.state });
    const v = await ctx.newPage();
    const rec = await screencast(v, `${OUT}/frames-${vp}`, w * scale, hgt * scale);
    const pause = (ms = 1400) => v.waitForTimeout(ms);
    await v.goto(B + "/", { waitUntil: "networkidle" });
    await v.waitForSelector(".card"); await pause(1800);
    await v.click('#tabs [data-tab="list"]'); await v.waitForSelector(".belt-item"); await pause(2000);
    await v.locator(".belt-item", { hasText: tick }).locator(".check").click(); await pause(1800);
    // a memo saves a new item while the List is open: it appears by itself
    const id = `m-${added.toLowerCase().replace(/\W+/g, "-")}`;
    await mcp("collection_add", { app: "paperbot", collection: "items", id, data: { list: "shopping", title: added, due: null, done: false, memo: id } });
    await admin("/admin/test/record", A.box, { id, kind: "save", title: added, items: [{ op: "add", list: "shopping", title: added, due: null, id: null, ok: true, why: null, app_url: null }], received_at: Date.now(), transcript: `Add ${added.toLowerCase()} to my shopping list.`, seconds: 2 });
    await v.waitForFunction((t) => [...document.querySelectorAll(".belt-title")].some((e) => e.textContent === t), added, { timeout: 10_000 }); await pause(2000);
    await v.click(".belt-done-toggle"); await pause(1800);
    await v.click('#tabs [data-tab="apps"]'); await v.waitForSelector(".belt-pic.has-pic"); await pause(2600);
    await rec.stop(`${OUT}/tour.${vp}.mp4`);
    await ctx.close();
  }

  await shots(A.state, "memos", "/", ".done-fold");
  await shots(A.state, "list", "/#list", ".belt-item");
  await shots(A.state, "apps", "/#apps", ".belt-app");
  await shots(C.state, "not-connected", "/#list", ".belt-invite");
} catch (e) {
  check("ran to the end", false, e?.stack ?? e);
} finally {
  for (const a of accounts) await a.page.evaluate(async () => fetch("/api/account", { method: "DELETE" })).catch(() => {});
  await browser.close();
  writeFileSync(`${OUT}/results.json`, JSON.stringify(results, null, 2));
  const bad = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - bad}/${results.length} passed -> ${OUT}`);
  process.exit(bad ? 1 : 0);
}
