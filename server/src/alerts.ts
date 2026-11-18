// Alerts to the owner by email: each new account, what paperbot pays a day, sign-up spikes, and the AI Gateway refusing calls.
// Sent as POST ALERT_URL {subject, text} with Bearer ALERT_TOKEN (a mail relay); without ALERT_URL they are only logged.
// Each alert is sent at most once per its window (Directory.alertDue), so a cron that runs every minute can check freely.
import { directory as dirStub, type Env } from "./env";
import type { Account } from "./directory";

const HOUR = 3600_000;
/** New accounts in an hour that look like a spike (a launch day is fine; a script is not). */
const SIGNUPS_PER_HOUR = 30;

export async function alert(env: Env, key: string, everyMs: number, subject: string, text: string): Promise<boolean> {
  if (!(await dirStub(env).alertDue(key, everyMs))) return false;
  console.log(JSON.stringify({ ev: "alert", key, subject }));
  if (!env.ALERT_URL || !env.ALERT_TOKEN) return true;
  try {
    const r = await fetch(env.ALERT_URL, { method: "POST", headers: { authorization: `Bearer ${env.ALERT_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ subject: `paperbot${env.TEST_HOOKS === "1" ? " (dev)" : ""}: ${subject}`, text: `${text}\n\n${env.APP_ORIGIN}` }), signal: AbortSignal.timeout(10_000) });
    if (!r.ok) console.log(JSON.stringify({ ev: "alert_failed", key, status: r.status }));
  } catch (e) { console.log(JSON.stringify({ ev: "alert_failed", key, error: String(e).slice(0, 200) })); }
  return true;
}

export type Spend = { inbox: string; email: string | null; usd: number };

/** Accounts made by test scripts (src/auth.ts: email sign-up on TEST_HOOKS deployments): no mail for them. */
const TEST_EMAIL = /@[a-z0-9.-]+\.test$/i;
/** A new account is mailed once if the sweep sees it this soon after it was made (the sweep runs every minute). */
const NEW_FOR = 15 * 60_000;

/** Every minute, after the sweep: each new account, the last 24 h of spend against ALERT_SPEND_USD, and new accounts in
 *  the last hour. */
export async function checkAlerts(env: Env, spend: Spend[], accounts: Account[]) {
  const people = accounts.filter((a) => a.inbox !== "default" && !TEST_EMAIL.test(a.email));
  for (const a of people.filter((a) => a.created > Date.now() - NEW_FOR)) {
    const who = a.email.endsWith("@passkey.invalid") ? "someone with a passkey" : a.email;
    await alert(env, `signup:${a.inbox}`, 365 * 24 * HOUR, `new sign-up: ${who}`,
      `${who} made a paperbot account (${people.length} account${people.length === 1 ? "" : "s"} besides yours).`);
  }
  const created = accounts.map((a) => a.created);
  const cap = Number(env.ALERT_SPEND_USD ?? 0);
  const total = spend.reduce((a, s) => a + s.usd, 0);
  if (cap > 0) {
    const top = [...spend].sort((a, b) => b.usd - a.usd).slice(0, 5).filter((s) => s.usd > 0)
      .map((s) => `  $${s.usd.toFixed(2)}  ${s.inbox === "default" ? "you" : s.email ?? s.inbox}`).join("\n");
    for (const [pct, every] of [[100, 6 * HOUR], [50, 12 * HOUR]] as const) {
      if (total < (cap * pct) / 100) continue;
      await alert(env, `spend${pct}`, every, `spent $${total.toFixed(2)} in 24 h (${pct}% of $${cap})`,
        `paperbot paid $${total.toFixed(2)} for AI in the last 24 hours. The AI Gateway stops every call at $${cap} a day` +
        ` (rolling), the owner's memos included.\n\nTop accounts:\n${top}\n\nPer-person limits: GUEST_CONFIG and DEFAULTS in server/src/inbox.ts.`);
      break;
    }
  }
  const lastHour = created.filter((t) => t > Date.now() - HOUR).length;
  if (lastHour >= SIGNUPS_PER_HOUR) await alert(env, "signups", 6 * HOUR, `${lastHour} new accounts in an hour`,
    `${lastHour} accounts were made in the last hour. Each one gets the guest limits; together they share the gateway's daily spend limit.`);
}

/** A model call failed: when the AI Gateway refused it for its spend or rate limit, tell the owner (memos are failing). */
export async function onModelError(env: Env, error: unknown) {
  const m = String(error instanceof Error ? error.message : error);
  if (!/spend|budget|cost limit|rate limit|429/i.test(m)) return;
  await alert(env, "gateway", 3 * HOUR, "the AI Gateway is refusing calls", `A model call failed with:\n\n${m.slice(0, 500)}\n\nMemos fail until the limit's window passes.`);
}
