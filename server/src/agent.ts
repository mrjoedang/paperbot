// WorkAgent: one Durable Object per work memo, in one of two modes.
// - research: Pi Durable (PiHarness) with Cloudflare's built-in web_search (exa) / web_fetch tools and a Cloudflare
//   Computer workspace for the report. Budgets: 8 web calls, 12 turns, 150k tokens, 120 s, $0.15 per task.
//   Citation guard: only URLs the agent actually fetched count as verified.
// - build (an app memo): OpenBelt's app tools over MCP, as the person (src/openbelt.ts), and no web tools, so nothing
//   it reads on the web can steer what it deploys. Budgets: 30 tool calls, 24 turns, 300 s, $0.25 per task.
// Model: anthropic/claude-haiku-5-5 via AI Gateway Unified Billing, fallback DeepSeek V4.1 Flash on Workers AI
// (never for a memo on the person's own key: that would bill paperbot).
import { Workspace } from "@cloudflare/computer";
import { createPiTools } from "@cloudflare/computer/tools/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, GenerationTask, Harness, hook, ToolTask, type ToolRegistration } from "@earendil-works/pi-durable";
import { Agent } from "agents";
import { PiHarness } from "agents/harness/pi";
import { createAI } from "agents/models/pi-ai";
import { webFetchTool } from "agents/webfetch/pi";
import { webSearchTool } from "agents/websearch/pi";
import { inbox, objKey, type Env } from "./env";
import { BUILD_TOOLS, buildCallRefusal, Mcp, McpUnauthorized, openbeltBase, type McpTool } from "./openbelt";
import { thoughtStep, toolStep, type Step } from "./logic";

export const PRIMARY_MODEL = "anthropic/claude-haiku-5-5";
export const FALLBACK_MODEL = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
// USD per million tokens: input, cached input (read), cache write, output.
const PRICES: Record<string, [number, number, number, number]> = {
  "anthropic/claude-haiku-5-5": [0.1, 0.01, 0.125, 0.5],
  "@cf/deepseek-ai/deepseek-v4.1-flash-1017": [0.3, 0.006, 0.3, 1.2],
};
const SEARCH_USD = 0.007; // per web_search call (exa), from the pi-gateway-test3 runs
const BUDGETS = {
  research: { maxToolCalls: 14, maxWebCalls: 8, maxTurns: 12, maxTokens: 150_000, wallMs: 120_000 },
  // A build reads two OpenBelt docs pages, deploys into a preview, checks it in a browser, fixes and promotes it: about
  // 12-15 turns whose context (the docs) is re-read each turn, measured in the 2026-11-15 voice-to-app runs.
  build: { maxToolCalls: 30, maxWebCalls: 0, maxTurns: 24, maxTokens: 1_500_000, wallMs: 300_000 },
};
type Mode = keyof typeof BUDGETS;
/** OpenBelt answers (a docs page, an app's files) cut to this many characters before the model reads them. */
const TOOL_TEXT_MAX = 40_000;
const REPORT_PATH = "/workspace/report.md";

// ---------- tool adapters ----------
// REQUIRED: pi-durable >= 1.2 reads ToolExecutionResult.output; the agents 0.28 built-ins return `content`.
// Without this the model receives empty tool results.
function adapt(tool: ToolRegistration<any>, onResult?: (args: any, r: any) => void): ToolRegistration<any> {
  return {
    ...tool,
    async execute(args: any, api: any, context: any) {
      const r: any = await tool.execute(args, api, context);
      onResult?.(args, r);
      if (r && r.output === undefined && r.content !== undefined) {
        const { content, ...rest } = r;
        return { ...rest, output: content };
      }
      return r;
    },
  } as ToolRegistration<any>;
}

function workspaceTools(workspace: Workspace): ToolRegistration<any>[] {
  const { tools, execute } = createPiTools({ workspace, exec: {} }); // no code execution
  return tools
    .filter((t) => ["read", "write", "edit", "ls"].includes(t.name))
    .map((tool): ToolRegistration<any> => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as any,
      replay: tool.name === "edit" ? "unsafe" : "safe",
      async execute(args: any, api: any, context: any) {
        const { content, isError } = await execute({ id: api.callId, name: tool.name, arguments: args }, { abortSignal: context.abortSignal });
        return { output: content as any, isError };
      },
    }));
}

