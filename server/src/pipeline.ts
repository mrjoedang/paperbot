// Audio checks, Whisper, the router, and acting on what it picked. The router is one Haiku call that reads the memo with
// its context (the time and place, the memos just before it, the person's open items and apps) and picks one action:
//   ignore    not meant for paperbot: overheard talk, mic tests, kids counting, a cut-off fragment
//   answer    a quick question: answered here (the router's own answer, or one more call with web search)
//   save      something to remember: added to, checked off in or removed from the person's OpenBelt app (src/items.ts)
//   research  needs reading the web: the WorkAgent researches it (src/agent.ts)
//   app       make or change an app: the WorkAgent builds it on OpenBelt
// The same stages run inline (ctx.waitUntil after the 202) and inside the Workflow (durable retries).
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { inbox, objKey, type Env } from "./env";
import { appNames, applyChanges, Belt, LISTS, NotConnected, openItems, type AppState, type ItemChange, type OpenItem, type Saved } from "./items";
import { openbeltBase } from "./openbelt";

export const ACTIONS = ["ignore", "answer", "save", "research", "app"] as const;
export type Action = (typeof ACTIONS)[number];
/** Actions the WorkAgent carries out (status "researching" until it reports). */
export const AGENT_ACTIONS: readonly Action[] = ["research", "app"];
const WHISPER = "@cf/openai/whisper-large-v3-turbo";
const MODEL = "anthropic/claude-haiku-5.5"; // AI Gateway Unified Billing catalog id
const PRICE = { in: 0.1, out: 0.5, search: 0.01 }; // USD per million tokens, and per web search

// ---------- audio ----------
export type WavInfo = { ok: boolean; why?: string; seconds: number; rms: number; activeSec: number; rate: number };

