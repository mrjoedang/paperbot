// Pure helpers (no Workers imports) so `node --test` can unit-test them: device telemetry parsing,
// web PATCH validation, live-event shaping.

// ---------- device telemetry (docs/device-api.md §8) ----------

/** Same mapping as firmware/core/src/pv_util.cpp batteryPercent() (LiPo curve, 3.3 V = 0 %, 4.2 V = 100 %). */
export function batteryPercent(mv: number | null | undefined): number | null {
  if (mv == null || !Number.isFinite(mv) || mv < 0) return null;
  const V = [3300, 3500, 3600, 3700, 3750, 3800, 3900, 4000, 4100, 4200];
  const P = [0, 5, 10, 20, 30, 45, 60, 75, 90, 100];
  if (mv <= V[0]) return 0;
  for (let i = 1; i < V.length; i++)
    if (mv <= V[i]) return P[i - 1] + Math.trunc(((P[i] - P[i - 1]) * (mv - V[i - 1])) / (V[i] - V[i - 1]));
  return 100;
}

export type ReqKind = "upload" | "result" | "updates" | "firmware" | "tasks" | "status" | "wifi" | "other";

export interface Telemetry {
  key: string | null; // 12-hex MAC from the clip id / ?device=, null = unknown (merged into the latest device)
  prefix: string; // id prefix ("sim-", "ui-", "" for the board)
  fw: string | null;
  batt_mv: number | null;
  usb: boolean | null;
  req: ReqKind;
  id: string | null; // clip id of this request (upload / single result)
  pending: number | null; // ids asked for in /v1/updates (results the device still waits for)
  sim: boolean; // the simulator sends X-Sim-Now-Ms
  wifi_rev: number | null; // X-PV-Wifi-Rev: the Wi-Fi list revision the device has
}

const MAC_ID = /^(.*?)([0-9a-f]{12})-\d{1,9}-[0-9a-f]{4,16}$/i;
/** Device MAC (+ id prefix) encoded in a clip id: `[prefix]<12 hex MAC>-<seq>-<rand>`. */
export function macFromId(id: string): { key: string; prefix: string } | null {
  const m = id.match(MAC_ID);
  return m ? { key: m[2].toLowerCase(), prefix: m[1].slice(0, 16) } : null;
}

const clean = (s: string | null, n: number) => (s ? s.replace(/[^\x20-\x7e]/g, "").trim().slice(0, n) || null : null);

export function parseTelemetry(header: (name: string) => string | null, url: URL, method: string): Telemetry | null {
  const fw = clean(header("x-pv-fw") ?? header("x-firmware-version") ?? header("x-pv-firmware") ?? header("x-fw-version"), 24);
  const battRaw = header("x-pv-batt");
  const usbRaw = header("x-pv-usb");
  const mv = battRaw != null && /^\s*\d{1,5}\s*$/.test(battRaw) ? Number(battRaw) : null;
  const batt_mv = mv != null && mv > 0 && mv < 6000 ? mv : null;
  const usb = usbRaw == null ? null : usbRaw.trim() === "1" ? true : usbRaw.trim() === "0" ? false : null;
  const revRaw = header("x-pv-wifi-rev");
  const wifi_rev = revRaw != null && /^\s*\d{1,9}\s*$/.test(revRaw) ? Number(revRaw) : null;
  // Only device-looking requests are telemetry (scripts / tests without these headers are not a device).
  if (!fw && batt_mv == null && usb == null && wifi_rev == null) return null;

  const path = url.pathname;
  let req: ReqKind = "other", id: string | null = null, pending: number | null = null, dev: { key: string; prefix: string } | null = null;
  let m = path.match(/^\/v1\/recordings\/([A-Za-z0-9_-]{1,64})$/);
  if (m) { id = m[1]; req = method === "PUT" ? "upload" : "result"; dev = macFromId(id); }
  else if (path === "/v1/updates") {
    req = "updates";
    const ids = (url.searchParams.get("ids") ?? "").split(",").filter(Boolean);
    pending = ids.length;
    for (const x of ids) if ((dev = macFromId(x))) break;
  } else if (path.startsWith("/v1/firmware")) {
    req = "firmware";
    const d = (url.searchParams.get("device") ?? "").toLowerCase();
    if (/^[0-9a-f]{12}$/.test(d)) dev = { key: d, prefix: "" };
  } else if (path === "/v1/tasks") req = "tasks";
  else if (path === "/v1/status") req = "status";
  else if (path === "/v1/wifi") req = "wifi";
  return { key: dev?.key ?? null, prefix: dev?.prefix ?? "", fw, batt_mv, usb, req, id, pending, sim: header("x-sim-now-ms") != null, wifi_rev };
}

