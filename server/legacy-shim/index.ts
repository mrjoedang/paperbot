// The old pocket-voice Worker's address (production until 2026-10-17), now a shim.
// - /v1/* (devices on old firmware): passed through unchanged to `paperbot` over a service binding
//   (paperbot checks the same device token; workers.dev Worker-to-Worker fetches are not allowed, bindings are).
// - /v1/export: the legacy task rows, still read from the old TaskList Durable Object (Bearer DEVICE_TOKEN).
// - everything else: 301 to https://app.paperbot.ca (same path + query).
import { DurableObject } from "cloudflare:workers";

interface Env { PAPERBOT: Fetcher; TASKS: DurableObjectNamespace<TaskList>; DEVICE_TOKEN: string }
const NEW_ORIGIN = "https://app.paperbot.ca";

/** The old task list, kept so its SQLite data survives (read-only). */
export class TaskList extends DurableObject<Env> {
  all(): unknown[] {
    try { return this.ctx.storage.sql.exec("SELECT * FROM tasks ORDER BY created_at").toArray(); } catch { return []; }
  }
}

function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/v1/export") {
      const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
      if (!safeEqual(token, env.DEVICE_TOKEN)) return new Response("unauthorized", { status: 401 });
      return Response.json(await env.TASKS.get(env.TASKS.idFromName("default")).all());
    }
    if (url.pathname.startsWith("/v1/")) return env.PAPERBOT.fetch(req);
    return Response.redirect(NEW_ORIGIN + url.pathname + url.search, 301);
  },
} satisfies ExportedHandler<Env>;