/** Parses a RIFF/WAVE PCM16 file. ok=false = unreadable (will be discarded as noise). */
export function wavInfo(b: Uint8Array): WavInfo {
  const bad = (why: string): WavInfo => ({ ok: false, why, seconds: 0, rms: 0, activeSec: 0, rate: 0 });
  if (b.length < 44) return bad("shorter than a WAV header");
  const tag = (o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return bad("not RIFF/WAVE");
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let off = 12, channels = 0, rate = 0, bits = 0, fmt = 0, dataOff = -1, dataLen = 0;
  while (off + 8 <= b.length) {
    const id = tag(off);
    const len = v.getUint32(off + 4, true);
    if (id === "fmt " && off + 24 <= b.length) {
      fmt = v.getUint16(off + 8, true); channels = v.getUint16(off + 10, true);
      rate = v.getUint32(off + 12, true); bits = v.getUint16(off + 22, true);
    }
    if (id === "data") {
      dataOff = off + 8;
      // len 0 / oversized = header not patched (power cut): use what is there.
      dataLen = len === 0 || len > b.length - dataOff ? b.length - dataOff : len;
      break;
    }
    off += 8 + len + (len & 1);
  }
  if (fmt !== 1 || bits !== 16 || !channels || !rate) return bad(`unsupported format (fmt=${fmt}, bits=${bits})`);
  if (dataOff < 0) return bad("no data chunk");
  const n = Math.floor(dataLen / 2);
  const frame = Math.max(1, Math.round(rate * channels * 0.03)); // 30 ms
  let sum = 0, fsum = 0, fn = 0, active = 0;
  for (let i = 0; i < n; i++) {
    const s = v.getInt16(dataOff + i * 2, true);
    sum += s * s; fsum += s * s; fn++;
    if (fn === frame) { if (Math.sqrt(fsum / fn) > 500) active++; fsum = 0; fn = 0; } // RMS 500 ~ -36 dBFS
  }
  return { ok: true, seconds: dataLen / (rate * channels * 2), rms: n ? Math.round(Math.sqrt(sum / n)) : 0, activeSec: +(active * 0.03).toFixed(2), rate };
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const gw = (env: Env, rec: string) => ({ gateway: { id: env.GATEWAY_ID, skipCache: true, metadata: { rec } } }) as any;

/** Whose clip this is: their Inbox Durable Object and time zone (relative dates, daily caps). */
export type Acct = { inbox: string; tz: string };

// ---------- stage 1: transcribe ----------
export type Transcribed = { seconds: number; rms: number; activeSec: number; transcript: string; gated: boolean; whisperMs: number };

export async function transcribe(env: Env, id: string, wav: Uint8Array, override?: string): Promise<Transcribed> {
  const a = wavInfo(wav);
  const base = { seconds: +a.seconds.toFixed(2), rms: a.rms, activeSec: a.activeSec };
  if (override) return { ...base, transcript: override, gated: false, whisperMs: 0 };
  // Pre-Whisper gate: don't pay for (or hallucinate on) silence / taps.
  if (!a.ok || a.seconds < 0.5 || a.activeSec < 0.25) return { ...base, transcript: "", gated: true, whisperMs: 0 };
  const t0 = Date.now();
  const out = (await env.AI.run(WHISPER, { audio: toBase64(wav), language: "en", vad_filter: true, condition_on_previous_text: false } as any, gw(env, id))) as any;
  return { ...base, transcript: String(out?.text ?? "").trim(), gated: false, whisperMs: Date.now() - t0 };
}

const HALLUCINATIONS = /^(thank you|thanks|thanks for watching|thank you for watching|you|bye|okay|ok|uh|um|hmm|so|\.+)[.!?]*$/i;
/** Nothing to route: the gate, an empty transcript or one of Whisper's stock phrases. */
export function silence(t: Transcribed): string | null {
  if (t.gated) return t.seconds < 0.5 ? "gate:too-short" : "gate:no-audio";
  if (!t.transcript) return "whisper:empty";
  if (t.transcript.split(/\s+/).filter(Boolean).length <= 4 && HALLUCINATIONS.test(t.transcript.trim())) return "hallucination-list";
  return null;
}

// ---------- stage 2: context (runs while Whisper does) ----------
export type Context = {
  now: string; place: string | null; recent: { t: string; ago_s: number }[];
  items: OpenItem[] | null; apps: string[] | null; app: AppState | null; // null: OpenBelt not connected
};

/** The user's local date/time (dates in memos are relative to it; due values are local, no offset). */
export function localNow(tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { today: `${p.year}-${p.month}-${p.day}`, weekday: p.weekday, time: `${p.hour}:${p.minute}` };
}

export const belt = (env: Env, box: string) => new Belt((refreshed) => inbox(env, box).openbeltAccess(openbeltBase(env.OPENBELT_URL), refreshed));

export async function gatherContext(env: Env, acct: Acct, id: string): Promise<Context> {
  const box = inbox(env, acct.inbox);
  const b = belt(env, acct.inbox);
  const [mine, ob] = await Promise.all([
    box.routeContext(id),
    Promise.all([openItems(b), appNames(b)]).catch((e) => { if (!(e instanceof NotConnected)) console.log(`openbelt context ${id}: ${e}`); return null; }),
  ]);
  const { today, weekday, time } = localNow(acct.tz);
  return { now: `${weekday} ${today} ${time} (${acct.tz})`, place: mine.place, recent: mine.recent, items: ob?.[0] ?? null, apps: ob?.[1] ?? null, app: mine.app };
}

// ---------- stage 3: route ----------
const ROUTER = `You route voice memos from paperbot, a push-to-talk gadget (hold a button, talk, release). The transcript comes from Whisper and can be misheard. Kids play with it too.
Pick one action:
- ignore: not a request to the assistant: mic tests, overheard conversation, kids counting or singing, a cut-off fragment with no clear request, filler.
- answer: a quick question or ask that 1-2 short sentences answer now: a joke, the time, the weather, a fact, a simple lookup. "Research X on google.ca" about a quick fact is still answer.
- save: something to keep for later (a todo, errand, shopping item, reminder, appointment, timer, note or idea), or a change to one of the open items (done, remove).
- research: needs reading several web pages: investigate a topic or website, compare options, recommendations.
- app: make or change an app, or add or change data in one of the user's apps other than their paperbot list.
A memo that only completes a cut-off previous memo takes the action the two make together.
title: what the memo is about, max 60 characters, no trailing period.
answer: for answer only: the reply itself, at most 2 short sentences and 120 characters, plain text, when you can answer without the web; null when the answer could have changed in the last year (weather, news, sports results, prices, opening hours, who holds a role) or for other actions.
items: for save only, else null: one entry per thing the memo names ("milk and bananas" is two). op "add" with list (todo: things to do; shopping: things to buy; reminder: anything with a date or time; note: ideas and facts), a short clean title and due (local ISO date or YYYY-MM-DDTHH:MM, else null); or op "done"/"drop" with the id of the open item it means.`;

const ROUTE_SCHEMA = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...ACTIONS] },
    title: { type: "string" },
    answer: { type: ["string", "null"] },
    items: {
      type: ["array", "null"], maxItems: 10,
      items: { type: "object", properties: {
        op: { type: "string", enum: ["add", "done", "drop"] },
        list: { type: "string", enum: [...LISTS] },
        title: { type: "string" },
        due: { type: ["string", "null"] },
        id: { type: ["string", "null"], description: "done/drop: the open item's id" },
      }, required: ["op", "list", "title", "due", "id"] },
    },
  },
  required: ["action", "title", "answer", "items"],
};