/** Isolate-level throttle: is this telemetry worth a Durable Object round trip? */
export function telemetrySig(t: Telemetry): string {
  return [t.key, t.fw, t.batt_mv == null ? "" : Math.round(t.batt_mv / 25), t.usb, t.req, t.pending, t.wifi_rev].join("|");
}

// ---------- web PATCH ----------
/** Actions a person may switch a memo to on the web: research or app start the agent. */
export const WEB_KINDS = ["research", "app", "ignore"] as const;
/** A memo is open or archived. Whether a saved memo is done comes from its items on the List (web app, belt.js), never set here. */
export const STATES = ["open", "archived"] as const;
const ISO_DUE = /^20\d\d-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?)?$/;

export type Patch = { title?: string; kind?: (typeof WEB_KINDS)[number]; due?: string | null; state?: (typeof STATES)[number] };

export function validatePatch(body: unknown): { ok: true; patch: Patch } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const patch: Patch = {};
  for (const k of Object.keys(b)) if (!["title", "kind", "due", "state"].includes(k)) return { ok: false, error: `unknown field: ${k.slice(0, 20)}` };
  if ("title" in b) {
    if (typeof b.title !== "string") return { ok: false, error: "title must be a string" };
    const t = b.title.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
    if (!t) return { ok: false, error: "title is empty" };
    if (t.length > 120) return { ok: false, error: "title longer than 120 characters" };
    patch.title = t;
  }
  if ("kind" in b) {
    if (!WEB_KINDS.includes(b.kind as any)) return { ok: false, error: `kind must be one of ${WEB_KINDS.join(", ")}` };
    patch.kind = b.kind as Patch["kind"];
  }
  if ("due" in b) {
    if (b.due === null || b.due === "") patch.due = null;
    else if (typeof b.due === "string" && ISO_DUE.test(b.due)) patch.due = b.due;
    else return { ok: false, error: "due must be null or YYYY-MM-DD[THH:MM]" };
  }
  if ("state" in b) {
    if (!STATES.includes(b.state as any)) return { ok: false, error: "state must be open or archived" };
    patch.state = b.state as Patch["state"];
  }
  if (!Object.keys(patch).length) return { ok: false, error: "nothing to change" };
  return { ok: true, patch };
}

// ---------- agent progress steps ----------
export type StepKind = "search" | "read" | "write" | "think" | "note" | "error";
export type Step = { at: number; kind: StepKind; text: string };

const host = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return String(u).slice(0, 60); } };

/** One human-readable research-log line for a tool call (null = not worth showing). */
export function toolStep(name: string, args: Record<string, unknown> | undefined, at = Date.now()): Step | null {
  const a = args ?? {};
  const s = (v: unknown, n = 90) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  if (name === "web_search") return { at, kind: "search", text: s(a.query) || "(empty query)" };
  if (name === "web_fetch") return { at, kind: "read", text: host(String(a.url ?? "")) + pathHint(String(a.url ?? "")) };
  if (name === "write") return { at, kind: "write", text: s(a.path, 60) || "report" };
  if (name === "edit") return { at, kind: "write", text: `editing ${s(a.path, 60)}` };
  // App builds (OpenBelt's tools, src/openbelt.ts BUILD_TOOLS): call runs an operation, shown as that operation
  if (name === "call" && typeof a.tool === "string") return toolStep(a.tool, (a.args ?? {}) as Record<string, unknown>, at);
  if (name === "docs") return { at, kind: "read", text: `OpenBelt docs${a.page ? `: ${s(a.page, 40)}` : ""}` };
  if (name === "search") return { at, kind: "search", text: `your apps: ${s(a.query, 60) || "all"}` };
  if (name === "deploy_app") return { at, kind: "write", text: `${a.preview ? "trying" : "deploying"} ${s(a.app, 40)}${a.preview ? " in a preview" : ""}` };
  if (name === "check_app") return { at, kind: "read", text: `checking ${s(a.app, 40)} in a browser` };
  if (name === "promote_app") return { at, kind: "write", text: `taking ${s(Array.isArray(a.apps) ? a.apps.join(", ") : a.app, 40)} live` };
  if (name === "app_files" || name === "app_info" || name === "app_diff" || name === "app_logs") return { at, kind: "read", text: `reading ${s(a.app, 40)}` };
  return null;
}
function pathHint(u: string) {
  try { const p = new URL(u).pathname; return p && p !== "/" ? (p.length > 40 ? p.slice(0, 39) + "…" : p) : ""; } catch { return ""; }
}

