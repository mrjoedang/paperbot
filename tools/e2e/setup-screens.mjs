// Every screen of /setup, in order, without a board: the real page against a real server (sign-in, claim, Wi-Fi list
// on the account), with navigator.serial replaced by a scripted board that answers like the firmware (info, wifi
// scan / test, prov, check-in, a first memo) and a fake flasher. Screenshots: build/e2e/screens/NN-name.png, plus
// build/e2e/screens/sheet.png. TEST_HOOKS servers only (it uses the test sign-in).
//
//   node tools/e2e/setup-screens.mjs --server http://127.0.0.1:8787 [--width 1280 --height 800]
import { chromium } from "playwright-core";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const SERVER = (arg("--server") || "").replace(/\/$/, "");
if (!SERVER || /^https:\/\/(app\.)?(pocketbot|paperbot)\.ca/.test(SERVER)) { console.error("--server URL (not production)"); process.exit(2); }
// a Wi-Fi QR code for the scripted network, as the Passwords app shows one (made here: qrcode, via uv)
const QR = new URL("../../build/e2e/wifi-qr.png", import.meta.url).pathname;
mkdirSync(new URL("../../build/e2e/", import.meta.url).pathname, { recursive: true });
execFileSync("uv", ["run", "-q", "--with", "qrcode[pil]", "python", "-c",
  `import qrcode; qrcode.make("WIFI:S:Home Wi-Fi;T:WPA;P:right-password-1;;").save("${QR}")`]);
const W = +arg("--width", "1280"), H = +arg("--height", "800");
const OUT = new URL("../../build/e2e/screens", import.meta.url).pathname; // the repo's build/, from any directory
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// ---- the scripted board (runs in the page before its scripts)
const FAKE_BOARD = () => {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const st = { fw: "1.0.0", server: "", token: false, granted: false, onConnect: null, pick: null, cancel: null, busyOnce: true, failFlashOnce: true };
  window.__board = st;
  class Port {
    getInfo() { return { usbVendorId: 0x303a, usbProductId: 0x1001 }; }
    async open() {
      if (st.busyOnce) { st.busyOnce = false; throw new DOMException("Failed to open serial port.", "NetworkError"); } // another tab has it
      this.buf = "";
      this.readable = new ReadableStream({ start: (c) => { this.ctl = c; } });
      this.writable = new WritableStream({ write: (chunk) => this.write(chunk) });
      setTimeout(() => { this.emit(`PVFW-VERSION:${st.fw};`); this.emit(`1,600,UI,screen=${st.token ? "READY" : "STATUS"},title=x,detail=y*00`); }, 400);
    }
    async close() { try { this.ctl.close(); } catch {} }
    async setSignals() {}
    emit(l) { try { this.ctl.enqueue(enc.encode(l + "\n")); } catch {} }
    reply(o, ms = 150) { setTimeout(() => this.emit("@" + JSON.stringify(o)), ms); }
    write(chunk) {
      this.buf += dec.decode(chunk);
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) { const l = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1); if (l) this.cmd(l); }
    }
    cmd(l) {
      if (l === "info") return this.reply({ v: 1, id: "a1b2c3d4e5f6", fw: st.fw, server: st.server, token: st.token, wifi_rev: 0, networks: [], hello: false, net: "never", sd: true, batt_mv: 4100, usb: true, state: "READY" });
      if (l === "wifi scan") return this.reply({ ok: true, what: "scan", nets: [
        { ssid: "Home Wi-Fi", rssi: -42, open: false }, { ssid: "Neighbours 5G", rssi: -63, open: false },
        { ssid: "Joe’s iPhone", rssi: -58, open: false }, { ssid: "Coffee Shop", rssi: -77, open: true }] }, 1200);
      if (l.startsWith("wifi test ")) {
        const t = JSON.parse(l.slice(10));
        if (t.ssid === "Neighbours 5G") return this.reply({ ok: false, what: "test", error: "wifi_not_found" }, 2000);
        return t.psk === "right-password-1" ? this.reply({ ok: true, what: "test", ssid: t.ssid, rssi: -42, ms: 2500 }, 2500)
          : this.reply({ ok: false, what: "test", error: "wifi_password" }, 2500);
      }
      if (l.startsWith("prov server ")) { st.server = l.slice(12); return this.reply({ ok: true, what: "server" }); }
      if (l.startsWith("prov token ")) { st.token = true; return this.reply({ ok: true, what: "token" }); }
      if (l.startsWith("prov wifi ")) return this.reply({ ok: true, what: "wifi", rev: 1, count: 1 });
      if (l === "prov done") {
        this.reply({ ok: true, what: "done" });
        setTimeout(() => this.emit("9,3000,HELLO,ok,ssid=Home Wi-Fi*00"), 2500);
      }
    }
  }
  const port = new Port();
  st.memo = () => {
    port.emit("10,1,UI,screen=REC,title=REC,detail=*00");
    setTimeout(() => port.emit("11,1,UI,screen=SENDING,title=sending,detail=*00"), 2500);
    setTimeout(() => port.emit("12,1,UI,screen=RESULT,title=REMINDER,detail=Call the dentist|Nov 18 9:00*00"), 5000);
  };
  const serial = {
    async getPorts() { return st.granted ? [port] : []; },
    requestPort() { return new Promise((res, rej) => { st.pick = () => { st.granted = true; res(port); }; st.cancel = () => rej(new DOMException("No port selected by the user.", "NotFoundError")); }); }, // held open: the picker
    addEventListener() {},
  };
  Object.defineProperty(Navigator.prototype, "serial", { get: () => serial, configurable: true });
};
// the flasher: progress over ~8 s, then the board is on the release version
const FAKE_ESPTOOL = `
export class Transport { constructor(p) { this.p = p; } async disconnect() {} }
export class ESPLoader {
  constructor() {}
  async main() { return "ESP32-C6"; }
  async writeFlash({ fileArray, reportProgress }) {
    const last = fileArray.length - 1;
    for (let i = 0; i <= last; i++) reportProgress(i, 1, 1);
    for (let k = 1; k <= 16; k++) {
      await new Promise((r) => setTimeout(r, 500)); reportProgress(last, k, 16);
      if (k === 6 && window.__board.failFlashOnce) { window.__board.failFlashOnce = false; throw new Error("write failed"); } // a loose cable, once
    }
  }
  async after() { window.__board.fw = "1.1.0"; }
}`;