export type Routed = { action: Action; title: string; answer: string | null; items: ItemChange[] | null; due: string | null; usd: number; routeMs: number };
const ISO_DUE = /^20\d\d-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])(T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?)?$/;
const usdOf = (u: any) => ((u?.input_tokens ?? 0) * PRICE.in + (u?.output_tokens ?? 0) * PRICE.out) / 1e6 + (u?.server_tool_use?.web_search_requests ?? 0) * PRICE.search;

async function haiku(env: Env, id: string, body: Record<string, unknown>) {
  const res = (await env.AI.run(MODEL as any, body as any, { ...gw(env, id), returnRawResponse: true } as any)) as unknown as Response;
  const out: any = await res.json().catch(() => null);
  if (!res.ok || !out?.content) throw new Error(`${MODEL}: ${res.status} ${JSON.stringify(out).slice(0, 200)}`);
  return out;
}

export function routeInput(transcript: string, c: Context): string {
  const lines = [`Now: ${c.now}`];
  if (c.place) lines.push(`Where the user is: ${c.place}`);
  if (c.apps) lines.push(`The user's apps: ${c.apps.join(", ") || "none"}`);
  if (c.items) lines.push(`Open items: ${JSON.stringify(c.items)}`);
  for (const p of c.recent) lines.push(`Previous memo (${p.ago_s} s ago): ${JSON.stringify(p.t)}`);
  lines.push("", `Memo: ${JSON.stringify(transcript)}`);
  return lines.join("\n");
}

export async function route(env: Env, id: string, transcript: string, c: Context): Promise<Routed> {
  const t0 = Date.now();
  const out = await haiku(env, id, {
    system: ROUTER, max_tokens: 600,
    messages: [{ role: "user", content: routeInput(transcript, c) }],
    tools: [{ name: "decide", description: "Record the decision.", input_schema: ROUTE_SCHEMA }],
    tool_choice: { type: "tool", name: "decide" },
  });
  const d = out.content.find((x: any) => x.type === "tool_use")?.input;
  if (!d || !ACTIONS.includes(d.action)) throw new Error(`router: unexpected reply ${JSON.stringify(out.content).slice(0, 200)}`);
  const title = String(d.title ?? "").trim().replace(/\.$/, "").slice(0, 60) || transcript.slice(0, 60);
  let items: ItemChange[] | null = null;
  if (d.action === "save") {
    const raw: any[] = Array.isArray(d.items) && d.items.length ? d.items.slice(0, 10) : [{ op: "add", list: "note", title }];
    items = raw.map((i) => {
      const op = ["add", "done", "drop"].includes(i?.op) ? i.op : "add";
      const known = op === "add" ? null : (c.items ?? []).find((x) => x.id === i.id) ?? null;
      return {
        op, list: LISTS.includes(i?.list) ? i.list : (known?.list as any) ?? "note",
        title: String(i?.title ?? known?.title ?? title).trim().slice(0, 120) || title,
        due: typeof i?.due === "string" && ISO_DUE.test(i.due) ? i.due : op === "add" ? null : known?.due ?? null,
        id: known?.id ?? null,
      };
    });
  }
  const answer = d.action === "answer" && typeof d.answer === "string" && d.answer.trim() ? d.answer.trim() : null;
  return { action: d.action, title, answer, items, due: items?.find((i) => i.due)?.due ?? null, usd: usdOf(out.usage), routeMs: Date.now() - t0 };
}