/** First sentence of the model's visible text in a turn (its "thinking out loud"), or null. */
export function thoughtStep(message: { content?: unknown } | undefined, at = Date.now()): Step | null {
  const parts = Array.isArray(message?.content) ? (message!.content as any[]) : [];
  const text = parts.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join(" ").replace(/\s+/g, " ").trim();
  if (!text || /^SUMMARY:/i.test(text)) return null;
  const first = text.split(/(?<=[.!?])\s/)[0];
  return { at, kind: "think", text: first.length > 140 ? first.slice(0, 139) + "…" : first };
}

// ---------- device status reports: POST /v1/status (docs/device-api.md §7) ----------
export const RESETS = ["poweron", "sw", "panic", "int_wdt", "task_wdt", "wdt", "brownout", "usb", "deepsleep", "other"] as const;
export const CRASH_RESETS = new Set(["panic", "int_wdt", "task_wdt", "wdt", "brownout"]);
const STAT_KEYS = ["clips", "uploads", "upload_fail", "wifi_fail", "dups", "quarantined", "dropped_bytes", "too_short", "epd_timeouts", "results", "check_fail"] as const;
export const STATUS_MAX_BYTES = 16 * 1024; // contract: ≤ 2 KB typical; a 40-line log can be larger, so accept up to 16 KB

export type DeviceStatus = {
  v: number; id: string | null; fw: string | null; slot: number | null; reset: string | null; boot_n: number | null; up_s: number | null;
  batt_mv: number | null; usb: boolean | null; rssi: number | null; connect_ms: number | null; heap: number | null; heap_min: number | null;
  q: number | null; pending: number | null; awake_ms: number | null; sleep_ms: number | null;
  stats: Partial<Record<(typeof STAT_KEYS)[number], number>>; log: string[] | null;
};

const num = (v: unknown, lo: number, hi: number): number | null => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : null);
const cleanLine = (s: string, n: number) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").slice(0, n);

/** Validate a status report. Unknown fields are ignored, missing ones are null, out-of-range numbers dropped. */
export function parseStatus(body: unknown): { ok: true; status: DeviceStatus } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be a JSON object" };
  const b = body as Record<string, any>;
  const id = typeof b.id === "string" && /^[0-9a-fA-F]{12}$/.test(b.id) ? b.id.toLowerCase() : null;
  const stats: DeviceStatus["stats"] = {};
  if (b.stats && typeof b.stats === "object") for (const k of STAT_KEYS) { const v = num(b.stats[k], 0, 1e12); if (v != null) stats[k] = v; }
  let log: string[] | null = null;
  if (Array.isArray(b.log)) log = b.log.filter((l: unknown) => typeof l === "string").slice(-40).map((l: string) => cleanLine(l, 160));
  const usb = b.usb === 1 || b.usb === true ? true : b.usb === 0 || b.usb === false ? false : null;
  return {
    ok: true,
    status: {
      v: num(b.v, 0, 1000) ?? 1, id, fw: typeof b.fw === "string" ? clean(b.fw, 24) : null, slot: num(b.slot, 0, 15),
      reset: typeof b.reset === "string" ? (RESETS.includes(b.reset as any) ? b.reset : "other") : null,
      boot_n: num(b.boot_n, 0, 1e9), up_s: num(b.up_s, 0, 1e10), batt_mv: num(b.batt_mv, 1, 6000), usb, rssi: num(b.rssi, -127, 0),
      connect_ms: num(b.connect_ms, 0, 600_000), heap: num(b.heap, 0, 1e9), heap_min: num(b.heap_min, 0, 1e9), q: num(b.q, 0, 1e6),
      pending: num(b.pending, 0, 1e6), awake_ms: num(b.awake_ms, 0, 1e11), sleep_ms: num(b.sleep_ms, 0, 1e11), stats, log,
    },
  };
}

