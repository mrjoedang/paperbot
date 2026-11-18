// pocket-voice v2: async device contract (docs/device-api.md).
// PUT -> audio durable in R2 -> 202 -> ctx.waitUntil(inline pipeline) with a Workflow fallback (durable retries)
// and a cron sweeper; work memos start a budgeted research agent (WorkAgent) without approval.

import { assistants, handleAuth, isOwner, migrate as authMigrate, revokeAssistant, sessionUser, userById, withMcpOAuth, type SessionUser } from "./auth";
import { sha256hex } from "./directory";
import { agentStub, directory as dirStub, inbox, objKey, type Env } from "./env";
import { checkAlerts, onModelError, type Spend } from "./alerts";
import { deviceView, webRecord, type Rec } from "./inbox";
import { parseStatus, parseTelemetry, STATUS_MAX_BYTES, telemetrySig, validatePatch } from "./logic";
import { handleMcp } from "./mcp";
import { ITEM_ID } from "./items";
import { openbeltBase } from "./openbelt";
import { processClip, wavInfo, type Acct } from "./pipeline";

export { Inbox, TaskList } from "./inbox";
export { Directory } from "./directory";
export { WorkAgent } from "./agent";
export { VoicePipeline } from "./pipeline";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const INLINE_TIMEOUT_MS = 20_000; // waitUntil gets ~30 s after the response; leave room for the fallback hand-off
const MAX_REPLY = 2048;
// The firmware records for as long as the button is held. 10 min of 16 kHz mono PCM16 is far beyond any memo, and the
// whole clip (plus its base64 copy for Whisper) still fits in a Worker's memory.
const MAX_UPLOAD_BYTES = 44 + 10 * 60 * 16000 * 2; // 19.2 MB
const BAD_KEEP_BYTES = 4096; // of an unreadable upload: enough to see what it was

// ---------- auth ----------
function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
const bearer = (req: Request) => req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
const cookie = (req: Request, name: string) => req.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1] ?? "";

/** The signed-in person's account (Better Auth session cookie). Anyone can sign up; each person gets their own Inbox (the owner keeps "default"). */
type WebAccount = { email: string; inbox: string; userId: string; owner: boolean };
const accountCache = new Map<string, { a: WebAccount; at: number }>();
async function webAccount(req: Request, env: Env): Promise<WebAccount | null> {
  const u = await sessionUser(req, env, new URL(req.url));
  return u ? accountFor(env, u) : null;
}
async function accountFor(env: Env, u: SessionUser): Promise<WebAccount> {
  const hit = accountCache.get(u.id);
  if (hit && hit.a.email === u.email && Date.now() - hit.at < 600_000) return hit.a;
  const owner = isOwner(env, u);
  const d = await dirStub(env).account(u.id, u.email, owner);
  await inbox(env, d.inbox).initAccount({ name: d.inbox, email: u.email, owner: d.inbox === "default", tz: d.tz });
  const a = { email: u.email, inbox: d.inbox, userId: u.id, owner: d.inbox === "default" };
  accountCache.set(u.id, { a, at: Date.now() });
  if (accountCache.size > 500) accountCache.clear();
  return a;
}

// ---------- board tokens ----------
// The owner's original DEVICE_TOKEN (secret) -> "default". Tokens minted by `pocketbot setup` ("pb_d_…") live hashed
// in the Directory; resolved per isolate with a short cache (a removed board stops within a minute).
type DevAuth = { inbox: string; tz: string; hash: string | null; seen: boolean };
const tokenCache = new Map<string, { a: DevAuth | null; at: number }>();
async function tokenAuth(req: Request, env: Env): Promise<DevAuth | null> {
  const t = bearer(req);
  if (!t) return null;
  if (env.DEVICE_TOKEN && safeEqual(t, env.DEVICE_TOKEN)) return { inbox: "default", tz: env.TZ || "UTC", hash: null, seen: true };
  if (!/^pb_d_[A-Za-z0-9_-]{20,64}$/.test(t)) return null;
  const hash = await sha256hex(t);
  const hit = tokenCache.get(hash);
  let a = hit && Date.now() - hit.at < (hit.a ? 60_000 : 5_000) ? hit.a : undefined;
  if (a === undefined) {
    const r = await dirStub(env).resolve(hash);
    a = r ? { inbox: r.inbox, tz: r.tz || env.TZ || "UTC", hash, seen: r.seen } : null;
    tokenCache.set(hash, { a, at: Date.now() });
    if (tokenCache.size > 500) tokenCache.clear();
  }
  return a;
}

// ---------- device telemetry ----------
// Isolate-level throttle: identical telemetry within 15 s does not cost a Durable Object round trip.
const telSeen = new Map<string, number>();
function noteTelemetry(env: Env, ctx: ExecutionContext, req: Request, url: URL, box: string) {
  const t = parseTelemetry((h) => req.headers.get(h), url, req.method);
  if (!t || t.req === "upload" || t.req === "status") return; // uploads / status reports go through Inbox.arrive() / deviceStatus()
  const sig = `${box}|${telemetrySig(t)}`, now = Date.now();
  if (now - (telSeen.get(sig) ?? 0) < 15_000) return;
  telSeen.set(sig, now);
  if (telSeen.size > 200) telSeen.clear();
  ctx.waitUntil(inbox(env, box).telemetry(t).catch((e) => console.log(`telemetry failed ${e}`)));
}

// ---------- device API ----------
const json = (body: unknown, status = 200) => {
  const s = JSON.stringify(body);
  return new Response(s, { status, headers: { "content-type": "application/json" } });
};

function firmwareHeader(req: Request): string | null {
  for (const h of ["x-firmware-version", "x-pv-firmware", "x-fw-version", "x-pv-fw"]) { const v = req.headers.get(h); if (v) return v.slice(0, 40); }
  return null;
}