// ---------- stage 4: act ----------
/** An answer that needs live facts: one more call, with up to 2 web searches. */
export async function answerWithWeb(env: Env, id: string, transcript: string, c: Context): Promise<{ text: string; usd: number }> {
  const out = await haiku(env, id, {
    system: `You answer a voice memo on a small e-paper screen. Reply with the answer only: at most 120 characters, plain text, no markdown, no links, no preamble and nothing about your sources or how you searched. When sources differ, give the most recent value. Search the web only for live or recent facts.\nNow: ${c.now}${c.place ? `\nWhere the user is: ${c.place}` : ""}`,
    max_tokens: 1000, thinking: { type: "disabled" },
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 2 }],
    messages: [{ role: "user", content: transcript }],
  });
  // Only the text after the last search result: what it says before searching ("I'll check...") is not the answer.
  const last = out.content.map((x: any) => x.type).lastIndexOf("web_search_tool_result");
  const text = brief(out.content.slice(last + 1).filter((x: any) => x.type === "text").map((x: any) => x.text).join(""));
  if (!text) throw new Error("answer: empty reply");
  return { text, usd: usdOf(out.usage) };
}

const ABOUT_SOURCES = /\b(sources?|searched|search results|I can(no|')t|I could(n't| not)|I used|I checked|google)\b/i;
/** What fits the screen: whole sentences up to 120 characters, without the ones about sources or searching. */
export function brief(text: string, max = 120): string {
  const all = text.replace(/\s+/g, " ").trim().match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  const kept = all.filter((s) => !ABOUT_SOURCES.test(s));
  const sentences = kept.length ? kept : all;
  let out = "";
  for (const s of sentences) { if (out && (out + " " + s).length > max) break; out = out ? `${out} ${s}` : s; }
  return out;
}

/** Result of a processed clip, as stored in the Inbox. */
export type Outcome = {
  kind: Action; title: string; due: string | null; transcript: string; noise_reason: string | null;
  summary: string | null; // answer: the answer
  items: Saved[] | null; app: AppState | null; // save: what changed in OpenBelt (ok=false + why "not connected": waits for Connect OpenBelt)
  usd: number; seconds: number; rms: number; active_sec: number; timings: string;
};

/** Do what the router picked: answer it, or write the item to OpenBelt. research / app go to the agent from the Inbox. */
export async function act(env: Env, acct: Acct, id: string, transcript: string, r: Routed, c: Context): Promise<Pick<Outcome, "summary" | "items" | "app"> & { usd: number; actMs: number }> {
  const t0 = Date.now();
  if (r.action === "answer") {
    if (r.answer) return { summary: r.answer, items: null, app: null, usd: 0, actMs: 0 };
    const a = await answerWithWeb(env, id, transcript, c);
    return { summary: a.text, items: null, app: null, usd: a.usd, actMs: Date.now() - t0 };
  }
  if (r.action === "save" && r.items) {
    try {
      const { saved, app } = await applyChanges(belt(env, acct.inbox), c.app, id, r.items);
      return { summary: null, items: saved, app, usd: 0, actMs: Date.now() - t0 };
    } catch (e) {
      if (e instanceof NotConnected) return { summary: null, items: r.items.map((i) => ({ ...i, ok: false, why: "not connected", app_url: null })), app: null, usd: 0, actMs: 0 };
      throw e;
    }
  }
  return { summary: null, items: null, app: null, usd: 0, actMs: 0 };
}