const b = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true, args: ["--use-angle=metal"] });
const ctx = await b.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
await ctx.addInitScript(FAKE_BOARD);
await ctx.route("**/setup/vendor/esptool.js", (r) => r.fulfill({ contentType: "text/javascript", body: FAKE_ESPTOOL }));
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
let n = 0;
const settle = (ms = 1600) => page.waitForTimeout(ms); // camera moves + e-paper refresh
const shot = async (name, ms) => { await settle(ms); n++; await page.screenshot({ path: `${OUT}/${String(n).padStart(2, "0")}-${name}.png` }); console.log(`${n} ${name}: ${await page.textContent("#view h1").catch(() => "")}`); };
const h1 = (re, ms = 60_000) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector("#view h1")?.textContent || ""), re.source, { timeout: ms });
const paste = (data) => page.evaluate(async (d) => { // what ⌘V delivers: text, or a picture
  const dt = new DataTransfer();
  if (d.text) dt.setData("text/plain", d.text);
  if (d.png) dt.items.add(new File([Uint8Array.from(atob(d.png), (c) => c.charCodeAt(0))], "qr.png", { type: "image/png" }));
  document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}, data);

await page.goto(`${SERVER}/setup`);
await page.waitForFunction(() => document.querySelector("#mv")?.loaded, null, { timeout: 30_000 });
await h1(/Plug it in/);
await shot("plug-it-in", 2400);
await page.click('[data-do="connect"]');
await h1(/Select device/);
await shot("port-picker-open");
await page.evaluate(() => window.__board.cancel()); // closed the picker without choosing
await page.waitForSelector(".hint");
await shot("port-picker-cancelled", 600);
await page.click('[data-do="connect"]');
await h1(/Select device/);
await page.evaluate(() => window.__board.pick());
await page.waitForFunction(() => /busy/.test(document.querySelector("#view").textContent), null, { timeout: 10_000 }); // another tab has the port
await shot("port-busy", 600);
await page.click('[data-do="connect"]');
await h1(/Select device/);
await page.evaluate(() => window.__board.pick());
await h1(/Connecting/, 5000).then(() => shot("connecting", 300)).catch(() => {});
await h1(/Make it yours/);
await shot("sign-in");
// The sign-in popup goes on to OpenBelt (Connect paperbot to OpenBelt) before it closes. Here it is cancelled: the popup
// still closes and setup goes on, with saves waiting for Connect in Settings (the connected path: setup-openbelt.mjs).
async function throughOpenBelt(pop, screenshot = false) {
  const atOpenBelt = await pop.waitForURL((u) => !u.href.startsWith(SERVER), { timeout: 15_000 }).then(() => true, () => false);
  if (!atOpenBelt) return;
  await pop.waitForLoadState("load").catch(() => {});
  if (screenshot) { n++; await pop.screenshot({ path: `${OUT}/${String(n).padStart(2, "0")}-sign-in-openbelt.png` }).catch(() => {}); console.log(`${n} sign-in-openbelt`); }
  // What OpenBelt sends back on Cancel, navigated from the page as its redirect is (a goto here would be the browser's own
  // navigation, which drops window.opener, the popup's way to tell the setup tab it's done).
  await pop.evaluate((u) => { location.href = u; }, `${SERVER}/api/openbelt/callback?error=access_denied`).catch(() => {});
}