async function handleUpload(req: Request, env: Env, ctx: ExecutionContext, id: string, acct: Acct): Promise<Response> {
  const t0 = Date.now();
  if (!ID_RE.test(id)) return json({ error: "bad id" }, 400); // never acceptable -> device sets it aside
  // Too large: 413 is final for every firmware (the clip goes to /REC_BAD on the card, never retried). The body is
  // read to the end first, so the board finishes sending and gets the reply instead of a reset it would retry.
  if (Number(req.headers.get("content-length")) > MAX_UPLOAD_BYTES) return tooLarge(req, id, await readCapped(req, 0));
  const box = inbox(env, acct.inbox);
  // Headers are here, the body may still be streaming: live UI shows "incoming" now; telemetry rides along.
  const existing = (await box.arrive(id, parseTelemetry((h) => req.headers.get(h), new URL(req.url), "PUT"))) as Record<string, unknown> | null;
  if (existing) return json({ ...existing, duplicate: true }, 202);

  const body = await readCapped(req, MAX_UPLOAD_BYTES);
  if (!body.bytes) return tooLarge(req, id, body);
  const wav = body.bytes;
  const fw = firmwareHeader(req);
  const test = env.TEST_HOOKS === "1" ? { fail: req.headers.get("x-test-fail") ?? "", text: req.headers.get("x-test-text") ?? "", agent: req.headers.get("x-test-agent") ?? "" } : null;
  const flags = test ? [test.fail && `fail=${test.fail}`, test.agent && `agent_${test.agent}`, test.text && `text=${encodeURIComponent(test.text)}`].filter(Boolean).join("&") : "";
  const info = wavInfo(wav);
  if (!info.ok) {
    // Unreadable / non-WAV body: keep its start for debugging, reply with a final "ignore" record so the device
    // deletes the clip instead of retrying forever (never a 4xx that would block the queue).
    await env.AUDIO.put(objKey(acct.inbox, "bad", id, ".bin"), wav.subarray(0, BAD_KEEP_BYTES));
    const { inserted, rec } = await box.receive({ id, status: "done", kind: "ignore", title: "(unreadable audio)", due: null, bytes: wav.length, fw, noise_reason: `unreadable: ${info.why}`, done_at: Date.now(), via: "put" });
    return json({ ...deviceView(rec), ...(inserted ? {} : { duplicate: true }) }, 202);
  }
  const seconds = +info.seconds.toFixed(2);
  const over = await box.overCap(seconds);
  if (over) { // a final error record; the audio is not kept
    const { inserted, rec } = await box.receive({ id, status: "error", error: "daily limit", detail: over, done_at: Date.now(), bytes: wav.length, fw, seconds, via: "put" });
    return json({ ...deviceView(rec), ...(inserted ? {} : { duplicate: true }) }, 202);
  }
  const audio_key = objKey(acct.inbox, "audio", id, ".wav");
  await env.AUDIO.put(audio_key, wav, { httpMetadata: { contentType: "audio/wav" }, customMetadata: fw ? { fw } : undefined });
  // Audio is durable from here on -> the record exists -> 202.
  const { inserted, rec } = await box.receive({ id, bytes: wav.length, audio_key, fw, seconds, test_flags: flags || null });
  if (!inserted) return json({ ...deviceView(rec), duplicate: true }, 202);
  if (rec.status !== "processing") { // went over the cap since the check above (another upload): not kept either
    ctx.waitUntil(env.AUDIO.delete(audio_key));
    return json(deviceView(rec), 202);
  }
  const cf = (req as any).cf ?? {};
  const place = [cf.city, cf.region, cf.country].filter((x) => typeof x === "string" && x).join(", ");
  if (place) ctx.waitUntil(box.setPlace(place).catch(() => {}));
  ctx.waitUntil(runInline(env, acct, id, rec.gen, flags));
  console.log(JSON.stringify({ ev: "put", id, bytes: wav.length, seconds: info.seconds, fw, ms: Date.now() - t0 }));
  return json({ id, status: "processing" }, 202);
}

/** The request body, or null bytes once it passes max (the rest is still read and dropped, never buffered). */
async function readCapped(req: Request, max: number): Promise<{ bytes: Uint8Array | null; total: number }> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (req.body) for await (const c of req.body as unknown as AsyncIterable<Uint8Array>) {
    total += c.byteLength;
    if (total <= max) chunks.push(c);
    else chunks.length = 0;
  }
  if (total > max) return { bytes: null, total };
  const bytes = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.byteLength; }
  return { bytes, total };
}
function tooLarge(req: Request, id: string, body: { total: number }): Response {
  console.log(JSON.stringify({ ev: "put_too_large", id, bytes: body.total, fw: firmwareHeader(req) }));
  return json({ error: `too large (max ${MAX_UPLOAD_BYTES} bytes)` }, 413);
}

const flag = (flags: string | null | undefined, k: string) => new URLSearchParams(flags ?? "").get(k) ?? undefined;

async function runInline(env: Env, acct: Acct, id: string, gen: number, flags: string) {
  const box = inbox(env, acct.inbox);
  const t0 = Date.now();
  try {
    await box.noteAttempt(id, gen, "inline");
    if (flag(flags, "fail")) throw new Error(`injected inline failure (${flag(flags, "fail")})`);
    let timer: any;
    const outcome = await Promise.race([
      processClip(env, acct, id, gen, flag(flags, "text")),
      new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`inline timeout ${INLINE_TIMEOUT_MS} ms`)), INLINE_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
    await box.complete(id, gen, outcome, "inline");
    console.log(JSON.stringify({ ev: "processed", id, kind: outcome.kind, ms: Date.now() - t0 }));
  } catch (e) {
    console.log(JSON.stringify({ ev: "inline_failed", id, error: String(e).slice(0, 200) }));
    await onModelError(env, e).catch(() => {});
    if (flag(flags, "fail") === "stuck") return; // test: simulate an isolate dying before the hand-off (cron sweeper recovers)
    await startWorkflow(env, acct, id, gen, flags);
  }
}

