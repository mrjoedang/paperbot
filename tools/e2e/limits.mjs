// What one free account can make the server do: reprocess the same memo over and over, upload huge or broken files,
// upload past the daily audio cap. Prints each request and the reply (tokens never printed).
//
//   sh tools/local-worker.sh &           # http://127.0.0.1:8787 (TEST_HOOKS: password sign-up)
//   node tools/e2e/limits.mjs            # or --server http://127.0.0.1:<port>
//
// A new guest account (30 audio minutes per 24 h) with a board token. Silent clips are enough: the pipeline sets them
// aside without Whisper, so this needs no AI binding.
const args = process.argv.slice(2);
const B = (args.includes("--server") ? args[args.indexOf("--server") + 1] : "http://127.0.0.1:8787").replace(/\/$/, "");
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$|^https:\/\/dev\.paperbot\.ca$/.test(B)) { console.error("Local Worker or dev only."); process.exit(2); }

const say = (s) => console.log(s);
const silentWav = (seconds) => {
  const data = Math.round(seconds * 16000) * 2, b = Buffer.alloc(44 + data);
  b.write("RIFF", 0); b.writeUInt32LE(36 + data, 4); b.write("WAVE", 8); b.write("fmt ", 12); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(data, 40);
  return b;
};

// ---- a guest account and its board ----
let cookie = "";
const web = async (path, init = {}) => {
  const r = await fetch(B + path, { ...init, headers: { origin: B, cookie, ...(init.body && typeof init.body === "string" ? { "content-type": "application/json" } : {}), ...init.headers } });
  for (const c of r.headers.getSetCookie?.() ?? []) cookie = [cookie, c.split(";")[0]].filter(Boolean).join("; ");
  return r;
};
const t = Date.now();
let r = await web("/api/auth/sign-up/email", { method: "POST", body: JSON.stringify({ email: `limits-${t}@t${t}.test`, password: crypto.randomUUID(), name: "Limits" }) });
if (!r.ok) { console.error(`sign-up ${r.status} (TEST_HOOKS on? local: POST /admin/auth-migrate once)`); process.exit(1); }
const me = await (await web("/api/me")).json();
const tok = (await (await web("/v1/setup/claim", { method: "POST", body: JSON.stringify({ device: "5100c0ffee02" }) })).json()).token;
say(`guest account, audio cap ${me.usage?.audio_cap_min} min / 24 h; board token pb_d_<redacted>`);
const usage = async () => (await (await web("/api/me")).json()).usage.audio_seconds_24h;
const seq = (() => { let n = 0; return () => `5100c0ffee02-${String(++n).padStart(6, "0")}-${t.toString(16).slice(-8)}`; })();

async function put(label, id, body, { chunked = false } = {}) {
  const init = { method: "PUT", headers: { authorization: `Bearer ${tok}`, "content-type": "audio/wav", "x-pv-fw": "1.2.0" } };
  if (chunked) Object.assign(init, { body: new Blob([body]).stream(), duplex: "half" });
  else init.body = body;
  const r = await fetch(`${B}/v1/recordings/${id}`, init);
  say(`> PUT /v1/recordings/${id}  ${label} (${body.length.toLocaleString("en")} bytes${chunked ? ", chunked" : ""})`);
  say(`< ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.status;
}
async function settle(id) {
  for (let i = 0; i < 40; i++) {
    const r = await (await web(`/api/tasks/${id}`)).json();
    if (r.status !== "processing") return r;
    await new Promise((f) => setTimeout(f, 250));
  }
  return (await web(`/api/tasks/${id}`)).json();
}
const stored = async (id) => (await web(`/audio/${id}`)).status === 200 ? "audio kept" : "no audio kept";

// ---- M1: reprocess the same memo ----
say("\n## Reprocess one 5-minute memo, again and again");
const memo = seq();
await put("5 min, silent", memo, silentWav(300));
const m = await settle(memo);
say(`  memo ${m.status}/${m.kind}; usage ${await usage()} s`);
for (let i = 1; i <= 8; i++) {
  const r = await web(`/api/tasks/${memo}/reprocess`, { method: "POST" });
  const b = await r.json();
  say(`> POST /api/tasks/<memo>/reprocess #${i}\n< ${r.status} ${r.status === 202 ? `{"status":"${b.status}"}` : JSON.stringify(b)}; usage ${await usage()} s`);
  await settle(memo);
  if (r.status === 429) break;
}

// ---- M3: what gets stored ----
say("\n## Uploads");
const big = silentWav(12 * 60); // 12 min: past the 10 min bound
let id = seq(); await put("12 min WAV", id, big); say(`  ${await stored(id)}`);
id = seq(); await put("12 min WAV", id, big, { chunked: true }); say(`  ${await stored(id)}`);
id = seq(); await put("not a WAV", id, Buffer.alloc(1_000_000, 0x61));
say("\n## 5-minute memos until the daily cap");
for (let i = 1; i <= 8; i++) {
  id = seq(); await put(`5 min WAV #${i}`, id, silentWav(300));
  const rec = await settle(id);
  say(`  record ${rec.status}${rec.error ? ` "${rec.error}"` : ""}; ${await stored(id)}; usage ${await usage()} s`);
  if (rec.error === "daily limit") break;
}

r = await web("/api/account", { method: "DELETE" });
say(`\n(test account deleted: ${r.status})`);