const [pop] = await Promise.all([ctx.waitForEvent("page"), page.click('[data-do="signin"]')]); // the sign-in popup
await pop.waitForSelector("#test-signin");
n++; await pop.screenshot({ path: `${OUT}/${String(n).padStart(2, "0")}-sign-in-popup.png` }); console.log(`${n} sign-in-popup`);
await pop.click("#test-signin"); // test deployments: a throwaway account in one click
await throughOpenBelt(pop, true);
await h1(/Installing/);
await shot("installing", 1200);
await page.waitForSelector('[data-do="install"]', { timeout: 30_000 }); // the write failed once
await shot("install-failed", 400);
await page.click('[data-do="install"]');
await page.waitForFunction(() => document.querySelector(".track i")?.style.width !== "0%", null, { timeout: 10_000 });
await shot("installing-again", 800);
await h1(/Signed in/, 30_000).then(() => shot("signed-in", 200)).catch(() => {});
await h1(/Choose your Wi-Fi/);
await page.waitForSelector(".net");
await shot("wifi-list");
await page.click('.net[data-ssid="Neighbours 5G"]');
await paste({ text: "some-password-1" });
await page.waitForFunction(() => /Can.t find this network/.test(document.querySelector("#view").textContent), null, { timeout: 15_000 });
await shot("wifi-not-found");
await page.click('.net[data-ssid="Home Wi-Fi"]');
// "Copy it from Wi-Fi settings": the page's own reaction only. The link itself would open Chrome's "Open System
// Settings?" dialog, which nobody answers here and which then swallows this script's real mouse clicks.
await page.evaluate(() => { const a = document.querySelector('[data-do="pw-help"]'); a.addEventListener("click", (e) => e.preventDefault(), { once: true }); a.click(); });
await shot("wifi-guide-mac", 800);
await page.click('[data-do="help-tab"][data-tab="iphone"]');
await shot("wifi-guide-iphone", 600);
await page.click('[data-do="help-tab"][data-tab="mac"]');

await paste({ text: "wrong-password-1" }); // pasting is the whole step: no Connect click
await shot("wifi-joining", 900);
await page.waitForFunction(() => /Wrong password/.test(document.querySelector("#view").textContent), null, { timeout: 15_000 });
await shot("wifi-wrong-password");
await paste({ png: readFileSync(QR).toString("base64") }); // a picture of the network's QR code (Passwords app)
await h1(/Connected/);
await shot("wifi-connected");
await page.click('[data-do="next"]');
await h1(/Getting online/, 5000).then(() => shot("getting-online", 600)).catch(() => {});
await h1(/Hold/);
await shot("hold-to-talk", 2200);
await page.evaluate(() => window.__board.memo());
await shot("recording", 1200);
await h1(/It works/, 15_000);
await shot("it-works", 2200);
// Continue says it's on its way at once (the app can take a moment on a slow network). Read right after the click, in
// the same tick: the app's service worker answers "/" too fast to see it otherwise.
const leaving = await page.evaluate(() => { const a = document.querySelector('[data-do="home"]'); a.click(); const b = document.querySelector('[data-do="home"]'); return b.classList.contains("busy") && !!b.querySelector(".loader"); });
if (!leaving) throw new Error("Continue on 'It works' shows no busy state");
await page.waitForURL(`${SERVER}/`, { timeout: 15_000 });
console.log("it-works Continue: busy, then the app");

