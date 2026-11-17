// Sign-in for people and their apps (Better Auth, users in D1 AUTH_DB):
// - the web app: Google and passkeys, either one makes a new account (email + password only on deployments with
//   TEST_HOOKS=1, for scripts)
// - setup in the browser (/setup) uses that same session to claim a board token (/v1/setup/claim, src/index.ts)
// - connectors (claude.ai, ChatGPT, Claude Code): OAuth 2.1 / MCP authorization server for /v1/mcp
// The owner is OWNER_EMAIL, and only with a verified address (Google): their inbox stays "default".
import { betterAuth } from "better-auth";
import { jwt } from "better-auth/plugins";
import { getMigrations } from "better-auth/db/migration";
import { passkey } from "@better-auth/passkey";
import { mcp, requireMcpAuth } from "@better-auth/mcp";
import type { Env } from "./env";

/** The address of an account made with only a passkey (no email). Pages show "your passkey" instead. */
export const passkeyEmail = (id: string) => `${id}@passkey.invalid`;

function options(env: Env, origin: string) {
  const google = env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET;
  return {
    appName: "paperbot",
    baseURL: origin,
    secret: env.BETTER_AUTH_SECRET,
    database: env.AUTH_DB,
    trustedOrigins: [origin],
    emailAndPassword: { enabled: env.TEST_HOOKS === "1" },
    socialProviders: google ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, prompt: "select_account" } } : {},
    // No /api/auth/delete-user: deleting an account goes through DELETE /api/account (boards, inbox, files too).
    advanced: { ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] } },
    // Per client IP, stored in D1 so every isolate sees the same counts. Setup codes and sign-ups are the
    // endpoints anyone can call without an account.
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 120,
      customRules: { "/sign-up/email": { window: 60, max: 5 }, "/oauth2/register": { window: 60, max: 10 } },
    },
    plugins: [
      jwt(),
      passkey({
        rpID: new URL(origin).hostname, rpName: "paperbot", origin,
        // Passkey-first sign-up: without a session, registering a passkey creates a new account (signed-in people
        // still add passkeys to their own). The account gets an address that can never be a real one
        // (<id>@passkey.invalid, RFC 2606): no email to verify, and no way to collide with (or be linked to) someone's
        // Google account. It is never the owner (OWNER_EMAIL needs Google).
        registration: {
          requireSession: false,
          resolveUser: () => { const id = crypto.randomUUID(); return { id, name: "paperbot", displayName: "paperbot" }; },
          afterVerification: async ({ ctx, user }: any) => {
            if (await ctx.context.internalAdapter.findUserById(user.id)) return; // a signed-in person adding a passkey
            const u = await ctx.context.internalAdapter.createUser({ id: user.id, email: passkeyEmail(user.id), name: "paperbot", emailVerified: false });
            return { userId: u.id };
          },
        },
      }),
      mcp({
        loginPage: "/login",
        consentPage: "/consent",
        resource: `${origin}/v1/mcp`,
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        scopes: ["openid", "profile", "email", "offline_access", "memos"],
      }),
    ],
  } as any;
}

/** A Better Auth instance for this request. Never shared across requests: on Workers, work an instance started
 *  for an earlier request (its database calls) can't finish once that request has ended, and a later request
 *  waiting on it hangs until it is cancelled (seen on dev: get-session cancelled after 30 s). */
export function auth(env: Env, origin: string) {
  return betterAuth(options(env, origin));
}

/** Creates / updates the auth tables (POST /admin/auth-migrate with the owner token, after a deploy that adds tables). */
export async function migrate(env: Env, origin: string) {
  const m = await getMigrations(options(env, origin));
  await m.runMigrations();
  return { created: m.toBeCreated.map((t: any) => t.table), added: m.toBeAdded.map((t: any) => t.table) };
}

/** Better Auth's routes. Desktop MCP clients (Claude Code) register http://localhost callbacks without
 *  application_type; Better Auth treats them as web clients and refuses http. Loopback-only = native (RFC 8252). */