const PREAMBLE = `You are a research assistant working on a task captured as a short voice memo (it may contain transcription errors).
Tools: web_search finds pages; web_fetch reads a URL (HTML, PDF and Office docs are converted to Markdown).
Rules:
- Only cite URLs you actually read with web_fetch. Never invent URLs. Do not cite search results you did not fetch.
- Work like this: 1-2 web_search calls, then web_fetch the 2-3 most relevant pages (official docs, datasheets, vendor pages) and base the answer on what you read. At most ~6 web_search/web_fetch calls in total.
- The user is away from the screen and cannot answer questions: make reasonable assumptions and finish the task.
- If you cannot verify the answer from fetched sources, say so plainly.
- When done, use the write tool ONCE to save the full report as ${REPORT_PATH} (Markdown, max ~300 words, with a "Sources" list of the fetched URLs).
- Then reply with plain text: first line "SUMMARY: <one line, max 60 characters, plain ASCII>", then a 1-3 sentence answer.`;

const BUILD_PREAMBLE = `You build small apps for the user on OpenBelt, from a short voice memo (it may contain transcription errors).
OpenBelt's tools act as the user, in their own OpenBelt workspace. An app there is static files plus OpenBelt's SDK for data.
Rules:
- The user is away from the screen and cannot answer questions: make reasonable assumptions and finish.
- search finds operations and apps; call runs an operation: call({ tool: "deploy_app", args: { ... } }), args fitting the schema search gave.
- Call search first. If an app already fits (the memo may ask to change one), change it (app_files, then deploy_app with edits and base_version) instead of making a new one.
- Read docs pages apps and sdk before your first deploy: call({ tool: "docs", args: { page: "apps" } }).
- Keep it small: one screen, works well on a phone, data saved with the SDK. Never make an app public.
- deploy_app into a preview environment, check_app it there (as a test person), fix until it works, then promote_app to take it live.
- When done, reply with plain text: first line "SUMMARY: App: <host of the live app URL>" (or "SUMMARY: Could not build: <why>", max 60 characters, plain ASCII), then a Markdown report under 200 words: the app link, what it does, the assumptions you made, and "Record a new memo to change it."`;

// The fallback, DeepSeek V4.1 Flash 1017, is newer than this pi-ai's Workers AI catalog (1.3.0; pi-ai 1.5 lists it but
// needs agents >= 0.33): listed here from the catalog's V4 Flash entry with the 1017 id, price and context window
// (developers.cloudflare.com/workers-ai/models/deepseek-v4.1-flash-1017). Delete this when agents is updated.
const LISTED_FROM = "@cf/deepseek-ai/deepseek-v4-flash-0731";
function withFallbackModel(list: readonly any[]): readonly any[] {
  const from = list.find((m) => m?.id === LISTED_FROM);
  if (!from || list.some((m) => m?.id === FALLBACK_MODEL)) return list;
  return [...list, { ...from, id: FALLBACK_MODEL, name: "DeepSeek V4.1 Flash 1017", contextWindow: 1_048_576,
    cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 } }];
}