// Set up again, still signed in: the page asks before the board is this account's (no install: the board is newer)
const again = async () => {
  const p = await ctx.newPage();
  p.on("pageerror", (e) => errors.push(String(e)));
  await p.goto(`${SERVER}/setup`);
  await p.evaluate(() => Object.assign(window.__board, { busyOnce: false, fw: "99.0.0" }));
  const h = (re, ms = 60_000) => p.waitForFunction((src) => new RegExp(src).test(document.querySelector("#view h1")?.textContent || ""), re.source, { timeout: ms });
  await h(/Plug it in/);
  await p.click('[data-do="connect"]');
  await p.evaluate(() => window.__board.pick());
  await h(/Use this account\?/);
  return { p, h, shot: async (name, ms) => { await p.waitForTimeout(ms ?? 1600); n++; await p.screenshot({ path: `${OUT}/${String(n).padStart(2, "0")}-${name}.png` }); console.log(`${n} ${name}: ${await p.textContent("#view h1").catch(() => "")}`); } };
};
{
  const { p, h, shot } = await again();
  await shot("again-use-this-account");
  const going = await p.evaluate(() => { // Continue is busy at once (read in the click's tick), and can't switch accounts now
    document.querySelector('[data-do="account-ok"]').click();
    return !!document.querySelector("#view .btn.busy .loader") && !document.querySelector('[data-do="relink"]');
  });
  if (!going) throw new Error("Continue on 'Use this account?' shows no busy state");
  await shot("again-use-this-account-going", 0);
  await h(/^Connecting$/, 30_000); // Home Wi-Fi is saved on the account: tried by itself, no list meanwhile
  if (await p.$(".net")) throw new Error("the network list shows while a saved network is tried");
  await shot("again-wifi-saved-connecting", 800);
  await h(/Connected/, 30_000);
  await shot("again-wifi-connected");
  await p.click('[data-do="other-net"]');
  await h(/Choose your Wi-Fi/);
  await p.waitForTimeout(4000); // not tried by itself again
  if (!/Choose your Wi-Fi/.test(await p.textContent("#view h1"))) throw new Error("another network: Home Wi-Fi was tried again");
  await shot("again-another-network", 0);
  await p.close();
}
{ // ... or another account: sign out, sign in as someone else in the popup; no question after that
  const { p, h, shot } = await again();
  const [pop] = await Promise.all([ctx.waitForEvent("page"), p.click('[data-do="relink"]')]);
  await pop.waitForSelector("#test-signin");
  await pop.click("#test-signin");
  await throughOpenBelt(pop);
  await h(/Choose your Wi-Fi/, 30_000);
  await shot("again-another-account-wifi");
  await p.close();
}

// Safari, phones: no Web Serial
const p2 = await ctx.newPage();
await p2.addInitScript(() => { Object.defineProperty(Navigator.prototype, "serial", { get: undefined, configurable: true }); delete Navigator.prototype.serial; });
await p2.goto(`${SERVER}/setup`);
await p2.waitForTimeout(2500);
n++; await p2.screenshot({ path: `${OUT}/${String(n).padStart(2, "0")}-no-web-serial.png` });
console.log(`${n} no-web-serial: ${await p2.textContent("#view h1")}`);
await b.close();

execFileSync("uv", ["run", "-q", "--with", "pillow", "python", "-c", `
import glob, os
from PIL import Image, ImageDraw
fs = sorted(glob.glob("${OUT}/[0-9]*.png")); ims = [Image.open(f).convert("RGB") for f in fs]
w, h = ims[0].width // 4, ims[0].height // 4; cols = 3; rows = (len(ims) + cols - 1) // cols
s = Image.new("RGB", (cols * (w + 12) + 12, rows * (h + 34) + 12), "white"); d = ImageDraw.Draw(s)
for i, (f, im) in enumerate(zip(fs, ims)):
    x, y = 12 + (i % cols) * (w + 12), 12 + (i // cols) * (h + 34)
    d.text((x, y), os.path.basename(f)[:-4], fill="black"); s.paste(im.resize((w, h)), (x, y + 18))
s.save("${OUT}/sheet.png")`]);
console.log(errors.length ? `page errors: ${errors.join(" | ")}` : "no page errors", `\n${OUT}/sheet.png`);