/** Battery drain estimate from samples (oldest first). Uses the newest stretch off USB; needs ≥ 3 samples over ≥ 2 h. */
export function batteryTrend(samples: { at: number; mv: number; usb: boolean | null }[], now = Date.now()) {
  const recent = samples.filter((s) => now - s.at <= 7 * 86400_000);
  let i = recent.length - 1;
  while (i >= 0 && !recent[i].usb) i--;
  const seg = recent.slice(i + 1); // after the last sample on USB
  if (seg.length < 3 || seg[seg.length - 1].at - seg[0].at < 2 * 3600_000) return null;
  const xs = seg.map((s) => (s.at - seg[0].at) / 3600_000), ys = seg.map((s) => s.mv);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0, sxx = 0;
  for (let k = 0; k < xs.length; k++) { sxy += (xs[k] - mx) * (ys[k] - my); sxx += (xs[k] - mx) ** 2; }
  if (!sxx) return null;
  const slope = sxy / sxx; // mV per hour
  const mvNow = my + slope * (xs[xs.length - 1] - mx);
  const days = slope < -0.05 ? Math.max(0, (mvNow - 3300) / -slope / 24) : null;
  return { mv_per_h: +slope.toFixed(2), days_left: days == null ? null : +days.toFixed(1), since: seg[0].at, samples: seg.length };
}

type Row = { at: number; s: DeviceStatus };
/** Aggregates over the last 24 h of status reports (oldest first). Cumulative counters are per boot. */
export function statusHealth(rows: Row[], now = Date.now()) {
  const day = rows.filter((r) => now - r.at <= 86400_000);
  let awake = 0, sleep = 0, wifiFail = 0, uploadFail = 0, conn = 0, connN = 0;
  for (let k = 0; k < day.length; k++) {
    const s = day[k].s;
    awake += s.awake_ms ?? 0; sleep += s.sleep_ms ?? 0;
    if (s.connect_ms != null) { conn += s.connect_ms; connN++; }
    const prevAll = rows[rows.indexOf(day[k]) - 1]?.s;
    const sameBoot = prevAll && prevAll.boot_n != null && prevAll.boot_n === s.boot_n;
    const delta = (key: "wifi_fail" | "upload_fail") => Math.max(0, (s.stats[key] ?? 0) - (sameBoot ? prevAll!.stats[key] ?? 0 : 0));
    wifiFail += delta("wifi_fail"); uploadFail += delta("upload_fail");
  }
  const last = rows[rows.length - 1]?.s;
  const lastDuty = last && last.awake_ms != null && last.sleep_ms != null && last.awake_ms + last.sleep_ms > 0 ? last.awake_ms / (last.awake_ms + last.sleep_ms) : null;
  return {
    reports_24h: day.length, duty_24h: awake + sleep > 0 ? +(awake / (awake + sleep)).toFixed(4) : null, duty_last: lastDuty == null ? null : +lastDuty.toFixed(4),
    awake_ms_24h: awake, connect_avg_ms: connN ? Math.round(conn / connN) : null, wifi_fail_24h: wifiFail, upload_fail_24h: uploadFail,
  };
}

