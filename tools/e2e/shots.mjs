// Screenshots of every web screen, in light and dark, on a desktop and a phone, plus a contact sheet:
//   build/shots/index.html  (open it in a browser; each image is build/shots/<screen>.<desktop|phone>.<light|dark>.png)
//
// Runs against a deployment with TEST_HOOKS (sign-up with a password, /admin/test/*):
//   sh tools/local-worker.sh &            # http://127.0.0.1:8787, serves server/public live: edit CSS, rerun
//   node tools/e2e/shots.mjs              # all screens
//   node tools/e2e/shots.mjs login settings --phone --dark     # some screens / variants
//   node tools/e2e/shots.mjs --server https://dev.paperbot.ca
//
// It makes a throwaway account, fills it with memos in every state (via /admin/test/record, owner token), links a
// board, shoots, and deletes the account. Console errors of each page are listed on the contact sheet.
import { chromium } from "playwright-core";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = `${ROOT}/build/shots`;
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const B = (opt("--server") ?? process.env.SHOTS_SERVER ?? "http://127.0.0.1:8787").replace(/\/$/, "");
if (/^https:\/\/((www|app)\.)?(pocketbot|paperbot)\.ca$|^https:\/\/(pocketbot|paperbot)\.mrjoedang\.workers\.dev$/.test(B)) { console.error("Not against production."); process.exit(2); }
const only = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--server");
const VARIANTS = [
  { vp: "desktop", theme: "light", viewport: { width: 1280, height: 860 }, scale: 1 },
  { vp: "desktop", theme: "dark", viewport: { width: 1280, height: 860 }, scale: 1 },
  { vp: "phone", theme: "light", viewport: { width: 390, height: 844 }, scale: 2, mobile: true },
  { vp: "phone", theme: "dark", viewport: { width: 390, height: 844 }, scale: 2, mobile: true },
].filter((v) => (!args.includes("--phone") || v.vp === "phone") && (!args.includes("--desktop") || v.vp === "desktop")
  && (!args.includes("--dark") || v.theme === "dark") && (!args.includes("--light") || v.theme === "light"));
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

// The owner token (only for /admin/test/*): never printed.
const ownerToken = () => {
  if (process.env.TOKEN) return process.env.TOKEN;
  const local = /^http:\/\/(127\.0\.0\.1|localhost)/.test(B);
  const f = local ? `${ROOT}/build/.dev.vars` : `${ROOT}/server/.secrets`;
  const m = existsSync(f) && readFileSync(f, "utf8").match(local ? /^DEVICE_TOKEN=(.+)$/m : /^DEV_TOKEN=(.+)$/m);
  if (!m) { console.error(`no owner token (set TOKEN or ${f})`); process.exit(2); }
  return m[1].trim();
};
const admin = (path, inbox, body) => fetch(`${B}${path}?inbox=${encodeURIComponent(inbox)}`, { method: "POST", headers: { authorization: `Bearer ${ownerToken()}`, "content-type": "application/json" }, body: JSON.stringify(body) })
  .then((r) => { if (!r.ok) throw new Error(`${path} ${r.status}`); return r.json(); });

if (!only.length) rmSync(OUT, { recursive: true, force: true }); // a filtered run keeps the other screens
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const shots = []; // {screen, file, variant, errors}
let state; // signed-in storage state

