// Prepaid AI credit: one-time CA$10 packs through Stripe Checkout (card, Apple Pay, Google Pay, Link), plain fetch.
// POST /api/credits/checkout -> a Checkout URL. Stripe calls POST /api/stripe/webhook:
//   checkout.session.completed -> the person's Inbox adds the credit (once per session: Stripe retries webhooks);
//   charge.refunded -> the refunded amount comes off again.
// The Inbox keeps the ledger and spends it (src/inbox.ts, "prepaid credit").
import { inbox, type Env } from "./env";

const PACK_CENTS = 1000;
/** EU, EEA, UK and Switzerland charge VAT on digital services from the first sale: no packs there until paperbot sells
 *  through a merchant of record. People there keep the free allowance and can bring their own key. */
const VAT_FIRST_SALE = new Set("AT BE BG HR CY CZ DK EE FI FR DE GR HU IE IT LV LT LU MT NL PL PT RO SK SI ES SE IS LI NO GB CH".split(" "));
export const canBuy = (env: Env, country: unknown) => !!env.STRIPE_SECRET_KEY && typeof country === "string" && !!country && !VAT_FIRST_SALE.has(country);
/** The request's country (Cloudflare); dev scripts may pretend with X-Test-Country. */
export const countryOf = (req: Request, env: Env): string | undefined =>
  (env.TEST_HOOKS === "1" && req.headers.get("x-test-country")) || (req as any).cf?.country;

async function stripe(env: Env, method: "GET" | "POST", path: string, form?: URLSearchParams): Promise<any> {
  const r = await fetch(`https://api.stripe.com/v1/${path}`, { method, body: form,
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) } });
  const j: any = await r.json();
  if (!r.ok) throw new Error(`stripe ${path}: ${r.status} ${j?.error?.message ?? ""}`);
  return j;
}

export async function checkout(env: Env, origin: string, inboxName: string, email: string | null): Promise<string> {
  const f = new URLSearchParams({
    mode: "payment",
    // Every method the account offers (card, Apple Pay, Google Pay, Link) but pay-later ones: for a CA$10 pack they only confuse.
    "excluded_payment_method_types[0]": "klarna",
    "excluded_payment_method_types[1]": "afterpay_clearpay",
    "excluded_payment_method_types[2]": "affirm",
    "line_items[0][quantity]": "1",
    "line_items[0][price_data][currency]": "cad",
    "line_items[0][price_data][unit_amount]": String(PACK_CENTS),
    "line_items[0][price_data][product_data][name]": "paperbot AI credit",
    client_reference_id: inboxName,
    "metadata[inbox]": inboxName,
    "payment_intent_data[metadata][inbox]": inboxName, // for refunds
    success_url: `${origin}/?paid=1#settings/recording`,
    cancel_url: `${origin}/#settings/recording`,
  });
  if (email && !/@passkey\.invalid$/.test(email)) f.set("customer_email", email);
  return (await stripe(env, "POST", "checkout/sessions", f)).url;
}

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
/** Stripe-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "t.body">, within 5 minutes. */
async function signed(env: Env, body: string, header: string | null): Promise<boolean> {
  const parts = (header ?? "").split(",");
  const t = Number(parts.find((p) => p.startsWith("t="))?.slice(2));
  const sigs = parts.filter((p) => p.startsWith("v1=")).map((p) => p.slice(3));
  if (!env.STRIPE_WEBHOOK_SECRET || !t || !sigs.length || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(env.STRIPE_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const want = enc.encode(hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${body}`))));
  return sigs.some((s) => s.length === want.length && crypto.subtle.timingSafeEqual(enc.encode(s), want));
}

export async function webhook(req: Request, env: Env): Promise<Response> {
  const body = await req.text();
  if (!(await signed(env, body, req.headers.get("stripe-signature")))) return new Response("bad signature", { status: 400 });
  const ev = JSON.parse(body), o = ev.data?.object ?? {};
  if (ev.type === "checkout.session.completed" && o.payment_status === "paid" && typeof o.metadata?.inbox === "string") {
    const r = await inbox(env, o.metadata.inbox).addCredit(`stripe:${o.id}`, (o.amount_total ?? 0) / 100, `bought ${o.currency} ${o.payment_intent ?? o.id}`);
    console.log(JSON.stringify({ ev: "credit_bought", inbox: o.metadata.inbox, added: r.added, balance: r.balance }));
  }
  if (ev.type === "charge.refunded" && typeof o.payment_intent === "string") {
    const pi = await stripe(env, "GET", `payment_intents/${o.payment_intent}`);
    const name = pi.metadata?.inbox;
    if (typeof name === "string") {
      // The charge's total refunded so far, so a second partial refund replaces the first entry instead of adding to it.
      const r = await inbox(env, name).setCredit(`refund:${o.id}`, -(o.amount_refunded ?? 0) / 100, `refunded ${o.id}`);
      console.log(JSON.stringify({ ev: "credit_refunded", inbox: name, balance: r.balance }));
    }
  }
  return new Response("ok");
}