export async function handleAuth(req: Request, env: Env, url: URL): Promise<Response> {
  if (url.pathname === "/api/auth/oauth2/register" && req.method === "POST") {
    const b = (await req.clone().json().catch(() => null)) as any;
    const loop = (u: string) => { try { return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(u).hostname); } catch { return false; } };
    if (b && !b.application_type && Array.isArray(b.redirect_uris) && b.redirect_uris.length && b.redirect_uris.every(loop)) {
      b.application_type = "native";
      req = new Request(req, { body: JSON.stringify(b) });
    }
  }
  return auth(env, url.origin).handler(req);
}

export type SessionUser = { id: string; email: string; name: string; verified: boolean };
/** Signed-in user from the session cookie. */
export async function sessionUser(req: Request, env: Env, url: URL): Promise<SessionUser | null> {
  try {
    const s = await auth(env, url.origin).api.getSession({ headers: req.headers });
    return s?.user ? { id: s.user.id, email: String(s.user.email).toLowerCase(), name: s.user.name, verified: !!s.user.emailVerified } : null;
  } catch { return null; }
}
export const isOwner = (env: Env, u: SessionUser) => !!env.OWNER_EMAIL && u.verified && u.email === env.OWNER_EMAIL.toLowerCase();

/** /v1/mcp with an OAuth access token (connectors): handler gets the user id (the token's subject).
 *  Access tokens are JWTs checked offline, so the consent is checked too: Disconnect takes effect at once. */
export function withMcpOAuth(env: Env, url: URL, handler: (req: Request, userId: string) => Promise<Response>) {
  return requireMcpAuth(auth(env, url.origin), async (r: Request, claims: any) => {
    const ok = claims?.sub && claims?.azp && (await env.AUTH_DB.prepare("SELECT 1 FROM oauthConsent WHERE userId = ? AND clientId = ?").bind(String(claims.sub), String(claims.azp)).first());
    if (!ok) return new Response(JSON.stringify({ error: "invalid_token", error_description: "disconnected" }), { status: 401, headers: {
      "content-type": "application/json", "www-authenticate": `Bearer error="invalid_token", resource_metadata="${url.origin}/.well-known/oauth-protected-resource/v1/mcp"` } });
    return handler(r, String(claims.sub));
  }, { resource: `${url.origin}/v1/mcp` } as any);
}

export async function userById(env: Env, id: string): Promise<SessionUser | null> {
  const r = (await env.AUTH_DB.prepare("SELECT id, email, name, emailVerified FROM user WHERE id = ?").bind(id).first()) as any;
  return r ? { id: r.id, email: String(r.email).toLowerCase(), name: r.name, verified: !!r.emailVerified } : null;
}

/** Connectors this person has allowed (claude.ai, ChatGPT, Claude Code), from the OAuth provider's tables. */
export async function assistants(env: Env, userId: string) {
  const rows = await env.AUTH_DB.prepare(
    `SELECT c.clientId AS client_id, c.createdAt AS allowed_at, o.name AS name, o.uri AS uri,
       (SELECT MAX(t.createdAt) FROM oauthAccessToken t WHERE t.clientId = c.clientId AND t.userId = c.userId) AS last_used
     FROM oauthConsent c LEFT JOIN oauthClient o ON o.clientId = c.clientId WHERE c.userId = ? ORDER BY c.createdAt DESC`,
  ).bind(userId).all();
  return (rows.results ?? []) as { client_id: string; allowed_at: string | number; name: string | null; uri: string | null; last_used: string | number | null }[];
}
/** Disconnect a connector: its consent and every token it holds for this person stop working. */
export async function revokeAssistant(env: Env, userId: string, clientId: string) {
  const b = [
    env.AUTH_DB.prepare("DELETE FROM oauthAccessToken WHERE userId = ? AND clientId = ?").bind(userId, clientId),
    env.AUTH_DB.prepare("DELETE FROM oauthRefreshToken WHERE userId = ? AND clientId = ?").bind(userId, clientId),
    env.AUTH_DB.prepare("DELETE FROM oauthConsent WHERE userId = ? AND clientId = ?").bind(userId, clientId),
  ];
  const r = await env.AUTH_DB.batch(b);
  return r.reduce((n, x) => n + (x.meta?.changes ?? 0), 0);
}
