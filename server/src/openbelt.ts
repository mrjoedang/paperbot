// OpenBelt (https://openbelt.com): where a person's app memos become apps. paperbot signs in to the person's OpenBelt
// workspace with OAuth, as any MCP client does (OpenBelt docs/mcp.md "Signing in (OAuth)"): it registers itself, sends the
// person to OpenBelt's sign-in (an email code, the email filled in with login_hint), and keeps the tokens sealed in their
// Inbox. OpenBelt never trusts paperbot to say who someone is. The WorkAgent then builds over OpenBelt's MCP (/mcp).
// The access and refresh tokens carry the workspace (<workspace>~pra_...), so the one base address serves them all.

/** The OpenBelt base address (no trailing slash): OPENBELT_URL, e.g. https://openbelt.com or http://localhost:2340. */
export const openbeltBase = (url: string | undefined) => (url ?? "https://openbelt.com").replace(/\/+$/, "");

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
export async function pkceChallenge(verifier: string) {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

async function answer(res: Response, what: string): Promise<Record<string, any>> {
  const text = await res.text();
  let body: Record<string, any> = {};
  try { body = JSON.parse(text); } catch {}
  if (!res.ok) throw new Error(`OpenBelt ${what}: ${res.status} ${body.error_description ?? body.error ?? text.slice(0, 200)}`);
  return body;
}

/** Register paperbot as a public OAuth client (RFC 7591) for this redirect address. One registration per sign-in:
 *  OpenBelt keeps clients someone signed in with and drops the rest after a day, so nothing global to keep here. */
export async function register(base: string, redirectUri: string): Promise<string> {
  const body = await answer(await fetch(`${base}/_oauth/register`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "paperbot", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" }),
  }), "client registration");
  if (typeof body.client_id !== "string") throw new Error("OpenBelt client registration: no client_id");
  return body.client_id;
}

export function authorizeUrl(base: string, p: { clientId: string; redirectUri: string; state: string; challenge: string; loginHint: string | null }) {
  const q = new URLSearchParams({
    response_type: "code", client_id: p.clientId, redirect_uri: p.redirectUri, state: p.state,
    code_challenge: p.challenge, code_challenge_method: "S256", resource: `${base}/mcp`,
  });
  if (p.loginHint) q.set("login_hint", p.loginHint);
  return `${base}/_oauth/authorize?${q}`;
}

export type Tokens = { access: string; refresh: string | null };
const tokensOf = (b: Record<string, any>): Tokens => {
  if (typeof b.access_token !== "string") throw new Error("OpenBelt token answer has no access_token");
  return { access: b.access_token, refresh: typeof b.refresh_token === "string" ? b.refresh_token : null };
};

export async function exchange(base: string, p: { code: string; clientId: string; redirectUri: string; verifier: string }): Promise<Tokens> {
  return tokensOf(await answer(await fetch(`${base}/_oauth/token`, {
    method: "POST",
    body: new URLSearchParams({ grant_type: "authorization_code", code: p.code, client_id: p.clientId, redirect_uri: p.redirectUri, code_verifier: p.verifier, resource: `${base}/mcp` }),
  }), "token exchange"));
}

export async function refresh(base: string, p: { refresh: string; clientId: string }): Promise<Tokens> {
  return tokensOf(await answer(await fetch(`${base}/_oauth/token`, {
    method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: p.refresh, client_id: p.clientId }),
  }), "token refresh"));
}

/** Sign paperbot out on OpenBelt (RFC 7009). Best effort: the tokens are deleted here either way. */
export async function revoke(base: string, p: { token: string; clientId: string }) {
  await fetch(`${base}/_oauth/revoke`, { method: "POST", body: new URLSearchParams({ token: p.token, client_id: p.clientId }) }).catch(() => {});
}

// ---------- MCP (Streamable HTTP, JSON-RPC) ----------
const PROTOCOL = "2025-06-18";
export class McpUnauthorized extends Error {}

/** One JSON-RPC message from a JSON or event-stream answer. */
function messageOf(text: string): Record<string, any> {
  const t = text.trim();
  if (t.startsWith("{")) return JSON.parse(t);
  const data = t.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).filter(Boolean);
  for (let i = data.length - 1; i >= 0; i--) { try { const m = JSON.parse(data[i]); if (m.id !== undefined) return m; } catch {} }
  throw new Error(`MCP: unreadable answer ${t.slice(0, 120)}`);
}

export type McpTool = { name: string; description: string; inputSchema: Record<string, unknown> };
/** image: the first image block, if the tool sent one (app_picture: the app's picture as base64 WebP). */
export type McpResult = { text: string; isError: boolean; image: { data: string; mimeType: string } | null };

/** A session with OpenBelt's /mcp as the person. A 401 throws McpUnauthorized (the caller refreshes and retries). */
export class Mcp {
  private session: string | null = null;
  private id = 0;
  constructor(private url: string, private token: string) {}

  private async post(payload: Record<string, unknown>, notification = false) {
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${this.token}`, "mcp-protocol-version": PROTOCOL };
    if (this.session) headers["mcp-session-id"] = this.session;
    const res = await fetch(this.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...payload, ...(notification ? {} : { id: ++this.id }) }) });
    if (res.status === 401) throw new McpUnauthorized((await res.text()).slice(0, 300));
    this.session = res.headers.get("mcp-session-id") ?? this.session;
    if (notification) return null;
    if (!res.ok) throw new Error(`MCP ${String(payload.method)}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const m = messageOf(await res.text());
    if (m.error) throw new Error(`MCP ${String(payload.method)}: ${m.error.message ?? JSON.stringify(m.error).slice(0, 200)}`);
    return m.result ?? {};
  }

  async open() {
    if (this.session) return;
    await this.post({ method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "paperbot", version: "1" } } });
    await this.post({ method: "notifications/initialized" }, true);
  }

  async tools(): Promise<McpTool[]> {
    await this.open();
    const out: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const r: any = await this.post({ method: "tools/list", params: cursor ? { cursor } : {} });
      for (const t of r.tools ?? []) out.push({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema ?? { type: "object" } });
      cursor = r.nextCursor;
    } while (cursor);
    return out;
  }

  async call(name: string, args: unknown): Promise<McpResult> {
    await this.open();
    const r: any = await this.post({ method: "tools/call", params: { name, arguments: args ?? {} } });
    const text = (r.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => String(c.text)).join("\n")
      || (r.structuredContent ? JSON.stringify(r.structuredContent) : "");
    const img = (r.content ?? []).find((c: any) => c?.type === "image" && typeof c.data === "string");
    return { text, isError: !!r.isError, image: img ? { data: img.data, mimeType: String(img.mimeType ?? "") } : null };
  }
}

/** OpenBelt's MCP lists two tools: search finds operations (with their input schemas), call runs one by name. */
export const BUILD_TOOLS = ["search", "call"];
/** The operations a build may call: making and checking apps in the person's workspace. Never people, connections,
 *  tokens, workspace settings or execute (docs: OpenBelt's tool list). */
export const BUILD_OPERATIONS = ["docs", "skills", "whoami", "deploy_app", "promote_app", "preview_reset", "check_app", "app_info", "app_files", "app_diff", "app_logs"];
/** Why a build's call is refused (null: it may run). */
export const buildCallRefusal = (args: any): string | null =>
  BUILD_OPERATIONS.includes(args?.tool) ? null : `paperbot builds may call only these operations: ${BUILD_OPERATIONS.join(", ")}.`;
