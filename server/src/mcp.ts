// MCP server (Streamable HTTP, stateless JSON responses) at POST /v1/mcp: the person's own Claude
// reads their memos and delivers research and apps for research and app memos. This is how people without included
// research use their existing Claude subscription (docs/setup.md "Research").
// Auth: an OAuth access token from Better Auth (src/auth.ts), bound to <origin>/v1/mcp. Scope: the person's inbox.
import { inbox, objKey, type Env } from "./env";
import { webRecord, type Rec } from "./inbox";
import { validatePatch } from "./logic";

const PROTOCOL = "2025-06-18";

type Tool = { name: string; description: string; inputSchema: Record<string, unknown> };
const TOOLS: Tool[] = [
  {
    name: "list_memos",
    description:
      "List the user's recent paperbot voice memos (newest first). Each has an id, kind (what paperbot did with it: answer, save, research, app), " +
      "title, due date and status; a save memo's item says what was added to, checked off in or removed from their paperbot list in OpenBelt. " +
      "Use research_needed=true to get the research and app memos waiting for you. An app memo asks for an app to be built or changed: " +
      "build it on OpenBelt if you have its tools, then deliver the link with complete_research.",
    inputSchema: {
      type: "object",
      properties: {
        research_needed: { type: "boolean", description: "Only research and app memos waiting for you." },
        kind: { type: "string", enum: ["answer", "save", "research", "app"] },
        include_archived: { type: "boolean", description: "Also memos the user archived (default: open ones only)." },
        limit: { type: "integer", minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: "get_memo",
    description: "Full details of one memo: the transcript of what the user said (may contain transcription errors), title, kind, due date, and any research result.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "complete_research",
    description:
      "Deliver the result of a research or app memo. The summary (max 60 characters, plain ASCII) is shown on the user's paperbot screen; the report " +
      "(Markdown, ideally under 300 words, with a Sources list) appears in the paperbot web app.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        summary: { type: "string", maxLength: 60 },
        report: { type: "string" },
        sources: { type: "array", items: { type: "string" }, description: "URLs you actually read." },
      },
      required: ["id", "summary", "report"],
    },
  },
  {
    name: "update_memo",
    description: "Archive a memo or open it again, or fix its title or due date (ISO date or date-time, or null). A saved memo is done when its items are checked off in the list; that is not set here.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        state: { type: "string", enum: ["open", "archived"] },
        title: { type: "string" },
        due: { type: ["string", "null"] },
      },
      required: ["id"],
    },
  },
];

const INSTRUCTIONS =
  "paperbot is the user's pocket voice-memo gadget. Each memo is answered, saved to the user's paperbot list in OpenBelt, or becomes a research " +
  "or app task. When asked to check paperbot (or when you see research or app memos waiting), call list_memos with research_needed=true, " +
  "read each with get_memo, research it (search the web, read sources), then call complete_research. Keep summaries under 60 characters.";

type RpcReq = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };
const ok = (id: RpcReq["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const err = (id: RpcReq["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

async function callTool(env: Env, box: string, name: string, a: any) {
  const b = inbox(env, box);
  a = a && typeof a === "object" ? a : {};
  if (name === "list_memos") {
    const rows = await b.memos({ research_needed: !!a.research_needed, kind: typeof a.kind === "string" ? a.kind : undefined, open_only: !a.include_archived, limit: Number(a.limit) || 20 });
    return text(rows.length ? JSON.stringify(rows, null, 1) : a.research_needed ? "No research or app memos are waiting." : "No memos.");
  }
  if (typeof a.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(a.id)) return text("id is required (from list_memos)", true);
  if (name === "get_memo") {
    const r = (await b.get(a.id)) as Rec | null;
    if (!r) return text("no memo with that id", true);
    const w = webRecord(r);
    return text(JSON.stringify({ id: w.id, kind: w.kind, title: w.title, due: w.due, status: w.status, state: w.state, transcript: w.transcript,
      recorded: new Date(w.received_at).toISOString(), summary: w.summary, research: (w.agent_result as any)?.report ?? (w.agent_result as any)?.answer ?? null }, null, 1));
  }
  if (name === "complete_research") {
    const summary = String(a.summary ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    const report = String(a.report ?? "").slice(0, 20_000);
    if (!summary || !report.trim()) return text("summary and report are required", true);
    const sources = Array.isArray(a.sources) ? a.sources.filter((u: unknown) => typeof u === "string" && /^https?:\/\//.test(u)).slice(0, 20) : [];
    const r = await b.completeExternal(a.id, { summary, report, sources });
    if (r.error) return text(r.error, true);
    if (report) await env.AUDIO.put(objKey(box, "reports", a.id, ".md"), report, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
    return text("Delivered. It shows on the user's paperbot the next time it checks in.");
  }
  if (name === "update_memo") {
    const patch: Record<string, unknown> = {};
    for (const k of ["state", "title", "due"]) if (k in a) patch[k] = a[k];
    const v = validatePatch(patch);
    if (!v.ok) return text(v.error, true);
    const r = (await b.patch(a.id, v.patch)) as { status: number; error?: string };
    return r.error ? text(r.error, true) : text("Updated.");
  }
  return text(`unknown tool ${name}`, true);
}

async function handle(env: Env, box: string, m: RpcReq): Promise<unknown | null> {
  if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") return err(null, -32600, "invalid request");
  const notification = m.id === undefined;
  switch (m.method) {
    case "initialize":
      return ok(m.id, {
        protocolVersion: typeof m.params?.protocolVersion === "string" ? m.params.protocolVersion : PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "paperbot", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    case "ping": return ok(m.id, {});
    case "tools/list": return ok(m.id, { tools: TOOLS });
    case "tools/call":
      try { return ok(m.id, await callTool(env, box, String(m.params?.name ?? ""), m.params?.arguments)); }
      catch (e) { return ok(m.id, text(`paperbot error: ${String(e).slice(0, 200)}`, true)); }
    default:
      return notification ? null : err(m.id, -32601, `method not found: ${m.method}`);
  }
}

/** POST /v1/mcp (JSON-RPC, single message or batch). GET/DELETE: 405 (no server-initiated stream, no sessions). */
export async function handleMcp(req: Request, env: Env, box: string): Promise<Response> {
  if (req.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
  let body: unknown;
  try { body = await req.json(); } catch { return Response.json(err(null, -32700, "parse error"), { status: 400 }); }
  const msgs = Array.isArray(body) ? body : [body];
  const out = (await Promise.all(msgs.map((m) => handle(env, box, m as RpcReq)))).filter((x) => x !== null);
  if (!out.length) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? out : out[0], { headers: { "cache-control": "no-store" } });
}
