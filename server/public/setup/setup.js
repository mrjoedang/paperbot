// /setup: set up a paperbot from the browser (docs/setup.md). The page does what `pocketbot setup` did on the Mac:
//   connect  the board over Web Serial (one connection for the whole run: opening the port resets the board)
//   install  the release image if the board's is older (esptool-js), while the person signs in (a popup, so this page
//            and its board connection stay); then a board token for them (POST /v1/setup/claim, same-origin session)
//   wifi     the board's own scan; a network saved on the account is tried by itself, otherwise the person types the
//            password; the board proves it ("wifi test") before it's saved (account, then board)
//   try      "prov done" (check-in), then the first memo, read from the board's console
import { screen } from "./screen.js";
import { Board, BOARD_MS, flasher, older, releaseImage, sleep, supported } from "./board.js";

const $ = (s) => document.querySelector(s);
const STEPS = ["connect", "install", "wifi", "try"];
const sc = screen($("#mv"));
sc.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(() => $("#stage").classList.add("ready")))); // drawn: the still fades out

const S = {
  step: "connect", connecting: false, slow: false, error: null, paperbot: false,
  install: { need: false, phase: "wait", pct: 0 },
  signin: { checked: false, done: false, email: "" },
  claimed: false, nets: [], test: { state: "idle", ssid: "", error: "" }, online: false, memo: { state: "wait" },
};
const sel = { wifi: null };
const typeOwn = new Set();
const known = new Map(); // ssid -> password, the networks saved on the account (GET /v1/wifi)
const autoTried = new Set();
let board = null, token = "", server = "", device = "";

// ------------------------------------------------------------------ clicks -> the flow
const queue = [];
let wake = null;
const act = (a, x = {}) => { queue.push({ a, ...x }); wake?.(); };
async function next(ms) {
  if (!queue.length) await new Promise((r) => { wake = r; setTimeout(r, ms); });
  wake = null;
  return queue.shift() || null;
}
const drain = () => { queue.length = 0; };

