// A new person's whole journey on a deployment with TEST_HOOKS (default https://dev.paperbot.ca):
//   sign up -> first-visit setup card -> passkey -> /setup on a fresh simulated board (its serial console bridged to
//   the page's navigator.serial)
//   -> a recording lands in their inbox -> a work memo waits for their assistant -> real Claude Code connects
//   with OAuth and delivers the research -> the board shows it -> their own API key runs the next work memo
//   (a fake key, so it must fail with Anthropic's "invalid key", never succeed on the owner's billing)
//   -> disconnect the assistant, remove the board, delete the account.
// Isolated headless Chrome (virtual passkey authenticator): nothing touches your own browser or Claude Code config
// (the connector is added with --scope local in build/e2e/cc). Uses your `claude` CLI for one Haiku call.
//
//   make sim                       # once, builds build/sim/pvsim (or: make sim-test)
//   cd tools/e2e && npm install && node accounts.mjs [--server https://dev.paperbot.ca] [--keep]
//
// Results: build/e2e/results.json. Exit 1 if any step failed.
import { chromium } from "playwright-core";
import { execFile, spawn } from "node:child_process";
import { createReadStream, existsSync, openSync, readFileSync, rmSync, writeFileSync, writeSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const B = (arg("--server") ?? process.env.E2E_SERVER ?? "https://dev.paperbot.ca").replace(/\/$/, "");
if (/^https:\/\/((www|app)\.)?(pocketbot|paperbot)\.ca$|^https:\/\/(pocketbot|paperbot)\.mrjoedang\.workers\.dev$/.test(B)) { console.error("Not against production."); process.exit(2); }
const KEEP = process.argv.includes("--keep");
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const W = `${ROOT}/build/e2e`, CC = `${W}/cc`, SIMDIR = `${W}/sim`, PTY = `${W}/serial`;
const PVSIM = `${ROOT}/build/sim/pvsim`;
const SIM_PORT = 8093, CONNECTOR = "pbe2e";
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
for (const [p, how] of [[PVSIM, "make sim-test"], [CHROME, "install Google Chrome or set CHROME"]])
  if (!existsSync(p)) { console.error(`missing ${p} (${how})`); process.exit(2); }

const results = [];
const step = (name, ok, detail = "") => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `  ${detail}` : ""}`); return ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms, every = 1000) => { const end = Date.now() + ms; let v; while (!(v = await f()) && Date.now() < end) await sleep(every); return v; };
const simSet = (key, value) => fetch(`http://localhost:${SIM_PORT}/api/set`, { method: "POST", body: new URLSearchParams({ key, value }) });
const simLog = () => (existsSync(`${SIMDIR}/sim.log`) ? readFileSync(`${SIMDIR}/sim.log`, "utf8") : "");
const record = async (wav, ms) => { await simSet("audio", `file:${ROOT}/server/test/wav/${wav}`); await simSet("cmd", `sim ${ms}`); };
const boardGet = (token, path = "/v1/wifi") => fetch(B + path, { headers: { authorization: `Bearer ${token}` } }).then((r) => r.status);

let sim, cleaned = false;
// Everything a run leaves behind (a simulator on SIM_PORT, the test connector in Claude Code): on every exit path,
// and at the start in case an earlier run was killed.
const cleanup = async () => {
  if (cleaned) return; cleaned = true;
  sim?.kill();
  await run("pkill", ["-f", `pvsim --serve --port ${SIM_PORT}`]).catch(() => {});
  if (existsSync(CC)) await run("claude", ["mcp", "remove", "--scope", "local", CONNECTOR], { cwd: CC }).catch(() => {});
};
setTimeout(async () => { console.log("FAIL watchdog: the run took over 15 minutes"); await cleanup(); process.exit(1); }, 15 * 60_000).unref();
await run("pkill", ["-f", `pvsim --serve --port ${SIM_PORT}`]).catch(() => {});
if (existsSync(CC)) await run("claude", ["mcp", "remove", "--scope", "local", CONNECTOR], { cwd: CC }).catch(() => {});
rmSync(W, { recursive: true, force: true });
mkdirSync(CC, { recursive: true });
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.on("dialog", (d) => d.accept(d.type() === "prompt" ? "DELETE" : undefined)); // confirm() and the delete prompt
const cdp = await ctx.newCDPSession(page);
await cdp.send("WebAuthn.enable");
await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
const api = (path, method = "GET") => page.evaluate(async ([p, m]) => { const r = await fetch(p, { method: m }); return { status: r.status, body: await r.json().catch(() => null) }; }, [path, method]);
const records = async () => (await api("/api/snapshot")).body?.records ?? [];

