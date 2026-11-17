// The web app screenshot on paperbot.ca (site/assets/img/app-list-phone-v2.webp; a new name when it changes, site/_headers
// caches images a day): the List tab on a phone, its items read from an OpenBelt workspace (a local one: `bun run dev` in an
// OpenBelt checkout).
//
//   sh tools/local-worker.sh --var OPENBELT_URL:<workspace URL> &   # http://127.0.0.1:8787 (or --server <a TEST_HOOKS deployment>)
//   OPENBELT_TOKEN_FILE=<file with the dev server's token> make site-shots ARGS="--openbelt <workspace URL>"
//
// It makes a throwaway account, links it to the workspace (via /admin/test/openbelt, owner token), shoots, and deletes the account.
// Needs cwebp (brew install webp).
import { chromium } from "playwright-core";
import { mcpClient, openbeltArgs, seedList } from "./openbelt.mjs";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const OUT = `${ROOT}/site/assets/img`;
const TMP = `${ROOT}/build/site-shots`;
const args = process.argv.slice(2);
const i = args.indexOf("--server");
const B = (i >= 0 ? args[i + 1] : process.env.SHOTS_SERVER ?? "http://127.0.0.1:8787").replace(/\/$/, "");
if (/^https:\/\/((www|app)\.)?(pocketbot|paperbot)\.ca$|^https:\/\/(pocketbot|paperbot)\.mrjoedang\.workers\.dev$/.test(B)) { console.error("Not against production."); process.exit(2); }
const OB = openbeltArgs(args);
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// The size of each image is set by the page (site/index.html width/height): keep them the same.
const SHOTS = [
  { file: "app-list-phone-v2", path: "/#list", ready: ".belt-item", viewport: { width: 390, height: 780 }, scale: 2, mobile: true },
];

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

rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
try {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(B + "/login");
  const su = await page.evaluate(async ([e, p]) => (await fetch("/api/auth/sign-up/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: e, password: p, name: "Sam Rivera" }) })).status, [`site-shots-${Date.now()}@example.com`, crypto.randomUUID()]);
  if (su !== 200) throw new Error(`sign-up ${su} (is TEST_HOOKS on? local: POST /admin/auth-migrate once)`);
  const uid = await page.evaluate(async () => (await (await fetch("/api/auth/get-session")).json()).user.id);
  const box = `u:${uid}`;
  await page.goto(B + "/"); // creates the account
  await page.waitForTimeout(800);
  const state = await ctx.storageState();

  // a fixed afternoon, so "Today" and the times read the same whenever this runs (the page's clock is set to it too)
  const min = 60_000, day = 86_400_000;
  const now = new Date().setHours(14, 30, 0, 0);
  const tomorrow = new Date(now + day); tomorrow.setHours(16, 30, 0, 0);
  const local = (d) => new Date(d.getTime() - d.getTimezoneOffset() * min).toISOString().slice(0, 16);
  await seedList(mcpClient(OB.url, OB.token, "site-shots"), ROOT, [
    ["site-plants", "reminder", "Water the plants", local(tomorrow), false], ["site-haircut", "todo", "Book a haircut", null, false],
    ["site-coffee", "shopping", "Coffee beans", null, false], ["site-oat", "shopping", "Oat milk", null, false],
    ["site-note", "note", "Start the day with a walk", null, false], ["site-bank", "todo", "Call the bank", null, true],
  ]);
  await admin("/admin/test/openbelt", box, { token: OB.token, workspace: "site" });

  for (const s of SHOTS) {
    const c = await browser.newContext({ viewport: s.viewport, deviceScaleFactor: s.scale, isMobile: !!s.mobile, hasTouch: !!s.mobile, colorScheme: "light", reducedMotion: "reduce", storageState: state });
    await c.clock.setFixedTime(now);
    const p = await c.newPage();
    await p.goto(B + s.path, { waitUntil: "networkidle" });
    await p.waitForSelector(s.ready);
    await p.evaluate(() => document.fonts.ready);
    await p.waitForTimeout(400);
    await p.screenshot({ path: `${TMP}/${s.file}.png` });
    execFileSync("cwebp", ["-quiet", "-q", "82", `${TMP}/${s.file}.png`, "-o", `${OUT}/${s.file}.webp`]);
    console.log(`site/assets/img/${s.file}.webp`);
    await c.close();
  }
  await page.evaluate(async () => fetch("/api/account", { method: "DELETE" }));
  await ctx.close();
} finally {
  await browser.close();
}