const ignored = (t: Transcribed, reason: string, timings: Record<string, number>): Outcome => ({
  kind: "ignore", title: "(no speech)", due: null, transcript: t.transcript, noise_reason: reason, summary: null, items: null, app: null,
  usd: 0, seconds: t.seconds, rms: t.rms, active_sec: t.activeSec, timings: JSON.stringify(timings),
});
function outcome(t: Transcribed, r: Routed, a: Awaited<ReturnType<typeof act>>, timings: Record<string, number>): Outcome {
  return {
    kind: r.action, title: r.action === "ignore" ? r.title || "(ignored)" : r.title, due: r.due, transcript: t.transcript, noise_reason: null,
    summary: a.summary, items: a.items, app: a.app, usd: +(r.usd + a.usd).toFixed(5),
    seconds: t.seconds, rms: t.rms, active_sec: t.activeSec, timings: JSON.stringify({ ...timings, routeMs: r.routeMs, actMs: a.actMs }),
  };
}

/** Full pipeline for one clip (inline path). Throws on AI/R2/OpenBelt failure (the Workflow then retries). */
export async function processClip(env: Env, acct: Acct, id: string, gen: number, override?: string): Promise<Outcome> {
  const t0 = Date.now();
  const ctxP = gatherContext(env, acct, id); // in parallel with R2 + Whisper
  ctxP.catch(() => {});
  const obj = await env.AUDIO.get(objKey(acct.inbox, "audio", id, ".wav"));
  if (!obj) throw new Error("audio missing in R2");
  const wav = new Uint8Array(await obj.arrayBuffer());
  const r2Ms = Date.now() - t0;
  const t = await transcribe(env, id, wav, override);
  const quiet = silence(t);
  if (quiet) return ignored(t, quiet, { r2Ms, whisperMs: t.whisperMs, pipelineMs: Date.now() - t0 });
  // Live UI: show what was heard while routing runs (not awaited: never slows the pipeline).
  const heard = inbox(env, acct.inbox).heard(id, gen, t.transcript).catch(() => {});
  const c = await ctxP;
  const r = await route(env, id, t.transcript, c);
  const a = await act(env, acct, id, t.transcript, r, c);
  await heard;
  return outcome(t, r, a, { r2Ms, whisperMs: t.whisperMs, pipelineMs: Date.now() - t0 });
}

// ---------- Workflow fallback (durable retries) ----------
export type PipelineParams = { id: string; gen: number; override?: string; fail?: string; inbox?: string; tz?: string };
const RETRY = { retries: { limit: 4, delay: "5 seconds" as const, backoff: "exponential" as const }, timeout: "2 minutes" as const };

export class VoicePipeline extends WorkflowEntrypoint<Env, PipelineParams> {
  async run(event: WorkflowEvent<PipelineParams>, step: WorkflowStep) {
    const { id, gen, override, fail } = event.payload;
    const acct: Acct = { inbox: event.payload.inbox ?? "default", tz: event.payload.tz || this.env.TZ || "UTC" };
    const box = inbox(this.env, acct.inbox);
    try {
      const t = await step.do("transcribe", RETRY, async (ctx) => {
        await box.noteAttempt(id, gen, `workflow#${ctx.attempt}`);
        if (fail === "always") throw new Error(`injected failure (workflow attempt ${ctx.attempt})`);
        const obj = await this.env.AUDIO.get(objKey(acct.inbox, "audio", id, ".wav"));
        if (!obj) throw new NonRetryableError("audio missing in R2");
        return await transcribe(this.env, id, new Uint8Array(await obj.arrayBuffer()), override);
      });
      const quiet = silence(t);
      let o: Outcome;
      if (quiet) o = ignored(t, quiet, { whisperMs: t.whisperMs, via: 1 });
      else {
        await box.heard(id, gen, t.transcript).catch(() => {});
        const c = await step.do("context", RETRY, () => gatherContext(this.env, acct, id));
        const r = await step.do("route", RETRY, () => route(this.env, id, t.transcript, c));
        const a = await step.do("act", RETRY, () => act(this.env, acct, id, t.transcript, r, c));
        o = outcome(t, r, a, { whisperMs: t.whisperMs, via: 1 });
      }
      await step.do("save", RETRY, async () => { await box.complete(id, gen, o, "workflow"); });
      return { kind: o.kind };
    } catch (e) {
      await step.do("record failure", async () => { await box.fail(id, gen, "transcription failed", String(e).slice(0, 300)); });
      throw e;
    }
  }
}