let email, token;
try {
  // ---- 1. sign up (dev: email + password; the password is random and never printed) ----
  email = `e2e-${Date.now()}@example.com`;
  await page.goto(B + "/");
  step("signed out: / redirects to sign-in", page.url().startsWith(B + "/login"), page.url().replace(B, ""));
  await page.click("#test-login summary");
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', crypto.randomUUID());
  await page.fill('input[name="name"]', "E2E Person");
  await page.click("#signup");
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15_000 });
  step("sign-up lands in the web app", new URL(page.url()).pathname === "/", page.url().replace(B, ""));
  const card = await page.waitForSelector(".setup-card", { timeout: 15_000 }).then(() => true).catch(() => false);
  step("first visit shows the setup card, linking to /setup", card && !!(await page.$('.setup-card a[href="/setup"]')));
  const me = (await api("/api/me")).body;
  step("Better Auth's own delete-user endpoint is off (deleting goes through /api/account)",
    (await page.evaluate(async () => (await fetch("/api/auth/delete-user", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status)) === 404);
  await page.goto(B + "/login?next=/%5Cexample.com");
  await page.click("#continue");
  await page.waitForLoadState().catch(() => {});
  step("sign-in never redirects to another site (next=/\\example.com)", page.url().startsWith(B), page.url());
  step("new account: own inbox, research waits for their assistant, 30 min audio a day", me?.email === email && !me.owner && me.research?.mode === "assistant" && me.usage?.audio_cap_min === 30, JSON.stringify(me));

  // ---- 2. passkey: add, sign out, sign in with only the passkey ----
  await page.goto(B + "/login");
  await page.click("#add-passkey");
  await page.waitForSelector("#msg:has-text('Passkey added')", { timeout: 10_000 }).catch(() => {});
  step("passkey added", (await page.textContent("#msg"))?.includes("Passkey added"), await page.textContent("#msg"));
  await page.evaluate(() => fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }));
  await page.goto(B + "/login");
  await page.click("#passkey", { timeout: 15_000 });
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15_000 }).catch(() => {});
  const who = await page.evaluate(async () => (await (await fetch("/api/auth/get-session")).json())?.user?.email);
  step("signed back in with only the passkey", who === email, who ?? "no session");

  // ---- 3. a fresh board (release image, no secrets) set up on /setup ----
  // The simulator's console is a pty; the page's navigator.serial is replaced by a port whose bytes go to and from it
  // (Chrome can't open a pty). Same firmware version as the server's release image, so nothing is flashed.
  const fw = (await (await fetch(`${B}/v1/setup/firmware/manifest.json`)).json()).version;
  sim = spawn(PVSIM, ["--serve", "--port", String(SIM_PORT), "--generic", "--usb", "--server", B, "--run-dir", SIMDIR, "--fw-version", fw, "--serial-pty", PTY], { stdio: "ignore" });
  await until(() => existsSync(PTY), 10_000, 250);
  const sp = await ctx.newPage();
  const fd = openSync(PTY, "r+");
  let written = "";
  await sp.exposeBinding("__serialWrite", (_s, bytes) => { const b = Buffer.from(bytes); written += b.toString(); writeSync(fd, b); });
  const rx = createReadStream(null, { fd, autoClose: false });
  rx.on("data", (b) => sp.evaluate((x) => window.__serialPush?.(x), [...b]).catch(() => {}));
  await sp.addInitScript(() => {
    const port = {
      getInfo: () => ({ usbVendorId: 0x303a, usbProductId: 0x1001 }),
      async open() { this.readable = new ReadableStream({ start: (c) => { window.__serialPush = (b) => { try { c.enqueue(new Uint8Array(b)); } catch {} }; } });
        this.writable = new WritableStream({ write: (chunk) => window.__serialWrite([...chunk]) }); },
      async close() { window.__serialPush = null; }, async setSignals() {},
    };
    Object.defineProperty(Navigator.prototype, "serial", { configurable: true, get: () => ({ getPorts: async () => [port], requestPort: async () => port, addEventListener() {} }) });
  });
  await sp.goto(B + "/setup");
  const h1 = (re, ms) => sp.waitForFunction((src) => new RegExp(src).test(document.querySelector("#view h1")?.textContent || ""), re.source, { timeout: ms });
  const asked = await h1(/Use this account\?/, 90_000).then(() => true, () => false);
  step("/setup finds the board, already signed in: no install, asks to use this account", asked, await sp.textContent("#view h1").catch(() => ""));
  if (asked) await sp.click('[data-do="account-ok"]');
  const atWifi = await h1(/Choose your Wi-Fi/, 90_000).then(() => true, () => false);
  step("Continue: the board is this account's, on to Wi-Fi", atWifi, await sp.textContent("#view h1").catch(() => ""));
  await sp.click('.net[data-ssid="PV-Home"]');
  await sp.evaluate(() => { const dt = new DataTransfer(); dt.setData("text/plain", "home-secret-1");
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })); }); // pasting connects
  step("pasting the Wi-Fi password connects the board", await h1(/Connected/, 90_000).then(() => true, () => false));
  await sp.click('[data-do="next"]');
  step("the board checks in; the page asks for the first memo", await h1(/Hold/, 90_000).then(() => true, () => false));
  token = written.match(/prov token (pb_d_[A-Za-z0-9_-]+)/)?.[1];
  step("the page claimed a board token for this person and wrote it to the board", !!token);
  await sp.close(); rx.on("error", () => {}); rx.destroy(); // the stream closes the pty fd
  const boards = (await api("/api/boards")).body ?? [];
  step("Connections lists the board, online", boards.length === 1 && boards[0].seen_at, JSON.stringify(boards.map((b) => [b.device, !!b.seen_at, b.fw])));

  // ---- 4. a recording lands in this person's inbox ----
  await record("tts-2.wav", 4000);
  const shown = await until(() => simLog().match(/UI,screen=RESULT,title=([^,]+)/), 45_000);
  step("board records and shows the result", shown, shown?.[1]);
  const recs = await records();
  step("memo is in this person's inbox", recs.length === 1, JSON.stringify(recs.map((x) => [x.kind, x.title])));
  await page.goto(B + "/");
  step("setup card is gone once there's a board and a memo", !(await page.waitForSelector(".setup-card", { timeout: 3000 }).catch(() => null)));
  step("audio usage counts the clip", ((await api("/api/me")).body?.usage?.audio_seconds_24h ?? 0) > 0);

  // ---- 5. a work memo waits for their assistant ----
  await record("tts-8.wav", 6000);
  const work = await until(async () => (await records()).find((x) => x.kind === "research" && x.agent_state === "external"), 60_000);
  step("research memo waits for the assistant (no research on paperbot's account)", work, work ? work.title : JSON.stringify((await records()).map((x) => [x.kind, x.status, x.agent_state])));

  // ---- 6. Claude Code connects with OAuth (discovery, registration, PKCE, consent) ----
  await run("claude", ["mcp", "add", "--scope", "local", "--transport", "http", CONNECTOR, `${B}/v1/mcp`], { cwd: CC });
  const login = spawn("python3", [`${ROOT}/tools/e2e/claude-login.py`, CONNECTOR, CC], { cwd: CC, stdio: "ignore" });
  await until(() => existsSync(`${CC}/url.txt`), 30_000, 500);
  let authUrl = existsSync(`${CC}/url.txt`) ? readFileSync(`${CC}/url.txt`, "utf8") : "";
  const cut = authUrl.indexOf("https://", 8); if (cut > 0) authUrl = authUrl.slice(0, cut);
  step("Claude Code discovers the server and registers itself", authUrl.startsWith(`${B}/api/auth/oauth2/authorize`), authUrl ? new URL(authUrl).searchParams.get("redirect_uri") : "no URL");
  await page.goto(authUrl);
  await page.waitForSelector("#allow", { timeout: 10_000 });
  await page.click("#allow");
  await page.waitForURL(/localhost:\d+\/callback/, { timeout: 15_000 }).catch(() => {});
  const ok = await until(() => /Authenticated with/.test(existsSync(`${CC}/login.log`) ? readFileSync(`${CC}/login.log`, "utf8") : ""), 15_000, 500);
  step("person allows it on the consent page; Claude Code is connected", ok);
  login.kill();
  await page.goto(B + "/"); // the browser is on Claude Code's localhost callback page
  const asst = (await api("/api/assistants")).body ?? [];
  step("Connections lists the assistant", asst.length === 1, JSON.stringify(asst.map((a) => a.name)));

  // ---- 7. Claude Code researches the memo; the board shows the answer ----
  const prompt = `Use the ${CONNECTOR} tools: call list_memos with research_needed=true, take the first memo, read it with get_memo, then call complete_research for it with a summary under 60 characters and a 2-sentence report from your own knowledge (no web). Reply DONE when finished.`;
  const cc = await run("claude", ["-p", prompt, "--model", "claude-haiku-5-5", "--allowedTools", `mcp__${CONNECTOR}__list_memos,mcp__${CONNECTOR}__get_memo,mcp__${CONNECTOR}__complete_research`], { cwd: CC, timeout: 240_000 }).catch((e) => e);
  step("Claude Code ran the tools", /DONE/.test(cc.stdout ?? ""), (cc.stdout ?? String(cc)).trim().slice(0, 120));
  const done = (await records()).find((x) => x.id === work?.id);
  step("memo is done with the assistant's summary", done?.status === "done" && done.summary, done?.summary);
  await simSet("cmd", "check");
  const wd = await until(() => simLog().match(/UI,screen=(WORK_?DONE|WORKDONE)[^\n]*/i), 30_000);
  step("board shows the research result", wd, wd?.[0].slice(0, 120));

  // ---- 8. their own API key runs the next work memo (fake key: must fail at Anthropic, never fall back) ----
  await page.goto(B + "/#settings");
  await page.waitForSelector("#byok", { timeout: 10_000 });
  await page.fill("#byok", `sk-ant-test-${crypto.randomUUID().replace(/-/g, "")}`);
  const saved = page.waitForResponse((r) => r.url().endsWith("/api/research") && r.request().method() === "POST", { timeout: 15_000 }).catch(() => null);
  await page.click("text=Save and check key");
  const sr = await saved;
  await page.waitForSelector('[data-choice="key"].current', { timeout: 10_000 }).catch(() => {});
  const rs = (await api("/api/research")).body;
  step("Settings saves the key; research mode is the person's key", rs?.mode === "key" && rs.hint?.length === 4,
    `${JSON.stringify(rs)}${rs?.mode === "key" ? "" : ` POST ${sr ? `${sr.status()} ${(await sr.text().catch(() => "")).slice(0, 120)}` : "never sent"}; on screen: ${await page.textContent(".acct-result").catch(() => "-")}`}`);
  if (rs?.mode !== "key") throw new Error("no own key: the next steps would wait for an assistant");
  await record("tts-17.wav", 6000);
  const own = await until(async () => (await records()).find((x) => x.kind === "research" && x.id !== work?.id && ["stopped", "done", "error"].includes(x.status)), 120_000, 2000);
  step("research ran on the person's key and was refused by Anthropic (no fallback to paperbot's billing)",
    own?.status === "stopped" && /401|auth|invalid|key/i.test(`${own.error} ${own.detail}`), own ? `${own.status}: ${own.error} ${String(own.detail ?? "").slice(0, 100)}` : "no result");
  await page.evaluate(() => fetch("/api/research", { method: "DELETE" }));
  step("key removed: back to the assistant", (await api("/api/research")).body?.mode === "assistant");

  // ---- 9. disconnect the assistant, remove the board, delete the account (through the UI) ----
  await page.goto(B + "/#connections/assistants");
  await page.click("text=Disconnect", { timeout: 10_000 });
  await until(async () => ((await api("/api/assistants")).body ?? []).length === 0, 10_000, 500);
  step("assistant disconnected", ((await api("/api/assistants")).body ?? []).length === 0);
  const after = await run("claude", ["mcp", "get", CONNECTOR], { cwd: CC, timeout: 60_000 }).then((x) => x.stdout, (e) => `${e.stdout ?? ""}${e.stderr ?? ""}`);
  step("Claude Code is cut off at once (its access token no longer works)", !/✓ Connected/.test(after), after.match(/Status:[^\n]*/)?.[0] ?? after.slice(0, 120));
  step("board token works before removal", (await boardGet(token)) === 200);
  await page.goto(B + "/#connections/devices");
  await page.click(".acct-item >> text=Remove", { timeout: 10_000 });
  const gone = await until(async () => (await boardGet(token)) === 401, 75_000, 3000); // other isolates cache tokens up to 60 s
  step("removed board's token stops working", gone);
  if (!KEEP) {
    await page.goto(B + "/#settings");
    await page.click("text=Delete account", { timeout: 10_000 });
    await page.waitForURL(/\/login/, { timeout: 15_000 }).catch(() => {});
    const sess = await page.evaluate(async () => (await (await fetch("/api/auth/get-session")).json())?.user?.email ?? null);
    step("account deleted: signed out", !sess && page.url().includes("/login"), page.url().replace(B, ""));
    step("account deleted: web API refuses", (await api("/api/snapshot")).status === 401);
  }
} catch (e) {
  step("unexpected error", false, String(e).slice(0, 400));
  // what the person would have seen: build/e2e/failure.png + the page's text and URL
  try {
    await page.screenshot({ path: `${W}/failure.png`, fullPage: true });
    console.log(`  at ${page.url()}\n  page: ${(await page.evaluate(() => document.body.innerText)).replace(/\s+/g, " ").slice(0, 300)}\n  screenshot: ${W}/failure.png`);
  } catch {}
} finally {
  await browser.close().catch(() => {});
  await cleanup();
  writeFileSync(`${W}/results.json`, JSON.stringify({ server: B, email, results }, null, 1));
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} passed (${W}/results.json)`);
  process.exit(passed === results.length ? 0 : 1);
}