async function startWorkflow(env: Env, acct: Acct, id: string, gen: number, flags: string | null) {
  const instance = `${id}-g${gen}-${Date.now().toString(36)}`.slice(0, 100);
  try {
    await env.PIPELINE.create({ id: instance, params: { id, gen, override: flag(flags, "text"), fail: flag(flags, "fail") === "always" ? "always" : undefined, inbox: acct.inbox, tz: acct.tz } });
    await inbox(env, acct.inbox).setWorkflow(id, gen, instance);
  } catch (e) {
    console.log(JSON.stringify({ ev: "workflow_create_failed", id, error: String(e).slice(0, 200) })); // the cron sweeper retries
  }
}

/** /v1/updates: known ids only, reply kept ≤ 2 KB (items that do not fit are omitted = "not ready"). */
async function handleUpdates(env: Env, url: URL, box: string): Promise<Response> {
  const ids = (url.searchParams.get("ids") ?? "").split(",").map((s) => s.trim()).filter((s) => ID_RE.test(s)).slice(0, 12);
  const items = (await inbox(env, box).views(ids)) as Record<string, unknown>[];
  while (items.length && JSON.stringify({ items }).length > MAX_REPLY) items.pop();
  return json({ items });
}

/** POST /v1/status (docs/device-api.md §7). 204, or 200 {"want_log":true} + X-PV-Want-Log: 1. */
async function handleStatus(req: Request, env: Env, url: URL, box: string): Promise<Response> {
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > STATUS_MAX_BYTES) return json({ error: "too large" }, 413);
  const text = await req.text();
  if (new TextEncoder().encode(text).length > STATUS_MAX_BYTES) return json({ error: "too large" }, 413);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return json({ error: "invalid JSON" }, 400); }
  const v = parseStatus(body);
  if (!v.ok) return json({ error: v.error }, 400);
  // Test deployment only: X-Test-At backdates the report (battery-trend tests over simulated time).
  const at = env.TEST_HOOKS === "1" && /^\d{13}$/.test(req.headers.get("x-test-at") ?? "") ? Number(req.headers.get("x-test-at")) : undefined;
  const { want_log } = await inbox(env, box).deviceStatus(v.status, parseTelemetry((h) => req.headers.get(h), url, "POST"), at);
  if (want_log) return new Response(JSON.stringify({ want_log: true }), { headers: { "content-type": "application/json", "x-pv-want-log": "1" } });
  return new Response(null, { status: 204 });
}

// Wi-Fi list revision for the X-PV-Wifi-Rev reply header, per inbox (cached per isolate for 5 s; changes made in this isolate refresh it).
const wifiRevs = new Map<string, { rev: number; at: number }>();
async function wifiRev(env: Env, box: string): Promise<number> {
  const c = wifiRevs.get(box);
  if (c && Date.now() - c.at <= 5_000) return c.rev;
  const rev = await inbox(env, box).wifiRev();
  wifiRevs.set(box, { rev, at: Date.now() });
  return rev;
}
/** Every /v1 reply carries X-PV-Wifi-Rev when the server's list is newer than the device's (no header = 0).
 *  A device ahead of us got its list elsewhere: our revision jumps past it, so it re-syncs. */
async function withWifiRev(req: Request, env: Env, res: Response, box: string): Promise<Response> {
  try {
    const raw = req.headers.get("x-pv-wifi-rev");
    const have = raw && /^\s*\d{1,9}\s*$/.test(raw) ? Number(raw) : 0;
    let rev = await wifiRev(env, box);
    if (rev < have) wifiRevs.set(box, { rev: (rev = await inbox(env, box).wifiRevPast(have)), at: Date.now() });
    if (rev <= have) return res;
    const out = new Response(res.body, res);
    out.headers.set("x-pv-wifi-rev", String(rev));
    return out;
  } catch { return res; }
}

async function handleDevice(req: Request, env: Env, ctx: ExecutionContext, url: URL, path: string, acct: Acct): Promise<Response> {
  const box = acct.inbox;
  let m = path.match(/^\/v1\/recordings\/([^/]+)$/);
  if (m && req.method === "PUT") return handleUpload(req, env, ctx, m[1], acct);
  if (m && req.method === "GET") {
    const v = ID_RE.test(m[1]) ? await inbox(env, box).view(m[1]) : null;
    return v ? json(v) : json({ error: "not found" }, 404);
  }
  if (path === "/v1/updates" && req.method === "GET") return handleUpdates(env, url, box);
  if (path === "/v1/firmware" && req.method === "GET") return new Response(null, { status: 204 }); // OTA: nothing yet
  if (path === "/v1/status" && req.method === "POST") return handleStatus(req, env, url, box);
  if (path === "/v1/wifi" && req.method === "GET") {
    const body = await inbox(env, box).wifiDeviceList();
    return new Response(body, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  }
  // `pocketbot setup`: the Mac's Wi-Fi networks + time zone (device token). Reply: the device body of GET /v1/wifi.
  if (path === "/v1/config" && req.method === "POST") {
    const b = (await req.json().catch(() => null)) as { tz?: unknown; wifi?: unknown } | null;
    if (!b || typeof b !== "object") return json({ error: "body must be a JSON object" }, 400);
    const ib = inbox(env, box);
    let tz: string | undefined;
    if (b.tz !== undefined) {
      if (typeof b.tz !== "string" || !validTz(b.tz)) return json({ error: "tz: an IANA time zone like America/Edmonton" }, 400);
      tz = await ib.setTz(b.tz);
      await dirStub(env).setTz(box, b.tz);
      for (const [k, v] of tokenCache) if (v.a?.inbox === box) tokenCache.delete(k);
    }
    let wifi: unknown;
    if (b.wifi !== undefined) {
      const r = await ib.wifiImport(b.wifi);
      if (r.error) return json({ error: r.error }, r.status);
      wifi = JSON.parse(r.body!);
      wifiRevs.delete(box);
    }
    return json({ tz: tz ?? (await ib.tz()), wifi: wifi ?? JSON.parse(await ib.wifiDeviceList()) });
  }
  if (path === "/v1/tasks" && req.method === "GET") {
    const open = (await inbox(env, box).list()).filter((r) => r.status !== "processing" && r.kind !== "ignore");
    return json(open.slice(0, 10).map(({ id, kind, title, due }) => ({ id, kind, title, due })));
  }
  return new Response("not found", { status: 404 });
}

/** Removes a person from the auth database (sessions, passkeys, connector grants, device codes). */
async function deleteUser(env: Env, userId: string) {
  const db = env.AUTH_DB;
  await db.batch([
    db.prepare("DELETE FROM oauthAccessToken WHERE userId = ?").bind(userId),
    db.prepare("DELETE FROM oauthRefreshToken WHERE userId = ?").bind(userId),
    db.prepare("DELETE FROM oauthConsent WHERE userId = ?").bind(userId),
    db.prepare("DELETE FROM passkey WHERE userId = ?").bind(userId),
    db.prepare("DELETE FROM deviceCode WHERE userId = ?").bind(userId), // sign-ins of the old setup CLI
    db.prepare("DELETE FROM session WHERE userId = ?").bind(userId),
    db.prepare("DELETE FROM account WHERE userId = ?").bind(userId),
    db.prepare("DELETE FROM user WHERE id = ?").bind(userId),
  ]);
}

// ---------- setup (`pocketbot setup`, docs/setup.md) ----------
function validTz(tz: string): boolean {
  if (!/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz) || tz.length > 40) return false;
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
}
/** Setup in the browser (/setup, docs/setup.md), with the person's session:
 *  POST /v1/setup/claim {device} -> a board token for the person's inbox;  GET /v1/setup/claim?device= -> online yet?
 *  Also the release image setup installs: /v1/setup/firmware/* (R2 setup/). */
