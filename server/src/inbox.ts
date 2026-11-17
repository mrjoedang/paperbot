// Inbox: one SQLite Durable Object holding every recording record (the idempotency key is the clip id)
// plus the work-agent coordinator (max concurrent agents, daily spend cap).
import { DurableObject } from "cloudflare:workers";

import { agentStub, type Env } from "./env";
import {
  batteryPercent, batteryTrend, CRASH_RESETS, deviceAlerts, statusHealth, validateWifi, WIFI_MAX, wifiDeviceBody,
  type DeviceStatus, type Patch, type Step, type Telemetry, type WifiInput,
} from "./logic";
import { AGENT_ACTIONS, localNow, type Action, type Outcome } from "./pipeline";
import { allItems, applyChanges, apps, Belt, ensureApp, NotConnected, picture, setDone, type AppState, type Saved } from "./items";
import { authorizeUrl, exchange, Mcp, pkceChallenge, randomToken, refresh, register, revoke } from "./openbelt";

export type Status = "processing" | "done" | "researching" | "paused_budget" | "stopped" | "error";

export interface Rec {
  id: string; received_at: number; status: Status; kind: Action | null; // the router's action (src/pipeline.ts)
  title: string | null; due: string | null; summary: string | null; error: string | null; detail: string | null;
  transcript: string | null; noise_reason: string | null;
  items: string | null; // save: JSON Saved[], what changed in the person's OpenBelt app (src/items.ts)
  seconds: number | null; rms: number | null; active_sec: number | null; bytes: number; audio_key: string | null;
  fw: string | null; gen: number; attempts: number; via: string | null; processing_since: number;
  done_at: number | null; timings: string | null; state: "open" | "archived"; wf_instance: string | null;
  // external: waits for the person's own Claude (MCP); needs_openbelt: an app or save memo waiting for Connect OpenBelt.
  agent_state: "queued" | "running" | "finished" | "external" | "needs_openbelt" | null; agent_day: string | null; agent_started_at: number | null;
  agent_finished_at: number | null; agent_cost: number | null; agent_outcome: string | null; agent_model: string | null;
  agent_result: string | null; test_flags: string | null; agent_progress: string | null;
}

export type Device = {
  key: string; prefix: string; sim: boolean; fw: string | null; batt_mv: number | null; batt_pct: number | null; usb: boolean | null;
  first_seen: number; last_seen: number; last_req: string | null; last_id: string | null; pending: number | null; reqs: number;
  status: DeviceStatus | null; status_at: number | null; want_log: boolean; ack_at: number | null; wifi_rev: number | null; wifi_fetched: number | null;
  health: ReturnType<typeof statusHealth> | null; trend: ReturnType<typeof batteryTrend>; alerts: ReturnType<typeof deviceAlerts>;
};
const DAY_MS = 86400_000;
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// research_included: 1 = work memos are researched here (owner; paid by the deployment), 0 = they wait
// for the person's own Claude (MCP connector, src/mcp.ts). audio_cap_min: audio minutes per 24 h (0 = no cap).
// free_builds_month: app builds a month on paperbot's account for someone without included research or their own key.
export const DEFAULTS = { daily_cap_usd: 2, max_concurrent: 2, task_cap_usd: 0.15, research_included: 1, audio_cap_min: 0, free_builds_month: 20 };
/** Per-task hard cap of an app build: it reads OpenBelt's docs and checks the app in a browser, so it costs more than research. */
export const BUILD_CAP_USD = 0.25;
/** Everyone but the owner: their own Claude does the research, transcription is capped (docs/setup.md). */
export const GUEST_CONFIG: Partial<Config> = { research_included: 0, audio_cap_min: 30, daily_cap_usd: 0 };
export type Config = typeof DEFAULTS;

// ---------- device view ----------
const FOLD: Record<string, string> = { "≈": "~", "×": "x", "–": "-", "—": "-", "‘": "'", "’": "'", "“": '"', "”": '"', "…": "...", "→": "->", "≤": "<=", "≥": ">=", "•": "-", "°": " deg", "µ": "u" };
/** Device-safe text: common symbols folded to ASCII, whitespace collapsed, cut to `bytes` UTF-8 bytes. */
export function deviceText(s: string, bytes: number): string {
  let t = s.replace(/[≈×–—‘’“”…→≤≥•°µ]/g, (c) => FOLD[c] ?? "?").replace(/\s+/g, " ").trim();
  const enc = new TextEncoder();
  if (enc.encode(t).length <= bytes) return t;
  while (enc.encode(t + "...").length > bytes) t = t.slice(0, -1);
  return t.trimEnd() + "...";
}

/** Firmware that shows an answer on a screen of its own (kind "answer", summary up to 120 bytes). */
export const ANSWER_FW = "1.2.0";
const fwAtLeast = (fw: string | null, min: string) => {
  const a = (fw ?? "").match(/^(\d+)\.(\d+)\.(\d+)/), b = min.split(".").map(Number);
  if (!a) return false;
  for (let i = 0; i < 3; i++) if (+a[i + 1] !== b[i]) return +a[i + 1] > b[i];
  return true;
};
export const itemsOf = (r: Pick<Rec, "items">): Saved[] => { try { const v = r.items ? JSON.parse(r.items) : []; return Array.isArray(v) ? v : []; } catch { return []; } };

/** The object the device sees (docs/device-api.md §2). The board's kinds are older than the router's actions: a saved
 *  item shows as its list (todo, shopping, reminder, note) or done / removed, ignore as noise, research and app as work. */
export function deviceView(r: Rec): Record<string, unknown> {
  const v: Record<string, unknown> = { id: r.id, status: r.status };
  if (r.status === "processing") return v;
  if (r.status === "error") return { ...v, error: r.error ?? "error" };
  const items = r.kind === "save" ? itemsOf(r) : [], item = items[0];
  const answers = fwAtLeast(r.fw, ANSWER_FW);
  v.kind = r.kind === "ignore" ? "noise" : r.kind === "save" ? (item?.op === "done" ? "done" : item?.op === "drop" ? "removed" : item?.list ?? "note")
    : r.kind === "answer" ? (answers ? "answer" : "work") : "work";
  v.title = deviceText(items.length ? items.map((i) => i.title).join(", ") : r.title ?? "", 95);
  v.due = item?.due ?? r.due;
  if (r.status === "done" && r.summary && r.kind !== "save" && r.kind !== "ignore") v.summary = deviceText(r.summary, r.kind === "answer" && answers ? 120 : 60);
  if ((r.status === "stopped" || r.status === "paused_budget") && r.error) v.error = deviceText(r.error, 60);
  return v;
}

const parse = (s: string | null) => { if (!s) return null; try { return JSON.parse(s); } catch { return null; } };
/** The object the web app sees (live events + /api). Untrusted text stays text: the client escapes it. */
export function webRecord(r: Rec, steps?: Step[]) {
  const { test_flags: _t, wf_instance: _w, agent_result, timings, agent_progress, items, ...rest } = r;
  return { ...rest, items: parse(items), agent_result: parse(agent_result), timings: parse(timings), agent_progress: parse(agent_progress), steps: steps ?? [], device: deviceView(r) };
}

const DEVICE_EMIT_MS = 10_000; // at most one unchanged-telemetry broadcast per 10 s

