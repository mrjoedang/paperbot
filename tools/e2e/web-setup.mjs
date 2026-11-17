// /setup (the setup in the browser, over Web Serial) end to end on the plugged-in board, as a new person: Chrome opens
// <server>/setup, connects (the port picker needs a person the first time for each server address; later runs reuse the
// grant kept in the profile), installs the release image if the board's is older, signs up in the sign-in popup
// (email + password: TEST_HOOKS servers only), proves a wrong Wi-Fi password is named and the right one works, waits for the check-in, and (unless --no-memo) the first memo: hold ☀ when the log says so; then the app.
// Screenshots: build/e2e/web-setup-*.png.
//
//   node tools/e2e/web-setup.mjs --server https://<tunnel or dev> [--no-memo] [--profile build/web-setup-profile]
// Wi-Fi: WIZ_SSID + WIZ_PSK. The password is never printed.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const flag = (k) => process.argv.includes(k);
const SERVER = (arg("--server") || "").replace(/\/$/, "");
if (!SERVER) { console.error("--server URL"); process.exit(2); }
if (/^https:\/\/(app\.)?(pocketbot|paperbot)\.ca/.test(SERVER)) { console.error("not against production"); process.exit(2); }
const OUT = "build/e2e";
mkdirSync(OUT, { recursive: true });
const SSID = process.env.WIZ_SSID || "TELUS6946";
let PSK = process.env.WIZ_PSK || "";
if (!PSK) { console.error(`no password for ${SSID}: WIZ_PSK`); process.exit(2); }

const results = [], t0 = Date.now();
const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
const step = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "✓" : "✗"} [${secs()}s] ${name}${detail ? `  (${detail})` : ""}`); };
const log = (m) => console.log(`  … [${secs()}s] ${m}`);
const notify = (m) => { try { execFileSync("terminal-notifier", ["-title", "paperbot test", "-message", m, "-sound", "default"]); } catch {} };

const ctx = await chromium.launchPersistentContext(arg("--profile", "build/web-setup-profile"), {
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: false, viewport: { width: 1280, height: 860 },
});
const page = ctx.pages()[0] || (await ctx.newPage());
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/favicon|blocklist|cloudflareinsights/.test(m.text())) errors.push(m.text()); // the zone injects Web Analytics; CSP blocks it });
const h1 = () => page.textContent("#view h1").catch(() => "");
async function waitH1(re, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (re.test(await h1())) return; await page.waitForTimeout(300); }
  throw new Error(`timed out waiting for ${what} (page says "${await h1()}")`);
}
const shot = (n) => page.screenshot({ path: `${OUT}/web-setup-${n}.png` });

try {
  await page.goto(`${SERVER}/login`);
  await page.evaluate(() => fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })); // a new person
  await page.goto(`${SERVER}/setup`);
  await page.waitForSelector("#view h1");
  await shot("0-start");
  if (/Plug it in/.test(await h1())) {
    step("asks to plug in, with a Connect button", !!(await page.$('[data-do="connect"]')));
    page.click('[data-do="connect"]').catch(() => {});
    log("CLICK THE BOARD IN CHROME'S PORT PICKER");
    notify("Pick the board in Chrome's port picker");
    await waitH1(/Connecting|Installing|Make it yours|Signed in/, 300_000, "the port picker");
  } else log("this site may use the board already: no picker");
  const tc = Date.now();
  await waitH1(/Installing|Make it yours|Signed in/, 90_000, "the board");
  step("connects to the board, then asks to sign in (any install runs behind it)", /Make it yours/.test(await h1()), `${((Date.now() - tc) / 1000).toFixed(1)} s`);
  await shot("1-install");

  // ---- sign in: the popup, while it installs
  await page.waitForSelector('[data-do="signin"]', { timeout: 30_000 });
  const [pop] = await Promise.all([ctx.waitForEvent("page"), page.click('[data-do="signin"]')]);
  await pop.waitForURL(/\/login\?next=%2Fsetup%2Fsigned-in/, { timeout: 15_000 });
  step("Sign in opens a popup on /login (the setup page keeps its board connection)", true);
  await pop.click("#test-login summary");
  await pop.fill('input[name="email"]', `web-setup-${Date.now()}@example.com`);
  await pop.fill('input[name="password"]', crypto.randomUUID());
  await pop.fill('input[name="name"]', "Web Setup Person");
  const closed = pop.waitForEvent("close", { timeout: 30_000 }).then(() => true, () => false);
  await pop.click("#signup");
  step("after sign-up the popup closes itself", await closed);
  await page.waitForFunction(() => /Signed in as/.test(document.querySelector("#view").textContent), null, { timeout: 15_000 });
  step("the setup page shows who is signed in", true);
  const pct = await page.$eval(".track i", (e) => e.style.width).catch(() => "");
  log(pct ? `still installing after sign-in: ${pct}` : `after sign-in: ${await h1()}`);

  // ---- Wi-Fi
  const tw = Date.now();
  await waitH1(/Choose your Wi-Fi/, 240_000, "install + claim");
  step("installed, claimed, Wi-Fi step", true, `${((Date.now() - tw) / 1000).toFixed(1)} s after sign-in`);
  await page.waitForSelector(".net", { timeout: 60_000 });
  const names = await page.$$eval(".net .name", (a) => a.map((x) => x.textContent));
  step("the board's own scan is listed", names.includes(SSID), `${names.length} networks`);
  await shot("2-wifi");
  await page.click(`.net[data-ssid="${SSID}"]`);
  await page.fill("#pw-wifi", "definitely-wrong-1");
  await page.click('[data-do="test"]');
  await page.waitForFunction(() => /Wrong password/.test(document.querySelector("#view").textContent), null, { timeout: 90_000 });
  step("a wrong password is named", true);
  await shot("3-wrong");
  await page.fill("#pw-wifi", PSK);
  await page.click('[data-do="test"]');
  await waitH1(/Connected/, 90_000, "the right password");
  step("the right password: Connected", true);
  await page.click('[data-do="next"]');

  // ---- check-in, first memo
  const to = Date.now();
  await waitH1(/Hold ☀|It works/, 120_000, "the check-in");
  step("online (check-in)", true, `${((Date.now() - to) / 1000).toFixed(1)} s`);
  await shot("5-try");
  step("the ☀ button is marked on the 3D board", await page.$eval("#hold", (e) => !e.hidden));
  const html = await page.content();
  step("no board token in the page", !/pb_d_/.test(html));
  step("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  if (flag("--no-memo")) await page.click('[data-do="next"]'); // Skip: straight to the app
  else {
    log("HOLD ☀ AND SAY: remind me to call the dentist on the 18th at 9");
    notify("Hold ☀ and say: remind me to call the dentist on the 18th at 9");
    await waitH1(/It works/, 180_000, "the first memo");
    step("the first memo shows on the page", true, await page.textContent("#view .sub").catch(() => ""));
    await shot("6-memo");
    await page.click('a.btn[href="/"]'); // Continue
  }
  await page.waitForURL((u) => u.pathname === "/", { timeout: 30_000 });
  step("ends in the app", true);
} catch (e) {
  step(String(e.message || e), false);
  await shot("x-failed").catch(() => {});
}
await ctx.close();
const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed in ${secs()} s`);
process.exit(bad.length ? 1 : 0);