async function handleSetup(req: Request, env: Env, url: URL, path: string): Promise<Response> {
  const f = path.match(/^\/v1\/setup\/firmware\/([A-Za-z0-9_.-]{1,64})$/);
  if (f && req.method === "GET") {
    const obj = await env.AUDIO.get(`setup/${f[1]}`);
    if (!obj) return json({ error: "no firmware published" }, 404);
    return new Response(obj.body, { headers: { "content-type": f[1].endsWith(".json") ? "application/json" : "application/octet-stream",
      "content-length": String(obj.size), "cache-control": f[1].endsWith(".json") ? "no-store" : "public, max-age=300" } });
  }
  if (path !== "/v1/setup/claim") return json({ error: "not found" }, 404);
  const who = await webAccount(req, env);
  if (!who) return json({ error: "sign in first" }, 401);
  if (req.method === "POST") {
    // Only the setup page itself may mint board tokens: a page on another site must not.
    if (!sameOrigin(req, url)) return json({ error: "cross-origin request" }, 403);
    const b = (await req.json().catch(() => ({}))) as { device?: unknown };
    const device = typeof b.device === "string" && /^[0-9a-f]{12}$/.test(b.device) ? b.device : null;
    if (!device) return json({ error: "device: the board id (12 hex characters)" }, 400);
    const token = await dirStub(env).mint(who.inbox, device);
    return json({ token, server: env.BOARD_SERVER || url.origin, email: who.email });
  }
  if (req.method === "GET") return json(await dirStub(env).status(who.inbox, url.searchParams.get("device") ?? ""));
  return json({ error: "use GET or POST" }, 405);
}

// ---------- cron sweeper ----------
/** Every person's inbox (the owner's "default" always). */
async function sweepAll(env: Env) {
  // The owner's inbox is swept even if the Directory can't be reached.
  let accounts: { inbox: string; created: number }[] = [];
  try { accounts = await dirStub(env).accounts(); } catch (e) { console.log(JSON.stringify({ ev: "sweep_directory_failed", error: String(e).slice(0, 200) })); }
  const names = new Set(["default", ...accounts.map((a) => a.inbox)]);
  const spend: Spend[] = [];
  for (const name of names) {
    try { spend.push(await sweep(env, name)); } catch (e) { console.log(JSON.stringify({ ev: "sweep_failed", inbox: name, error: String(e).slice(0, 200) })); }
  }
  try { await checkAlerts(env, spend, accounts.map((a) => a.created)); } catch (e) { console.log(JSON.stringify({ ev: "alerts_failed", error: String(e).slice(0, 200) })); }
}
async function sweep(env: Env, name: string): Promise<Spend> {
  const box = inbox(env, name);
  const acct: Acct = { inbox: name, tz: await box.tz() };
  const s = await box.stale(Date.now());
  for (const r of s.processing) {
    let running = false;
    if (r.wf_instance) {
      try {
        const st = await (await env.PIPELINE.get(r.wf_instance)).status();
        running = ["queued", "running", "waiting", "paused", "waitingForPause"].includes(st.status);
      } catch {}
    }
    if (running) continue;
    if (r.attempts >= 12) { await box.fail(r.id, r.gen, "transcription failed", "gave up after 12 attempts"); continue; }
    console.log(JSON.stringify({ ev: "sweep_restart", id: r.id, wf: r.wf_instance }));
    await startWorkflow(env, acct, r.id, r.gen, r.test_flags);
  }
  for (const r of s.running) {
    // Agents report back themselves; this only pokes ones that look stuck (status() re-arms their watcher).
    try { await (await agentStub(env, name, r.id)).status(); } catch (e) { console.log(`poke ${r.id} failed ${e}`); }
  }
  if (s.queued) await box.pump();
  return s.spend;
}

// ---------- web app ----------
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; " +
  "img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

async function asset(env: Env, req: Request, url: URL, path: string): Promise<Response> {
  const res = await env.ASSETS.fetch(new Request(new URL(path, url.origin), { headers: req.headers }));
  const out = new Response(res.body, res);
  const html = path === "/" || path.endsWith(".html") || (res.headers.get("content-type") ?? "").includes("text/html");
  out.headers.set("cache-control", html || path.endsWith("/version.json") ? "no-store" : "no-cache"); // always revalidate: a deploy shows up at once
  out.headers.set("x-content-type-options", "nosniff");
  out.headers.set("referrer-policy", "no-referrer");
  out.headers.set("x-pv-web", "3"); // web app build
  if (html) out.headers.set("content-security-policy", CSP);
  return out;
}