// ------------------------------------------------------------------ server
async function dev(method, path, body) { // as the board (its token): Wi-Fi list, time zone
  const r = await fetch(path, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}
async function me() { // Better Auth's session check: null (not a 401) when signed out
  const r = await fetch("/api/auth/get-session", { cache: "no-store" }).catch(() => null);
  const j = r && r.ok ? await r.json().catch(() => null) : null;
  return j?.user ? { email: j.user.email } : null;
}
async function checkSignin() {
  const m = await me();
  S.signin.checked = true;
  // a session this page's popup didn't make (from before, maybe long ago, maybe someone else's): ask before the board is
  // theirs. Signing in in the popup is the choice already.
  if (m?.email && !S.signin.done) S.signin = { checked: true, done: true, email: m.email, passkey: /@passkey\.invalid$/.test(m.email), confirm: !popupUsed };
  render();
}
window.addEventListener("message", (e) => { if (e.origin === location.origin && e.data === "pb-signed-in") checkSignin(); });
window.addEventListener("focus", () => {
  if (!S.signin.done) checkSignin();
  if (pip && S.test.state === "ok") unfloat(); // back on the page once it worked: the floating window is done
});
// Sign-in happens in a popup: leaving this page would drop the board connection (and stop a running install).
let popupUsed = false;
function signinPopup(w = window.open("/setup/signed-in", "pb-signin", "popup,width=480,height=720")) {
  if (!w) { S.error = "Allow pop-ups for this site, then click Sign in again."; render(); }
  else popupUsed = true;
  return w;
}

// ------------------------------------------------------------------ the board's console
function onLine(l) {
  if (l.includes(",HELLO,ok")) { S.online = true; render(); }
  const i = l.indexOf(",UI,screen=");
  if (i < 0) return;
  let rest = l.slice(i + 11);
  const star = rest.lastIndexOf("*");
  if (star > 0) rest = rest.slice(0, star);
  const parts = rest.split(","), field = (k) => (parts.find((p) => p.startsWith(k)) || "").slice(k.length);
  const scr = parts[0], m = S.memo;
  if (scr === "REC") S.memo = { state: "rec" };
  else if (["SAVED", "SENDING", "QUEUED"].includes(scr) && (m.state === "rec" || m.state === "send")) S.memo = { state: "send" };
  else if (["RESULT", "WORKDONE", "RESEARCHING"].includes(scr) && m.state !== "wait") { S.memo = { state: "done", kind: field("title=").toLowerCase(), title: field("detail=").split("|")[0] }; savedItem(); }
  else if (scr === "SENT" && m.state === "send") S.memo = { state: "done", kind: "sent", title: "" };
  else if (scr === "TOOSHORT" || scr === "NOISE") S.memo = { state: "wait" };
  render();
}
/** What the first memo saved in the person's OpenBelt list (its newest record's first item), for "It works" to show. */
async function savedItem() {
  for (let i = 0; i < 8 && S.memo.state === "done" && !S.memo.saved; i++) {
    const r = await fetch("/api/snapshot", { cache: "no-store" }).then((x) => (x.ok ? x.json() : null)).catch(() => null);
    const rec = r?.records?.[0], item = (rec?.items ?? []).find((x) => x.ok && x.op === "add");
    if (item && Date.now() - rec.received_at < 10 * 60_000) { S.memo.saved = item; render(); return; }
    await new Promise((res) => setTimeout(res, 1500));
  }
}
/** A console command; if the board was unplugged, wait for it to come back first (its settings are on it). */
async function ask(cmd, ms = BOARD_MS) {
  for (let i = 0; i < 2; i++) {
    if (board.gone) {
      S.error = "Plug it back in."; render();
      await board.reconnect(30 * 60_000);
      S.error = null; render();
    }
    const r = await board.ask(cmd, ms);
    if (r || !board.gone) return r;
  }
  return null;
}

// ------------------------------------------------------------------ the flow
async function connect() {
  let port = await Board.granted(); // this site was allowed before: no picker
  for (;;) {
    if (!port) {
      S.connecting = false; render();
      const a = await next(1e9);
      if (a?.a === "plugged") port = await Board.granted();
      else if (a?.a === "connect") {
        S.picking = true; render(); // Chrome's picker is open: the page says which entry is the board
        port = await Board.pick().catch(() => null);
        S.picking = false; S.cancelled = !port;
      }
      if (!port) continue;
    }
    S.connecting = true; S.error = null; S.slow = false; render();
    const slow = setTimeout(() => { S.slow = true; render(); }, 9000);
    try {
      await board.open(port);
    } catch {
      clearTimeout(slow);
      S.error = "The device is busy. Close other tabs or apps using it (like a serial monitor), then click Connect.";
      port = null;
      continue;
    }
    const info = await board.hello();
    clearTimeout(slow);
    return info;
  }
}

// The release image downloads from the moment the page opens (~1.8 MB), so an install starts at once.
let imageP = null;
const image = () => (imageP ??= releaseImage().catch((e) => { imageP = null; throw e; }));

async function install(info) {
  let img;
  for (;;) {
    img = await image().catch(() => null);
    if (img) break;
    S.error = "Couldn't download the software. Check your internet."; render();
    await sleep(4000);
  }
  S.error = null;
  S.install.need = !info || older(info.fw, img.version);
  S.step = "install"; render();
  if (!S.install.need) { S.install.phase = "done"; return info; }
  for (;;) {
    S.install = { need: true, phase: "flash", pct: 0 }; S.error = null; render();
    try {
      await board.flash(img.files, (p) => { S.install.pct = p; render(); });
    } catch {
      S.install.phase = "wait";
      S.error = "Installing didn't finish. Keep it plugged in and try again."; render();
      drain();
      while ((await next(1e9))?.a !== "install");
      continue;
    }
    S.install.phase = "restart"; render();
    const late = setTimeout(() => { S.error = "It didn't restart. Unplug it (and its battery) for 5 seconds, then plug it back in."; render(); }, 30_000);
    info = await board.reconnect(30 * 60_000).catch(() => null);
    clearTimeout(late);
    if (info) break;
    S.install.phase = "wait";
    S.error = "It didn't answer after installing. Try again."; render();
    while ((await next(1e9))?.a !== "install");
  }
  S.error = null;
  S.install.phase = "done"; S.install.pct = 100; render();
  return info;
}

async function claim() {
  for (;;) { // "Use another account" during the question signs out: wait for the new sign-in
    while (!S.signin.done) await next(800);
    if (!S.signin.confirm) break;
    render();
    if ((await next(800))?.a === "account-ok" && S.signin.done) S.signin.confirm = false;
  }
  for (;;) {
    S.signin.claiming = true; render(); // from here the board becomes this account's: "Use another account" goes away
    const r = await fetch("/v1/setup/claim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ device }) }).catch(() => null);
    if (r?.ok) { ({ token, server } = await r.json()); break; }
    if (r?.status === 401) {
      S.signin = { checked: true, done: false, email: "" }; S.error = "Sign in again."; render();
      while (!S.signin.done) await next(800);
      continue;
    }
    S.error = "Couldn't connect. Check your internet."; render();
    await sleep(3000);
  }
  S.claimed = true; S.error = null; render();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  await dev("POST", "/v1/config", { tz }).catch(() => {});
  const list = await dev("GET", "/v1/wifi").catch(() => ({ networks: [] }));
  for (const n of list.networks || []) known.set(n.ssid, n.psk);
  for (const [what, val] of [["server", server || location.origin], ["token", token]]) {
    const r = await ask(`prov ${what} ${val}`);
    if (!r?.ok) throw new Error(`The board didn't take the ${what} setting.`);
  }
  if (list.networks?.length) await ask(`prov wifi ${JSON.stringify(list)}`); // networks this account has already
}

const hotspotName = (s) => /iphone|ipad|pixel|galaxy|hotspot|android|phone/i.test(s);
async function scan() {
  const r = await ask("wifi scan");
  if (!r) { S.error = "It didn't answer. Keep it plugged in."; render(); return; }
  const nets = (r.nets || []).map((n) => ({ ssid: n.ssid, rssi: n.rssi ?? -90, open: !!n.open, known: known.has(n.ssid), hotspot: hotspotName(n.ssid) }));
  if (nets.length || !S.nets.length) { S.nets = nets; S.error = null; }
  render();
}

async function test(ssid, typed, auto = false) {
  const fail = (e) => { S.test = { state: "fail", ssid, error: e }; render(); };
  const n0 = S.nets.find((n) => n.ssid === ssid);
  if (!n0) return;
  const open = n0.open, psk = typed || known.get(ssid) || "";
  if (!open && (psk.length < 8 || psk.length > 63)) return fail("wifi_password");
  S.test = { state: "run", ssid, error: "", auto }; render();
  const r = await ask(`wifi test ${JSON.stringify({ ssid, psk: open ? "" : psk })}`, BOARD_MS + 25_000);
  if (!r) return fail("no_wifi");
  if (!r.ok) return fail(r.error || "no_wifi");
  if (typed || !known.has(ssid)) { // new to the account: save it there, then the account's list to the board
    const n = { ssid, ...(open ? { open: true } : { psk }) };
    const saved = await dev("POST", "/v1/config", { wifi: [n] }).catch(() => null);
    if (!saved?.wifi) { S.error = "Couldn't save the network to your account. Check your internet and try again."; return fail("server"); }
    known.set(ssid, open ? "" : psk);
    const rep = await ask(`prov wifi ${JSON.stringify(saved.wifi)}`);
    if (!rep?.ok) return fail("no_wifi");
  }
  S.test = { state: "ok", ssid, error: "" }; S.error = null; render();
}

async function wifi() {
  S.step = "wifi"; S.error = null; S.test = { state: "idle", ssid: "", error: "" };
  drain(); render();
  await scan();
  for (;;) {
    const ok = S.test.state === "ok";
    // a network the account already has: try it without asking
    if (!ok && S.test.state === "idle" && sel.wifi && known.has(sel.wifi) && !autoTried.has(sel.wifi)) {
      autoTried.add(sel.wifi);
      await test(sel.wifi, "", true);
      continue;
    }
    const c = await next(500);
    if (c?.a === "next" && ok) return;
    if (c?.a === "other-net" && ok) { autoTried.add(S.test.ssid); S.test = { state: "idle", ssid: "", error: "" }; render(); } // no auto-retry of it
    if (c?.a === "scan" && !ok) await scan();
    else if (c?.a === "test" && !ok) { await test(c.ssid, c.psk); drain(); }
  }
}

const NET_HELP = {
  wifi_password: (s) => `${s} refused the password. Go back and type it again.`,
  wifi_not_found: (s) => `It can't see ${s}. Move it closer.`,
  server: () => "It joined the Wi-Fi but can't reach the internet.",
};
async function tryIt() {
  S.step = "try"; S.error = null; drain(); render();
  const r = await ask("prov done");
  if (!r?.ok) S.error = "Setup didn't finish. Unplug it, plug it back in and reload this page.";
  const t0 = Date.now();
  let asked = 0, diagnosed = false;
  for (;;) {
    if (!S.online && Date.now() - asked > 2000) {
      asked = Date.now();
      const st = await fetch(`/v1/setup/claim?device=${device}`, { cache: "no-store" }).then((x) => x.json()).catch(() => ({}));
      if (st.online) { S.online = true; S.error = null; render(); }
      else if (Date.now() - t0 > 60_000 && !diagnosed) {
        diagnosed = true;
        const i = (await ask("info")) || {};
        const ssid = i.ssid || "your Wi-Fi";
        S.error = (NET_HELP[i.net] || (() => `It couldn't get online through ${ssid}.`))(ssid); render();
      }
    }
    const c = await next(400);
    if (c?.a === "next") return;
  }
}

async function main() {
  if (!supported()) { S.step = "unsupported"; render(); return; }
  checkSignin();
  image().catch(() => {}); // start the download now
  setTimeout(() => flasher().catch(() => {}), 1500); // and the flasher, once the page is up
  board = new Board({ onLine, onGone: () => { S.error = "Plug it back in."; render(); } });
  navigator.serial.addEventListener("connect", () => act("plugged"));
  try {
    let info = await connect();
    S.paperbot = !!info;
    info = await install(info);
    device = info.id;
    await claim();
    await wifi();
    await tryIt(); // "Start" (a link to the app) or Skip
    await board.close();
    location.href = "/";
  } catch (e) {
    S.error = `${e.message || e} Reload this page to try again.`; render();
  }
}

// ------------------------------------------------------------------ the page
let lastHtml = "", lastKey = "", shown = "";
const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const loader = `<span class="loader"><i></i><i></i><i></i></span>`;
const check = `<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
const popOut = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="4.5" width="19" height="15" rx="2.5"/><rect x="12" y="11" width="7" height="6" rx="1.2" class="fill"/></svg>`; // a window in a window
const sig = (rssi) => `<span class="sig s${rssi >= -55 ? 4 : rssi >= -65 ? 3 : rssi >= -75 ? 2 : 1}"><i></i><i></i><i></i><i></i></span>`;
const err = (s) => (s.error ? `<p class="err">${esc(s.error)}</p>` : "");

// What the 3D board's screen shows: the page's own frames (assets/bolt, drawn by `pvsim --setup-frames` with the
// firmware's faces and font) for steps the board never shows itself; its real frames once it's in use.
function frame(s) {
  const net = (idle) => ({ run: "joining", fail: "wrong", ok: "online" })[s.test.state] || idle;
  if (s.step === "connect" || s.step === "unsupported") return "plug";
  if (s.step === "install") return s.signin.done && s.install.need && s.install.phase !== "done" ? "install" : "hello";
  if (s.step === "wifi") return net("wifi");
  if (s.step === "try") {
    if (!s.online) return "joining";
    if (s.memo.state === "rec") return "rec";
    if (s.memo.state === "send") return "sending";
    if (s.memo.state === "done") return /dentist/i.test(s.memo.title) && s.memo.kind === "reminder" ? "reminder" : "sent";
    return "ready";
  }
  return "ready";
}

// The 3D scene: on the Connect step the camera looks at the bottom edge and a USB-C cable plugs in, over and over;
// once connected the cable stays in and the camera comes back to the front.
const mv = $("#mv");
const VIEW = {
  front: ["4deg 86deg 0.2m", "0m -0.012m 0m"],
  bottom: ["22deg 100deg 0.27m", "0m -0.022m 0m"], // looking up at the USB-C edge, room below for the cable
  side: ["62deg 82deg 0.15m", "0.006m -0.004m 0m"], // turned to the right side, close on the ☀ button
};
const viewFor = (s) => s.step === "connect" || s.step === "unsupported" ? (s.connecting ? "front" : "bottom")
  : holdHint(s) ? "side" : "front";
// the first memo: a marker on the ☀ button until the recording is done
const holdHint = (s) => s.step === "try" && s.online && (s.memo.state === "wait" || s.memo.state === "rec");
let viewNow = "";
const look = ([orbit, target]) => { mv.cameraOrbit = orbit; mv.cameraTarget = target; };
let cableWant = "", cableTimer = 0;
// Plays a clip once and holds its last pose. The name must be applied (updateComplete) before play(), or the
// element's own update restarts the clip as an endless loop.
async function playOnce(name) {
  mv.animationName = name;
  await mv.updateComplete;
  mv.currentTime = 0;
  const done = new Promise((r) => mv.addEventListener("finished", r, { once: true }));
  mv.play({ repetitions: 1 });
  await done;
}
async function cable(want) {
  if (want === cableWant) return;
  cableWant = want;
  clearTimeout(cableTimer);
  if (!mv.loaded) await new Promise((r) => mv.addEventListener("load", r, { once: true }));
  if (want === "hint") {
    const loop = async () => {
      if (cableWant !== "hint") return;
      await playOnce("plug");
      if (cableWant === "hint") cableTimer = setTimeout(loop, 1400);
    };
    loop();
  } else if (want === "in") {
    if (mv.animationName !== "plug" || mv.paused) await playOnce("plug"); // ends seated (no-op look if it already is)
  }
}
const cableFor = (s) => s.step === "connect" || s.step === "unsupported" ? (s.connecting ? "in" : "hint") : "in";

const WIFI_ERR = {
  wifi_password: "Wrong password",
  wifi_not_found: "Can't find this network from here. Move closer, or check it's 2.4 GHz.",
  server: "Connected, but can't reach the internet. Try again.",
  no_wifi: "Couldn't connect. Try again.",
};
// The password, the easy way: pasting is the whole step (no Connect click). A paste can also be a Wi-Fi QR code's text
// ("WIFI:S:name;T:WPA;P:secret;;") or a picture of one (the Passwords app shows one per network), read with
// BarcodeDetector. On a Mac a link opens Wi-Fi settings, where Known Networks → ⋯ → Copy Password puts it on the
// clipboard (the Details… window has no password on macOS 26).
const isMac = /mac/i.test(navigator.userAgentData?.platform || navigator.platform || "");
// a phone or tablet (an iPad says it's a Mac, but has a touch screen)
const handheld = navigator.userAgentData?.mobile || /iPhone|iPad|Android|Mobile/i.test(navigator.userAgent) || (isMac && navigator.maxTouchPoints > 1);
const NEEDS = [
  [`<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>`, "A Mac or PC"],
  [`<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>`, "Chrome, Edge or Firefox"],
  [`<rect x="8" y="2" width="8" height="7" rx="2"/><path d="M10 9v3M14 9v3M12 12v10"/>`, "A USB-C cable that carries data"],
];
const WIFI_SETTINGS = "x-apple.systempreferences:com.apple.wifi-settings-extension";
let pwHelp = false, helpOn = isMac ? "mac" : "iphone"; // the guide to copying the password, and which device it shows
function parseWifiQr(t) {
  if (!/^WIFI:/i.test(t)) return null;
  const f = {};
  for (const m of t.slice(5).matchAll(/([A-Z]):((?:\\.|[^;\\])*);/gi)) f[m[1].toUpperCase()] = m[2].replace(/\\(.)/g, "$1");
  return f.S ? { ssid: f.S, psk: f.P || "", open: /^nopass$/i.test(f.T || "") } : null;
}
async function qrText(file) {
  if (!("BarcodeDetector" in window)) return "";
  try { return (await new BarcodeDetector({ formats: ["qr_code"] }).detect(await createImageBitmap(file)))[0]?.rawValue || ""; } catch { return ""; }
}
async function onPaste(e) {
  if (S.step !== "wifi" || S.test.state === "run" || S.test.state === "ok" || !sel.wifi) return;
  const dt = e.clipboardData;
  const img = [...(dt?.files || [])].find((f) => f.type.startsWith("image/"));
  let text = (dt?.getData("text/plain") || "").trim();
  e.preventDefault();
  if (!text && img) text = (await qrText(img)).trim();
  if (!text) { if (img) { S.error = "That picture isn't a Wi-Fi QR code."; render(); } return; }
  let ssid = sel.wifi, psk = text;
  const w = parseWifiQr(text);
  if (w) {
    if (!S.nets.some((n) => n.ssid === w.ssid)) { S.error = `It can't see ${w.ssid} from here.`; render(); return; }
    ssid = sel.wifi = w.ssid; psk = w.psk;
  }
  S.error = null;
  typeOwn.add(ssid);
  lastHtml = ""; render();
  for (const f of [document.getElementById("pw-wifi"), pip?.document.getElementById("pw-float")]) if (f) f.value = psk;
  act("test", { ssid, psk });
}

// The guide that takes the network list's place while someone fetches the password: drawn copies of the screens
// they'll see (Mac: Wi-Fi settings → Known Networks → ⋯ → Copy Password; iPhone: Settings → Wi-Fi → ⓘ → Password),
// with the thing to click circled. Universal Clipboard brings an iPhone copy to this Mac.
function guideSteps(ssid, on = helpOn, here = "Come back here and press") {
  const wifi = `<svg class="m-wifi" viewBox="0 0 24 24"><path d="M2.5 9a14 14 0 0 1 19 0M5.8 12.4a9.3 9.3 0 0 1 12.4 0M9.1 15.7a4.6 4.6 0 0 1 5.8 0"/><circle cx="12" cy="19" r="1.4"/></svg>`;
  const row = (end) => `<div class="m-row">${wifi}<span class="m-name">${esc(ssid)}</span>${end}</div>`;
  const lock = `<svg class="m-lock" viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>`;
  return on === "mac" ? [
    [`In <b>Wi-Fi</b> settings, find <b>Known Networks</b>. Click <b>⋯</b> next to ${esc(ssid)}.`,
      // the Wi-Fi card is what they see first (a landmark, faded); Known Networks is under it
      `<div class="mock"><div class="m-card"><span class="m-app">${wifi}</span><b>Wi-Fi</b><span class="m-toggle"></span></div>
        <div class="m-head">Known Networks</div><div class="m-row"><span class="m-name">${esc(ssid)}</span>${lock}${wifi}<span class="m-more ring">⋯</span></div></div>`],
    [`Click <b>Copy Password</b>. Your Mac asks for Touch ID.`,
      `<div class="mock m-menu"><div class="ring">Copy Password</div><div>Auto-Join</div><div>Remove From List</div></div>`],
    [`${here} <kbd>⌘</kbd> <kbd>V</kbd>.`, ""],
  ] : [
    [`On your iPhone: <b>Settings</b> → <b>Wi-Fi</b>. Tap <b>ⓘ</b> next to ${esc(ssid)}.`,
      `<div class="mock">${row(`<span class="m-info ring">i</span>`)}</div>`],
    [`Tap <b>Password</b>, then <b>Copy</b>.`, `<div class="mock m-pill"><span class="ring">Copy</span></div>`],
    [`On this computer, press <kbd>⌘</kbd> <kbd>V</kbd> here.`, ""],
  ];
}
const stepList = (steps) => `<ol class="steps">${steps.map(([t, m], i) => `<li><span class="n">${i + 1}</span><div><p>${t}</p>${m}</div></li>`).join("")}</ol>`;
function guide(ssid) {
  const tab = (k, t) => `<button class="${helpOn === k ? "on" : ""}" data-do="help-tab" data-tab="${k}">${t}</button>`;
  // the floating window was closed: a way back to it
  const again = isMac && "documentPictureInPicture" in window && !pip ? `<button class="mini icon" data-do="float">${popOut}Show steps in a floating window</button>` : "";
  return `<div class="guide">${again}<div class="seg">${tab("mac", "On this Mac")}${tab("iphone", "On iPhone")}</div>
    ${stepList(guideSteps(ssid))}
    <button class="mini" data-do="help-close">Show all networks</button></div>`;
}

function netList(s, which) {
  const nets = pwHelp ? s.nets.filter((n) => n.ssid === sel[which]) : s.nets;
  if (!nets.length) return "";
  const picked = sel[which];
  return `<div class="card"><ul class="nets${pwHelp ? " guiding" : ""}" role="radiogroup">${nets.map((n) => {
    const on = n.ssid === picked, bad = on && s.test.state === "fail" && s.test.ssid === n.ssid;
    const useSaved = n.known && !bad && !typeOwn.has(n.ssid);
    const field = n.open ? "" : useSaved
      ? `<div class="saved">${check}Saved on your account</div><button class="mini" data-do="type-own" data-ssid="${esc(n.ssid)}">Type a different password</button>`
      : `<input class="pw ${bad ? "bad" : ""}" id="pw-${which}" type="password" placeholder="Paste or type the password" autocomplete="current-password" name="password">`;
    const help = n.open || useSaved || pwHelp ? "" : isMac
      ? `<a class="mini" data-do="pw-help" href="${WIFI_SETTINGS}">Copy it from Wi-Fi settings</a>`
      : `<button class="mini" data-do="pw-help">Copy it from your iPhone</button>`;
    const row = on ? `<div class="pwrow">${field}${bad ? `<p class="err">${esc(WIFI_ERR[s.test.error] || WIFI_ERR.no_wifi)}</p>` : ""}${help}</div>` : "";
    if (on && pwHelp) return `<li><div class="net" aria-checked="true"><span class="name">${esc(n.ssid)}</span>${sig(n.rssi)}</div>${row}</li><li>${guide(n.ssid)}</li>`;
    return `<li><button class="net" role="radio" aria-checked="${on}" data-pick="${which}" data-ssid="${esc(n.ssid)}"><span class="name">${esc(n.ssid)}</span>${sig(n.rssi)}</button>${row}</li>`;
  }).join("")}</ul></div>`;
}
const connectBtn = (s, which) => s.test.state === "run" ? `<button class="btn busy" disabled style="opacity:1">${loader}</button>`
  : `<button class="btn" data-do="test" data-which="${which}" ${sel[which] ? "" : "disabled"}>Connect</button>`;
const LIST_NAMES = { todo: "To-do", shopping: "Shopping", reminder: "Reminders", note: "Notes" };
const savedCard = (it) => `<div class="saved-item"><div><b>${esc(it.title)}</b><span>${esc([LIST_NAMES[it.list] ?? it.list, it.due ? new Date(it.due).toLocaleString([], it.due.includes("T") ? { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } : { weekday: "short", month: "short", day: "numeric" }) : ""].filter(Boolean).join(" · "))}</span></div>
</div>`;
const V = {
  // A phone or tablet can't set up at all: send the link to a computer. A computer only needs another browser.
  unsupported: () => {
    const need = `<ul class="need">${NEEDS.map(([icon, text]) => `<li><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg>${text}</li>`).join("")}</ul>`;
    if (!handheld) return `<h1>Open this in Chrome</h1>${need}
      <div class="copy"><input id="here" readonly value="${esc(location.href)}"><button class="btn" data-do="copy">Copy</button></div>`;
    return `<h1>Set up on a computer</h1>${need}${navigator.share
      ? `<button class="btn" data-do="share"><svg class="ic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5"/><path d="M8 11H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-2"/></svg>Send link</button>
         <button class="link" data-do="copy">Copy link</button>`
      : `<button class="btn" data-do="copy">Copy link</button>`}`;
  },
  connect: (s) => s.connecting
    ? `<h1>Connecting</h1>${err(s)}<span class="waiting">${loader}</span>
       ${s.slow ? `<ul class="tips"><li>Press ⏻ on the device</li><li>Unplug it and plug it back in</li></ul>` : ""}`
    : s.picking
    ? `<h1>Select device</h1><p class="sub">It’s listed as “USB JTAG/serial debug unit”.</p>`
    : `<h1>Plug it in</h1><p class="sub">Use a USB-C cable that can transfer data.</p>${err(s)}
       <button class="btn" data-do="connect">Connect</button>
       ${s.cancelled ? `<p class="hint">Not listed? Try another cable.</p>` : ""}`,
  // The install runs in the background: the person sees "Sign in"; only if it's still going after they've signed in
  // do they see it (a progress bar). A failed install is the one thing that asks for a click.
  install: (s) => {
    const i = s.install, busy = i.need && i.phase !== "done", failed = i.need && i.phase === "wait" && s.error;
    const retry = failed ? `${err(s)}<button class="btn" data-do="install">Try again</button>` : err(s);
    if (!s.signin.done) return `<h1>Make it yours</h1>${retry}
      ${failed ? "" : s.signin.checked ? `<button class="btn" data-do="signin">Sign in</button>` : `<span class="waiting">${loader}</span>`}`;
    const who = (pre) => `<p class="sub">${s.signin.passkey ? (pre ? "Signed in with your passkey" : "With your passkey") : pre + esc(s.signin.email)}</p>${s.claimed || s.signin.claiming ? "" : `<button class="mini" data-do="relink">Use another account</button>`}`;
    return busy && !failed
      ? `<h1>Installing</h1>${who("Signed in as ")}<div class="track"><i style="width:${i.phase === "restart" ? 100 : i.pct}%"></i></div>`
      : failed ? `<h1>Installing</h1>${who("Signed in as ")}${retry}`
      : s.signin.confirm || s.signin.going ? `<h1>Use this account?</h1><p class="sub">${s.signin.passkey ? "The one with your passkey" : esc(s.signin.email)}</p>${err(s)}
          ${s.signin.going // Continue: busy until the Wi-Fi step (claim, then settings to the board); no switching meanwhile
            ? `<button class="btn busy" disabled style="opacity:1">${loader}</button>`
            : `<button class="btn" data-do="account-ok">Continue</button><button class="mini" data-do="relink">Use another account</button>`}`
      : `<h1>Signed in</h1>${who("")}${err(s)}<span class="waiting">${loader}</span>`;
  },
  wifi: (s) => s.test.state === "run" && s.test.auto // a network saved on the account, tried by itself: no list to pick from yet
    ? `<h1>Connecting</h1><p class="sub">${esc(s.test.ssid)} · saved on your account</p>${err(s)}<span class="waiting">${loader}</span>`
    : s.test.state === "ok"
    ? `<h1>Connected</h1><p class="ok">${check}${esc(s.test.ssid)}</p><button class="btn" data-do="next">Continue</button>
       <button class="link" data-do="other-net">Use another network</button>`
    : `<h1>Choose your Wi-Fi</h1>${err(s)}${s.nets.length ? netList(s, "wifi") + connectBtn(s, "wifi") : `<span class="waiting">${loader}</span>`}
       ${s.nets.length ? `<button class="link" data-do="scan">Scan again</button>` : ""}`,
  try: (s) => !s.online
    ? `<h1>Getting online</h1>${err(s)}<span class="waiting">${loader}</span><button class="link" data-do="next">Skip</button>`
    : s.memo.state === "done"
    ? `<h1>It works</h1><p class="sub">You can unplug it now.</p>${s.memo.saved ? savedCard(s.memo.saved) : ""}
       <a class="btn${s.leaving ? " busy" : ""}" href="${s.memo.saved ? "/#list" : "/"}" data-do="home">${s.leaving ? loader : "Continue"}</a>`
    : `<h1>Hold ☀ and say</h1><p class="say">“Remind me to call the dentist on the 18th at 9.”</p>
       ${s.memo.state === "wait" ? "" : `<span class="waiting">${loader}</span>`}<button class="link" data-do="next">Skip</button>`,
};

// ------------------------------------------------------------------ the floating window
// "Copy it from Wi-Fi settings" sends someone to System Settings, away from this page. Where the browser can
// (Document Picture-in-Picture: Chrome, Edge), the Wi-Fi step floats over Settings: where to click and the field the
// password is pasted into. The flow and the board connection stay in this page; the window only
// draws S and passes clicks, keys and pastes back here. It closes when the step is done or the page is used again.
let pip = null, pipHtml = "";
async function float() {
  if (pip || !("documentPictureInPicture" in window)) return;
  try {
    const w = await documentPictureInPicture.requestWindow({ width: 340, height: 600 });
    const css = w.document.createElement("link");
    css.rel = "stylesheet"; css.href = new URL("/setup/setup.css", location.href).href;
    w.document.head.append(css);
    w.document.title = "Set up paperbot";
    w.document.body.className = "floating";
    wire(w.document);
    w.addEventListener("pagehide", () => { if (pip === w) { pip = null; pipHtml = ""; render(); } }); // closed: the page offers it again
    pip = w; render();
    w.document.getElementById("pw-float")?.focus();
  } catch { window.open(WIFI_SETTINGS); } // no floating window after all: Settings straight away, the page's guide shows the way
}
const unfloat = () => { const w = pip; pip = null; pipHtml = ""; w?.close(); };
function floatView(s) {
  const t = s.test, ssid = sel.wifi || t.ssid;
  const head = (h, sub) => `<header><h2>${h}</h2><p class="sub">${sub}</p></header>`;
  if (t.state === "ok") return `${head("Connected", `${check}${esc(t.ssid)}`)}<button class="btn" data-do="back">Back to setup</button>`;
  if (t.state === "run") return `${head("Connecting", `to ${esc(t.ssid)}`)}${err(s)}<span class="waiting">${loader}</span>`; // e.g. "Plug it back in."
  const bad = t.state === "fail" && t.ssid === ssid;
  // top to bottom, like the person works: open Settings, find the network, copy, then the field to paste into
  const steps = guideSteps(ssid, "mac", "Press");
  steps[steps.length - 1][1] = `<input class="pw ${bad ? "bad" : ""}" id="pw-float" type="password" placeholder="Paste the Wi-Fi password" autocomplete="off">
    ${bad && !s.error ? `<p class="err">${esc(WIFI_ERR[t.error] || WIFI_ERR.no_wifi)}</p>` : err(s)}`; // the page's own error is the specific one
  return `${head("Connect your paperbot", `to <b>${esc(ssid)}</b>`)}
    ${stepList([[`<button class="btn quiet" data-do="open-settings">Open Wi-Fi settings</button>`, ""], ...steps])}`;
}
function renderFloat(s) {
  if (!pip) return;
  if (s.step !== "wifi" || !sel.wifi) return unfloat();
  const html = floatView(s);
  if (html === pipHtml) return;
  const d = pip.document, v = d.getElementById("pw-float")?.value, focused = d.activeElement?.id === "pw-float";
  d.body.innerHTML = html;
  pipHtml = html;
  const f = d.getElementById("pw-float");
  if (f && v) f.value = v;
  if (f && focused) f.focus();
}

function render() {
  const s = S;
  const i = STEPS.indexOf(s.step);
  $("#dots").innerHTML = i < 0 ? "" : STEPS.map((_, k) => `<i class="${k === i ? "on" : k < i ? "done" : ""}"></i>`).join("");
  // default pick: a network the account has, else the strongest that isn't a phone
  if (s.step === "wifi" && !sel.wifi && s.nets.length) {
    const best = s.nets.find((n) => n.known && !n.hotspot) || s.nets.find((n) => !n.hotspot) || s.nets[0];
    sel.wifi = best?.ssid || null;
  }
  const html = V[s.step](s);
  // while a password field has focus, rebuild only for a change that matters: a rebuild swaps the field, and a
  // password AutoFill still filling the old one is lost
  const key = JSON.stringify([s.step, s.test, s.error, sel, [...typeOwn], pwHelp, helpOn]);
  const typing = document.activeElement?.matches?.("#view input") && key === lastKey;
  lastKey = key;
  if (html !== lastHtml && !typing) {
    const keep = [...document.querySelectorAll("#view input")].map((x) => [x.id, x.value]);
    const focus = document.activeElement?.id;
    $("#view").innerHTML = html;
    lastHtml = html;
    for (const [id, v] of keep) { const x = document.getElementById(id); if (x && id !== "here") x.value = v; }
    if (focus) document.getElementById(focus)?.focus();
  }
  const f = frame(s);
  if (f !== shown) { shown = f; sc.show(f, { flash: true }); }
  cable(cableFor(s));
  const v = viewFor(s);
  if (v !== viewNow) { viewNow = v; look(VIEW[v]); }
  $("#hold").hidden = !holdHint(s);
  renderFloat(s);
}

function onClick(e) {
  const p = e.target.closest("[data-pick]");
  if (p && S.test.state !== "run") {
    sel[p.dataset.pick] = p.dataset.ssid;
    if (S.test.state === "fail") S.test = { state: "idle", ssid: "", error: "" };
    const f = document.getElementById(`pw-${p.dataset.pick}`);
    if (f) f.value = ""; // another network: not the last one's password
    lastHtml = ""; render();
    document.getElementById(`pw-${p.dataset.pick}`)?.focus();
    return;
  }
  const b = e.target.closest("[data-do]");
  if (!b) return;
  const a = b.dataset.do;
  if (a === "test") {
    const which = b.dataset.which, ssid = sel[which], pw = document.getElementById(`pw-${which}`)?.value ?? "";
    if (pw) typeOwn.add(ssid);
    act("test", { ssid, psk: pw });
  } else if (a === "pw-help") {
    pwHelp = true; // on a Mac the link also opens Wi-Fi settings (Chrome asks first); the guide shows where to click
    if (isMac && "documentPictureInPicture" in window) { e.preventDefault(); float(); } // Settings is the window's step 1
    setTimeout(() => { lastHtml = ""; render(); }, 300);
    return;
  } else if (a === "back") {
    unfloat(); window.focus();
  } else if (a === "float") {
    float();
  } else if (a === "open-settings") {
    // window.open: a floating window that follows a link itself closes, and a frame isn't allowed to open an app
    b.ownerDocument.defaultView.open(WIFI_SETTINGS);
  } else if (a === "help-tab") {
    helpOn = b.dataset.tab; lastHtml = ""; render();
  } else if (a === "help-close") {
    pwHelp = false; lastHtml = ""; render();
  } else if (a === "type-own") {
    typeOwn.add(b.dataset.ssid);
    lastHtml = ""; render();
    document.querySelector("#view .pw")?.focus();
  } else if (a === "home") { // the app takes a moment to answer: the button says it's on its way
    if (e.metaKey || e.ctrlKey || e.shiftKey) return; // a new tab or window: the link as usual
    e.preventDefault();
    S.leaving = true; render();
    location.href = b.getAttribute("href");
  } else if (a === "account-ok") { // busy in the click itself: the claim can take a moment
    S.signin.going = true; render(); act(a);
  } else if (a === "signin") signinPopup();
  else if (a === "relink") {
    const w = signinPopup(window.open("about:blank", "pb-signin", "popup,width=480,height=720")); // opened during the click
    S.signin = { checked: true, done: false, email: "" }; render();
    fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })
      .finally(() => { if (w) w.location.href = "/setup/signed-in"; });
  } else if (a === "copy") {
    navigator.clipboard?.writeText(location.href).then(() => { b.textContent = "Copied"; });
  } else if (a === "share") {
    navigator.share({ url: location.href }).catch(() => {}); // closing the share sheet is not an error
  } else act(a);
}
function onKey(e) {
  if (e.key !== "Enter") return;
  if (e.target.id === "pw-float") {
    if (e.target.value && sel.wifi && S.test.state !== "run") { typeOwn.add(sel.wifi); act("test", { ssid: sel.wifi, psk: e.target.value }); }
  } else if (e.target.matches?.(".pw")) document.querySelector('[data-do="test"]')?.click();
}
function wire(d) {
  d.addEventListener("click", onClick);
  d.addEventListener("keydown", onKey);
  d.addEventListener("paste", onPaste);
}
wire(document);

render();
main();
