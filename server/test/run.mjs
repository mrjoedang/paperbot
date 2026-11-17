// Batch test: PUT each clip, time the 202, poll GET until final (work: until done/paused/stopped).
// usage: node run.mjs <tag> [file ...]   -> results/<tag>.json
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
const dir = new URL(".", import.meta.url).pathname;
// The owner token of the server under test: TOKEN, else DEVICE_TOKEN in server/.dev.vars (dev Worker: DEV_TOKEN in server/.secrets).
const TOKEN = process.env.TOKEN ?? readFileSync(dir + "../.dev.vars", "utf8").match(/^DEVICE_TOKEN=(.+)$/m)[1].trim();
const BASE = process.env.BASE ?? "https://dev.paperbot.ca";
const H = { authorization: `Bearer ${TOKEN}` };
const tag = process.argv[2] ?? "batch";
const files = process.argv.length > 3 ? process.argv.slice(3) : readdirSync(dir + "wav").filter((f) => /\.(wav|bin)$/.test(f));
const dataset = JSON.parse(readFileSync(dir + "dataset.json", "utf8"));
const NOISE = /^(click|short|tiny|silent|roomnoise|hiss|junk|truncated)/;
const expect = (f) => { const m = f.match(/^tts-(\d+)/); if (m) { const d = dataset.find((x) => x.id === +m[1]); return { kind: d.kind, alt: d.alt ?? [], text: d.text, due: d.due }; } return NOISE.test(f) ? { kind: "noise", alt: [] } : null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const extraHeaders = JSON.parse(process.env.HDR ?? "{}");

async function one(f) {
  const id = `${tag}-${f.replace(/\.[a-z]+$/i, "").replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 64);
  const body = readFileSync(dir + "wav/" + f);
  const t0 = performance.now();
  const r = await fetch(`${BASE}/v1/recordings/${id}`, { method: "PUT", headers: { ...H, "content-type": "audio/wav", "x-firmware-version": "test-0.1", ...extraHeaders }, body });
  const putMs = Math.round(performance.now() - t0);
  const put = { status: r.status, body: await r.json().catch(() => null) };
  let first = null, final = null, polls = 0, seen = [];
  for (;;) {
    const g = await fetch(`${BASE}/v1/recordings/${id}`, { headers: H });
    const v = g.status === 200 ? await g.json() : { status: `http${g.status}` };
    const ms = Math.round(performance.now() - t0);
    polls++;
    if (!seen.includes(v.status)) seen.push(v.status);
    if (v.status !== "processing" && !first) first = { ms, ...v };
    if (["done", "paused_budget", "stopped", "error"].includes(v.status)) { final = { ms, bytes: JSON.stringify(v).length, ...v }; break; }
    if (ms > 240_000) { final = { ms, timeout: true, ...v }; break; }
    await sleep(v.status === "researching" ? 3000 : 250);
  }
  const e = expect(f);
  const ok = e ? (final.kind === e.kind || e.alt.includes(final.kind)) : null;
  return { file: f, id, putMs, put, firstResultMs: first?.ms, final, seen, polls, expected: e?.kind ?? null, ok };
}

const out = [];
const queue = [...files];
await Promise.all([0, 1, 2].map(async () => { while (queue.length) { const f = queue.shift(); const r = await one(f); out.push(r); console.log(`${r.ok === null ? " " : r.ok ? "✓" : "✗"} ${f.padEnd(34)} put ${r.put.status} ${r.putMs}ms  result ${r.firstResultMs}ms  ${r.final.status} ${r.final.kind ?? ""} "${r.final.title ?? r.final.error ?? ""}" ${r.final.summary ? "| " + r.final.summary : ""} exp=${r.expected ?? "?"}`); } }));
mkdirSync(dir + "results", { recursive: true });
writeFileSync(dir + `results/${tag}.json`, JSON.stringify(out, null, 1));