/** `path` is relative to the app root ("/" in production, /admin/app/ on the test mount). */
async function handleWeb(req: Request, env: Env, url: URL, ctx: ExecutionContext, path: string, who: WebAccount): Promise<Response> {
  const name = who.inbox;
  const box = inbox(env, name);
  if (path === "/setup/signed-in" && req.method === "GET") {
    // Setup's sign-in popup connects OpenBelt (where saved items live) on its way out, once: then it closes either way.
    if (!url.searchParams.has("openbelt") && !(await box.openbeltStatus()).connected)
      return Response.redirect(`${url.origin}/api/openbelt/connect?next=${encodeURIComponent("/setup/signed-in?openbelt=1")}`, 302);
    return setupSignedIn();
  }
  if (path === "/api/live") {
    if (!sameOrigin(req, url)) return json({ error: "cross-origin request" }, 403);
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a websocket", { status: 426 });
    return box.fetch(req); // the Inbox DO is the hub (hibernatable WebSockets)
  }
  if (path === "/api/snapshot") return json(await box.snapshot());
  if (path === "/api/tasks" && req.method === "GET") {
    const all = url.searchParams.has("all");
    return json(((await box.snapshot()) as any).records.filter((r: any) => (all ? r.state !== "archived" : r.state === "open")));
  }
  if (path === "/api/budget") return json(await box.spend());
  if (path === "/api/device") return json(await box.devices());
  const mutate = req.method !== "GET" && req.method !== "HEAD";
  if (mutate && path.startsWith("/api/") && !sameOrigin(req, url)) return json({ error: "cross-origin request" }, 403);
  // ---- account: who I am, my boards, my assistants, research, time zone, export, delete ----
  if (path === "/api/me" && req.method === "GET") {
    return json({ email: who.email, owner: who.owner, tz: await box.tz(), usage: await box.usage(), research: await box.researchSettings() });
  }
  if (path === "/api/boards" && req.method === "GET") {
    const devs = (await box.devices()) as any[];
    const tele = new Map(devs.map((d) => [d.key, d]));
    const boards = ((await dirStub(env).boards(name)) as any[]).map((b) => ({ ...b, telemetry: b.device ? tele.get(b.device) ?? null : null }));
    // The owner's boards from before setup existed use the built-in DEVICE_TOKEN, not a board token: list them too
    // (nothing to remove: that token is the deployment's secret).
    if (name === "default") for (const d of devs) if (!d.sim && !boards.some((b) => b.device === d.key))
      boards.push({ device: d.key, created: d.first_seen, seen_at: d.last_seen, fw: d.fw, telemetry: d, builtin: true });
    return json(boards);
  }
  let bd = path.match(/^\/api\/boards\/([0-9a-f]{12})$/);
  if (bd && req.method === "DELETE") {
    const n = await dirStub(env).revoke(name, bd[1]);
    for (const [k, v] of tokenCache) if (v.a?.inbox === name) tokenCache.delete(k);
    return n ? json({ removed: bd[1] }) : json({ error: "no such board on your account" }, 404);
  }
  if (path === "/api/assistants" && req.method === "GET") return json(await assistants(env, who.userId));
  bd = path.match(/^\/api\/assistants\/([A-Za-z0-9_-]{8,128})$/);
  if (bd && req.method === "DELETE") return json({ disconnected: bd[1], changes: await revokeAssistant(env, who.userId, bd[1]) });
  if (path === "/api/research") {
    if (req.method === "GET") return json(await box.researchSettings());
    if (req.method === "DELETE") return json(await box.setResearchKey(null));
    if (req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { provider?: string; key?: string };
      if (b.provider !== "anthropic" || typeof b.key !== "string" || !/^sk-ant-[A-Za-z0-9_-]{20,200}$/.test(b.key.trim())) return json({ error: "Paste an Anthropic API key (it starts with sk-ant-)." }, 400);
      const key = b.key.trim();
      // Dev only: a fake "sk-ant-test-..." key is saved unchecked, so scripts can prove research runs on the
      // person's key (it must fail with Anthropic's "invalid key" instead of succeeding on the owner's billing).
      if (env.TEST_HOOKS === "1" && key.startsWith("sk-ant-test-")) return json(await box.setResearchKey(key));
      const t = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 1, messages: [{ role: "user", content: "ok" }] }) });
      // Anthropic's errors: 401/403 bad or revoked key, 400 with "credit" (no credit) or "limit" (a workspace spend limit), 402 billing.
      const body = t.ok ? "" : await t.text().catch(() => "");
      if (t.status === 401 || t.status === 403) return json({ error: "Anthropic rejected this key. Copy it again from platform.claude.com/settings/keys." }, 400);
      if (t.status === 402 || (t.status === 400 && /credit/i.test(body))) return json({ error: "This key's account has no API credit. Add credit at platform.claude.com/settings/billing (a Claude subscription doesn't include it)." }, 400);
      if (t.status === 400 && /limit/i.test(body)) return json({ error: "This key's workspace has reached its spend limit. Raise it at platform.claude.com/settings/spend-limits." }, 400);
      if (t.status === 429) return json({ error: "Anthropic is rate-limiting this key. Try again in a minute." }, 400);
      if (!t.ok && t.status !== 400) return json({ error: `Anthropic answered ${t.status}. Try again in a minute.` }, 502);
      return json(await box.setResearchKey(key));
    }
  }
  // ---- OpenBelt: where app memos are built (src/openbelt.ts). Connect = OpenBelt's own sign-in (email code), as OAuth ----
  if (path === "/api/openbelt" && req.method === "GET") return json(await box.openbeltStatus());
  if (path === "/api/openbelt" && req.method === "DELETE") return json(await box.openbeltDisconnect(openbeltBase(env.OPENBELT_URL)));
  if (path === "/api/openbelt/connect" && req.method === "GET") {
    // A top-level navigation from the web app (a link): only ever back into this app afterwards.
    const asked = url.searchParams.get("next") ?? "/#settings/apps";
    const next = asked.startsWith("/") && !asked.startsWith("//") ? asked : "/#settings/apps";
    try {
      const to = await box.openbeltStart(openbeltBase(env.OPENBELT_URL), `${url.origin}/api/openbelt/callback`, next);
      return Response.redirect(to, 302);
    } catch (e) {
      // From setup's popup: go on without it (saved items wait for Connect in the app).
      if (next.startsWith("/setup/")) { console.log(JSON.stringify({ ev: "openbelt_connect_unreachable", error: String(e).slice(0, 200), inbox: name })); return Response.redirect(`${url.origin}${next}`, 302); }
      return new Response(`Couldn't reach OpenBelt: ${String(e instanceof Error ? e.message : e).slice(0, 200)}. Try again in a minute.`, { status: 502, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
  }
  if (path === "/api/openbelt/callback" && req.method === "GET") {
    // The web app shows a fixed message (text in a URL could be anyone's); the reason goes to the log. Setup's popup goes on to
    // its last page either way.
    const back = (q: string, next: string | null) => Response.redirect(next?.startsWith("/setup/") ? `${url.origin}${next}` : `${url.origin}/?${q}#settings/apps`, 302);
    const err = url.searchParams.get("error");
    if (err) { console.log(JSON.stringify({ ev: "openbelt_connect_refused", error: err.slice(0, 60), inbox: name })); return back(err === "access_denied" ? "openbelt_error=denied" : "openbelt_error=1", await box.openbeltAbandon()); }
    const done = await box.openbeltFinish(openbeltBase(env.OPENBELT_URL), url.searchParams.get("code") ?? "", url.searchParams.get("state") ?? "");
    if (!done.ok) console.log(JSON.stringify({ ev: "openbelt_connect_failed", error: done.error.slice(0, 200), inbox: name }));
    return done.ok ? Response.redirect(`${url.origin}${done.next}`, 302) : back("openbelt_error=1", done.next);
  }
  // ---- List and Apps: the person's OpenBelt list and apps, read live as them (src/items.ts) ----
  if (path === "/api/belt" && req.method === "GET") return json(await box.beltView(openbeltBase(env.OPENBELT_URL)));
  let bi = path.match(/^\/api\/belt\/items\/([^/]+)$/);
  if (bi && req.method === "POST") {
    const id = decodeURIComponent(bi[1]), body = (await req.json().catch(() => null)) as { done?: unknown } | null;
    if (!ITEM_ID.test(id) || typeof body?.done !== "boolean") return json({ error: "send { done: true | false } for an item id" }, 400);
    const r = await box.beltSetDone(openbeltBase(env.OPENBELT_URL), id, body.done);
    return r.ok ? json(r) : json(r, r.error === "gone" ? 404 : r.error === "not connected" ? 409 : 502);
  }
  bi = path.match(/^\/api\/belt\/apps\/([a-z0-9-]{1,63})\/picture$/);
  if (bi && req.method === "GET") {
    const theme = url.searchParams.get("theme") === "dark" ? "dark" : "light";
    const pic = await box.beltPicture(openbeltBase(env.OPENBELT_URL), bi[1], theme).catch(() => null);
    if (!pic) return new Response(null, { status: 404, headers: { "cache-control": "no-store" } });
    const etag = `"${pic.tag}-${theme}"`;
    // pictures are retaken at most every 5 minutes: the browser keeps one that long, then asks with its tag
    const headers = { "content-type": pic.type, "cache-control": "private, max-age=300", etag };
    return req.headers.get("if-none-match") === etag ? new Response(null, { status: 304, headers }) : new Response(pic.bytes, { headers });
  }
  if (path === "/api/tz" && req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as { tz?: unknown };
    if (typeof b.tz !== "string" || !validTz(b.tz)) return json({ error: "tz: an IANA time zone like America/Edmonton" }, 400);
    await box.setTz(b.tz);
    await dirStub(env).setTz(name, b.tz);
    return json({ tz: b.tz });
  }
  if (path === "/api/export" && req.method === "GET") {
    const snap = (await box.snapshot()) as any;
    return new Response(JSON.stringify({ email: who.email, exported_at: new Date().toISOString(), records: snap.records, wifi: snap.wifi }, null, 1), {
      headers: { "content-type": "application/json", "content-disposition": 'attachment; filename="paperbot-export.json"' } });
  }
  if (path === "/api/account" && req.method === "DELETE") {
    if (who.owner) return json({ error: "The owner account holds the original inbox and can't be deleted here." }, 409);
    // Sign-in first (sessions and connectors stop), then boards, then the inbox (stops its agents, tombstoned so
    // nothing re-creates it), then the files.
    await deleteUser(env, who.userId);
    accountCache.delete(who.userId);
    await box.openbeltDisconnect(openbeltBase(env.OPENBELT_URL)); // paperbot signed out on OpenBelt (the apps stay theirs)
    await dirStub(env).removeAccount(name);
    for (const [k, v] of tokenCache) if (v.a?.inbox === name) tokenCache.delete(k);
    await box.wipe();
    for (const dir of ["audio", "reports", "bad"] as const) {
      for (let cursor: string | undefined; ;) {
        const l = await env.AUDIO.list({ prefix: `${dir}/${name}/`, cursor });
        if (l.objects.length) await env.AUDIO.delete(l.objects.map((o) => o.key));
        if (!l.truncated) break;
        cursor = l.cursor;
      }
    }
    return json({ deleted: true });
  }
  let d = path.match(/^\/api\/device\/([a-z0-9_-]{1,32})\/(health|request-log|ack)$/);
  if (d) {
    if (d[2] === "health") return json(await box.health(d[1], Number(url.searchParams.get("days")) || 30));
    if (!mutate) return json({ error: "use POST" }, 405);
    if (d[2] === "ack") return json(await box.ackDevice(d[1]));
    const b = (await req.json().catch(() => ({}))) as { on?: boolean };
    return json(await box.requestLog(d[1], b.on !== false));
  }
  if (path === "/api/wifi") {
    if (req.method === "GET") return json(await box.wifiList());
    if (req.method === "POST") return result(await box.wifiAdd(await req.json().catch(() => null)), name);
  }
  if (path === "/api/wifi/order" && req.method === "POST") return result(await box.wifiOrder(((await req.json().catch(() => ({}))) as any).ids), name);
  d = path.match(/^\/api\/wifi\/([A-Za-z0-9_-]{1,16})$/);
  if (d && req.method === "PATCH") return result(await box.wifiUpdate(d[1], await req.json().catch(() => null)), name);
  if (d && req.method === "DELETE") return result(await box.wifiDelete(d[1]), name);
  let m = path.match(/^\/api\/tasks\/([A-Za-z0-9_-]{1,64})$/);
  if (m && req.method === "GET") {
    const r = (await box.web(m[1])) as any;
    return r ? json({ ...r, events: await box.events(m[1]) }) : json({ error: "not found" }, 404);
  }
  if (m && (req.method === "PATCH" || req.method === "POST")) {
    if (!sameOrigin(req, url)) return json({ error: "cross-origin request" }, 403);
    let body: unknown;
    try { body = await req.json(); } catch { return json({ error: "invalid JSON" }, 400); }
    const v = validatePatch(body);
    if (!v.ok) return json({ error: v.error }, 400);
    const r = (await box.patch(m[1], v.patch)) as { status: number; error?: string; rec?: unknown };
    return r.error ? json({ error: r.error }, r.status) : json(r.rec);
  }
  m = path.match(/^\/api\/tasks\/([A-Za-z0-9_-]{1,64})\/reprocess$/);
  if (m && req.method === "POST") {
    if (!sameOrigin(req, url)) return json({ error: "cross-origin request" }, 403);
    return reprocess(env, ctx, m[1], name);
  }
  m = path.match(/^\/audio\/([A-Za-z0-9_-]{1,64})$/);
  if (m) {
    const rec = (await box.get(m[1])) as Rec | null; // only this person's recordings
    const obj = rec?.audio_key ? await env.AUDIO.get(rec.audio_key) : null;
    return obj
      ? new Response(obj.body, { headers: { "content-type": "audio/wav", "content-length": String(obj.size), "cache-control": "private, max-age=86400, immutable" } })
      : new Response("not found", { status: 404 });
  }
  if (path.startsWith("/api/")) return json({ error: "not found" }, 404);
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
  return asset(env, req, url, path);
}

function result(r: { status: number; error?: string; wifi?: unknown }, name = "default") {
  if (r.wifi) wifiRevs.set(name, { rev: (r.wifi as { rev: number }).rev, at: Date.now() });
  return r.error ? json({ error: r.error }, r.status) : json(r.wifi);
}

/** /setup: the whole setup in the browser over Web Serial (public/setup.html, public/setup/). Public: the person signs
 *  in part-way through, in a popup (/setup/signed-in), so the page keeps its board connection. Its own CSP: the 3D
 *  board's mesh decoder is WebAssembly, and its screen frames are drawn into data: textures. */
async function setupPage(env: Env, req: Request, url: URL): Promise<Response> {
  const res = await asset(env, req, url, "/setup");
  res.headers.set("content-security-policy", "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; font-src 'self'; " +
    "img-src 'self' data: blob:; connect-src 'self' data: blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  return res;
}
/** The sign-in popup's last page (a session is required, so without one it goes through /login first). */
function setupSignedIn(): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Signed in</title><link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="stylesheet" href="/setup/setup.css"><main class="setup"><section class="step"><h1>Signed in</h1><p class="sub">You can close this window.</p></section></main>
<script src="/setup/signed-in.js"></script>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY",
    "content-security-policy": "default-src 'self'; frame-ancestors 'none'; form-action 'none'" } });
}

