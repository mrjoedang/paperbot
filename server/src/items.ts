// Saved items live in the person's OpenBelt workspace, in one app paperbot deploys there ("paperbot", the files in
// inbox-app/): collection "items", one document per thing to remember, id = the memo id. paperbot never keeps them.
// Everything here runs as the person over OpenBelt's MCP (src/openbelt.ts), from the pipeline or the Inbox.
import indexHtml from "./inbox-app/index.html";
import openbeltJson from "./inbox-app/openbelt.json";
import { Mcp, McpUnauthorized } from "./openbelt";

export const APP = "paperbot";
export const LISTS = ["todo", "shopping", "reminder", "note"] as const;
export type List = (typeof LISTS)[number];
/** What the router asks for, one per thing the memo names: add a new item, or mark / remove an open one (by its id). */
export type ItemChange = { op: "add" | "done" | "drop"; list: List; title: string; due: string | null; id: string | null };
/** What happened, kept on the memo. ok=false: nothing changed in OpenBelt (why says so). */
export type Saved = ItemChange & { ok: boolean; why: string | null; app_url: string | null };
export type OpenItem = { id: string; list: string; title: string; due: string | null };
/** The deployed app's files hash and URL (kept in the Inbox, so an unchanged app is never deployed again). */
export type AppState = { hash: string; url: string };

const FILES = [{ path: "index.html", content: indexHtml }, { path: "openbelt.json", content: JSON.stringify(openbeltJson, null, 2) + "\n" }];
let filesHash: string | null = null;
async function appHash(): Promise<string> {
  if (filesHash) return filesHash;
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(FILES.map((f) => f.path + "\n" + f.content).join("\n"))));
  return (filesHash = [...d.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join(""));
}

/** OpenBelt as the person: one MCP session, refreshed once on a 401. null access = not connected. */
export type Access = (refreshed: boolean) => Promise<{ url: string; token: string } | null>;
export class Belt {
  private mcp: Mcp | null = null;
  constructor(private access: Access) {}
  /** Throws NotConnected when the person has no OpenBelt sign-in (or it was dropped). */
  async call(name: string, args: Record<string, unknown>) {
    for (let attempt = 0; ; attempt++) {
      if (!this.mcp) {
        const a = await this.access(attempt > 0);
        if (!a) throw new NotConnected();
        this.mcp = new Mcp(a.url, a.token);
      }
      try { return await this.mcp.call(name, args); }
      catch (e) { if (e instanceof McpUnauthorized && attempt === 0) { this.mcp = null; continue; } throw e; }
    }
  }
}
export class NotConnected extends Error { constructor() { super("OpenBelt is not connected"); } }

const parse = (t: string) => { try { return JSON.parse(t); } catch { return null; } };

/** Deploy the app when its files changed since the last deploy (or it was never deployed). */
export async function ensureApp(belt: Belt, known: AppState | null, force = false): Promise<AppState> {
  const hash = await appHash();
  if (known && known.hash === hash && !force) return known;
  const r = await belt.call("deploy_app", { app: APP, description: openbeltJson.description, files: FILES });
  if (r.isError) throw new Error(`deploy ${APP}: ${r.text.slice(0, 200)}`);
  return { hash, url: String(parse(r.text)?.url ?? known?.url ?? "") };
}

/** The open items the router may mark done or remove (newest first). [] before the app exists. */
export async function openItems(belt: Belt, limit = 40): Promise<OpenItem[]> {
  const r = await belt.call("collection_list", { app: APP, collection: "items", limit: 100 });
  if (r.isError) return [];
  const docs = (parse(r.text)?.docs ?? []) as { id: string; data: any }[];
  return docs.filter((d) => d.data && !d.data.done).slice(0, limit)
    .map((d) => ({ id: d.id, list: String(d.data.list ?? "note"), title: String(d.data.title ?? ""), due: d.data.due ?? null }));
}

// ---------- what the web app's List and Apps show (read live from OpenBelt each time; paperbot keeps no copy) ----------
/** memo: the memo that said it (null when added in OpenBelt): the web app shows a saved memo as done when all its items are. */
export type Item = { id: string; list: List; title: string; due: string | null; done: boolean; memo: string | null };
export type BeltApp = { app: string; url: string; description: string; updated: string };
/** An OpenBelt document id (OpenBelt's own rule): what the web app may name in a check-off. */
export const ITEM_ID = /^[A-Za-z0-9_.:@+-]{1,100}$/;

