// Directory: one SQLite Durable Object (name "directory") that knows who owns what.
//  - accounts: one per person (Better Auth user id) -> the name of their Inbox Durable Object
//    ("default" = the owner, OWNER_EMAIL with a verified address; "u:<user id>" for everyone else)
//  - board tokens (SHA-256 only) -> account; the owner's legacy DEVICE_TOKEN is checked in the Worker
// Sign-in, sessions and connector OAuth live in Better Auth (src/auth.ts).
// A Durable Object instead of KV: a token minted during setup must work on the board's first request,
// seconds later (KV can take up to a minute to propagate).
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";

export type Account = { inbox: string; user_id: string; email: string; tz: string | null; created: number };
export type Board = { device: string | null; created: number; seen_at: number | null; fw: string | null };

export async function sha256hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const randomToken = (bytes = 24) => {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export class Directory extends DurableObject<Env> {
  sql = this.ctx.storage.sql;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Before sign-up was open, accounts were keyed by email (test deployments only; production never had them):
    // set those tables aside (kept, unused) and start over. The owner's inbox and DEVICE_TOKEN don't live here.
    const cols = this.sql.exec("SELECT name FROM pragma_table_info('accounts')").toArray().map((r: any) => r.name);
    if (cols.length && !cols.includes("user_id")) {
      for (const t of ["accounts", "tokens", "setups"]) {
        if (this.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", t).toArray().length) this.sql.exec(`ALTER TABLE ${t} RENAME TO ${t}_v1`);
      }
    }
    this.sql.exec(`CREATE TABLE IF NOT EXISTS accounts (inbox TEXT PRIMARY KEY, user_id TEXT UNIQUE NOT NULL, email TEXT NOT NULL, tz TEXT, created INTEGER NOT NULL)`);
    this.sql.exec("CREATE TABLE IF NOT EXISTS alerts (key TEXT PRIMARY KEY, at INTEGER NOT NULL)"); // src/alerts.ts: when each was last sent
    this.sql.exec(`CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, inbox TEXT NOT NULL, device TEXT, created INTEGER NOT NULL, seen_at INTEGER, fw TEXT,
      revoked INTEGER NOT NULL DEFAULT 0)`);
  }

  // ---------- accounts ----------
  /** The account of a signed-in person (created on first use). The owner's inbox is "default". */
  account(userId: string, email: string, owner: boolean): Account {
    const cur = this.sql.exec("SELECT * FROM accounts WHERE user_id = ?", userId).toArray()[0] as unknown as Account | undefined;
    if (cur) {
      if (cur.email !== email) this.sql.exec("UPDATE accounts SET email = ? WHERE user_id = ?", email, userId);
      return { ...cur, email };
    }
    const inbox = owner && !this.sql.exec("SELECT 1 FROM accounts WHERE inbox = 'default'").toArray().length ? "default" : `u:${userId}`;
    this.sql.exec("INSERT INTO accounts (inbox, user_id, email, tz, created) VALUES (?, ?, ?, NULL, ?)", inbox, userId, email, Date.now());
    return this.sql.exec("SELECT * FROM accounts WHERE inbox = ?", inbox).one() as unknown as Account;
  }
  /** Claims an alert: true (and noted) when `key` wasn't sent in the last `everyMs`. One writer, so no double mails. */
  alertDue(key: string, everyMs: number): boolean {
    const last = this.sql.exec("SELECT at FROM alerts WHERE key = ?", key).toArray()[0]?.at as number | undefined;
    if (last !== undefined && Date.now() - last < everyMs) return false;
    this.sql.exec("INSERT OR REPLACE INTO alerts VALUES (?, ?)", key, Date.now());
    return true;
  }
  accounts(): Account[] { return this.sql.exec("SELECT * FROM accounts ORDER BY created").toArray() as unknown as Account[]; }
  setTz(inbox: string, tz: string) { this.sql.exec("UPDATE accounts SET tz = ? WHERE inbox = ?", tz, inbox); }
  /** Delete account: its board tokens stop working at once. The inbox's data is wiped by the Worker. */
  removeAccount(inbox: string) {
    this.sql.exec("UPDATE tokens SET revoked = 1 WHERE inbox = ?", inbox);
    this.sql.exec("DELETE FROM accounts WHERE inbox = ?", inbox);
  }

  // ---------- board tokens ----------
  /** Board token -> its account. null = unknown or revoked. */
  resolve(hash: string): { inbox: string; tz: string | null; device: string | null; seen: boolean } | null {
    const r = this.sql.exec("SELECT t.inbox, t.device, t.seen_at, a.tz FROM tokens t LEFT JOIN accounts a ON a.inbox = t.inbox WHERE t.hash = ? AND t.revoked = 0", hash).toArray()[0] as any;
    return r ? { inbox: r.inbox, tz: r.tz ?? null, device: r.device ?? null, seen: !!r.seen_at } : null;
  }
  /** First request from the board with this token (its check-in): setup waits for this. */
  seen(hash: string, fw: string | null) {
    this.sql.exec("UPDATE tokens SET seen_at = ?, fw = COALESCE(?, fw) WHERE hash = ? AND seen_at IS NULL", Date.now(), fw, hash);
  }
  /** A new board token. Setting the same board up again in the same account retires its previous token. */
  async mint(inbox: string, device: string | null): Promise<string> {
    const token = `pb_d_${randomToken()}`, hash = await sha256hex(token);
    this.sql.exec("INSERT INTO tokens (hash, inbox, device, created) VALUES (?, ?, ?, ?)", hash, inbox, device, Date.now());
    if (device) this.sql.exec("UPDATE tokens SET revoked = 1 WHERE inbox = ? AND device = ? AND hash != ?", inbox, device, hash);
    return token;
  }
  /** The account's boards (latest live token per device). */
  boards(inbox: string): Board[] {
    return this.sql.exec(`SELECT device, MAX(created) AS created, MAX(seen_at) AS seen_at, fw FROM tokens WHERE inbox = ? AND revoked = 0 GROUP BY device ORDER BY created DESC`, inbox)
      .toArray() as unknown as Board[];
  }
  /** Remove a board from an account: its tokens stop working at once. */
  revoke(inbox: string, device: string): number {
    return this.sql.exec("UPDATE tokens SET revoked = 1 WHERE inbox = ? AND device = ? AND revoked = 0", inbox, device).rowsWritten;
  }
  status(inbox: string, device: string) {
    const t = this.sql.exec("SELECT seen_at, fw FROM tokens WHERE inbox = ? AND device = ? AND revoked = 0 ORDER BY created DESC LIMIT 1", inbox, device).toArray()[0] as any;
    return { device, online: !!t?.seen_at, seen_at: t?.seen_at ?? null, fw: t?.fw ?? null };
  }
}
