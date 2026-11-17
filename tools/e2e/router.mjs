// The router end to end: real speech (macOS `say`) uploaded as a board does, through Whisper, the router and the act
// step, then what the board shows (device view) and, for saves, what landed in OpenBelt.
// usage: BASE=http://127.0.0.1:8790 TOKEN=<device token> node tools/e2e/router.mjs ["memo text" ...]
// Without memo texts it plays the default script (saves, a check-off, answers, an ignored mic test).
// Writes build/e2e/router.json. Each memo waits for the previous one's result, as a person would.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const TOKEN = process.env.TOKEN;
if (!TOKEN) throw new Error("TOKEN: the owner's device token of the server under test");
const FW = process.env.FW ?? "1.2.0";
const SCRIPT = process.argv.slice(2).length ? process.argv.slice(2) : [
  "Remind me to get some eggs.",
  "Remind me to call the dentist on the 18th at 11.",
  "Tell me a joke.",
  "What's the weather like right now?",
  "Test, test, one, two, three.",
  "I got the eggs, check them off.",
  "Add oat milk and bananas to my shopping list.",
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = join(tmpdir(), `paperbot-router-${process.pid}`);
mkdirSync(dir, { recursive: true });
const tag = Date.now().toString(36);
const out = [];
for (const [i, text] of SCRIPT.entries()) {
  const wav = join(dir, `${i}.wav`);
  execFileSync("say", ["-o", wav, "--data-format=LEI16@16000", text]);
  const id = `e2e${tag}-${String(i).padStart(2, "0")}`;
  const t0 = Date.now();
  const put = await fetch(`${BASE}/v1/recordings/${id}`, { method: "PUT", headers: { authorization: `Bearer ${TOKEN}`, "content-type": "audio/wav", "x-pv-fw": FW }, body: readFileSync(wav) });
  let v = null, first = null;
  for (;;) {
    const g = await fetch(`${BASE}/v1/recordings/${id}`, { headers: { authorization: `Bearer ${TOKEN}`, "x-pv-fw": FW } });
    v = g.status === 200 ? await g.json() : { status: `http${g.status}` };
    if (v.status !== "processing" && !first) first = Date.now() - t0;
    if (["done", "error", "stopped", "paused_budget"].includes(v.status) || Date.now() - t0 > 90_000) break;
    await sleep(v.status === "researching" ? 2000 : 250);
  }
  const ms = Date.now() - t0;
  out.push({ text, id, put: put.status, ms, first, view: v });
  console.log(`${String(ms).padStart(6)} ms  ${JSON.stringify(text).padEnd(60)} -> ${v.kind ?? v.status}: ${v.title ?? ""}${v.due ? ` @ ${v.due}` : ""}${v.summary ? ` | ${v.summary}` : ""}`);
}
mkdirSync("build/e2e", { recursive: true });
writeFileSync("build/e2e/router.json", JSON.stringify(out, null, 1));