async function shoot(screen, path, { signedIn = true, ready, prep, full = false, note = "" } = {}) {
  if (only.length && !only.includes(screen)) return;
  for (const v of VARIANTS) {
    const ctx = await browser.newContext({ viewport: v.viewport, deviceScaleFactor: v.scale, isMobile: !!v.mobile, hasTouch: !!v.mobile, colorScheme: v.theme,
      reducedMotion: "reduce", storageState: signedIn ? state : undefined });
    // light is the default; the dark shots are of someone who picked Dark in the theme menu
    if (v.theme === "dark") await ctx.addInitScript(() => { try { localStorage.setItem("pv-theme", "dark"); } catch {} });
    const page = await ctx.newPage();
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error" && !/cloudflareinsights|Failed to load resource/.test(m.text())) errors.push(m.text().slice(0, 200)); });
    page.on("response", (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push(`${r.status()} ${r.request().method()} ${r.url().replace(B, "")}`); });
    page.on("pageerror", (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`));
    try {
      await page.goto(B + path, { waitUntil: "networkidle", timeout: 20_000 }).catch(() => {});
      if (ready) await page.waitForSelector(ready, { timeout: 10_000 });
      if (prep) await prep(page);
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(400);
    } catch (e) { errors.push(`shots: ${String(e).split("\n")[0].slice(0, 200)}`); }
    const file = `${screen}.${v.vp}.${v.theme}.png`;
    await page.screenshot({ path: `${OUT}/${file}`, fullPage: full });
    shots.push({ screen, file, variant: `${v.vp} ${v.theme}`, errors, note, path });
    await ctx.close();
  }
  console.log(`shot ${screen}${shots.filter((s) => s.screen === screen && s.errors.length).length ? "  (console errors)" : ""}`);
}

try {
  // ---- signed out ----
  await shoot("login", "/login", { signedIn: false, ready: "#passkey" });

  // ---- a throwaway account (password sign-up: TEST_HOOKS deployments only) ----
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(B + "/login");
  const email = `shots-${Date.now()}@example.com`;
  const su = await page.evaluate(async ([e, p]) => (await fetch("/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: e, password: p, name: "Sam Rivera" }) })).status, [email, crypto.randomUUID()]);
  if (su !== 200) throw new Error(`sign-up ${su} (is TEST_HOOKS on? local: POST /admin/auth-migrate once)`);
  const uid = await page.evaluate(async () => (await (await fetch("/api/auth/get-session")).json()).user.id);
  const box = `u:${uid}`;
  await page.goto(B + "/"); // creates the account
  await page.waitForTimeout(800);
  state = await ctx.storageState();
  const inPage = (fn, arg) => page.evaluate(fn, arg);

  // ---- first visit (nothing yet) ----
  await shoot("login-signed-in", "/login", { ready: "#continue" });
  await shoot("first-visit", "/", { ready: ".setup-card" });
  // the loading screen, held up the way it looks before the app's first paint
  await shoot("boot", "/", { ready: ".setup-card", prep: async (p) => { await p.evaluate(() => {
    const b = document.getElementById("app-boot"); b.style.transition = "none"; b.classList.remove("is-ready"); b.querySelector(".boot-label").textContent = "Loading paperbot"; }); } });
  await shoot("settings", "/#settings", { ready: ".settings-nav" });
  await shoot("settings-wifi-empty", "/#settings/wifi", { ready: ".empty-state" });
  // consent, the way an assistant reaches it: a registered client, then /authorize (which signs the query and redirects)
  const consentPath = async (client_name, redirect) => {
    const c = await inPage(async (b) => (await (await fetch("/api/auth/oauth2/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) })).json()),
      { client_name, redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
    const q = new URLSearchParams({ response_type: "code", client_id: c.client_id, redirect_uri: redirect, scope: "openid profile email offline_access memos", state: "shots",
      code_challenge: "E9Melhoa2OwvFrEMTJguCQaoeEKu8eNKr1bMwmY_xRV_wN6s0yQUCpjwM0PyUBUCaa5-wRUwV-eeL5ZQ", code_challenge_method: "S256", resource: `${B}/v1/mcp` });
    await page.goto(`${B}/api/auth/oauth2/authorize?${q}`);
    const u = new URL(page.url());
    if (u.pathname !== "/consent") throw new Error(`authorize went to ${u.pathname}`);
    return u.pathname + u.search;
  };
  await shoot("consent", await consentPath("Claude", "https://claude.ai/api/mcp/auth_callback"), { ready: "#allow" });
  await shoot("consent-unknown", await consentPath("Claude", "https://attacker.example/cb"), { ready: "#allow" });

  // ---- a linked board and memos in every state ----
  const tok = await inPage(async () => (await (await fetch("/v1/setup/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device: "5100c0ffee01" }) })).json()).token);
  await fetch(`${B}/v1/status`, { method: "POST", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", "x-pv-fw": "1.0.0", "x-pv-batt": "3950", "x-pv-usb": "0", "x-pv-wifi-rev": "1" },
    body: JSON.stringify({ device: "5100c0ffee01", fw: "1.0.0" }) }).catch(() => {});
  const now = Date.now(), min = 60_000, day = 86_400_000;
  const tomorrow9 = new Date(now + day); tomorrow9.setHours(9, 0, 0, 0);
  const local = (d) => new Date(d.getTime() - d.getTimezoneOffset() * min).toISOString().slice(0, 16);
  const report = "## Short answer\n\nFor a 1.54\" e-paper board that wakes a few times an hour, a **500 to 1000 mAh LiPo** pouch cell gives weeks of standby.\n\n- **Adafruit 1000 mAh** (PKCell LP503562): fits behind the panel, has a protection circuit.\n- **Sparkfun 850 mAh**: thinner, slightly less capacity.\n\nAvoid coin cells: the ESP32-C6's Wi-Fi bursts draw ~300 mA, more than a CR2032 can supply.\n\n### Sources\n\n- https://www.adafruit.com/product/258\n- https://learn.sparkfun.com/tutorials/battery-technologies";
  const recs = [
    { id: "shot-work-wait", kind: "research", title: "Compare small travel routers that do 2.4 GHz", status: "researching", agent_state: "external", received_at: now - 4 * min,
      transcript: "Can you compare small travel routers that still do 2.4 gigahertz, I need one for the paperbot when I travel.", seconds: 6 },
    { id: "shot-todo", kind: "save", title: "Buy AA batteries", items: [{ op: "add", list: "shopping", title: "AA batteries", due: null, id: null, ok: true, why: null, app_url: "https://paperbot--test.openbelt.app/" }], received_at: now - 62 * min, transcript: "Buy AA batteries.", seconds: 2, state: "open" },
    { id: "shot-reminder", kind: "save", title: "Call the dentist", due: local(tomorrow9), items: [{ op: "add", list: "reminder", title: "Call the dentist", due: local(tomorrow9), id: null, ok: true, why: null, app_url: "https://paperbot--test.openbelt.app/" }], received_at: now - 2 * 60 * min, transcript: "Remind me to call the dentist tomorrow at nine.", seconds: 3 },
    { id: "shot-answer", kind: "answer", title: "Tell me a joke", summary: "Why don't skeletons fight each other? They don't have the guts.", agent_cost: 0.0003, received_at: now - 3 * 60 * min, transcript: "Tell me a joke.", seconds: 2 },
    { id: "shot-save-wait", kind: "save", title: "Pick up milk", agent_state: "needs_openbelt", items: [{ op: "add", list: "shopping", title: "Milk", due: null, id: null, ok: false, why: "not connected", app_url: null }], received_at: now - 4 * 60 * min, transcript: "Remind me to pick up some milk.", seconds: 2 },
    { id: "shot-work-done", kind: "research", title: "Best battery for a small e-ink device", status: "done", summary: "500-1000 mAh LiPo pouch; avoid coin cells",
      agent_state: "finished", agent_model: "anthropic/claude-sonnet-5-5", agent_cost: 0.031, agent_started_at: now - day - 90_000, agent_finished_at: now - day,
      agent_result: { summary: "500-1000 mAh LiPo pouch; avoid coin cells", report, citations: { verified: ["https://www.adafruit.com/product/258"], unverified: ["https://learn.sparkfun.com/tutorials/battery-technologies"] }, counters: { web_calls: 4, turns: 6 } },
      received_at: now - day - 2 * min, transcript: "Research the best lithium battery for a small e-ink device, like the one in the paperbot.", seconds: 5 },
    { id: "shot-work-stopped", kind: "research", title: "OTA update best practices on ESP32", status: "stopped", error: "API key rejected",
      detail: "anthropic answered 401: invalid x-api-key. Check the key in Settings → Research.", agent_state: "finished", received_at: now - day - 30 * min,
      transcript: "Find out the current best practice for OTA firmware updates on the ESP32.", seconds: 5 },
    { id: "shot-note", kind: "save", title: "Bolt should wink when a memo is saved", items: [{ op: "add", list: "note", title: "Bolt should wink when a memo is saved", due: null, id: null, ok: true, why: null, app_url: "https://paperbot--test.openbelt.app/" }], received_at: now - day - 3 * 60 * min, transcript: "Idea: Bolt should wink when a memo is saved.", seconds: 3 },
    { id: "shot-unsure", kind: "ignore", title: "Something about the garage", received_at: now - 2 * day, transcript: "Uh, the garage, the thing with the, never mind.", seconds: 4 },
    { id: "shot-done", kind: "save", title: "Water the plants", items: [{ op: "done", list: "todo", title: "Water the plants", due: null, id: "x", ok: true, why: null, app_url: "https://paperbot--test.openbelt.app/" }], received_at: now - 3 * day, transcript: "Water the plants.", seconds: 2 },
  ];
  for (const r of recs) await admin("/admin/test/record", box, r);

  await shoot("inbox", "/", { ready: ".card", full: true });
  await shoot("item-work-done", "/#item/shot-work-done", { ready: ".item-view:not([hidden])", full: true });
  await shoot("item-work-waiting", "/#item/shot-work-wait", { ready: ".item-view:not([hidden])", full: true });
  await shoot("item-work-stopped", "/#item/shot-work-stopped", { ready: ".item-view:not([hidden])" });
  await shoot("item-answer", "/#item/shot-answer", { ready: ".item-view:not([hidden])" });
  await shoot("item-saved", "/#item/shot-reminder", { ready: ".item-view:not([hidden])" });
  await shoot("item-save-waiting", "/#item/shot-save-wait", { ready: ".item-view:not([hidden])" });
  await shoot("item-reminder", "/#item/shot-reminder", { ready: ".item-view:not([hidden])" });
  await shoot("settings-devices", "/#settings/devices", { ready: ".acct-item" });
  await shoot("settings-menu", "/", { ready: "#settings-toggle", prep: async (p) => { await p.click("#settings-toggle"); } });
  await inPage(async () => fetch("/api/research", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ provider: "anthropic", key: "sk-ant-test-shots0000000000000000000000003f9a" }) }));
  await shoot("settings-own-key", "/#settings/research", { ready: '[data-choice="key"].current' });

  await inPage(async () => fetch("/api/account", { method: "DELETE" }));
  await ctx.close();
} catch (e) {
  console.error(`FAILED: ${e.message}`);
  process.exitCode = 1;
} finally {
  // one sheet per screen (its variants side by side): quick to review, build/shots/<screen>.sheet.png
  const sheetCtx = await browser.newContext({ viewport: { width: 1800, height: 700 } });
  const sp = await sheetCtx.newPage();
  for (const sc of [...new Set(shots.map((x) => x.screen))]) {
    const imgs = shots.filter((x) => x.screen === sc);
    writeFileSync(`${OUT}/.sheet.html`, `<body style="margin:0;background:#888;display:flex;gap:10px;padding:10px;align-items:flex-start;font:13px system-ui">${imgs.map((x) =>
      `<figure style="margin:0"><figcaption style="color:#fff">${x.variant}</figcaption><img style="display:block;height:${x.file.includes(".phone.") ? 640 : 520}px" src="${x.file}"></figure>`).join("")}</body>`);
    await sp.goto(`file://${OUT}/.sheet.html`);
    await sp.waitForTimeout(150);
    await sp.screenshot({ path: `${OUT}/${sc}.sheet.png`, fullPage: true });
  }
  await sheetCtx.close();
  await browser.close();
  // contact sheet
  const screens = [...new Set(shots.map((s) => s.screen))];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const html = `<!doctype html><meta charset="utf-8"><title>paperbot screens</title>
<style>body{font:14px system-ui;margin:20px;background:#ddd}h2{margin:28px 0 8px;font-size:16px}.row{display:flex;gap:12px;align-items:flex-start;overflow-x:auto}
figure{margin:0;background:#fff;padding:6px;border-radius:6px}figcaption{font-size:12px;color:#555;margin-bottom:4px}img{display:block;max-height:520px;border:1px solid #ccc}
.err{color:#b00;font:12px ui-monospace,monospace;white-space:pre-wrap;max-width:420px}</style>
<h1>paperbot screens <small>${esc(B)} · ${new Date().toISOString().slice(0, 16)}</small></h1>
${screens.map((sc) => `<h2>${esc(sc)} <small>${esc(shots.find((s) => s.screen === sc).path)}</small></h2><div class="row">${shots.filter((s) => s.screen === sc).map((s) =>
  `<figure><figcaption>${esc(s.variant)}</figcaption><a href="${s.file}"><img src="${s.file}" alt="${esc(sc)} ${esc(s.variant)}"></a>${s.errors.length ? `<div class="err">${s.errors.map(esc).join("\n")}</div>` : ""}</figure>`).join("")}</div>`).join("\n")}`;
  writeFileSync(`${OUT}/index.html`, html);
  const bad = shots.filter((s) => s.errors.length);
  console.log(`\n${shots.length} screenshots, ${bad.length} with console errors -> ${OUT}/index.html`);
}
