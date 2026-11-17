// /setup for someone new, with OpenBelt connected in the sign-in popup: a fresh simulated board (pvsim, its console bridged to
// the page's navigator.serial), the install (a stand-in flasher: the simulator can't be flashed), sign-up in the popup, the
// popup's way through OpenBelt ("Connect paperbot to OpenBelt", Continue with Google) and back, Wi-Fi, then a spoken memo
// (real Whisper and routing) that is saved in the person's OpenBelt list at once. Records a video of every page and takes a
// screenshot of each step.
//
// Needs a test server (TEST_HOOKS=1) whose OPENBELT_URL is an OpenBelt with Google sign-in, and a Google it trusts. Locally:
//   (openbelt)  bun scripts/verify/drive/google.ts --port 7466 --client paperbot-local --secret paperbot-local-secret
//   (openbelt)  OPENBELT_SIGNIN=email OPENBELT_GOOGLE_CLIENT_ID=paperbot-local OPENBELT_GOOGLE_CLIENT_SECRET=paperbot-local-secret \
//                 OPENBELT_GOOGLE_ISSUER=http://127.0.0.1:7466 bun scripts/verify/launch.ts --run .verify/paperbot-e2e
//   (paperbot)  AI=remote sh tools/local-worker.sh --var OPENBELT_URL:http://localhost:<its port>
//   make sim-build && cd tools/e2e && node setup-openbelt.mjs --server http://127.0.0.1:8787
//
// --via email: the popup signs in to OpenBelt with an email code instead of Google; the code is read from the local
// OpenBelt's log (--openbelt-log <platform.log>: OpenBelt locally has no mail service, so the code is only there).
// --manual --real-board: the plugged-in board instead of the simulator, with Chrome's own port picker and the real release
// image (from the server's R2 setup/). The page stays on this Mac's loopback address (OpenBelt only sends a sign-in back to
// https or loopback); start the Worker with IP=0.0.0.0 and --var BOARD_SERVER:http://<this Mac's LAN address>:8787 so the
// board is told an address it can reach.
// --manual: no script. A visible Chrome on the same simulated board, for a person to click through; a panel on the page
// says a sentence to the board (macOS say) and holds ☀; with --openbelt-log, OpenBelt's code page shows the emailed code
// and fills it in. Close the window to stop.
//
// Output: build/e2e-openbelt/ (NN-step.png, video/*.webm, seamless.mp4: the page with the popup over it, steps.json). Exit 1 if a
// step failed.
import { chromium } from "playwright-core";
import { execFile, spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const B = (arg("--server", "http://127.0.0.1:8787")).replace(/\/$/, "");
if (/paperbot\.ca|pocketbot\.ca/.test(B)) { console.error("Not against production."); process.exit(2); }
let EMAIL = arg("--email", "ada@gmail.com");
const THROWAWAY = process.argv.includes("--throwaway"); // sign up with the page's "Test sign-in (new throwaway account)" button
const MANUAL = process.argv.includes("--manual");
const REAL = process.argv.includes("--real-board");
if (REAL && !MANUAL) { console.error("--real-board needs --manual"); process.exit(2); }
const VIA = arg("--via", "google"), OB_LOG = arg("--openbelt-log", process.env.OPENBELT_LOG ?? "");
if (VIA === "email" && !OB_LOG) { console.error("--via email needs --openbelt-log <the local OpenBelt's platform.log>"); process.exit(2); }
/** The newest sign-in code the local OpenBelt "mailed" (to its log), with the address. */
const obCode = () => {
  if (!OB_LOG || !existsSync(OB_LOG)) return null;
  const all = [...readFileSync(OB_LOG, "utf8").matchAll(/mail to (\S+) .*?your code for OpenBelt is (\d{6})/g)];
  const m = all.at(-1);
  return m ? { email: m[1], code: m[2] } : null;
};
const PACE = Number(arg("--pace", "1500")); // ms a person takes to read a popup page before tapping (the video's pace)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = `${ROOT}/build/e2e-openbelt`, SIMDIR = `${OUT}/sim`, PTY = `${OUT}/serial`, VIDEO = `${OUT}/video`;
const PVSIM = `${ROOT}/build/sim/pvsim`, SIM_PORT = 8093, FW = "1.2.0";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
for (const [p, how] of [...(REAL ? [] : [[PVSIM, "make sim-build"]]), [CHROME, "install Google Chrome or set CHROME"]])
  if (!existsSync(p)) { console.error(`missing ${p} (${how})`); process.exit(2); }

const results = [], t0 = Date.now(), marks = [];
const step = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`); return ok; };
const mark = (what) => marks.push({ at: (Date.now() - t0) / 1000, what });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms, every = 1000) => { const end = Date.now() + ms; let v; while (!(v = await f()) && Date.now() < end) await sleep(every); return v; };
const simSet = (key, value) => fetch(`http://localhost:${SIM_PORT}/api/set`, { method: "POST", body: new URLSearchParams({ key, value }) });

// The release image: newer than the simulator's, so setup installs it (with the stand-in flasher below) while the person signs in.
const IMAGE = new TextEncoder().encode("paperbot release image (stand-in)");
const IMAGE_SUM = [...new Uint8Array(await crypto.subtle.digest("SHA-256", IMAGE))].map((b) => b.toString(16).padStart(2, "0")).join("");
const FAKE_ESPTOOL = `
export class Transport { constructor(p) { this.p = p; } async disconnect() {} }
export class ESPLoader {
  constructor() {}
  async main() { return "ESP32-C6"; }
  async writeFlash({ fileArray, reportProgress }) {
    for (let k = 1; k <= 24; k++) { await new Promise((r) => setTimeout(r, 500)); reportProgress(fileArray.length - 1, k, 24); }
  }
  async after() {}
}`;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(VIDEO, { recursive: true });
// What the person says, as the board's microphone hears it (16 kHz mono).
await run("say", ["-v", "Samantha", "-o", `${OUT}/dentist.wav`, "--data-format=LEI16@16000", "Remind me to call the dentist on the eighteenth at nine."]);
await run("pkill", ["-f", `pvsim --serve --port ${SIM_PORT}`]).catch(() => {});
const sim = REAL ? null : spawn(PVSIM, ["--serve", "--port", String(SIM_PORT), "--generic", "--usb", "--server", B, "--run-dir", SIMDIR, "--fw-version", FW, "--serial-pty", PTY], { stdio: "ignore" });
const cleanup = async () => { if (!sim) return; sim.kill(); await run("pkill", ["-f", `pvsim --serve --port ${SIM_PORT}`]).catch(() => {}); };
if (sim) await until(() => existsSync(PTY), 10_000, 250);

const browser = await chromium.launch({ executablePath: CHROME, headless: !MANUAL });
const ctx = await browser.newContext(MANUAL ? { viewport: null } : { viewport: { width: 1280, height: 800 }, recordVideo: { dir: VIDEO, size: { width: 1280, height: 800 } } });
if (!REAL) {
await ctx.route("**/v1/setup/firmware/manifest.json", (r) => r.fulfill({ json: { version: "9.9.9", files: [{ name: "app.bin", offset: "0x10000", sha256: IMAGE_SUM }] } }));
await ctx.route("**/v1/setup/firmware/app.bin", (r) => r.fulfill({ body: Buffer.from(IMAGE), contentType: "application/octet-stream" }));
await ctx.route("**/setup/vendor/esptool.js", (r) => r.fulfill({ contentType: "text/javascript", body: FAKE_ESPTOOL }));
}
const pages = [];
ctx.on("page", (p) => { pages.push({ page: p, opened: (Date.now() - t0) / 1000 }); });

let n = 0;
const shot = async (p, name) => { n++; await p.screenshot({ path: `${OUT}/${String(n).padStart(2, "0")}-${name}.png` }); mark(name); };

let ok = false;
try {
  const sp = await ctx.newPage();
  const errors = [];
  sp.on("pageerror", (e) => errors.push(String(e)));
  // The board's console: bytes to and from the simulator's pty. Not granted until the person picks it, as in a new browser.
  let rx = null;
  if (sim) {
  const fd = openSync(PTY, "r+");
  await sp.exposeBinding("__serialWrite", (_s, bytes) => writeSync(fd, Buffer.from(bytes)));
  rx = createReadStream(null, { fd, autoClose: false });
  rx.on("data", (b) => sp.evaluate((x) => window.__serialPush?.(x), [...b]).catch(() => {}));
  await sp.addInitScript(() => {
    let granted = false;
    const port = {
      getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }),
      async open() { this.readable = new ReadableStream({ start: (c) => { window.__serialPush = (b) => { try { c.enqueue(new Uint8Array(b)); } catch {} }; } });
        this.writable = new WritableStream({ write: (chunk) => window.__serialWrite([...chunk]) }); },
      async close() { window.__serialPush = null; }, async setSignals() {},
    };
    Object.defineProperty(Navigator.prototype, "serial", { configurable: true, get: () => ({
      getPorts: async () => (granted ? [port] : []),
      requestPort: () => new Promise((res) => setTimeout(() => { granted = true; res(port); }, 1200)), // Chrome's picker, chosen
      addEventListener() {} }) });
  });
  }
  const h1 = (re, ms = 60_000) => sp.waitForFunction((src) => new RegExp(src).test(document.querySelector("#view h1")?.textContent || ""), re.source, { timeout: ms });

  if (MANUAL) {
    if (REAL) await sp.addInitScript(() => { window.__realBoard = true; });
    await sp.exposeBinding("__hold", async (_s, text) => {
      await run("say", ["-v", "Samantha", "-o", `${OUT}/said.wav`, "--data-format=LEI16@16000", String(text)]);
      await simSet("audio", `file:${OUT}/said.wav`);
      await simSet("cmd", "sim 3500");
    });
    await sp.addInitScript(() => addEventListener("DOMContentLoaded", () => {
      if (location.pathname !== "/setup") return;
      // The test values a person needs here, and buttons that act like them (the board is simulated: it knows PV-Home).
      const d = document.createElement("div");
      d.style.cssText = "position:fixed;right:16px;top:64px;z-index:9;display:grid;gap:10px;width:380px;padding:14px;border-radius:14px;background:#fff;color:#111;box-shadow:0 6px 24px rgba(0,0,0,.18);font:14px/1.45 system-ui";
      const btn = "padding:8px 12px;border-radius:9px;border:0;background:#111;color:#fff;font:600 13px system-ui;cursor:pointer;white-space:nowrap";
      const row = "display:flex;gap:10px;align-items:center;justify-content:space-between";
      d.innerHTML = `<b style="font-size:15px">Local test</b>
        <div style="color:#444">Sign in with <b>Test sign-in (new throwaway account)</b>. OpenBelt's email code fills in by itself.</div>
        <div style="${row}"><span style="white-space:nowrap">Wi-Fi <b>PV-Home</b> · <code style="font-size:13px">home-secret-1</code></span>
          <button type="button" id="t-wifi" style="${btn}">Paste password</button></div>
        <form style="display:grid;gap:8px"><input name="t" value="Remind me to call the dentist on the eighteenth at nine." style="padding:8px 10px;border-radius:9px;border:0;background:#f0f0ee;color:#111;font:14px system-ui">
          <button style="${btn}">Hold ☀ and say</button></form>`;
      if (window.__realBoard) { d.querySelector("#t-wifi").parentElement.remove(); d.querySelector("form").remove();
        d.insertAdjacentHTML("beforeend", "<div>Real board: pick it in Chrome's list, use your own Wi-Fi, then hold ☀ on the board and talk.</div>"); }
      else d.querySelector("#t-wifi").onclick = () => {
        if (!document.querySelector('.net[data-ssid="PV-Home"] .pw, .pwrow')) document.querySelector('.net[data-ssid="PV-Home"]')?.click();
        setTimeout(() => { const dt = new DataTransfer(); dt.setData("text/plain", "home-secret-1");
          document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); }, 300);
      };
      const f = d.querySelector("form");
      if (f) f.onsubmit = async (e) => { e.preventDefault(); const b = f.querySelector("button"); b.disabled = true; b.textContent = "Saying…";
        await window.__hold(f.t.value).finally(() => { b.disabled = false; b.textContent = "Hold ☀ and say"; }); };
      document.body.append(d);
    }));
    if (OB_LOG) {
      await ctx.exposeBinding("__obCode", () => obCode());
      await ctx.addInitScript(() => addEventListener("DOMContentLoaded", async () => {
        const input = document.querySelector('form[action="/_signin/code"] input[name="code"]');
        if (!input || !window.__obCode) return;
        const email = document.querySelector('form[action="/_signin/code"] input[name="email"]')?.value;
        let c = null;
        for (let i = 0; i < 10 && !(c && (!email || c.email === email)); i++) { c = await window.__obCode(); if (!c || (email && c.email !== email)) await new Promise((r) => setTimeout(r, 300)); }
        if (!c) return;
        input.value = c.code;
        const note = document.createElement("p");
        note.textContent = `Local test: OpenBelt has no mail here. The code for ${c.email} is ${c.code} (filled in).`;
        note.style.cssText = "margin:12px 0;padding:10px 12px;border-radius:10px;background:#fff3c4;color:#222;font:14px system-ui";
        input.form.before(note);
      }));
    }
    await sp.goto(`${B}/setup`);
    console.log(`Chrome is open on ${B}/setup with ${REAL ? "the plugged-in board" : "a simulated board"}. Close the window to stop.`);
    await new Promise((r) => { sp.on("close", r); browser.on("disconnected", r); });
    await browser.close().catch(() => {});
    await cleanup();
    process.exit(0);
  }
  await sp.goto(`${B}/setup`);
  await sp.waitForFunction(() => document.querySelector("#mv")?.loaded, null, { timeout: 30_000 }).catch(() => {});
  await h1(/Plug it in/);
  await sp.waitForTimeout(1500);
  await shot(sp, "plug-it-in");
  await sp.click('[data-do="connect"]');
  await h1(/Make it yours/, 30_000);
  await sp.waitForTimeout(1200);
  await shot(sp, "make-it-yours");

  // ---- the popup: sign up on paperbot, then on through OpenBelt
  const [pop] = await Promise.all([ctx.waitForEvent("page"), sp.click('[data-do="signin"]')]);
  await pop.setViewportSize({ width: 480, height: 720 });
  await pop.waitForSelector("#test-login", { timeout: 30_000 });
  await pop.waitForTimeout(800);
  await shot(pop, "popup-paperbot-sign-in");
  if (THROWAWAY) {
    await pop.waitForTimeout(PACE);
    await pop.click("#test-signin");
    await pop.waitForURL(/\/_signin\?/, { timeout: 30_000 });
    EMAIL = (await sp.evaluate(async () => (await (await fetch("/api/auth/get-session")).json())?.user?.email)) ?? EMAIL;
    console.log(`throwaway account: ${EMAIL}`);
  } else {
    await pop.click("#test-login summary");
    await pop.fill('input[name="email"]', EMAIL);
    await pop.fill('input[name="password"]', `pw-${crypto.randomUUID()}`);
    await pop.fill('input[name="name"]', EMAIL.split("@")[0].replace(/^./, (c) => c.toUpperCase()));
    await pop.waitForTimeout(PACE);
    await pop.click("#signup");
    await pop.waitForURL(/\/_signin\?/, { timeout: 30_000 });
  }
  await pop.waitForTimeout(PACE);
  const openbelt = await pop.textContent("main");
  await shot(pop, "popup-openbelt-connect");
  step("after signing up, the popup goes on to OpenBelt: Connect paperbot to OpenBelt, as the paperbot account's email, Continue with Google first",
    /Connect paperbot to OpenBelt/.test(openbelt) && (await pop.inputValue('input[name="email"]').catch(() => "")) === EMAIL && /Continue with Google/.test(openbelt.split(/\bor\b/)[0]), openbelt.replace(/\s+/g, " ").slice(0, 160));
  await pop.waitForTimeout(PACE);
  let closed;
  if (VIA === "email") {
    const before = obCode()?.code ?? null;
    await pop.click('form[action="/_signin"] button');
    await pop.waitForSelector('form[action="/_signin/code"] input[name="code"]', { timeout: 15_000 });
    const got = await until(async () => { const c = obCode(); return c && c.email === EMAIL && c.code !== before ? c : null; }, 15_000, 300);
    await pop.fill('input[name="code"]', got?.code ?? "");
    await pop.waitForTimeout(PACE);
    await shot(pop, "popup-code");
    closed = pop.waitForEvent("close", { timeout: 60_000 }).then(() => true, () => false);
    await pop.click('form[action="/_signin/code"] button');
    await pop.waitForURL(/\/setup\/signed-in/, { timeout: 30_000 }).then(() => shot(pop, "popup-done"), () => shot(pop, "popup-stuck").catch(() => {}));
    step("an emailed code: OpenBelt signs them in, makes their workspace, allows paperbot, and the popup closes", (await closed) && !!got, got ? "" : "no code in the OpenBelt log");
  } else {
    await pop.click('form[action="/_signin/google"] button');
    await pop.waitForSelector("#account", { timeout: 15_000 });
    await pop.waitForTimeout(PACE);
    await shot(pop, "popup-google");
    closed = pop.waitForEvent("close", { timeout: 60_000 }).then(() => true, () => false);
    await pop.click("#account");
    await pop.waitForURL(/\/setup\/signed-in/, { timeout: 30_000 }).then(() => shot(pop, "popup-done"), () => shot(pop, "popup-stuck").catch(() => {}));
    step("one tap on Google: OpenBelt signs them in, makes their workspace, allows paperbot, and the popup closes", await closed);
  }

  const status = await sp.evaluate(async () => (await fetch("/api/openbelt")).json());
  step("paperbot is connected to OpenBelt, in the workspace made for them", status.connected && status.workspace, JSON.stringify(status));

  // ---- the board: install (if still going), Wi-Fi, check-in
  await h1(/Installing|Choose your Wi-Fi/, 60_000);
  if (/Installing/.test(await sp.textContent("#view h1"))) { await sp.waitForTimeout(800); await shot(sp, "installing"); }
  await h1(/Choose your Wi-Fi/, 90_000);
  await sp.waitForSelector(".net", { timeout: 60_000 });
  await sp.waitForTimeout(800);
  await shot(sp, "wifi");
  await sp.click('.net[data-ssid="PV-Home"]');
  await sp.waitForTimeout(600);
  await sp.evaluate(() => { const dt = new DataTransfer(); dt.setData("text/plain", "home-secret-1");
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); });
  step("pasting the Wi-Fi password connects the board", await h1(/Connected/, 90_000).then(() => true, () => false));
  await sp.waitForTimeout(800);
  await shot(sp, "wifi-connected");
  await sp.click('[data-do="next"]');
  step("the board checks in; the page asks for the first memo", await h1(/Hold/, 90_000).then(() => true, () => false));
  await sp.waitForTimeout(2000);
  await shot(sp, "hold-and-say");

  // ---- hold ☀: "Remind me to call the dentist on the eighteenth at nine."
  await simSet("audio", `file:${OUT}/dentist.wav`);
  await simSet("cmd", "sim 3500");
  const worked = await h1(/It works/, 120_000).then(() => true, () => false);
  step("the memo goes through: It works", worked);
  const saved = await sp.waitForSelector(".saved-item", { timeout: 30_000 }).then(() => true, () => false);
  await sp.waitForTimeout(1500);
  await shot(sp, "it-works");
  const item = await sp.evaluate(async () => (await (await fetch("/api/snapshot")).json()).records?.[0]?.items?.find((i) => i.ok && i.op === "add") ?? null);
  step("the memo is saved in their OpenBelt list at once (no Connect step), and It works shows it",
    saved && item?.app_url && /dentist/i.test(item.title), JSON.stringify(item));

  // ---- Continue: the List tab, read live from their OpenBelt
  await sp.waitForTimeout(PACE);
  await sp.click('[data-do="home"]');
  await sp.waitForURL(/#list$/, { timeout: 30_000 });
  const listed = await sp.waitForSelector('#belt .belt-item:has-text("dentist")', { timeout: 30_000 }).then(() => true, () => false);
  await sp.waitForTimeout(PACE);
  await shot(sp, "list");
  step("Continue opens paperbot's List tab, showing the item from their OpenBelt list", listed);

  // a tick here is written to OpenBelt
  await sp.click('#belt .belt-item:has-text("dentist") .check');
  const ticked = await until(async () => (await sp.evaluate(async () => (await fetch("/api/belt", { cache: "no-store" })).json())).items?.some((i) => /dentist/i.test(i.title) && i.done), 15_000);
  await sp.waitForTimeout(800);
  await sp.click(".belt-done-toggle").catch(() => {});
  await sp.waitForTimeout(PACE);
  await shot(sp, "list-done");
  step("ticking it off on the List tab marks it done in OpenBelt", !!ticked);

  // ---- Apps: none yet for someone new (the list app is the List tab); cards and pictures are tools/e2e/belt.mjs's
  await sp.click('#tabs [data-tab="apps"]');
  const empty = await sp.waitForSelector('#belt .empty:has-text("No apps yet")', { timeout: 30_000 }).then(() => true, () => false);
  await sp.waitForTimeout(PACE);
  await shot(sp, "apps");
  step("the Apps tab reads their OpenBelt apps: none yet, the list app being the List tab", empty);

  step("no page errors", errors.length === 0, errors.join(" | "));
  await sp.waitForTimeout(2000);
  await sp.close();
  rx?.on("error", () => {}); rx?.destroy();
  ok = results.every((r) => r.ok);
} catch (e) {
  step("unexpected error", false, String(e).slice(0, 400));
} finally {
  const videos = [];
  for (const { page, opened } of pages) { await page.close().catch(() => {}); const v = await page.video()?.path().catch(() => null); if (v) videos.push({ path: v, opened, url: page.url() }); }
  await ctx.close();
  await browser.close();
  await cleanup();
  writeFileSync(`${OUT}/steps.json`, JSON.stringify({ results, marks, videos }, null, 1));
  // One video: the setup page, with the sign-in popup over it while it was open (cut from the top-left of its own recording).
  const [main, popup] = videos;
  if (main && popup) {
    const at = (popup.opened - pages[0].opened).toFixed(2);
    const r = spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-i", main.path, "-i", popup.path, "-filter_complex",
      `[1:v]crop=480:650:0:0,pad=iw+12:ih+12:6:6:color=0x2b2b2b,setpts=PTS-STARTPTS+${at}/TB[p];[0:v][p]overlay=x=(W-w)/2:y=(H-h)/2:eof_action=pass:enable='gte(t,${at})',format=yuv420p`,
      "-c:v", "libx264", "-crf", "22", "-movflags", "+faststart", `${OUT}/seamless.mp4`], { encoding: "utf8" });
    console.log(r.status === 0 ? `video: ${OUT}/seamless.mp4` : `video failed: ${r.stderr}`);
  }
  console.log(`${results.filter((r) => r.ok).length}/${results.length} passed · ${OUT}`);
  process.exit(ok ? 0 : 1);
}