export class Inbox extends DurableObject<Env> {
  sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS records (
      id TEXT PRIMARY KEY, received_at INTEGER NOT NULL, status TEXT NOT NULL, kind TEXT,
      title TEXT, due TEXT, summary TEXT, error TEXT, detail TEXT, transcript TEXT,
      noise_reason TEXT, seconds REAL, rms REAL, active_sec REAL, bytes INTEGER NOT NULL DEFAULT 0, audio_key TEXT,
      fw TEXT, gen INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, via TEXT,
      processing_since INTEGER NOT NULL DEFAULT 0, done_at INTEGER, timings TEXT, state TEXT NOT NULL DEFAULT 'open',
      wf_instance TEXT, agent_state TEXT, agent_day TEXT, agent_started_at INTEGER, agent_finished_at INTEGER,
      agent_cost REAL, agent_outcome TEXT, agent_model TEXT, agent_result TEXT, test_flags TEXT)`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS records_status ON records(status)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS events (at INTEGER, id TEXT, msg TEXT)");
    try { this.sql.exec("ALTER TABLE records ADD COLUMN agent_progress TEXT"); } catch {} // added with the live web app
    try { this.sql.exec("ALTER TABLE records ADD COLUMN items TEXT"); } catch {} // added with the router (saved items)
    this.sql.exec("CREATE TABLE IF NOT EXISTS agent_steps (id TEXT, at INTEGER, kind TEXT, text TEXT)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS agent_steps_id ON agent_steps(id)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS devices (key TEXT PRIMARY KEY, prefix TEXT, sim INTEGER, fw TEXT, batt_mv INTEGER, usb INTEGER,
      first_seen INTEGER, last_seen INTEGER, last_req TEXT, last_id TEXT, pending INTEGER, reqs INTEGER NOT NULL DEFAULT 0)`);
    for (const col of ["status TEXT", "status_at INTEGER", "want_log INTEGER", "ack_at INTEGER", "wifi_rev INTEGER", "wifi_fetched INTEGER", "batt_at INTEGER"])
      try { this.sql.exec(`ALTER TABLE devices ADD COLUMN ${col}`); } catch {}
    this.sql.exec("CREATE TABLE IF NOT EXISTS device_status (key TEXT, at INTEGER, boot_n INTEGER, reset TEXT, json TEXT)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS device_status_at ON device_status(key, at)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS device_events (key TEXT, at INTEGER, kind TEXT, reset TEXT, boot_n INTEGER, fw TEXT, text TEXT, log TEXT)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS batt_samples (key TEXT, at INTEGER, mv INTEGER, usb INTEGER)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS batt_samples_at ON batt_samples(key, at)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS wifi (id TEXT PRIMARY KEY, ssid TEXT NOT NULL, psk_enc TEXT, open INTEGER NOT NULL DEFAULT 0, prio INTEGER NOT NULL,
      name TEXT, note TEXT, created INTEGER, updated INTEGER)`);
    if (!this.kv("wifi_seeded")) { // networks come from `pocketbot setup` (the Mac's saved ones) or the web app
      this.setKv("wifi_seeded", "1");
      this.setKv("wifi_rev", "1");
    }
    if (!this.kv("actions_v1")) this.migrateToActions();
    // Memos had their own "done" (ticked in the inbox); a saved memo is now done when its List items are. Ticked ones were finished: archive them.
    if (!this.kv("states_v2")) { this.sql.exec("UPDATE records SET state = 'archived' WHERE state = 'done'"); this.setKv("states_v2", "1"); }
    // Heartbeats from the web app are answered without waking this object (hibernatable WebSockets).
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** One-time cutover (2026-11): the router's actions replace the old kinds (note, todo, reminder, work, unsure, noise)
   *  and its confidence columns. Items saved before stay here as history; new ones live in the person's OpenBelt app. */
  private migrateToActions() {
    const cols = new Set((this.sql.exec("PRAGMA table_info(records)").toArray() as any[]).map((c) => String(c.name)));
    if (cols.has("guess_kind")) {
      const hasIntent = cols.has("intent");
      for (const r of this.sql.exec(`SELECT id, kind, title, due${hasIntent ? ", intent" : ""} FROM records WHERE kind IS NOT NULL`).toArray() as any[]) {
        const kind = r.kind === "noise" ? "ignore" : r.kind === "work" ? (r.intent === "build" ? "app" : "research") : ["todo", "reminder", "note", "unsure"].includes(r.kind) ? "save" : r.kind;
        const list = r.kind === "todo" || r.kind === "reminder" ? r.kind : "note";
        const items = kind === "save" ? JSON.stringify([{ op: "add", list, title: r.title ?? "", due: r.due ?? null, id: null, ok: false, why: "before OpenBelt", app_url: null }]) : null;
        this.sql.exec("UPDATE records SET kind = ?, items = ? WHERE id = ?", kind, items, r.id);
      }
      for (const c of ["guess_kind", "confidence", "noise_p", "intent"]) if (cols.has(c)) this.sql.exec(`ALTER TABLE records DROP COLUMN ${c}`);
    }
    this.setKv("actions_v1", "1");
  }

  // ---------- live hub (hibernatable WebSockets) ----------
  private lastDeviceEmit = 0;

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response("expected a websocket", { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ t: "snapshot", ...this.snapshot() }));
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    if (msg === "snapshot") ws.send(JSON.stringify({ t: "snapshot", ...this.snapshot() })); // client-requested resync
  }
  webSocketClose(ws: WebSocket, code: number, reason: string) { try { ws.close(code, reason); } catch {} }
  webSocketError() {}

  /** Everything the web app needs to (re)build its state. */
  snapshot() {
    const records = this.sql.exec("SELECT * FROM records ORDER BY received_at DESC LIMIT 500").toArray() as unknown as Rec[];
    const steps = new Map<string, Step[]>();
    for (const s of this.sql.exec("SELECT id, at, kind, text FROM agent_steps ORDER BY at").toArray() as any[]) {
      if (!steps.has(s.id)) steps.set(s.id, []);
      steps.get(s.id)!.push({ at: s.at, kind: s.kind, text: s.text });
    }
    return { now: Date.now(), records: records.map((r) => webRecord(r, steps.get(r.id))), budget: this.spend(), devices: this.devices(), wifi: this.wifiList() };
  }
  private emit(ev: Record<string, unknown>) {
    const sockets = this.ctx.getWebSockets();
    if (!sockets.length) return;
    const s = JSON.stringify({ ...ev, now: Date.now() });
    for (const ws of sockets) { try { ws.send(s); } catch {} }
  }
  private stepsOf(id: string): Step[] {
    return this.sql.exec("SELECT at, kind, text FROM agent_steps WHERE id = ? ORDER BY at", id).toArray() as unknown as Step[];
  }
  /** Broadcast the current state of one record. */
  private changed(id: string) {
    const r = this.get(id);
    if (r) this.emit({ t: "rec", rec: webRecord(r, this.stepsOf(id)) });
  }
  private emitBudget() { this.emit({ t: "budget", budget: this.spend() }); }
  web(id: string) { const r = this.get(id); return r ? webRecord(r, this.stepsOf(id)) : null; }

  // ---------- device telemetry ----------
  devices(): Device[] {
    return (this.sql.exec("SELECT * FROM devices ORDER BY last_seen DESC LIMIT 5").toArray() as any[]).map((d) => this.deviceOf(d));
  }
  device(key: string): Device | null {
    const d = this.sql.exec("SELECT * FROM devices WHERE key = ?", key).toArray()[0];
    return d ? this.deviceOf(d) : null;
  }
  private deviceOf(d: any): Device {
    const now = Date.now();
    const rows = (this.sql.exec("SELECT at, json FROM device_status WHERE key = ? AND at > ? ORDER BY at", d.key, now - 2 * DAY_MS).toArray() as any[])
      .map((r) => ({ at: r.at as number, s: JSON.parse(r.json) as DeviceStatus }));
    const samples = (this.sql.exec("SELECT at, mv, usb FROM batt_samples WHERE key = ? AND at > ? ORDER BY at", d.key, now - 7 * DAY_MS).toArray() as any[])
      .map((r) => ({ at: r.at as number, mv: r.mv as number, usb: r.usb == null ? null : !!r.usb }));
    const crashes = this.sql.exec("SELECT at, reset FROM device_events WHERE key = ? AND kind = 'crash' AND at > ? ORDER BY at DESC LIMIT 5", d.key, d.ack_at ?? 0).toArray() as any[];
    const status = d.status ? (JSON.parse(d.status) as DeviceStatus) : null;
    const health = rows.length ? statusHealth(rows, now) : null;
    const base = {
      key: d.key, prefix: d.prefix ?? "", sim: !!d.sim, fw: d.fw, batt_mv: d.batt_mv, batt_pct: batteryPercent(d.batt_mv), usb: d.usb == null ? null : !!d.usb,
      first_seen: d.first_seen, last_seen: d.last_seen, last_req: d.last_req, last_id: d.last_id, pending: d.pending, reqs: d.reqs,
    };
    return {
      ...base, status: status ? { ...status, log: null } : null, status_at: d.status_at ?? null, want_log: !!d.want_log, ack_at: d.ack_at ?? null,
      wifi_rev: d.wifi_rev ?? null, wifi_fetched: d.wifi_fetched ?? null, health, trend: batteryTrend(samples, now),
      alerts: deviceAlerts(base, health, crashes, status, now),
    };
  }

  // ---------- device status reports (POST /v1/status) ----------
  /** Store one report, derive boot/crash/firmware events, return whether the device should attach its log next time. */
  deviceStatus(st: DeviceStatus, t: Telemetry | null, at?: number): { want_log: boolean } {
    const now = at ?? Date.now();
    const tel: Telemetry = {
      key: st.id ?? t?.key ?? null, prefix: t?.prefix ?? "", fw: st.fw ?? t?.fw ?? null, batt_mv: st.batt_mv ?? t?.batt_mv ?? null, usb: st.usb ?? t?.usb ?? null,
      req: "status", id: null, pending: st.pending ?? t?.pending ?? null, sim: t?.sim ?? false, wifi_rev: t?.wifi_rev ?? null,
    };
    const key = this.telemetry(tel, now, false);
    const prev = this.sql.exec("SELECT boot_n, json FROM device_status WHERE key = ? AND at <= ? ORDER BY at DESC LIMIT 1", key, now).toArray()[0] as any;
    const prevS = prev ? (JSON.parse(prev.json) as DeviceStatus) : null;
    const { log, ...rest } = st;
    this.sql.exec("INSERT INTO device_status VALUES (?, ?, ?, ?, ?)", key, now, st.boot_n, st.reset, JSON.stringify(rest));
    this.sql.exec("DELETE FROM device_status WHERE at < ?", now - 30 * DAY_MS);
    this.sql.exec("DELETE FROM batt_samples WHERE at < ?", now - 30 * DAY_MS);
    this.sql.exec("DELETE FROM device_events WHERE at < ?", now - 90 * DAY_MS);
    if (st.batt_mv != null) {
      this.sql.exec("INSERT INTO batt_samples VALUES (?, ?, ?, ?)", key, now, st.batt_mv, st.usb == null ? null : st.usb ? 1 : 0);
      this.sql.exec("UPDATE devices SET batt_at = ? WHERE key = ?", now, key);
    }
    const events: Record<string, unknown>[] = [];
    const ev = (kind: string, text: string, withLog: boolean) => {
      const lg = withLog && log?.length ? JSON.stringify(log) : null;
      this.sql.exec("INSERT INTO device_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)", key, now, kind, st.reset, st.boot_n, st.fw, text, lg);
      events.push({ key, at: now, kind, reset: st.reset, boot_n: st.boot_n, fw: st.fw, text, log: lg ? log : null });
    };
    const newBoot = !prevS || (st.boot_n != null && prevS.boot_n !== st.boot_n);
    let logUsed = false;
    if (newBoot && st.reset && CRASH_RESETS.has(st.reset)) { ev("crash", st.reset === "brownout" ? "brownout reset" : `crash: ${st.reset}`, true); logUsed = true; }
    else if (newBoot && prevS) ev("boot", `restarted (${st.reset ?? "unknown"})`, false);
    if (prevS?.fw && st.fw && prevS.fw !== st.fw) ev("firmware", `firmware ${prevS.fw} -> ${st.fw}`, false);
    if (log?.length && !logUsed) { ev("log", "log attached", true); }
    if (log?.length) this.sql.exec("UPDATE devices SET want_log = 0 WHERE key = ?", key);
    this.sql.exec("UPDATE devices SET status = ?, status_at = ? WHERE key = ?", JSON.stringify(rest), now, key);
    const want = !!(this.sql.exec("SELECT want_log FROM devices WHERE key = ?", key).toArray()[0] as any)?.want_log;
    this.lastDeviceEmit = now;
    this.emit({ t: "device", device: this.device(key), req: "status" });
    for (const e of events) this.emit({ t: "device_event", event: e });
    return { want_log: want };
  }
  requestLog(key: string, on = true) {
    this.sql.exec("UPDATE devices SET want_log = ? WHERE key = ?", on ? 1 : 0, key);
    const d = this.device(key);
    this.emit({ t: "device", device: d });
    return d;
  }
  ackDevice(key: string) {
    this.sql.exec("UPDATE devices SET ack_at = ? WHERE key = ?", Date.now(), key);
    const d = this.device(key);
    this.emit({ t: "device", device: d });
    return d;
  }
  /** Health view: battery series (30 d, ≤ 600 points), recent reports, events with logs. */
  health(key: string, days = 30) {
    const since = Date.now() - Math.min(30, Math.max(1, days)) * DAY_MS;
    let series = (this.sql.exec("SELECT at, mv, usb FROM batt_samples WHERE key = ? AND at > ? ORDER BY at", key, since).toArray() as any[]).map((r) => [r.at, r.mv, r.usb]);
    if (series.length > 600) { const k = Math.ceil(series.length / 600); series = series.filter((_, i) => i % k === 0 || i === series.length - 1); }
    const reports = (this.sql.exec("SELECT at, json FROM device_status WHERE key = ? ORDER BY at DESC LIMIT 60", key).toArray() as any[]).map((r) => ({ at: r.at, ...JSON.parse(r.json) }));
    const events = (this.sql.exec("SELECT * FROM device_events WHERE key = ? ORDER BY at DESC LIMIT 50", key).toArray() as any[]).map((e) => ({ ...e, log: e.log ? JSON.parse(e.log) : null }));
    return { device: this.device(key), series, reports, events };
  }

  // ---------- Wi-Fi networks (passwords AES-GCM encrypted with the WIFI_KEY secret) ----------
  private kv(k: string): string | null { return (this.sql.exec("SELECT v FROM kv WHERE k = ?", k).toArray()[0]?.v as string) ?? null; }
  private setKv(k: string, v: string) { this.sql.exec("INSERT OR REPLACE INTO kv VALUES (?, ?)", k, v); }
  wifiRev(): number { return Number(this.kv("wifi_rev") ?? 0); }

  // ---------- account (one Inbox per person, src/directory.ts) ----------
  /** Called when a person's account is linked (setup / first sign-in). Guests get GUEST_CONFIG once. */
  initAccount(a: { name: string; email: string; owner: boolean; tz?: string | null }) {
    this.alive();
    const first = !this.kv("inbox_name");
    this.setKv("inbox_name", a.name);
    this.setKv("email", a.email);
    if (a.tz) this.setKv("tz", a.tz);
    if (first && !a.owner) this.setConfig(GUEST_CONFIG);
    return { name: a.name, tz: this.tz(), config: this.config() };
  }
  name(): string { return this.kv("inbox_name") ?? "default"; }

  /** Audio transcribed in the last 24 h against the cap (Settings -> Recording). */
  usage() {
    const used = Number(this.sql.exec("SELECT COALESCE(SUM(seconds), 0) AS s FROM records WHERE received_at > ? AND status != 'error'", Date.now() - DAY_MS).one().s);
    return { audio_seconds_24h: Math.round(used), audio_cap_min: this.config().audio_cap_min };
  }
  private overAudioCap(extraSeconds: number): string | null {
    const cap = this.config().audio_cap_min;
    if (!(cap > 0)) return null;
    const used = this.usage().audio_seconds_24h;
    return used + extraSeconds > cap * 60 ? `audio cap ${cap} min / 24 h (used ${used} s)` : null;
  }

  // ---------- research with the person's own API key ----------
  researchSettings() {
    const b = this.kv("byok") ? JSON.parse(this.kv("byok")!) : null;
    const c = this.config();
    return { mode: b ? "key" : c.research_included ? "included" : "assistant", provider: b?.provider ?? null, hint: b?.hint ?? null };
  }
  /** Save (validated by the Worker) or remove the key. Research runs on it automatically; the daily cap protects them. */
  async setResearchKey(key: string | null) {
    if (!key) {
      this.sql.exec("DELETE FROM kv WHERE k = 'byok'");
      if (this.name() !== "default") this.setConfig({ research_included: 0, daily_cap_usd: 0 });
      return this.researchSettings();
    }
    this.setKv("byok", JSON.stringify({ provider: "anthropic", enc: await this.seal(key), hint: key.slice(-4) }));
    this.setConfig({ research_included: 1, daily_cap_usd: Math.max(this.config().daily_cap_usd, 5) });
    return this.researchSettings();
  }
  /** For the WorkAgent of one of this inbox's records, at the moment it calls the model (never stored there). */
  async researchKey(): Promise<string | null> {
    const b = this.kv("byok") ? JSON.parse(this.kv("byok")!) : null;
    return b ? await this.open(b.enc) : null;
  }
  usesOwnKey(): boolean { return !!this.kv("byok"); }

  // ---------- OpenBelt: where app memos are built (src/openbelt.ts) ----------
  // kv openbelt: { client_id, enc (sealed {access, refresh}), workspace, email, at }; openbelt_pending: { state, verifier, client_id,
  // redirect, next, at } for one sign-in at a time (15 minutes).
  private openbeltLink(): { client_id: string; enc: string; workspace: string; email: string; at: number } | null {
    const v = this.kv("openbelt");
    return v ? JSON.parse(v) : null;
  }
  openbeltStatus() {
    const l = this.openbeltLink();
    const waiting = this.sql.exec("SELECT count(*) AS n FROM records WHERE agent_state = 'needs_openbelt'").one().n as number;
    const c = this.config();
    return { connected: !!l, workspace: l?.workspace ?? null, email: l?.email ?? null, connected_at: l?.at ?? null, waiting,
      free_builds: c.research_included || this.usesOwnKey() ? null : { used: this.freeBuildsUsed(), month: c.free_builds_month } };
  }
  /** Start Connect OpenBelt: register paperbot as a client and return OpenBelt's sign-in address (login_hint: their email). */
  async openbeltStart(base: string, redirect: string, next: string) {
    const clientId = await register(base, redirect);
    const state = randomToken(24), verifier = randomToken(48);
    this.setKv("openbelt_pending", JSON.stringify({ state, verifier, client_id: clientId, redirect, next, at: Date.now() }));
    const email = this.kv("email");
    return authorizeUrl(base, { clientId, redirectUri: redirect, state, challenge: await pkceChallenge(verifier), loginHint: email && !/@passkey\.invalid$/.test(email) ? email : null });
  }
  /** OpenBelt sent the person back: check the state, trade the code, learn the workspace, run the app memos that waited. */
  /** OpenBelt sent the person back without a code (they cancelled): forget the sign-in, and say where it was going. */
  openbeltAbandon(): string | null {
    const p = this.kv("openbelt_pending") ? JSON.parse(this.kv("openbelt_pending")!) : null;
    this.sql.exec("DELETE FROM kv WHERE k = 'openbelt_pending'");
    return typeof p?.next === "string" ? p.next : null;
  }
  async openbeltFinish(base: string, code: string, state: string): Promise<{ ok: true; next: string; workspace: string } | { ok: false; error: string; next: string | null }> {
    const p = this.kv("openbelt_pending") ? JSON.parse(this.kv("openbelt_pending")!) : null;
    if (!p || p.state !== state) return { ok: false, error: "This sign-in link is not the one paperbot started. Connect OpenBelt again.", next: null };
    this.sql.exec("DELETE FROM kv WHERE k = 'openbelt_pending'");
    if (Date.now() - p.at > 15 * 60_000) return { ok: false, error: "The sign-in took more than 15 minutes. Connect OpenBelt again.", next: p.next };
    let tokens;
    try { tokens = await exchange(base, { code, clientId: p.client_id, redirectUri: p.redirect, verifier: p.verifier }); }
    catch (e) { return { ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 300), next: p.next }; }
    let who: any = {};
    try { who = JSON.parse((await new Mcp(`${base}/mcp`, tokens.access).call("whoami", {})).text); } catch {}
    const old = this.openbeltLink(); // connected again: sign the previous grant out on OpenBelt
    if (old) { try { const t = JSON.parse(await this.open(old.enc)); await revoke(base, { token: t.refresh ?? t.access, clientId: old.client_id }); } catch {} }
    this.setKv("openbelt", JSON.stringify({ client_id: p.client_id, enc: await this.seal(JSON.stringify(tokens)), workspace: String(who.workspace ?? ""), email: String(who.person?.email ?? ""), at: Date.now() }));
    this.sql.exec("DELETE FROM kv WHERE k = 'openbelt_app'"); // maybe another workspace: deploy the app again on the first save
    const waiting = this.sql.exec("SELECT id, kind FROM records WHERE agent_state = 'needs_openbelt' ORDER BY received_at").toArray() as { id: string; kind: string }[];
    for (const r of waiting) { this.log(r.id, "OpenBelt connected"); if (r.kind !== "save") { this.dispatch(r.id); this.changed(r.id); } }
    // The list app now, so the first thing said is saved at once and "Open list" works (saveWaiting deploys it otherwise).
    this.ctx.waitUntil(waiting.some((r) => r.kind === "save") ? this.saveWaiting(base) : this.prepareList(base));
    return { ok: true, next: p.next, workspace: String(who.workspace ?? "") };
  }
  /** The person's list app in their OpenBelt workspace, deployed if it isn't yet. */
  private async prepareList(base: string) {
    try {
      const known = this.kv("openbelt_app");
      const app = await ensureApp(new Belt((refreshed) => this.openbeltAccess(base, refreshed)), known ? JSON.parse(known) : null);
      this.setKv("openbelt_app", JSON.stringify(app));
    } catch (e) { console.log(JSON.stringify({ ev: "openbelt_list_deploy_failed", error: String(e).slice(0, 200) })); }
  }
  /** Items said before OpenBelt was connected: write them now, oldest first. One that fails keeps waiting. */
  private async saveWaiting(base: string) {
    const belt = new Belt((refreshed) => this.openbeltAccess(base, refreshed));
    for (const r of this.sql.exec("SELECT * FROM records WHERE agent_state = 'needs_openbelt' AND kind = 'save' ORDER BY received_at").toArray() as unknown as Rec[]) {
      const items = itemsOf(r);
      if (!items.length) continue;
      try {
        const known = this.kv("openbelt_app");
        const { saved, app } = await applyChanges(belt, known ? JSON.parse(known) : null, r.id, items);
        this.setKv("openbelt_app", JSON.stringify(app));
        this.sql.exec("UPDATE records SET items = ?, agent_state = NULL WHERE id = ?", JSON.stringify(saved), r.id);
        this.log(r.id, `saved after Connect OpenBelt: ${saved.map((i) => `${i.op} ${i.list}`).join(", ")}`);
      } catch (e) { this.log(r.id, `save after Connect OpenBelt failed: ${String(e).slice(0, 200)}`); }
      this.changed(r.id);
    }
  }
  /** For the WorkAgent building one of this inbox's app memos: OpenBelt's MCP address and a working access token.
   *  refreshed=true after a 401: trade the refresh token for a new pair (OpenBelt rotates them). */
  async openbeltAccess(base: string, refreshed = false): Promise<{ url: string; token: string } | null> {
    const l = this.openbeltLink();
    if (!l) return null;
    let t = JSON.parse(await this.open(l.enc)) as { access: string; refresh: string | null };
    if (refreshed) {
      // A sign-in OpenBelt no longer honours (unused for 30 days, or signed out there): forget it, so Settings → Apps says
      // so and app memos wait for Connect again instead of failing one after another.
      if (!t.refresh) { this.dropOpenbelt("no refresh token"); return null; }
      try { t = await refresh(base, { refresh: t.refresh, clientId: l.client_id }); }
      catch (e) {
        if (/\b(400|401)\b|invalid_grant|invalid_client/.test(String(e))) { this.dropOpenbelt(String(e).slice(0, 160)); return null; }
        throw e;
      }
      // Disconnected (or refreshed by another build) while that ran: never bring a removed link back.
      const now = this.openbeltLink();
      if (!now) return null;
      if (now.enc === l.enc) this.setKv("openbelt", JSON.stringify({ ...now, enc: await this.seal(JSON.stringify(t)) }));
      else t = JSON.parse(await this.open(now.enc));
    }
    return { url: `${base}/mcp`, token: t.access };
  }
  private dropOpenbelt(why: string) {
    this.sql.exec("DELETE FROM kv WHERE k = 'openbelt'");
    console.log(JSON.stringify({ ev: "openbelt_signin_dropped", inbox: this.name(), why }));
  }
  /** Disconnect: sign paperbot out on OpenBelt and forget the tokens. Apps stay in the person's workspace. */
  async openbeltDisconnect(base: string) {
    const l = this.openbeltLink();
    if (!l) return this.openbeltStatus();
    try { const t = JSON.parse(await this.open(l.enc)); await revoke(base, { token: t.refresh ?? t.access, clientId: l.client_id }); } catch {}
    this.sql.exec("DELETE FROM kv WHERE k IN ('openbelt', 'openbelt_pending')");
    return this.openbeltStatus();
  }
  // ---------- the web app's List and Apps: read from the person's OpenBelt each time, as them ----------
  private belt(base: string) { return new Belt((refreshed) => this.openbeltAccess(base, refreshed)); }
  /** One section of the view: its value, or what went wrong (OpenBelt down, a refused call) without failing the other. */
  private static async part<T>(f: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    try { return { ok: true, value: await f() }; }
    catch (e) { if (e instanceof NotConnected) throw e; return { ok: false, error: String(e instanceof Error ? e.message : e).slice(0, 200) }; }
  }
  async beltView(base: string) {
    if (!this.openbeltLink()) return { connected: false as const };
    const belt = this.belt(base);
    try {
      // one after the other: the first refreshes an expired sign-in, so the second doesn't refresh it again
      const items = await Inbox.part(() => allItems(belt)), list = await Inbox.part(() => apps(belt));
      return { connected: true as const, workspace: this.openbeltLink()?.workspace ?? "",
        items: items.ok ? items.value : null, apps: list.ok ? list.value : null, error: !items.ok ? items.error : !list.ok ? list.error : null };
    } catch (e) { if (e instanceof NotConnected) return { connected: false as const }; throw e; }
  }
  async beltSetDone(base: string, id: string, done: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
    try { await setDone(this.belt(base), id, done); return { ok: true }; }
    catch (e) { return { ok: false, error: e instanceof NotConnected ? "not connected" : String(e instanceof Error ? e.message : e).slice(0, 200) }; }
  }
  async beltPicture(base: string, app: string, theme: "light" | "dark") {
    try { return await picture(this.belt(base), app, theme); }
    catch (e) { if (e instanceof NotConnected) return null; throw e; }
  }

  private freeKey() { return `free_builds:${localNow(this.tz()).today.slice(0, 7)}`; }
  private freeBuildsUsed() { return Number(this.kv(this.freeKey()) ?? 0); }
  private freeBuildsLeft() { return this.config().free_builds_month - this.freeBuildsUsed(); }

  /** Delete account: every row and the live sockets. (R2 objects and the auth database are cleaned by the Worker.) */
  async wipe() {
    const name = this.name();
    for (const r of this.sql.exec("SELECT id FROM records WHERE agent_state = 'running'").toArray() as { id: string }[]) {
      try { await (await agentStub(this.env, name, r.id)).stop("account deleted"); } catch {}
    }
    for (const ws of this.ctx.getWebSockets()) { try { ws.close(4000, "account deleted"); } catch {} }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    // Tombstone: this inbox never takes records or an account again (a new sign-up gets a new user id / inbox).
    this.sql.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT)");
    this.setKv("deleted", String(Date.now()));
  }
  private alive() { if (this.kv("deleted")) throw new Error("account deleted"); }
  tz(): string { return this.kv("tz") ?? this.env.TZ ?? "UTC"; }
  setTz(tz: string) { this.setKv("tz", tz); return this.tz(); }
  /** Merge networks sent by `pocketbot setup` (the Mac's saved Wi-Fi): new SSIDs are added, known ones get the
   *  new password. Returns the device body of GET /v1/wifi (the setup writes exactly this to the board). */
  async wifiImport(nets: unknown): Promise<{ status: number; error?: string; body?: string }> {
    if (!Array.isArray(nets) || nets.length > WIFI_MAX) return { status: 400, error: `networks: a list of at most ${WIFI_MAX}` };
    for (const n of nets) {
      const val = validateWifi(n);
      if (!val.ok) return { status: 400, error: val.error };
    }
    let changed = false;
    for (const n of nets as WifiInput[]) {
      const cur = this.sql.exec("SELECT id, psk_enc, open FROM wifi WHERE ssid = ?", n.ssid!).toArray()[0] as any;
      if (cur) {
        const psk = n.psk ?? "";
        const same = cur.psk_enc ? psk && (await this.open(cur.psk_enc)) === psk : !psk && !!cur.open === !!n.open;
        if (!same) { await this.wifiUpdate(cur.id, { psk, ...(n.open ? { open: true } : {}) }); changed = true; }
      } else {
        if ((this.sql.exec("SELECT count(*) AS n FROM wifi").one().n as number) >= WIFI_MAX) break;
        const r = await this.wifiAdd({ ssid: n.ssid, ...(n.psk ? { psk: n.psk } : {}), ...(n.open ? { open: true } : {}), ...(n.fallback ? { fallback: true } : {}), name: n.name ?? "", note: "from pocketbot setup" });
        if (r.error) return { status: r.status, error: r.error };
        changed = true;
      }
    }
    if (!changed) this.log("wifi", "setup import: nothing new");
    return { status: 200, body: await this.wifiDeviceList() };
  }
  private aes: CryptoKey | null = null;
  private async key(): Promise<CryptoKey> {
    if (this.aes) return this.aes;
    const raw = this.env.WIFI_KEY ? unb64(this.env.WIFI_KEY) : null;
    if (!raw || raw.length !== 32) throw new Error("WIFI_KEY secret missing or not 32 bytes base64");
    return (this.aes = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
  }
  private async seal(pt: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await this.key(), new TextEncoder().encode(pt)));
    const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
    return b64(out);
  }
  private async open(s: string): Promise<string> {
    const u = unb64(s);
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: u.slice(0, 12) }, await this.key(), u.slice(12)));
  }
  /** For the web app: never includes passwords. */
  wifiList() {
    const nets = (this.sql.exec("SELECT * FROM wifi ORDER BY prio, created").toArray() as any[]).map((n) => ({
      id: n.id, ssid: n.ssid, name: n.name ?? "", note: n.note ?? "", prio: n.prio, open: !!n.open, has_psk: !!n.psk_enc,
      needs_psk: !n.open && !n.psk_enc, fallback: n.prio === 9, updated: n.updated,
    }));
    return { rev: this.wifiRev(), max: WIFI_MAX, networks: nets };
  }
  /** A device can hold a higher revision than ours (its list came from another server, e.g. the test
   *  Worker); it only fetches newer ones, so move past it. */
  wifiRevPast(have: number): number {
    if (this.wifiRev() <= have) {
      this.setKv("wifi_rev", String(have));
      this.wifiChanged(`device had rev ${have}`);
    }
    return this.wifiRev();
  }
  private wifiChanged(why: string) {
    const rev = this.wifiRev() + 1;
    this.setKv("wifi_rev", String(rev));
    this.log("wifi", `rev ${rev}: ${why}`);
    this.emit({ t: "wifi", wifi: this.wifiList() });
  }
  private renumber() { // order-preserving priorities 0..7, fallback networks stay 9
    const rows = this.sql.exec("SELECT id FROM wifi WHERE prio < 9 ORDER BY prio, created").toArray() as any[];
    rows.forEach((r, i) => this.sql.exec("UPDATE wifi SET prio = ? WHERE id = ?", i, r.id));
  }
  async wifiAdd(body: unknown) {
    const val = validateWifi(body);
    if (!val.ok) return { status: 400, error: val.error };
    const v = val.v as Required<Pick<WifiInput, "ssid">> & WifiInput;
    if ((this.sql.exec("SELECT count(*) AS n FROM wifi").one().n as number) >= WIFI_MAX) return { status: 409, error: `Bolt can remember ${WIFI_MAX} networks; remove one first` };
    if (this.sql.exec("SELECT 1 FROM wifi WHERE ssid = ?", v.ssid).toArray().length) return { status: 409, error: "that network is already on the list" };
    const id = crypto.randomUUID().slice(0, 8), now = Date.now();
    const next = (this.sql.exec("SELECT COALESCE(MAX(prio), -1) AS m FROM wifi WHERE prio < 9").one().m as number) + 1;
    this.sql.exec("INSERT INTO wifi (id, ssid, psk_enc, open, prio, name, note, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id, v.ssid, v.psk ? await this.seal(v.psk) : null, v.open ? 1 : 0, v.fallback ? 9 : Math.min(8, next), v.name ?? "", v.note ?? "", now, now);
    this.renumber();
    this.wifiChanged(`add ${id}`);
    return { status: 200, wifi: this.wifiList() };
  }
  async wifiUpdate(id: string, body: unknown) {
    const val = validateWifi(body, true);
    if (!val.ok) return { status: 400, error: val.error };
    const v = val.v;
    const cur = this.sql.exec("SELECT * FROM wifi WHERE id = ?", id).toArray()[0] as any;
    if (!cur) return { status: 404, error: "not found" };
    if (v.ssid !== undefined && v.ssid !== cur.ssid && this.sql.exec("SELECT 1 FROM wifi WHERE ssid = ? AND id != ?", v.ssid, id).toArray().length) return { status: 409, error: "that network is already on the list" };
    const set: string[] = [], args: unknown[] = [];
    if (v.ssid !== undefined) { set.push("ssid = ?"); args.push(v.ssid); }
    if (v.psk !== undefined) { set.push("psk_enc = ?"); args.push(v.psk ? await this.seal(v.psk) : null); }
    if (v.open !== undefined) { set.push("open = ?"); args.push(v.open ? 1 : 0); if (v.open) set.push("psk_enc = NULL"); }
    if (v.name !== undefined) { set.push("name = ?"); args.push(v.name); }
    if (v.note !== undefined) { set.push("note = ?"); args.push(v.note); }
    if (v.fallback !== undefined) { set.push("prio = ?"); args.push(v.fallback ? 9 : 8); }
    if (!set.length) return { status: 400, error: "nothing to change" };
    set.push("updated = ?"); args.push(Date.now());
    this.sql.exec(`UPDATE wifi SET ${set.join(", ")} WHERE id = ?`, ...(args as any[]), id);
    this.renumber();
    // Name / note are web-only: the device list (and its revision) only changes for ssid / psk / open / priority.
    const deviceVisible = v.ssid !== undefined || v.psk !== undefined || v.open !== undefined || v.fallback !== undefined;
    if (deviceVisible) this.wifiChanged(`update ${id}`); else this.emit({ t: "wifi", wifi: this.wifiList() });
    return { status: 200, wifi: this.wifiList() };
  }
  wifiDelete(id: string) {
    const n = this.sql.exec("DELETE FROM wifi WHERE id = ?", id).rowsWritten;
    if (!n) return { status: 404, error: "not found" };
    this.renumber();
    this.wifiChanged(`delete ${id}`);
    return { status: 200, wifi: this.wifiList() };
  }
  /** New try-order for the non-fallback networks (ids in order). */
  wifiOrder(ids: unknown) {
    if (!Array.isArray(ids) || ids.some((x) => typeof x !== "string")) return { status: 400, error: "ids must be a list" };
    ids.forEach((id: string, i: number) => this.sql.exec("UPDATE wifi SET prio = ? WHERE id = ? AND prio < 9", Math.min(8, i), id));
    this.renumber();
    this.wifiChanged("reorder");
    return { status: 200, wifi: this.wifiList() };
  }
  /** GET /v1/wifi body (decrypted passwords; device only). */
  async wifiDeviceList(): Promise<string> {
    const rows = this.sql.exec("SELECT * FROM wifi ORDER BY prio, created").toArray() as any[];
    const nets = [];
    for (const r of rows) nets.push({ ssid: r.ssid as string, psk: r.psk_enc ? await this.open(r.psk_enc) : "", prio: r.prio as number, usable: !!r.open || !!r.psk_enc });
    return wifiDeviceBody(this.wifiRev(), nets);
  }
  /** Record one device request (X-PV-FW / X-PV-Batt / X-PV-USB). Broadcasts changes, unchanged heartbeats at most every 10 s. */
  telemetry(t: Telemetry, now = Date.now(), emit = true): string {
    const key = t.key ?? (this.sql.exec("SELECT key FROM devices ORDER BY last_seen DESC LIMIT 1").toArray()[0]?.key as string | undefined) ?? "unknown";
    const prev = this.sql.exec("SELECT * FROM devices WHERE key = ?", key).toArray()[0] as any;
    // No MAC in this request (scripts, /v1/tasks): it refreshes the latest device but never relabels it.
    if (!t.key && prev) t = { ...t, prefix: prev.prefix ?? "", sim: !!prev.sim };
    this.sql.exec(
      `INSERT INTO devices (key, prefix, sim, fw, batt_mv, usb, first_seen, last_seen, last_req, last_id, pending, reqs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(key) DO UPDATE SET prefix = CASE WHEN excluded.prefix != '' THEN excluded.prefix ELSE prefix END, sim = excluded.sim, fw = COALESCE(excluded.fw, fw), batt_mv = COALESCE(excluded.batt_mv, batt_mv),
       usb = COALESCE(excluded.usb, usb), last_seen = excluded.last_seen, last_req = excluded.last_req, last_id = COALESCE(excluded.last_id, last_id),
       pending = COALESCE(excluded.pending, pending), reqs = reqs + 1`,
      key, t.prefix, t.sim ? 1 : 0, t.fw, t.batt_mv, t.usb == null ? null : t.usb ? 1 : 0, now, now, t.req, t.id, t.pending,
    );
    if (t.wifi_rev != null) this.sql.exec("UPDATE devices SET wifi_rev = ? WHERE key = ?", t.wifi_rev, key);
    if (t.req === "wifi") this.sql.exec("UPDATE devices SET wifi_fetched = ? WHERE key = ?", this.wifiRev(), key);
    // Battery history for the health chart: one sample per 5 min (or on a USB change).
    if (t.batt_mv != null && (!prev || now - (prev.batt_at ?? 0) >= 300_000 || (t.usb != null && !!prev.usb !== t.usb))) {
      this.sql.exec("INSERT INTO batt_samples VALUES (?, ?, ?, ?)", key, now, t.batt_mv, t.usb == null ? null : t.usb ? 1 : 0);
      this.sql.exec("UPDATE devices SET batt_at = ? WHERE key = ?", now, key);
    }
    const moved = !prev || prev.fw !== (t.fw ?? prev.fw) || (t.usb != null && !!prev.usb !== t.usb) || (t.batt_mv != null && Math.abs((prev.batt_mv ?? 0) - t.batt_mv) >= 15)
      || (t.pending != null && t.pending !== prev.pending) || t.req === "upload" || (t.wifi_rev != null && t.wifi_rev !== prev.wifi_rev) || t.req === "wifi";
    if (emit && (moved || now - this.lastDeviceEmit >= DEVICE_EMIT_MS)) {
      this.lastDeviceEmit = now;
      this.emit({ t: "device", device: this.device(key), req: t.req });
    }
    return key;
  }
  /** Start of an upload (headers seen, body still streaming): telemetry + "incoming" for the live UI.
   *  Returns the existing record's device view for a duplicate. */
  arrive(id: string, t: Telemetry | null) {
    this.alive(); // a deleted account's board can still reach here for up to a minute (token cache): nothing is stored
    if (t) this.telemetry(t);
    const r = this.get(id);
    if (r) return deviceView(r);
    this.emit({ t: "incoming", id });
    return null;
  }

  // ---------- records ----------
  get(id: string): Rec | null {
    return (this.sql.exec("SELECT * FROM records WHERE id = ?", id).toArray()[0] as unknown as Rec) ?? null;
  }
  view(id: string) { const r = this.get(id); return r ? deviceView(r) : null; }
  views(ids: string[]) { return ids.map((id) => this.get(id)).filter((r): r is Rec => !!r).map(deviceView); }
  log(id: string, msg: string) {
    this.sql.exec("INSERT INTO events VALUES (?, ?, ?)", Date.now(), id, msg);
  }
  events(id: string) { return this.sql.exec("SELECT at, msg FROM events WHERE id = ? ORDER BY at", id).toArray(); }

  /** Insert a new record (audio already durable in R2). Returns inserted=false for a duplicate. */
  receive(r: Partial<Rec> & { id: string }): { inserted: boolean; rec: Rec } {
    const now = Date.now();
    const row: Record<string, unknown> = { received_at: now, status: "processing", processing_since: now, ...r };
    const keys = Object.keys(row);
    if (this.get(r.id)) return { inserted: false, rec: this.get(r.id)! };
    const over = row.status === "processing" && typeof r.seconds === "number" ? this.overAudioCap(r.seconds) : null;
    if (over) Object.assign(row, { status: "error", error: "daily limit", detail: over, done_at: now });
    const n = this.sql.exec(`INSERT OR IGNORE INTO records (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`, ...keys.map((k) => row[k] as any)).rowsWritten;
    if (n) { this.log(r.id, `received ${r.status ?? "processing"} bytes=${r.bytes ?? 0} fw=${r.fw ?? "-"}`); this.changed(r.id); }
    return { inserted: n > 0, rec: this.get(r.id)! };
  }

  noteAttempt(id: string, gen: number, via: string) {
    this.sql.exec("UPDATE records SET attempts = attempts + 1, via = ? WHERE id = ? AND gen = ? AND status = 'processing'", via, id, gen);
    this.log(id, `attempt ${via} gen=${gen}`);
  }

  /** Pipeline progress: Whisper is done, routing runs. Shows the transcript live before the title exists. */
  heard(id: string, gen: number, transcript: string) {
    const n = this.sql.exec("UPDATE records SET transcript = ? WHERE id = ? AND gen = ? AND status = 'processing'", transcript, id, gen).rowsWritten;
    if (n) this.changed(id);
  }

  /** Save a processing result. Only the first result for the current generation wins. */
  complete(id: string, gen: number, o: Outcome, via: string): Rec | null {
    const r = this.get(id);
    if (!r || r.gen !== gen || r.status !== "processing") return r;
    const work = AGENT_ACTIONS.includes(o.kind);
    const waits = o.kind === "save" && !!o.items?.some((i) => i.why === "not connected");
    // The router's (and an answer's) model cost counts against today's budget like an agent's.
    this.sql.exec(
      `UPDATE records SET status = ?, kind = ?, title = ?, due = ?, transcript = ?, noise_reason = ?, summary = ?, items = ?,
       seconds = ?, rms = ?, active_sec = ?, timings = ?, via = ?, done_at = ?, error = NULL, agent_state = ?, agent_cost = ?, agent_day = ? WHERE id = ?`,
      work ? "researching" : "done", o.kind, o.title, o.due, o.transcript, o.noise_reason, o.summary, o.items ? JSON.stringify(o.items) : null,
      o.seconds, o.rms, o.active_sec, o.timings, via, Date.now(), waits ? "needs_openbelt" : null, o.usd || null, o.usd ? localNow(this.tz()).today : null, id,
    );
    if (o.app) this.setKv("openbelt_app", JSON.stringify(o.app));
    this.log(id, `routed ${o.kind}${o.items ? ` (${o.items.map((i) => `${i.op} ${i.list}${i.ok ? "" : `: ${i.why}`}`).join(", ")})` : ""}${o.noise_reason ? ` ${o.noise_reason}` : ""} $${o.usd} via ${via}`);
    if (work) this.dispatch(id);
    this.changed(id);
    return this.get(id);
  }

  /** What the router reads besides the memo: where the board is, the memos just before this one, the OpenBelt app. */
  routeContext(id: string) {
    const now = Date.now();
    const recent = (this.sql.exec(
      "SELECT transcript, received_at FROM records WHERE id != ? AND received_at > ? AND received_at <= ? AND transcript IS NOT NULL AND transcript != '' ORDER BY received_at DESC LIMIT 3",
      id, now - 180_000, now).toArray() as any[]).reverse().map((r) => ({ t: String(r.transcript).slice(0, 300), ago_s: Math.round((now - r.received_at) / 1000) }));
    const app = this.kv("openbelt_app");
    return { place: this.kv("place"), recent, app: app ? (JSON.parse(app) as AppState) : null };
  }
  /** Where the board uploads from (Cloudflare's guess from its address): the router's "here" for weather and the like. */
  setPlace(place: string | null) { if (place && place !== this.kv("place")) this.setKv("place", place.slice(0, 80)); }

  fail(id: string, gen: number, error: string, detail: string) {
    const r = this.get(id);
    if (!r || r.gen !== gen || r.status !== "processing") return;
    this.sql.exec("UPDATE records SET status = 'error', error = ?, detail = ?, done_at = ? WHERE id = ?", error, detail, Date.now(), id);
    this.log(id, `error: ${detail}`);
    this.changed(id);
  }

  setWorkflow(id: string, gen: number, instance: string) {
    this.sql.exec("UPDATE records SET wf_instance = ? WHERE id = ? AND gen = ?", instance, id, gen);
    this.log(id, `workflow ${instance}`);
  }

  /** Reprocessing transcribes again, so it counts against the audio cap too. null = allowed. */
  reprocessRefused(id: string): string | null {
    const r = this.get(id);
    if (!r) return null;
    return this.overAudioCap(r.status === "error" ? r.seconds ?? 0 : 0);
  }
  /** Re-run processing from the stored audio (new generation). */
  async reprocess(id: string): Promise<Rec | null> {
    const r = this.get(id);
    if (!r || !r.audio_key) return r;
    if (r.agent_state === "running") {
      try { await (await agentStub(this.env, this.name(), id)).stop("reprocess"); } catch {}
    }
    this.sql.exec(
      `UPDATE records SET gen = gen + 1, status = 'processing', processing_since = ?, kind = NULL, title = NULL, items = NULL,
       due = NULL, summary = NULL, error = NULL, detail = NULL, done_at = NULL, wf_instance = NULL, agent_state = NULL,
       agent_outcome = NULL, agent_result = NULL, agent_progress = NULL, attempts = 0, test_flags = NULL WHERE id = ?`, Date.now(), id);
    this.sql.exec("DELETE FROM agent_steps WHERE id = ?", id);
    this.log(id, "reprocess");
    this.changed(id);
    return this.get(id);
  }

  list(all = false): Rec[] {
    const where = all ? "state != 'archived'" : "state = 'open'";
    return this.sql.exec(`SELECT * FROM records WHERE ${where} ORDER BY received_at DESC LIMIT 300`).toArray() as unknown as Rec[];
  }
  setState(id: string, state: Rec["state"]) {
    this.sql.exec("UPDATE records SET state = ? WHERE id = ?", state, id);
    this.changed(id);
    return this.get(id);
  }

  /** Web edit (validated by logic.validatePatch). Changing the action to research or app starts the agent (hands-off, budgeted). */
  patch(id: string, p: Patch): { status: number; error?: string; rec?: ReturnType<typeof webRecord> } {
    const r = this.get(id);
    if (!r) return { status: 404, error: "not found" };
    const kindChange = p.kind !== undefined && p.kind !== r.kind;
    if (kindChange && r.status === "processing") return { status: 409, error: "still processing" };
    if (kindChange && (r.agent_state === "running" || r.agent_state === "queued")) return { status: 409, error: "research in progress" };
    if (kindChange && r.status === "error") return { status: 409, error: "reprocess it first" };
    const set: string[] = [], args: unknown[] = [];
    if (p.title !== undefined) { set.push("title = ?"); args.push(p.title); }
    if (p.due !== undefined) { set.push("due = ?"); args.push(p.due); }
    if (p.state !== undefined) { set.push("state = ?"); args.push(p.state); }
    let startWork = false;
    if (kindChange) {
      set.push("kind = ?"); args.push(p.kind);
      const agent = AGENT_ACTIONS.includes(p.kind!);
      if (agent) { set.push("status = 'researching'", "summary = NULL", "error = NULL", "agent_state = NULL"); startWork = true; }
      else if (r.status !== "done") { set.push("status = 'done'", "error = NULL"); } // paused/stopped work -> a plain memo
      if (!agent && (r.agent_state === "needs_openbelt" || r.agent_state === "external")) set.push("agent_state = NULL"); // nothing waits any more
    }
    if (set.length) this.sql.exec(`UPDATE records SET ${set.join(", ")} WHERE id = ?`, ...(args as any[]), id);
    this.log(id, `web edit ${JSON.stringify(p)}`);
    if (startWork) this.dispatch(id);
    this.changed(id);
    return { status: 200, rec: this.web(id)! };
  }

  /** Rows the cron sweeper should look at. */
  stale(now: number) {
    return {
      processing: this.sql.exec("SELECT id, gen, wf_instance, attempts, processing_since, test_flags FROM records WHERE status = 'processing' AND processing_since < ?", now - 45_000).toArray() as unknown as Rec[],
      running: this.sql.exec("SELECT id, agent_started_at FROM records WHERE agent_state = 'running' AND agent_started_at < ?", now - 150_000).toArray() as unknown as Rec[],
      queued: this.sql.exec("SELECT count(*) AS n FROM records WHERE agent_state = 'queued'").one().n as number,
    };
  }

  // ---------- config ----------
  config(): Config {
    const c: Record<string, number> = { ...DEFAULTS };
    for (const r of this.sql.exec("SELECT k, v FROM config").toArray()) if (String(r.k) in c) c[String(r.k)] = Number(r.v);
    return c as Config;
  }
  setConfig(patch: Partial<Config>) {
    for (const [k, v] of Object.entries(patch)) if (k in DEFAULTS && Number.isFinite(Number(v))) this.sql.exec("INSERT OR REPLACE INTO config VALUES (?, ?)", k, String(v));
    const c = this.config();
    this.ctx.waitUntil(this.pump());
    this.emitBudget();
    return c;
  }

  // ---------- agent coordinator ----------
  spend(day = localNow(this.tz()).today) { // the daily cap resets at local midnight
    // Finished agents, plus the router's and answers' cost on memos no agent ran on (agent_state NULL).
    const row = this.sql.exec("SELECT COALESCE(SUM(agent_cost), 0) AS s FROM records WHERE agent_day = ? AND (agent_state = 'finished' OR agent_state IS NULL)", day).one();
    const running = this.sql.exec("SELECT count(*) AS n FROM records WHERE agent_state = 'running'").one().n as number;
    return { day, spent_usd: +Number(row.s).toFixed(4), running, queued: this.sql.exec("SELECT count(*) AS n FROM records WHERE agent_state = 'queued'").one().n as number, ...this.config() };
  }

  /** Work memo for the person's own Claude: stays "researching" until complete_research arrives over MCP. */
  private external(id: string) {
    this.sql.exec("UPDATE records SET agent_state = 'external', agent_progress = NULL WHERE id = ?", id);
    this.log(id, "waiting for your Claude (MCP)");
  }
  /** MCP complete_research: the person's Claude delivers the result. */
  completeExternal(id: string, p: { summary: string; report: string; sources: string[] }) {
    const r = this.get(id);
    if (!r) return { status: 404, error: "no memo with that id" };
    if (!r.kind || !AGENT_ACTIONS.includes(r.kind)) return { status: 409, error: `this memo is ${r.kind ? `a ${r.kind} memo` : "still processing"}, not research or an app` };
    if (r.agent_state === "running" || r.agent_state === "queued") return { status: 409, error: "research is already running on the server" };
    const result = { summary: p.summary, answer: p.report.split("\n").find((l) => l.trim())?.slice(0, 400) ?? "", report: p.report,
      citations: { cited: p.sources, verified: p.sources, unverified: [] }, via: "mcp" };
    this.sql.exec(`UPDATE records SET status = 'done', summary = ?, error = NULL, agent_state = 'finished', agent_finished_at = ?, agent_cost = 0,
      agent_outcome = 'done', agent_model = 'your Claude (MCP)', agent_result = ? WHERE id = ?`, p.summary, Date.now(), JSON.stringify(result), id);
    this.log(id, `research delivered over MCP: ${p.summary}`);
    this.changed(id);
    return { status: 200, rec: deviceView(this.get(id)!) };
  }
  /** MCP list_memos. */
  memos(f: { kind?: string; open_only?: boolean; research_needed?: boolean; limit?: number }) {
    const where: string[] = ["status != 'processing'", "kind != 'ignore'"], args: unknown[] = [];
    if (f.kind) { where.push("kind = ?"); args.push(f.kind); }
    if (f.open_only !== false) where.push("state = 'open'");
    if (f.research_needed) where.push("kind IN ('research', 'app')", "status IN ('researching', 'paused_budget', 'stopped')", "(agent_state IS NULL OR agent_state IN ('external', 'finished', 'needs_openbelt'))");
    const rows = this.sql.exec(`SELECT * FROM records WHERE ${where.join(" AND ")} ORDER BY received_at DESC LIMIT ?`, ...(args as any[]), Math.min(50, f.limit ?? 20)).toArray() as unknown as Rec[];
    return rows.map((r) => {
      const items = r.kind === "save" ? itemsOf(r) : [];
      return { id: r.id, kind: r.kind, title: r.title, due: r.due, status: r.status, state: r.state, recorded: new Date(r.received_at).toISOString(),
        items: items.length ? items.map((i) => ({ op: i.op, list: i.list, title: i.title, saved: i.ok })) : undefined, answer: r.kind === "answer" ? r.summary : undefined,
        research: r.kind && AGENT_ACTIONS.includes(r.kind) ? (r.status === "done" ? "done" : r.agent_state === "external" || r.agent_state === "needs_openbelt" ? "waiting for you" : r.status) : undefined };
    });
  }

  /** Who runs a work memo (hands-off, no approval). An app memo is built in the person's OpenBelt workspace: it waits
   *  for Connect OpenBelt first, then runs on included research, their own key, or one of their free builds a month;
   *  with none of those left it goes to their own Claude. Research runs here with included research or their key,
   *  else waits for their own Claude (src/mcp.ts). Budget and concurrency apply in pump(). */
  private dispatch(id: string) {
    const r = this.get(id);
    if (!r || !r.kind || !AGENT_ACTIONS.includes(r.kind)) return;
    const c = this.config();
    if (r.kind === "app") {
      if (!this.openbeltLink()) return this.needsOpenbelt(id);
      if (c.research_included || this.usesOwnKey() || this.freeBuildsLeft() > 0) return this.admit(id);
      this.log(id, `free builds used up (${c.free_builds_month} a month)`);
      return this.external(id);
    }
    if (c.research_included || this.usesOwnKey()) this.admit(id);
    else this.external(id);
  }
  private needsOpenbelt(id: string) {
    this.sql.exec("UPDATE records SET agent_state = 'needs_openbelt', agent_progress = NULL WHERE id = ?", id);
    this.log(id, "app: waiting for Connect OpenBelt");
  }

  private admit(id: string) {
    this.sql.exec("UPDATE records SET agent_state = 'queued', agent_progress = NULL WHERE id = ?", id);
    this.sql.exec("DELETE FROM agent_steps WHERE id = ?", id);
    this.log(id, "agent queued");
    this.ctx.waitUntil(this.pump());
  }

  /** Start queued agents while concurrency and the daily budget allow. Budget check reserves the
   *  per-task hard cap for every running agent, so the daily cap cannot be overshot. */
  async pump() {
    for (;;) {
      const next = this.sql.exec("SELECT id, transcript, title, test_flags, kind FROM records WHERE agent_state = 'queued' ORDER BY done_at LIMIT 1").toArray()[0] as unknown as Rec | undefined;
      if (!next) return;
      const s = this.spend();
      const build = next.kind === "app";
      // A free build is counted against free_builds_month, not the daily cap (guests have none).
      const free = build && !s.research_included && !this.usesOwnKey();
      const cap = build ? Math.max(s.task_cap_usd, BUILD_CAP_USD) : s.task_cap_usd;
      if (free && this.freeBuildsLeft() <= 0) {
        this.log(next.id, "free builds used up: for your assistant");
        this.external(next.id);
        this.changed(next.id);
        continue;
      }
      if (!free && s.spent_usd + cap * (s.running + 1) > s.daily_cap_usd + 1e-9) {
        this.sql.exec("UPDATE records SET status = 'paused_budget', agent_state = NULL, error = 'daily budget' WHERE id = ?", next.id);
        this.log(next.id, `paused_budget: spent ${s.spent_usd} + ${s.running + 1} x ${s.task_cap_usd} > ${s.daily_cap_usd}`);
        this.changed(next.id);
        this.emitBudget();
        continue;
      }
      if (s.running >= s.max_concurrent) return;
      this.sql.exec("UPDATE records SET agent_state = 'running', agent_day = ?, agent_started_at = ? WHERE id = ?", s.day, Date.now(), next.id);
      this.log(next.id, `agent start${build ? ` (build${free ? `, free ${this.freeBuildsUsed() + 1}/${s.free_builds_month}` : ""})` : ""} (running ${s.running + 1}/${s.max_concurrent}, spent ${s.spent_usd})`);
      this.addStep(next.id, { at: Date.now(), kind: "note", text: "agent started" });
      this.changed(next.id);
      this.emitBudget();
      try {
        const agent = await agentStub(this.env, this.name(), next.id);
        await agent.start(next.id, next.transcript ?? "", next.title ?? "", { taskCapUsd: cap, flags: next.test_flags ?? "", inbox: this.name(), ownKey: this.usesOwnKey(), mode: build ? "build" : "research" });
        if (free) this.setKv(this.freeKey(), String(this.freeBuildsUsed() + 1)); // counted once it really runs
      } catch (e) {
        if (build && !this.openbeltLink()) { // OpenBelt's sign-in was gone (expired, disconnected): wait for Connect again
          this.needsOpenbelt(next.id);
          this.changed(next.id);
          this.emitBudget();
          continue;
        }
        this.agentFinished(next.id, { outcome: "stopped", error: "agent failed to start", detail: String(e).slice(0, 300), cost: 0, model: null, result: null });
      }
    }
  }

  /** Called by the WorkAgent when its task settles. */
  agentFinished(id: string, p: { outcome: "done" | "unsure" | "stopped"; summary?: string; error?: string; detail?: string; cost: number; model: string | null; result: unknown }) {
    const r = this.get(id);
    if (!r || r.agent_state !== "running") return;
    const status: Status = p.outcome === "stopped" ? "stopped" : "done";
    // "unsure": hedged or unverified research is still delivered, marked with a leading "? ".
    const summary = p.summary ? (p.outcome === "unsure" ? `? ${p.summary}` : p.summary) : null;
    this.sql.exec(
      `UPDATE records SET status = ?, summary = ?, error = ?, detail = ?, agent_state = 'finished', agent_finished_at = ?, agent_cost = ?,
       agent_outcome = ?, agent_model = ?, agent_result = ? WHERE id = ?`,
      status, summary, p.error ?? null, p.detail ?? null, Date.now(), p.cost, p.outcome, p.model, p.result ? JSON.stringify(p.result) : null, id,
    );
    this.log(id, `agent ${p.outcome} cost=$${p.cost.toFixed(4)} ${p.error ?? ""} ${summary ?? ""}`);
    this.addStep(id, { at: Date.now(), kind: p.outcome === "stopped" ? "error" : "note", text: p.outcome === "stopped" ? `stopped: ${p.error ?? "?"}` : "report ready" });
    this.changed(id);
    this.emitBudget();
    this.ctx.waitUntil(this.pump());
  }

  private addStep(id: string, s: Step) {
    this.sql.exec("INSERT INTO agent_steps VALUES (?, ?, ?, ?)", id, s.at, s.kind, s.text.slice(0, 200));
  }
  /** Live research progress from a WorkAgent (tool calls, visible thoughts, turn/cost counters). */
  agentProgress(id: string, step: Step | null, progress: Record<string, unknown> | null) {
    const r = this.get(id);
    if (!r || r.agent_state !== "running") return;
    if (step) {
      const n = this.sql.exec("SELECT count(*) AS n FROM agent_steps WHERE id = ?", id).one().n as number;
      if (n >= 60) step = null; // replayed hooks / runaway loops: the log stays bounded
      else this.addStep(id, step);
    }
    if (progress) this.sql.exec("UPDATE records SET agent_progress = ? WHERE id = ?", JSON.stringify(progress), id);
    if (step || progress) this.emit({ t: "step", id, step, progress });
  }

  /** Admin: delete one record. Returns its audio key (the Worker deletes the R2 object). */
  async remove(id: string) {
    const r = this.get(id);
    if (!r) return { deleted: 0 };
    if (r.agent_state === "running") { try { await (await agentStub(this.env, this.name(), id)).stop("deleted"); } catch {} }
    this.sql.exec("DELETE FROM records WHERE id = ?", id);
    this.sql.exec("DELETE FROM agent_steps WHERE id = ?", id);
    this.log(id, "deleted by admin");
    this.emit({ t: "resync" });
    return { deleted: 1, audio_key: r.audio_key };
  }

  /** Admin: forget a device (telemetry, status history, events, battery samples). */
  removeDevice(key: string) {
    let n = 0;
    for (const t of ["devices", "device_status", "device_events", "batt_samples"]) n += this.sql.exec(`DELETE FROM ${t} WHERE key = ?`, key).rowsWritten;
    this.emit({ t: "resync" });
    return { deleted: n };
  }

  // ---------- test hooks (TEST_HOOKS=1 only; routed from /admin/test/*) ----------
  /** Insert a finished record as-is (XSS / layout tests). */
  testInsert(r: Partial<Rec> & { id: string; title: string }) {
    const now = Date.now();
    const row: Record<string, unknown> = { received_at: now, status: "done", processing_since: now, done_at: now, bytes: 0, via: "test", kind: "note", ...r };
    for (const k of ["agent_result", "items"]) if (row[k] && typeof row[k] !== "string") row[k] = JSON.stringify(row[k]);
    const keys = Object.keys(row).filter((k) => /^[a-z_]+$/.test(k));
    this.sql.exec(`INSERT OR REPLACE INTO records (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`, ...keys.map((k) => row[k] as any));
    this.changed(r.id);
    return this.web(r.id);
  }
  /** n fake records spread over 30 days (performance test). */
  testSeed(n: number) {
    const kinds = ["todo", "shopping", "reminder", "note", "research", "answer", "ignore"];
    const words = ["buy", "call", "fix", "research", "remember", "email", "book", "check", "order", "read", "plan", "water"];
    const things = ["AA batteries", "the dentist", "e-paper fonts", "the plants", "flight to Lisbon", "ESP32 deep sleep", "Mom", "invoice #42", "bike tyre", "tax forms", "Zigbee vs Thread", "coffee beans"];
    const now = Date.now();
    for (let i = 0; i < Math.min(n, 1000); i++) {
      const k = kinds[i % kinds.length], w = words[(i * 7) % words.length], t = things[(i * 5) % things.length];
      const at = now - Math.floor((i / n) * 30 * 86400_000) - 60_000;
      const title = k === "ignore" ? "(no speech)" : `${w[0].toUpperCase()}${w.slice(1)} ${t}`;
      const list = ["todo", "shopping", "reminder", "note"].includes(k) ? k : null;
      const due = k === "reminder" ? new Date(at + 86400_000).toISOString().slice(0, 16) : null;
      const items = list ? JSON.stringify([{ op: "add", list, title, due, id: null, ok: true, why: null, app_url: "https://paperbot--test.openbelt.app/" }]) : null;
      this.sql.exec(
        `INSERT OR REPLACE INTO records (id, received_at, status, kind, title, due, transcript, seconds, bytes, via, done_at, state, summary, agent_cost, items)
         VALUES (?, ?, 'done', ?, ?, ?, ?, ?, 0, 'seed', ?, ?, ?, ?, ?)`,
        `seed-${String(i).padStart(4, "0")}`, at, list ? "save" : k, title, due,
        k === "ignore" ? "" : `Okay so I need to ${w} ${t}, don't let me forget that one.`, 2 + (i % 9), at + 3000, i % 5 === 0 ? "archived" : "open",
        k === "research" ? `Found 3 options for ${t}` : k === "answer" ? `${t} is a fine thing to ${w}.` : null, k === "research" ? 0.02 : null, items,
      );
    }
    this.emit({ t: "resync" });
    return { seeded: Math.min(n, 1000) };
  }
  /** Delete records whose id starts with one of the prefixes (test data cleanup). */
  testPurge(prefixes: string[]) {
    let n = 0;
    for (const p of prefixes.filter((x) => /^[A-Za-z0-9_-]{2,20}$/.test(x))) {
      n += this.sql.exec("DELETE FROM records WHERE id LIKE ? ESCAPE '\\'", p.replace(/_/g, "\\_") + "%").rowsWritten;
      this.sql.exec("DELETE FROM agent_steps WHERE id LIKE ? ESCAPE '\\'", p.replace(/_/g, "\\_") + "%");
    }
    this.emit({ t: "resync" });
    return { deleted: n };
  }
  /** Link an OpenBelt workspace with a plain token, no OAuth (a local OpenBelt's verify token): the save path end to end. */
  async testOpenbelt(token: string, workspace: string) {
    this.setKv("openbelt", JSON.stringify({ client_id: "test", enc: await this.seal(JSON.stringify({ access: token, refresh: null })), workspace, email: "test@paperbot.test", at: Date.now() }));
    this.sql.exec("DELETE FROM kv WHERE k = 'openbelt_app'");
    return this.openbeltStatus();
  }
  /** Close every live socket as a restart would (1012): exercises the web app's reconnect + resync. */
  testDrop() { const n = this.ctx.getWebSockets().length; for (const ws of this.ctx.getWebSockets()) { try { ws.close(1012, "test restart"); } catch {} } return { dropped: n }; }
  testDevices(clear: boolean, key?: string) {
    if (clear) for (const t of ["devices", "device_status", "device_events", "batt_samples"])
      key ? this.sql.exec(`DELETE FROM ${t} WHERE key = ?`, key) : this.sql.exec(`DELETE FROM ${t}`);
    this.emit({ t: "resync" });
    return this.devices();
  }
}

/** The v1 task list. Its rows were imported long ago; the class stays only because its binding (TASKS) and stored data do:
 *  removing it is a wrangler migration (deleted_classes). */
export class TaskList extends DurableObject<Env> {}