/** Mutations must come from the app itself (defence in depth on top of SameSite cookies / Access). */
function sameOrigin(req: Request, url: URL): boolean {
  const o = req.headers.get("origin");
  if (o) return o === url.origin;
  const site = req.headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
}

async function reprocess(env: Env, ctx: ExecutionContext, id: string, name = "default") {
  const box = inbox(env, name);
  const { rec: r, refused } = await box.reprocess(id);
  if (refused) return json({ error: `Daily limit reached (${refused}). Add your API key in Settings to raise it, or try again tomorrow.` }, 429);
  if (!r) return json({ error: "not found" }, 404);
  if (!r.audio_key) return json({ error: "no audio to reprocess", ...deviceView(r) }, 409);
  ctx.waitUntil(runInline(env, { inbox: name, tz: await box.tz() }, id, r.gen, ""));
  return json({ ...deviceView(r), gen: r.gen }, 202);
}

// ---------- admin (bearer token; scripts / tests / migration) ----------
async function handleAdmin(req: Request, env: Env, url: URL, ctx: ExecutionContext): Promise<Response> {
  const box = inbox(env);
  const path = url.pathname;
  if (path === "/admin/config") {
    if (req.method === "POST") return json(await box.setConfig((await req.json()) as any));
    return json(await box.spend());
  }
  if (path === "/admin/sweep" && req.method === "POST") { await sweepAll(env); return json({ ok: true }); }
  if (path === "/admin/accounts" && req.method === "GET") {
    const accts = await dirStub(env).accounts();
    return json(await Promise.all(accts.map(async (a) => ({ ...a, config: await inbox(env, a.inbox).config(), boards: await dirStub(env).boards(a.inbox) }))));
  }
  // Wi-Fi places from the command line (same validation as the web app; passwords never returned).
  if (path === "/admin/wifi") {
    if (req.method === "GET") return json(await box.wifiList());
    if (req.method === "POST") return result(await box.wifiAdd(await req.json().catch(() => null)));
  }
  if (path.startsWith("/admin/test/") && env.TEST_HOOKS === "1" && req.method === "POST") {
    const body = (await req.json().catch(() => ({}))) as any;
    // ?inbox=u:<user id>: a test account's inbox (screenshots, e2e); default: the owner's.
    const q = url.searchParams.get("inbox");
    const tb = q && /^u:[A-Za-z0-9_-]{1,64}$/.test(q) ? inbox(env, q) : box;
    if (path === "/admin/test/seed") return json(await tb.testSeed(Number(body.n) || 200));
    if (path === "/admin/test/record") return json(await tb.testInsert(body));
    if (path === "/admin/test/purge") return json(await tb.testPurge(Array.isArray(body.prefixes) ? body.prefixes : []));
    if (path === "/admin/test/devices") return json(await tb.testDevices(!!body.clear, typeof body.key === "string" ? body.key : undefined));
    if (path === "/admin/test/drop") return json(await tb.testDrop());
    if (path === "/admin/test/openbelt") return json(await tb.testOpenbelt(String(body.token ?? ""), String(body.workspace ?? "test")));
  }
  let d = path.match(/^\/admin\/devices\/([A-Za-z0-9_-]{1,32})$/);
  if (d && req.method === "DELETE") return json(await box.removeDevice(d[1]));
  let m = path.match(/^\/admin\/records\/([A-Za-z0-9_-]+)$/);
  if (m && req.method === "DELETE") {
    const r = (await box.remove(m[1])) as { deleted: number; audio_key?: string | null };
    if (r.audio_key && url.searchParams.has("audio")) { await env.AUDIO.delete(r.audio_key); return json({ ...r, audio_deleted: true }); }
    return json(r);
  }
  if (m) {
    const r = await box.get(m[1]);
    return r ? json({ ...webRecord(r), events: await box.events(m[1]) }) : json({ error: "not found" }, 404);
  }
  m = path.match(/^\/admin\/records\/([A-Za-z0-9_-]+)\/reprocess$/);
  if (m && req.method === "POST") return reprocess(env, ctx, m[1]);
  m = path.match(/^\/admin\/agents\/([A-Za-z0-9_-]+)$/);
  if (m) return json(await (await agentStub(env, "default", m[1])).status());
  if (path === "/admin/records") return json((await box.list(true)).map((r) => ({ id: r.id, status: r.status, kind: r.kind, title: r.title, via: r.via, received_at: r.received_at, done_at: r.done_at, agent_cost: r.agent_cost })));
  return new Response("not found", { status: 404 });
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    // Sign-in (Better Auth): its API, OAuth discovery for connectors, and the pages that sign you in.
    // Old addresses (pocketbot.ca, workers.dev) keep serving boards (/v1) and /admin; people go to the app's own address.
    if (env.APP_ORIGIN && url.origin !== env.APP_ORIGIN && !/^\/(v1|admin)(\/|$)/.test(path))
      return Response.redirect(`${env.APP_ORIGIN}${path}${url.search}`, 301);
    if (path.startsWith("/api/auth/") || path.startsWith("/.well-known/oauth-")) return handleAuth(req, env, url);
    if (["/login", "/consent"].includes(path)) return asset(env, req, url, path);
    if (path === "/api/sign-in-options") return json({ google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET), password: env.TEST_HOOKS === "1" });
    if (path === "/setup" && req.method === "GET") return setupPage(env, req, url);
    if (req.method === "GET" && /^\/[\w./-]+\.(css|js|woff2|png|svg|webmanifest|ico|json|glb|webp)$/.test(path) && !/^\/(api|audio|v1|admin)\//.test(path))
      return asset(env, req, url, path); // static files: public, the sign-in pages need them before there is a session
    if (path === "/v1/setup" || path.startsWith("/v1/setup/")) return handleSetup(req, env, url, path); // no token yet
    if (path === "/v1/ping") return new Response(null, { status: 204, headers: { "cache-control": "no-store" } }); // the board's "wifi test"
    if (path === "/install") return Response.redirect(`${url.origin}/setup`, 301); // the old CLI installer's address
    // Connectors: an OAuth access token bound to this resource (401 + resource metadata otherwise).
    if (path === "/v1/mcp") {
      return withMcpOAuth(env, url, async (r, userId) => {
        const u = await userById(env, userId);
        return u ? handleMcp(r, env, (await accountFor(env, u)).inbox) : new Response("unknown user", { status: 403 });
      })(req);
    }
    if (path === "/admin/auth-migrate" && req.method === "POST" && safeEqual(bearer(req), env.DEVICE_TOKEN)) return json(await authMigrate(env, url.origin));
    if (path.startsWith("/admin/")) {
      if (!safeEqual(bearer(req), env.DEVICE_TOKEN)) return new Response("unauthorized", { status: 401 });
      return handleAdmin(req, env, url, ctx);
    }
    if (path.startsWith("/v1/")) {
      const a = await tokenAuth(req, env);
      if (!a) return new Response("unauthorized", { status: 401 });
      const fw = firmwareHeader(req);
      if (!a.seen && a.hash && fw) { // first request from the device itself (X-PV-FW; not the setup tool) = it checked in
        a.seen = true;
        ctx.waitUntil(dirStub(env).seen(a.hash, fw).catch(() => {}));
      }
      noteTelemetry(env, ctx, req, url, a.inbox);
      return withWifiRev(req, env, await handleDevice(req, env, ctx, url, path, { inbox: a.inbox, tz: a.tz }), a.inbox);
    }
    const who = await webAccount(req, env);
    if (!who) {
      if (req.method === "GET" && !path.startsWith("/api/") && !path.startsWith("/audio/")) return Response.redirect(`${url.origin}/login?next=${encodeURIComponent(path + url.search)}`, 302);
      return json({ error: "sign in first" }, 401);
    }
    return handleWeb(req, env, url, ctx, path, who);
  },
  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(sweepAll(env));
  },
} satisfies ExportedHandler<Env>;