export type Alert = { code: "unheard" | "battery_low" | "crash" | "wifi" | "epd"; level: "warn" | "bad"; text: string; at: number };
/** What Bolt should worry about. `crashes` = crash events newer than the last time the owner looked. */
export function deviceAlerts(d: { last_seen: number; batt_pct: number | null; usb: boolean | null }, health: ReturnType<typeof statusHealth> | null,
  crashes: { at: number; reset: string }[], last: DeviceStatus | null, now = Date.now()): Alert[] {
  const a: Alert[] = [];
  for (const c of crashes) a.push({ code: "crash", level: "bad", at: c.at, text: c.reset === "brownout" ? "brownout reset (battery sagged under load)" : `crashed (${c.reset})` });
  if (now - d.last_seen > 24 * 3600_000) a.push({ code: "unheard", level: "warn", at: d.last_seen, text: "not heard from in over a day" });
  if (d.batt_pct != null && d.batt_pct < 15 && !d.usb) a.push({ code: "battery_low", level: d.batt_pct < 5 ? "bad" : "warn", at: d.last_seen, text: `battery at ${d.batt_pct}%` });
  if (health && health.wifi_fail_24h >= 3) a.push({ code: "wifi", level: "warn", at: d.last_seen, text: `${health.wifi_fail_24h} Wi-Fi failures in 24 h` });
  if (last?.stats.epd_timeouts) a.push({ code: "epd", level: "warn", at: d.last_seen, text: `${last.stats.epd_timeouts} display timeouts since boot` });
  return a;
}

// ---------- Wi-Fi networks (docs/device-api.md §9) ----------
export const WIFI_MAX = 8;
export const utf8Len = (s: string) => new TextEncoder().encode(s).length;

export type WifiInput = { ssid?: string; psk?: string; open?: boolean; name?: string; note?: string; fallback?: boolean };
/** Validate a network from the web app. SSIDs are kept byte-exact (no trimming / normalisation). */
export function validateWifi(b: unknown, partial = false): { ok: true; v: WifiInput } | { ok: false; error: string } {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { ok: false, error: "body must be a JSON object" };
  const o = b as Record<string, unknown>, v: WifiInput = {};
  for (const k of Object.keys(o)) if (!["ssid", "psk", "open", "name", "note", "fallback"].includes(k)) return { ok: false, error: `unknown field: ${k.slice(0, 20)}` };
  if ("ssid" in o || !partial) {
    if (typeof o.ssid !== "string" || !o.ssid.length) return { ok: false, error: "network name (SSID) is required" };
    if (utf8Len(o.ssid) > 32) return { ok: false, error: `SSID is ${utf8Len(o.ssid)} bytes; the limit is 32 bytes (UTF-8)` };
    if (/[\u0000]/.test(o.ssid)) return { ok: false, error: "SSID contains a NUL character" };
    v.ssid = o.ssid;
  }
  if ("open" in o) v.open = o.open === true;
  if ("psk" in o) {
    if (typeof o.psk !== "string") return { ok: false, error: "password must be a string" };
    if (o.psk.length && (o.psk.length < 8 || o.psk.length > 63)) return { ok: false, error: "WPA passwords are 8–63 characters" };
    if (!/^[\x20-\x7e]*$/.test(o.psk)) return { ok: false, error: "password must be printable ASCII (WPA2 passphrase)" };
    v.psk = o.psk;
  }
  if (v.open && v.psk) return { ok: false, error: "an open network has no password" };
  for (const k of ["name", "note"] as const) if (k in o) {
    if (typeof o[k] !== "string") return { ok: false, error: `${k} must be a string` };
    v[k] = (o[k] as string).replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, k === "name" ? 40 : 120);
  }
  if ("fallback" in o) v.fallback = o.fallback === true;
  return { ok: true, v };
}

/** Device list body (§9): ≤ 8 networks, ≤ 2 KB. Networks still waiting for a password are left out. */
export function wifiDeviceBody(rev: number, nets: { ssid: string; psk: string; prio: number; usable: boolean }[]): string {
  const list = nets.filter((n) => n.usable).sort((a, b) => a.prio - b.prio).slice(0, WIFI_MAX).map(({ ssid, psk, prio }) => ({ ssid, psk, prio }));
  let body = JSON.stringify({ rev, networks: list });
  while (new TextEncoder().encode(body).length > 2048 && list.length) { list.pop(); body = JSON.stringify({ rev, networks: list }); }
  return body;
}
