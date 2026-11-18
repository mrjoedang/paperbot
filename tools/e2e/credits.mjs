// Prepaid credit end to end on dev, with Stripe in test mode (the sandbox): a guest past the free allowance is refused,
// pays CA$10 with Stripe's test card in a headless Checkout, the webhook adds the credit, a memo and a research memo are
// paid from it, a refund takes it back, a forged webhook is refused. Real router/answer/research calls: about $0.10.
//
//   node tools/e2e/credits.mjs     # needs: the Stripe CLI logged in to the sandbox (stripe login), server/.secrets DEV_TOKEN
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const B = "https://dev.paperbot.ca";
const DEV = readFileSync(`${ROOT}/server/.secrets`, "utf8").match(/^DEV_TOKEN=(.+)$/m)[1].trim();
const stripe = (...a) => JSON.parse(execFileSync("stripe", a, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).replace(/^[^{]*/, ""));
const say = (...a) => console.log(...a);
const sleep = (ms) => new Promise((f) => setTimeout(f, ms));
const wav = (s) => {
  const n = Math.round(s * 16000), b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(8000 * Math.sin((2 * Math.PI * 220 * i) / 16000)), 44 + i * 2); // a tone: passes the silence gate
  return b;
};
let cookie = "";
const web = async (path, init = {}) => {
  const r = await fetch(B + path, { ...init, headers: { origin: B, cookie, ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...init.headers } });
  for (const c of r.headers.getSetCookie?.() ?? []) cookie = [cookie, c.split(";")[0]].filter(Boolean).join("; ");
  return r;
};
const t = Date.now();
await web("/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email: `credit-${t}@t${t}.test`, password: crypto.randomUUID(), name: "Credit" }) });
const box = `u:${(await (await web("/api/auth/get-session")).json()).user.id}`;
const tok = (await (await web("/v1/setup/claim", { method: "POST", body: JSON.stringify({ device: "5100c0ffee06" }) })).json()).token;
const me = async () => (await web("/api/me")).json();
const credit = async () => (await me()).usage.credit_usd;
let n = 0;
async function memo(text, polls = 30) {
  const id = `5100c0ffee06-${String(++n).padStart(6, "0")}-${t.toString(16).slice(-8)}`;
  const r = await fetch(`${B}/v1/recordings/${id}`, { method: "PUT", body: wav(1.5), headers: { authorization: `Bearer ${tok}`, "content-type": "audio/wav", "x-test-text": text } });
  let j = await r.json();
  for (let i = 0; i < polls && ["processing", "researching"].includes(j.status); i++) { await sleep(2000); j = await (await web(`/api/tasks/${id}`)).json(); }
  return `${j.status}${j.kind ? "/" + j.kind : ""}${j.error ? ` "${j.error}"` : ""}${j.agent_cost ? ` cost $${j.agent_cost}` : ""}`;
}
try {
  await fetch(`${B}/admin/test/record?inbox=${encodeURIComponent(box)}`, { method: "POST", headers: { authorization: `Bearer ${DEV}`, "content-type": "application/json" },
    body: JSON.stringify({ id: "credits-spent", kind: "answer", title: "spent", status: "done", agent_cost: 0.6, received_at: Date.now() - 60_000 }) });
  const m0 = await me();
  say(`1. free allowance used up: $${m0.usage.house_usd_24h} of $${m0.usage.house_cap_usd}; can_buy=${m0.can_buy}`);
  say(`2. memo:                   ${await memo("what is the weather in Calgary right now")}`);
  let r = await web("/api/credits/checkout", { method: "POST", headers: { "x-test-country": "DE" } });
  say(`3. checkout from Germany:  ${r.status} ${(await r.json()).error}`);
  r = await web("/api/credits/checkout", { method: "POST" });
  const { url } = await r.json();
  say(`4. checkout:               ${r.status} ${url?.slice(0, 34)}…`);
  const browser = await chromium.launch({ executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await sleep(7000);
  const f = page.frames().find((x) => /elements-inner-habanero/.test(x.url())) ?? page.frames().find((x) => /elements-inner/.test(x.url()));
  if (!(await f.locator('input[name="number"]').count())) await f.getByText("Card", { exact: true }).first().click(); // card folded among other methods
  await f.waitForSelector('input[name="number"]');
  await f.fill('input[name="number"]', "4242424242424242");
  await f.fill('input[name="expiry"]', "12 / 34");
  await f.fill('input[name="cvc"]', "123");
  await f.fill('input[name="name"]', "Test Person");
  await f.selectOption('select[name="country"]', "CA").catch(() => {});
  await sleep(800);
  if (await f.locator('input[name="postalCode"]').count()) await f.fill('input[name="postalCode"]', "T2P 1J9");
  await page.screenshot({ path: `${ROOT}/build/credits-checkout.png`, fullPage: true });
  let paid = false; // the Pay button: in the page or in Stripe's payment frame; exactly "Pay", not "Apple Pay"
  for (const fr of [page, ...page.frames()]) { const b = fr.getByRole("button", { name: "Pay", exact: true }); if (await b.count()) { await b.first().click(); paid = true; break; } }
  if (!paid) throw new Error("no Pay button (build/credits-checkout.png)");
  await page.waitForURL((u) => u.toString().startsWith(B), { timeout: 60000 }).catch(() => {});
  say(`5. paid, back at:          ${new URL(page.url()).origin}${new URL(page.url()).search}`);
  await browser.close();
  let c = 0;
  for (let i = 0; i < 30 && c <= 0; i++) { c = await credit(); if (c <= 0) await sleep(1000); }
  say(`6. credit (webhook):       $${c}`);
  say(`7. memo:                   ${await memo("what is the weather in Calgary right now")}; credit $${await credit()}`);
  say(`8. research memo:          ${await memo("research the best small e-paper displays for a DIY gadget and compare two of them", 90)}; credit $${await credit()}`);
  const s = stripe("checkout", "sessions", "list", "--limit", "5").data.find((x) => x.metadata?.inbox === box);
  stripe("refunds", "create", "--payment-intent", s.payment_intent);
  let c2 = c;
  for (let i = 0; i < 30; i++) { c2 = await credit(); if (c2 < c - 5) break; await sleep(1000); }
  say(`9. refunded CA$10:         credit $${c2}`);
  say(`10. memo:                  ${await memo("what is the weather in Calgary right now")}`);
  r = await fetch(`${B}/api/stripe/webhook`, { method: "POST", headers: { "stripe-signature": `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}` },
    body: JSON.stringify({ type: "checkout.session.completed", data: { object: { payment_status: "paid", amount_total: 100000, metadata: { inbox: box }, id: "cs_forged" } } }) });
  say(`11. forged webhook:        ${r.status} ${await r.text()}; credit $${await credit()}`);
} finally {
  say(`(test account deleted: ${(await web("/api/account", { method: "DELETE" })).status})`);
}
