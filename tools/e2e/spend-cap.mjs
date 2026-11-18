// The daily cap on what paperbot pays to route and answer one guest's memos (house_cap_usd, server/src/inbox.ts), on
// dev: real router and web-search answers (about $0.02 each, so a run costs about $0.50 on paperbot-dev's gateway).
// Then an API key (a dev "sk-ant-test-" key) raises the limits 4x. Prints requests and replies; tokens never printed.
//
//   node tools/e2e/spend-cap.mjs --server https://dev.paperbot.ca
const args = process.argv.slice(2);
const B = (args.includes("--server") ? args[args.indexOf("--server") + 1] : "https://dev.paperbot.ca").replace(/\/$/, "");
if (!/^https:\/\/dev\.paperbot\.ca$/.test(B)) { console.error("dev only (it needs the AI binding)."); process.exit(2); }
const say = (s) => console.log(s);
const wav = (seconds) => {
  const n = Math.round(seconds * 16000), b = Buffer.alloc(44 + n * 2);
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
let r = await web("/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email: `spend-${t}@t${t}.test`, password: crypto.randomUUID(), name: "Spend" }) });
if (!r.ok) { console.error(`sign-up ${r.status}`); process.exit(1); }
const tok = (await (await web("/v1/setup/claim", { method: "POST", body: JSON.stringify({ device: "5100c0ffee03" }) })).json()).token;
const usage = async () => (await (await web("/api/me")).json()).usage;
const u0 = await usage();
say(`guest account: ${JSON.stringify(u0)}`);
const seq = (() => { let n = 0; return () => `5100c0ffee03-${String(++n).padStart(6, "0")}-${t.toString(16).slice(-8)}`; })();
const QUESTIONS = ["what is the weather in Calgary right now", "what is the price of bitcoin today", "who won the last NHL game",
  "what is the latest news about SpaceX", "what is the exchange rate from Canadian to US dollars today"];

async function memo(text) {
  const id = seq();
  const res = await fetch(`${B}/v1/recordings/${id}`, { method: "PUT", body: wav(1.5), headers: { authorization: `Bearer ${tok}`, "content-type": "audio/wav", "x-pv-fw": "1.2.0", "x-test-text": text } });
  const first = await res.json();
  for (let i = 0; i < 80 && first.status === "processing"; i++) {
    const rec = await (await web(`/api/tasks/${id}`)).json();
    if (rec.status !== "processing") return { put: res.status, rec };
    await new Promise((f) => setTimeout(f, 500));
  }
  return { put: res.status, rec: first.status === "processing" ? await (await web(`/api/tasks/${id}`)).json() : first };
}

say("\n## Web answers until the daily cap");
let refused = null;
for (let i = 1; i <= 150 && !refused; i += 6) { // six at a time
  const batch = await Promise.all([0, 1, 2, 3, 4, 5].map((k) => memo(QUESTIONS[(i + k) % QUESTIONS.length])));
  const u = await usage();
  batch.forEach(({ put, rec }, k) => say(`> PUT #${i + k} "${QUESTIONS[(i + k) % QUESTIONS.length]}"  < ${put} ${rec.status}${rec.kind ? `/${rec.kind}` : ""}${rec.error ? ` "${rec.error}: ${rec.detail ?? ""}"` : ""}`));
  say(`  house $${u.house_usd_24h} of $${u.house_cap_usd}`);
  refused = batch.find(({ rec }) => rec.error === "daily limit")?.rec ?? null;
}
say(refused ? "\nrefused once over the cap" : "\nNEVER refused");

say("\n## An API key raises the limits");
r = await web("/api/research", { method: "POST", body: JSON.stringify({ provider: "anthropic", key: `sk-ant-test-${crypto.randomUUID().replace(/-/g, "")}` }) });
say(`> POST /api/research (dev test key)  < ${r.status}`);
say(`usage: ${JSON.stringify(await usage())}`);
const { put, rec } = await memo("what time is it in Tokyo");
say(`> PUT after the key  < ${put} ${rec.status}${rec.kind ? `/${rec.kind}` : ""}${rec.error ? ` "${rec.error}"` : ""}`);

r = await web("/api/account", { method: "DELETE" });
say(`\n(test account deleted: ${r.status})`);