// Workaround: pi-durable does not pass maxTokens; without it some providers apply a tiny default. A build's deploy_app
// carries the whole app as arguments, after the model's reasoning: 8192 cut DeepSeek's tool call off (2026-11-16).
const MAX_OUTPUT_TOKENS = 32_768;
function withMaxTokens<P extends object>(provider: P): P {
  return new Proxy(provider, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (prop === "getModels" && typeof v === "function") return (...a: unknown[]) => withFallbackModel(v.apply(target, a));
      if ((prop === "stream" || prop === "streamSimple") && typeof v === "function")
        return (model: any, ctx: any, opts: any = {}) =>
          v.call(target, model, ctx, { ...opts, maxTokens: opts.maxTokens ?? Math.min(model.maxTokens ?? MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS) });
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

// agents/models/pi-ai sends third-party models through the gateway's universal endpoint, which is not served by
// Unified Billing on this account; env.AI.run("<vendor>/<model>") is. Rewrite those calls (keeps pi-ai's wire parsers).
const CATALOG_IDS: Record<string, string> = {
  "anthropic/claude-haiku-5-5": "anthropic/claude-haiku-5.5",
  "anthropic/claude-sonnet-5-5": "anthropic/claude-sonnet-5.5",
};
// The person's own API key, when their memo is researched on it: the call goes through the gateway's pass-through
// route with the key in the provider's auth header instead of Unified Billing. pi's harness keeps only a model
// reference (provider + id), so per-call options can't carry it: the agent resolves it here, per request.
type OwnKey = () => Promise<string | null>;
function unifiedBillingBinding(ai: Ai, ownKey: OwnKey = async () => null, onKeyRejected: (why: string) => void = () => {}): Ai {
  return new Proxy(ai as any, {
    get(t, p) {
      if (p !== "gateway") { const v = Reflect.get(t, p, t); return typeof v === "function" ? v.bind(t) : v; }
      return (id: string) => {
        const gw = t.gateway(id);
        return new Proxy(gw, {
          get(g, q) {
            const v = Reflect.get(g, q, g);
            if (q !== "run") return typeof v === "function" ? v.bind(g) : v;
            return async (req: any, opts: any = {}) => {
              if (Array.isArray(req)) { if (await ownKey()) throw new Error("batched model calls can't carry the person's own key"); return v.call(g, req, opts); }
              if (req.provider === "workers-ai") return v.call(g, req, opts); // Workers AI: no provider key involved
              const own = await ownKey(); // throws when the memo needs a key that is gone: never falls back to the owner's billing
              if (own) {
                const auth = req.provider === "anthropic" ? { "x-api-key": own } : { authorization: `Bearer ${own}` };
                const res = await v.call(g, { ...req, headers: { ...(req.headers ?? {}), ...auth } }, opts);
                if (res instanceof Response && (res.status === 401 || res.status === 403)) {
                  onKeyRejected(`${req.provider} answered ${res.status}: ${(await res.clone().text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160)}`);
                }
                return res;
              }
              const { model, ...body } = req.query ?? {};
              const spec = `${req.provider}/${model}`;
              const beta = req.headers?.["anthropic-beta"];
              return t.run(CATALOG_IDS[spec] ?? spec, body, {
                gateway: { ...(opts.gateway ?? {}), id, skipCache: true },
                ...(beta || opts.extraHeaders ? { extraHeaders: { ...(opts.extraHeaders ?? {}), ...(beta ? { "anthropic-beta": beta } : {}) } } : {}),
                returnRawResponse: true,
                signal: opts.signal,
              });
            };
          },
        });
      };
    },
  }) as Ai;
}

// ---------- citation guard / outcome ----------
function normUrl(u: string): string {
  try {
    const x = new URL(u.trim().replace(/[).,;:!?\]>'"]+$/, ""));
    return `${x.hostname.replace(/^www\./, "")}${x.pathname.replace(/\/+$/, "")}${x.search}`.toLowerCase();
  } catch { return u; }
}
function extractUrls(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/https?:\/\/[^\s<>"'`)\]|]+/g)) out.add(m[0].replace(/[.,;:!?]+$/, ""));
  return [...out];
}
export function citationCheck(text: string, fetched: string[]) {
  const ok = new Set(fetched.map(normUrl));
  const cited = extractUrls(text);
  const verified = cited.filter((u) => ok.has(normUrl(u)));
  const unverified = cited.filter((u) => !ok.has(normUrl(u)));
  let annotated = text;
  for (const u of unverified) annotated = annotated.split(u).join(`${u} [unverified]`);
  return { cited: cited.length, verified, unverified, annotated };
}
const HEDGE = /\b(unverified|unconfirmed|not verified|could ?n[o']t (verify|confirm|find|determine)|unable to (verify|confirm|find|determine)|unclear|uncertain|not sure|unknown|probably|possibly|no (reliable|official) source)\b/i;

// ---------- agent ----------
type Meta = { op: string; rec: string; model: string; submitted_at: number; finished_at: number | null; status: string | null; stop_why: string | null; flags: string; cap: number };

export class WorkAgent extends Agent<Env> {
  ai = createAI({ binding: unifiedBillingBinding(this.env.AI, () => this.ownKey(), (why) => { this.keyRejected = why; this.log(`own key rejected: ${why}`); }), id: this.env.GATEWAY_ID });
  /** Set when the provider refused the person's own key: the memo says so instead of "agent failed". */
  private keyRejected: string | null = null;
  private keyCache: { key: string; at: number } | null = null;
  /** This memo's research key (their inbox holds it encrypted), cached for a minute; null = owner's billing. */
  private async ownKey(): Promise<string | null> {
    if (!this.task().ownKey) return null;
    if (this.keyCache && Date.now() - this.keyCache.at < 60_000) return this.keyCache.key;
    const key = await this.box().researchKey();
    if (!key) throw new Error("this memo is researched with the person's own key, which was removed");
    this.keyCache = { key, at: Date.now() };
    return key;
  }
  registry = createRegistry();
  workspace = new Workspace({ storage: this.ctx.storage });
  harness = new PiHarness({
    harness: ({ storage, context }) => {
      const models = createModels();
      models.setProvider(withMaxTokens(this.ai.provider));
      return Harness.open(storage, { models, registry: this.registry, settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 2000 } }, onReport: (e) => console.error("pi report", e) }, context);
    },
    defaults: { model: this.ai(PRIMARY_MODEL), thinkingLevel: "low" },
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS work_meta (op TEXT PRIMARY KEY, rec TEXT, model TEXT, submitted_at INTEGER, finished_at INTEGER,
      status TEXT, stop_why TEXT, flags TEXT, cap REAL)`);
    sql.exec("CREATE TABLE IF NOT EXISTS work_log (at INTEGER, msg TEXT)");
    sql.exec("CREATE TABLE IF NOT EXISTS work_urls (url TEXT, kind TEXT, ok INTEGER, at INTEGER)");
    sql.exec("CREATE TABLE IF NOT EXISTS work_counters (k TEXT PRIMARY KEY, v REAL)");
    sql.exec("CREATE TABLE IF NOT EXISTS work_task (k TEXT PRIMARY KEY, v TEXT)");

    const web = (t: ToolRegistration<any>) => adapt(t, (a, r) => this.recordUrls(t.name, a, r));
    this.registry.install({
      name: "research",
      sections: [
        { key: "preamble", render: () => PREAMBLE, tag: false },
        { key: "today", render: () => new Date().toISOString().slice(0, 10) },
      ],
      tools: [
        web(webFetchTool({ binding: env.AI, pageChars: 12_000, timeoutMs: 25_000 })),
        ...(env.WEB_SEARCH === "1" ? [web(webSearchTool({ binding: env.AI, ...(env.SEARCH_PROVIDER ? { provider: env.SEARCH_PROVIDER as any } : {}), limit: 5, maxDescriptionChars: 300, timeoutMs: 15_000 }))] : []),
        ...workspaceTools(this.workspace),
      ],
    });
    // After eviction a build's agent comes back with the OpenBelt tools it had (start() stored them).
    const stored = this.task();
    if (stored.mode === "build" && stored.obTools) this.installBuild(JSON.parse(stored.obTools));
    this.registry.install({
      name: "budget",
      hooks: [
        hook(ToolTask, {
          beforeTool: (call: any) => {
            const BUDGET = this.budget();
            const isWeb = call.name === "web_fetch" || call.name === "web_search";
            const all = this.bump("tool_calls");
            const webN = isWeb ? this.bump("web_calls") : this.count("web_calls");
            if (call.name === "web_search") this.bump("cost", SEARCH_USD);
            if (all > BUDGET.maxToolCalls) { this.hardStop(`tool_calls>${BUDGET.maxToolCalls}`); return { block: "Tool budget exhausted. No more tools." }; }
            if (isWeb && webN > BUDGET.maxWebCalls) {
              this.note(`web_calls>${BUDGET.maxWebCalls}`);
              this.live({ at: Date.now(), kind: "note", text: "web budget used up: writing it up" }, true);
              return { block: `Web budget exhausted (${BUDGET.maxWebCalls} calls). Write ${REPORT_PATH} from what you have and give the final answer now.` };
            }
            this.live(toolStep(call.name, call.arguments), true);
            return undefined;
          },
        } as any),
        hook(GenerationTask, {
          beforeRequest: (req: any) => {
            const BUDGET = this.budget();
            const m = this.current();
            const turns = this.count("turns"), tokens = this.count("tokens"), cost = this.count("cost");
            const cap = m?.cap ?? 0.15;
            if (cost >= cap) { this.hardStop(`cost $${cost.toFixed(3)}>=$${cap}`); return undefined; }
            if (m && Date.now() - m.submitted_at > BUDGET.wallMs) { this.hardStop(`wall>${BUDGET.wallMs}ms`); return undefined; }
            if (turns >= BUDGET.maxTurns + 2 || tokens >= BUDGET.maxTokens * 1.3) { this.hardStop(turns >= BUDGET.maxTurns + 2 ? "turns (hard)" : "tokens (hard)"); return undefined; }
            if (turns >= BUDGET.maxTurns || tokens >= BUDGET.maxTokens || cost >= cap * 0.75) {
              this.note(turns >= BUDGET.maxTurns ? "turns (soft)" : tokens >= BUDGET.maxTokens ? "tokens (soft)" : "cost (soft)");
              return { messages: [...req.messages, { role: "user", content: "BUDGET EXHAUSTED: do not call any more tools. Give the final answer now (SUMMARY line first).", timestamp: Date.now() }] };
            }
            return undefined;
          },
          afterResponse: (msg: any) => {
            const u = msg.usage ?? {};
            this.bump("turns");
            this.bump("tokens", (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0));
            const [pin, pread, pwrite, pout] = PRICES[this.current()?.model ?? ""] ?? PRICES[PRIMARY_MODEL];
            this.bump("cost", ((u.input ?? 0) * pin + (u.cacheRead ?? 0) * pread + (u.cacheWrite ?? 0) * pwrite + (u.output ?? 0) * pout) / 1e6);
            this.live(thoughtStep(msg), true);
          },
        } as any),
      ],
    } as any);
    this.lifecycle.use(this.harness);

    // After eviction/crash: re-arm the watcher so completion is reported without polling.
    for (const r of sql.exec("SELECT op FROM work_meta WHERE status IS NULL").toArray())
      ctx.waitUntil(this.settle(String(r.op)).catch((e) => this.log(`watch failed ${e}`)));
  }

  log(msg: string) { this.ctx.storage.sql.exec("INSERT INTO work_log VALUES (?, ?)", Date.now(), msg); }
  budget() { return BUDGETS[this.task().mode]; }

  /** Build mode: OpenBelt's app tools in place of the web tools and the report workspace. */
  installBuild(tools: McpTool[]) {
    this.registry.uninstall({ name: "research" } as any);
    this.registry.install({
      name: "build",
      sections: [
        { key: "preamble", render: () => BUILD_PREAMBLE, tag: false },
        { key: "today", render: () => new Date().toISOString().slice(0, 10) },
      ],
      tools: tools.map((t): ToolRegistration<any> => ({
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as any,
        replay: "unsafe", // deploys and promotions must not run twice on a replay
        execute: async (args: any) => {
          const refused = t.name === "call" ? buildCallRefusal(args) : null;
          if (refused) return { output: [{ type: "text", text: refused }] as any, isError: true };
          try {
            const r = await this.obCall(t.name, args);
            // The live URL comes from OpenBelt's own answer, not only from the model's SUMMARY line.
            if (t.name === "call" && args?.tool === "promote_app" && !r.isError)
              for (const u of r.text.matchAll(/"url"\s*:\s*"(https?:\/\/[^"]+)"/g)) this.ctx.storage.sql.exec("INSERT OR REPLACE INTO work_task VALUES ('live_url', ?)", u[1]);
            const text = r.text.length > TOOL_TEXT_MAX ? `${r.text.slice(0, TOOL_TEXT_MAX)}\n[cut at ${TOOL_TEXT_MAX} characters]` : r.text;
            return { output: [{ type: "text", text: text || "(no text)" }] as any, isError: r.isError };
          } catch (e) {
            return { output: [{ type: "text", text: `OpenBelt ${t.name} failed: ${String(e instanceof Error ? e.message : e).slice(0, 300)}` }] as any, isError: true };
          }
        },
      })),
    });
  }
  private obMcp: Mcp | null = null;
  /** One OpenBelt MCP call as the person. A 401 refreshes their sign-in once (their Inbox holds it) and retries. */
  async obCall(name: string, args: unknown) {
    const base = openbeltBase(this.env.OPENBELT_URL);
    for (let attempt = 0; ; attempt++) {
      if (!this.obMcp) {
        const a = await this.box().openbeltAccess(base, attempt > 0);
        if (!a) throw new Error("OpenBelt is not connected (Connections, Apps)");
        this.obMcp = new Mcp(a.url, a.token);
      }
      try { return await this.obMcp.call(name, args); }
      catch (e) {
        this.obMcp = null;
        if (e instanceof McpUnauthorized && attempt === 0) { this.log(`openbelt 401 on ${name}: refreshing`); continue; }
        throw e;
      }
    }
  }
  /** The Inbox this memo belongs to (one per person). */
  box() { return inbox(this.env, this.task().inbox); }
  count(k: string): number { return Number(this.ctx.storage.sql.exec("SELECT v FROM work_counters WHERE k = ?", k).toArray()[0]?.v ?? 0); }
  bump(k: string, by = 1): number {
    this.ctx.storage.sql.exec("INSERT INTO work_counters VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = v + excluded.v", k, by);
    return this.count(k);
  }
  current(): Meta | null { return (this.ctx.storage.sql.exec("SELECT * FROM work_meta ORDER BY submitted_at DESC LIMIT 1").toArray()[0] as unknown as Meta) ?? null; }
  meta(op: string): Meta | null { return (this.ctx.storage.sql.exec("SELECT * FROM work_meta WHERE op = ?", op).toArray()[0] as unknown as Meta) ?? null; }
  note(why: string) { this.log(`budget: ${why}`); }
  /** Live research log -> Inbox hub -> web app. Fire and forget; never blocks the agent. */
  live(step: Step | null, counters = false) {
    const m = this.current();
    if (!m || (!step && !counters)) return;
    const progress = counters ? {
      turns: this.count("turns"), cost: +this.count("cost").toFixed(5), web_calls: this.count("web_calls"), tool_calls: this.count("tool_calls"),
      tokens: this.count("tokens"), model: m.model.replace(/^.*\//, ""), cap: m.cap, started_at: m.submitted_at,
    } : null;
    this.ctx.waitUntil(this.box().agentProgress(m.rec, step, progress).catch((e) => this.log(`live failed ${e}`)));
  }
  hardStop(why: string) {
    const m = this.current();
    if (!m || m.stop_why) return;
    this.ctx.storage.sql.exec("UPDATE work_meta SET stop_why = ? WHERE op = ?", why, m.op);
    this.log(`hard stop: ${why}`);
    this.live({ at: Date.now(), kind: "error", text: `budget stop (${why})` }, true);
    // Do not await inside a hook: abort() waits for the session to go idle.
    this.ctx.waitUntil(this.harness.abort({ operationId: m.op }).then((ok) => this.log(`abort ${ok}`)).catch((e) => this.log(`abort failed ${e}`)));
  }

  recordUrls(tool: string, args: any, r: any) {
    try {
      const now = Date.now();
      const st = r?.details?.output?.status;
      const ok = r && !r.isError && (st === undefined || st < 400) ? 1 : 0;
      const ins = (u: string, kind: string, k: number) => this.ctx.storage.sql.exec("INSERT INTO work_urls VALUES (?, ?, ?, ?)", u, kind, k, now);
      if (tool === "web_fetch") {
        ins(String(args.url), "fetch", ok);
        if (!ok) { let h = String(args.url); try { h = new URL(h).hostname; } catch {} this.live({ at: now, kind: "error", text: `couldn't read ${h}${st ? ` (${st})` : ""}` }); }
        const fin = r?.details?.output?.finalUrl;
        for (const red of r?.details?.output?.redirects ?? []) if (red !== args.url) ins(String(red), "fetch-redirect", ok);
        if (fin && fin !== args.url) ins(String(fin), "fetch-final", ok);
      } else if (tool === "web_search") {
        for (const it of r?.details?.output?.items ?? []) if (it.url) ins(String(it.url), "search", 1);
        if (r?.isError) this.log(`web_search error: ${JSON.stringify(r.details).slice(0, 300)}`);
      }
    } catch (e) { this.log(`recordUrls failed ${e}`); }
  }

  /** Called by the Inbox coordinator. Idempotent per record id. */
  async start(rec: string, transcript: string, title: string, opts: { taskCapUsd: number; flags: string; inbox?: string; ownKey?: boolean; mode?: Mode }) {
    const op = `${rec}-1`;
    if (this.meta(op)) return { op, already: true };
    const mode: Mode = opts.mode ?? "research";
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO work_task VALUES ('transcript', ?), ('title', ?), ('inbox', ?), ('own_key', ?), ('mode', ?)",
      transcript, title, opts.inbox ?? "default", opts.ownKey ? "1" : "", mode);
    if (mode === "build") {
      // OpenBelt's tools as they are now, kept for an agent that comes back after eviction.
      let tools: McpTool[];
      try {
        const base = openbeltBase(this.env.OPENBELT_URL);
        let a = await this.box().openbeltAccess(base);
        if (!a) throw new Error("OpenBelt is not connected");
        try { tools = await new Mcp(a.url, a.token).tools(); }
        catch (e) {
          if (!(e instanceof McpUnauthorized)) throw e;
          a = await this.box().openbeltAccess(base, true);
          if (!a) throw new Error("OpenBelt sign-in expired: connect it again");
          tools = await new Mcp(a.url, a.token).tools();
        }
      } catch (e) {
        throw new Error(`OpenBelt: ${String(e instanceof Error ? e.message : e).slice(0, 200)}`);
      }
      tools = tools.filter((t) => BUILD_TOOLS.includes(t.name));
      if (tools.length !== BUILD_TOOLS.length) throw new Error(`OpenBelt: its MCP lists ${tools.map((t) => t.name).join(", ") || "none"} of ${BUILD_TOOLS.join(", ")}`);
      this.ctx.storage.sql.exec("INSERT OR REPLACE INTO work_task VALUES ('ob_tools', ?)", JSON.stringify(tools));
      this.installBuild(tools);
      this.log(`build: ${tools.length} OpenBelt tools`);
    }
    // Test hook: an unknown model makes the agent fail -> "stopped" (fallback disabled for it).
    const model = opts.flags.includes("agent_fail") ? "anthropic/no-such-model" : PRIMARY_MODEL;
    // Test hook: a $0.002 per-task cap forces the cost hard stop.
    await this.submitOp(op, rec, model, opts.flags, opts.flags.includes("agent_cap") ? 0.002 : opts.taskCapUsd);
    // Test hook: abort the primary run (as if the model call failed) to exercise the fallback model.
    if (opts.flags.includes("agent_abort")) await this.schedule(4, "testAbort", { op });
    await this.schedule(Math.ceil(this.budget().wallMs / 1000) + 5, "deadline", { rec });
    return { op };
  }

  private async submitOp(op: string, rec: string, model: string, flags: string, cap: number) {
    this.ctx.storage.sql.exec("INSERT INTO work_meta (op, rec, model, submitted_at, flags, cap) VALUES (?, ?, ?, ?, ?, ?)", op, rec, model, Date.now(), flags, cap);
    await this.harness.session().setModel(this.ai(model, { metadata: { rec } }));
    const t = this.task();
    const ask = t.mode === "build" ? "App memo" : "Task";
    const receipt = await this.harness.submit(`${ask} (from a voice memo titled "${t.title}"): ${t.transcript}`, { operationId: op });
    this.log(`submit ${op} model=${model} accepted=${receipt.accepted}`);
    this.live({ at: Date.now(), kind: "note", text: `thinking with ${model.replace(/^.*\//, "")}` }, true);
    this.ctx.waitUntil(this.settle(op).catch((e) => this.log(`settle failed ${e}`)));
  }

  task() {
    const rows = this.ctx.storage.sql.exec("SELECT k, v FROM work_task").toArray();
    const g = (k: string) => String(rows.find((r) => r.k === k)?.v ?? "");
    return { transcript: g("transcript"), title: g("title"), inbox: g("inbox") || "default", ownKey: g("own_key") === "1",
      mode: (g("mode") === "build" ? "build" : "research") as Mode, obTools: g("ob_tools") || null };
  }

  async deadline({ rec }: { rec: string }) {
    const m = this.current();
    if (m && !m.status) this.hardStop(`wall>${this.budget().wallMs}ms (alarm)`);
    // If the harness never settles (e.g. stuck abort), report "stopped" anyway after a grace period.
    await this.schedule(30, "forceFinish", { rec });
  }
  async forceFinish({ rec }: { rec: string }) {
    const m = this.current();
    if (m && !m.status) {
      this.ctx.storage.sql.exec("UPDATE work_meta SET status = 'forced', finished_at = ? WHERE op = ?", Date.now(), m.op);
      await this.box().agentFinished(rec, { outcome: "stopped", error: "time limit", detail: "forced after deadline", cost: this.count("cost"), model: m.model, result: null });
    }
  }

  async testAbort({ op }: { op: string }) {
    this.log(`test abort ${op}`);
    this.ctx.waitUntil(this.harness.abort({ operationId: op }).catch(() => false));
  }

  async stop(why: string) { this.hardStop(why); }

  async settle(op: string) {
    const r = await this.harness.wait(op);
    const m = this.meta(op);
    if (!m || m.status) return;
    this.ctx.storage.sql.exec("UPDATE work_meta SET status = ?, finished_at = ? WHERE op = ?", r.status, Date.now(), op);
    this.log(`settled ${op} ${r.status} ${r.reason ?? ""}`);
    const cost = +this.count("cost").toFixed(5);
    const text = r.text ?? "";
    const meta = this.meta(op)!;

    if (r.status !== "done" || !text.trim()) {
      // Model failure (not a budget stop) on the primary model: retry once with the fallback model.
      if (this.keyRejected) {
        await this.box().agentFinished(m.rec, { outcome: "stopped", error: "API key rejected", detail: `${this.keyRejected}. Check the key in Settings → Research.`, cost, model: meta.model, result: null });
        return;
      }
      // Never for a memo on the person's own key: the fallback runs on paperbot's account.
      if (!meta.stop_why && meta.model === PRIMARY_MODEL && !meta.flags.includes("agent_fail") && !this.task().ownKey) {
        this.log(`primary failed (${r.reason ?? "no text"}), falling back to ${FALLBACK_MODEL}`);
        await this.submitOp(`${m.rec}-2`, m.rec, FALLBACK_MODEL, meta.flags, meta.cap);
        return;
      }
      const error = meta.stop_why?.startsWith("cost") ? "task budget" : meta.stop_why?.startsWith("wall") ? "time limit" : meta.stop_why ? "agent budget" : "agent failed";
      await this.box().agentFinished(m.rec, { outcome: "stopped", error, detail: `${meta.stop_why ?? ""} ${r.reason ?? ""}`.trim().slice(0, 300), cost, model: meta.model, result: { answer: text } });
      return;
    }

    if (this.task().mode === "build") {
      let summaryLine = (text.match(/SUMMARY:\s*(.+)/)?.[1] ?? "(no summary)").trim();
      const answer = text.replace(/^.*SUMMARY:.*$/m, "").trim();
      // The app is the URL whose host the SUMMARY names (the report may name docs or a preview first), else the URL
      // promote_app took live (the model may leave the SUMMARY line out).
      const host = summaryLine.match(/^App:\s*([^\s/]+)/i)?.[1]?.toLowerCase() ?? "";
      const urls = [...answer.matchAll(/https?:\/\/[^\s<>"'`)\]]+/g)].map((x) => x[0].replace(/[.,;:!?]+$/, ""));
      const live = (this.ctx.storage.sql.exec("SELECT v FROM work_task WHERE k = 'live_url'").toArray()[0]?.v as string | undefined) ?? null;
      const app = urls.find((u) => { try { return new URL(u).hostname.toLowerCase() === host; } catch { return false; } }) ?? live;
      const built = !!app && !/^Could not build/i.test(summaryLine);
      if (built && !/^App:/i.test(summaryLine)) summaryLine = `App: ${new URL(app).host}`;
      if (!built && !/^Could not build/i.test(summaryLine)) { // it stopped without an app or a reason: say so, don't show DONE
        await this.box().agentFinished(m.rec, { outcome: "stopped", error: "build did not finish", detail: answer.slice(0, 300), cost, model: meta.model, result: { answer } });
        return;
      }
      const result = { summary: summaryLine, answer: answer.split("\n").find((l) => l.trim())?.slice(0, 400) ?? "", report: answer, app_url: app,
        citations: { cited: 0, verified: [], unverified: [] }, hedged: false, budget_note: meta.stop_why,
        counters: { turns: this.count("turns"), tool_calls: this.count("tool_calls"), tokens: this.count("tokens") },
        wall_ms: Date.now() - (this.ctx.storage.sql.exec("SELECT MIN(submitted_at) AS t FROM work_meta").one().t as number) };
      await this.env.AUDIO.put(objKey(this.task().inbox, "reports", m.rec, ".md"), answer, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
      await this.box().agentFinished(m.rec, { outcome: built ? "done" : "unsure", summary: summaryLine, cost, model: meta.model, result });
      return;
    }

    let report: string | null = null;
    try { report = await this.workspace.fs.readFile(REPORT_PATH, "utf8"); } catch {}
    const summaryLine = (text.match(/SUMMARY:\s*(.+)/)?.[1] ?? report?.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "") ?? "(no summary)").trim();
    const fetched = this.ctx.storage.sql.exec("SELECT url FROM work_urls WHERE kind LIKE 'fetch%' AND ok = 1").toArray().map((x) => String(x.url));
    const guard = citationCheck(`${report ?? ""}\n${text}`, fetched);
    const answer = text.replace(/^.*SUMMARY:.*$/m, "").trim();
    const hedged = HEDGE.test(summaryLine) || HEDGE.test(answer.split(/(?<=[.!?])\s/)[0] ?? "");
    const unsure = hedged || guard.unverified.length > 0 || guard.verified.length === 0;
    const result = {
      summary: summaryLine, answer, report: report ? citationCheck(report, fetched).annotated : null,
      citations: { cited: guard.cited, verified: guard.verified, unverified: guard.unverified },
      hedged, budget_note: meta.stop_why, counters: { turns: this.count("turns"), web_calls: this.count("web_calls"), tool_calls: this.count("tool_calls"), tokens: this.count("tokens") },
      wall_ms: Date.now() - (this.ctx.storage.sql.exec("SELECT MIN(submitted_at) AS t FROM work_meta").one().t as number),
    };
    if (report) await this.env.AUDIO.put(objKey(this.task().inbox, "reports", m.rec, ".md"), citationCheck(report, fetched).annotated, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
    await this.box().agentFinished(m.rec, { outcome: unsure ? "unsure" : "done", summary: summaryLine, cost, model: meta.model, result });
  }

  async status() {
    return {
      meta: this.ctx.storage.sql.exec("SELECT * FROM work_meta ORDER BY submitted_at").toArray(),
      counters: Object.fromEntries(this.ctx.storage.sql.exec("SELECT k, v FROM work_counters").toArray().map((r) => [r.k, r.v])),
      urls: this.ctx.storage.sql.exec("SELECT url, kind, ok FROM work_urls ORDER BY at").toArray(),
      log: this.ctx.storage.sql.exec("SELECT at, msg FROM work_log ORDER BY at").toArray(),
      pending: await this.harness.pending(),
    };
  }
}