/** Every item, open and done, newest first. [] before the app exists (nothing saved yet). */
export async function allItems(belt: Belt): Promise<Item[]> {
  const out: Item[] = [];
  let cursor: string | null = null;
  do {
    const r = await belt.call("collection_list", { app: APP, collection: "items", limit: 500, ...(cursor ? { cursor } : {}) });
    if (r.isError) { if (/no app|not found|missing|no collection/i.test(r.text)) return []; throw new Error(`items: ${r.text.slice(0, 200)}`); }
    const page = parse(r.text) ?? {};
    for (const d of (page.docs ?? []) as { id: string; data: any }[]) {
      if (!d.data || typeof d.data.title !== "string") continue;
      out.push({ id: d.id, list: LISTS.includes(d.data.list) ? d.data.list : "note", title: d.data.title, due: typeof d.data.due === "string" ? d.data.due : null, done: !!d.data.done, memo: typeof d.data.memo === "string" ? d.data.memo : null });
    }
    cursor = typeof page.cursor === "string" ? page.cursor : null;
  } while (cursor && out.length < 2000);
  return out;
}

/** Check an item off (or back on), as the person would in the list app. */
export async function setDone(belt: Belt, id: string, done: boolean) {
  const r = await belt.call("collection_update", { app: APP, collection: "items", id, data: { done } });
  if (r.isError) throw new Error(/no document|no such/i.test(r.text) ? "gone" : `update: ${r.text.slice(0, 200)}`);
}

/** The person's apps, newest first, without the list app itself (the List tab shows it). */
export async function apps(belt: Belt): Promise<BeltApp[]> {
  const r = await belt.call("app_list", { limit: 50 });
  if (r.isError) throw new Error(`apps: ${r.text.slice(0, 200)}`);
  const all = ((parse(r.text)?.apps ?? []) as any[])
    .map((a) => ({ app: String(a.app), url: String(a.url ?? ""), description: String(a.description ?? ""), updated: String(a.updated ?? "") }));
  return all.filter((a) => a.app !== APP);
}

/** An app's picture (the one OpenBelt's home page shows on its card): WebP bytes and what it is of, or null before the first
 *  is taken. */
export async function picture(belt: Belt, app: string, theme: "light" | "dark") {
  const r = await belt.call("app_picture", { app, theme });
  if (r.isError) throw new Error(`picture: ${r.text.slice(0, 200)}`);
  const about = parse(r.text)?.picture as { version: string; taken: string } | null | undefined;
  if (!about || !r.image) return null;
  const bin = atob(r.image.data), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, type: r.image.mimeType || "image/webp", tag: `${about.version}-${about.taken}` };
}

/** Names of the person's apps (for "add stuff to my to-do app" -> app). */
export async function appNames(belt: Belt): Promise<string[]> {
  const r = await belt.call("app_list", { limit: 50 });
  return r.isError ? [] : ((parse(r.text)?.apps ?? []) as { app: string }[]).map((a) => a.app);
}

/** Apply a memo's changes, in order. Idempotent: a new item's id is the memo id (then -2, -3...), so a retry finds
 *  the ones already there and is done. Throws on the first failure (the pipeline retries the memo). */
export async function applyChanges(belt: Belt, known: AppState | null, memoId: string, changes: ItemChange[]): Promise<{ saved: Saved[]; app: AppState }> {
  let app = await ensureApp(belt, known);
  const saved: Saved[] = [];
  let n = 0;
  for (const c of changes) {
    const done = (ok: boolean, why: string | null) => saved.push({ ...c, ok, why, app_url: app.url || null });
    if (c.op === "add") {
      const id = n++ ? `${memoId}-${n}` : memoId;
      const add = () => belt.call("collection_add", { app: APP, collection: "items", id, data: { list: c.list, title: c.title, due: c.due, done: false, memo: memoId } });
      let r = await add();
      if (r.isError && /no app|not found|missing/i.test(r.text) && !/already exists/.test(r.text)) { app = await ensureApp(belt, null, true); r = await add(); } // deleted in OpenBelt: deploy again
      if (r.isError && !/already exists/.test(r.text)) throw new Error(`save: ${r.text.slice(0, 200)}`);
      done(true, null);
      continue;
    }
    if (!c.id) { done(false, "no matching item"); continue; }
    const r = c.op === "done"
      ? await belt.call("collection_update", { app: APP, collection: "items", id: c.id, data: { done: true } })
      : await belt.call("collection_delete", { app: APP, collection: "items", id: c.id });
    if (r.isError && /no document|no such/i.test(r.text)) { done(false, "already gone"); continue; }
    if (r.isError) throw new Error(`${c.op}: ${r.text.slice(0, 200)}`);
    done(true, null);
  }
  return { saved, app };
}
