// Sign-in (Google, passkeys; email + password only where test hooks are on) and connector consent. Better Auth
// under /api/auth.
const app = document.getElementById("app");
const page = document.body.dataset.page;
const qs = new URLSearchParams(location.search);

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) el.append(k);
  return el;
}
// Icons (static markup, no untrusted strings).
const svg = (markup, size = 18) => { const t = document.createElement("template"); t.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">${markup}</svg>`; return t.content.firstChild; };
const IC = {
  google: () => svg('<path fill="#4285F4" d="M23.5 12.3c0-.8-.1-1.6-.2-2.3H12v4.4h6.5a5.6 5.6 0 0 1-2.4 3.7v3h3.9c2.3-2.1 3.5-5.2 3.5-8.8z"/><path fill="#34A853" d="M12 24c3.2 0 6-1.1 7.9-2.9l-3.9-3c-1.1.7-2.4 1.2-4 1.2-3.1 0-5.7-2.1-6.6-4.9h-4v3.1A12 12 0 0 0 12 24z"/><path fill="#FBBC05" d="M5.4 14.4a7.2 7.2 0 0 1 0-4.7V6.6h-4a12 12 0 0 0 0 10.8l4-3z"/><path fill="#EA4335" d="M12 4.8c1.8 0 3.3.6 4.6 1.8l3.4-3.4A12 12 0 0 0 1.4 6.6l4 3.1C6.3 6.9 8.9 4.8 12 4.8z"/>'),
  key: () => svg('<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="m10.8 12.2 8.7-8.7M17 6l2.5 2.5M14.5 8.5 17 11"/></g>'),
  check: () => svg('<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m5 12.5 4.5 4.5L19 7.5"/>', 16),
  done: () => svg('<path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="m5 12.5 4.5 4.5L19 7.5"/>', 26),
};
const btn = (label, { primary = false, id, icon, onclick, type = "button" } = {}) =>
  h("button", { class: `btn${primary ? " primary" : ""}`, id, type, onclick }, icon?.(), label);
const msgEl = () => h("p", { class: "auth-msg", id: "msg", role: "status" });
const say = (el, text, kind = "bad") => { el.textContent = text; el.className = `auth-msg ${kind}`; };
const show = (...kids) => app.replaceChildren(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
async function api(path, body, method = body ? "POST" : "GET") {
  const r = await fetch(`/api/auth${path}`, { method, credentials: "same-origin", headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  return { ok: r.ok, status: r.status, body: await r.json().catch(() => null) };
}
const session = async () => (await api("/get-session")).body;
// The account as people know it: an account made with only a passkey has a placeholder address (src/auth.ts).
const byPasskey = (u) => /@passkey\.invalid$/.test(u?.email ?? "");
const whoEl = (u) => byPasskey(u) ? "your passkey account" : h("b", {}, u.email);

// ---- WebAuthn (passkeys) ----
const b64u = {
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
  dec: (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)),
};
// Signed in: a passkey for this account. Signed out (createSession): a new account with just this passkey.
async function addPasskey(createSession = false) {
  const o = (await api("/passkey/generate-register-options")).body;
  const c = await navigator.credentials.create({ publicKey: { ...o, challenge: b64u.dec(o.challenge), user: { ...o.user, id: b64u.dec(o.user.id) },
    excludeCredentials: (o.excludeCredentials || []).map((x) => ({ ...x, id: b64u.dec(x.id) })) } });
  return api("/passkey/verify-registration", { response: { id: c.id, rawId: b64u.enc(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults(),
    response: { clientDataJSON: b64u.enc(c.response.clientDataJSON), attestationObject: b64u.enc(c.response.attestationObject), transports: c.response.getTransports?.() ?? [] } }, name: "passkey", ...(createSession ? { createSession: true } : {}) });
}
async function passkeySignIn() {
  const o = (await api("/passkey/generate-authenticate-options")).body;
  const a = await navigator.credentials.get({ publicKey: { ...o, challenge: b64u.dec(o.challenge), allowCredentials: (o.allowCredentials || []).map((x) => ({ ...x, id: b64u.dec(x.id) })) } });
  return api("/passkey/verify-authentication", { response: { id: a.id, rawId: b64u.enc(a.rawId), type: a.type, clientExtensionResults: a.getClientExtensionResults(),
    response: { clientDataJSON: b64u.enc(a.response.clientDataJSON), authenticatorData: b64u.enc(a.response.authenticatorData), signature: b64u.enc(a.response.signature),
      userHandle: a.response.userHandle ? b64u.enc(a.response.userHandle) : null } } });
}

// After sign-in: continue an OAuth authorization (connector) or go where the person was headed.
function afterSignIn() {
  if (qs.has("client_id") && qs.has("sig")) return `/api/auth/oauth2/authorize${location.search}`;
  // Same origin only: "/\\evil.com" and "//evil.com" both parse to another host.
  try { const u = new URL(qs.get("next") ?? "/", location.origin); return u.origin === location.origin ? u.pathname + u.search + u.hash : "/"; }
  catch { return "/"; }
}
function continueAfterSignIn() { location.href = afterSignIn(); }
async function googleSignIn() {
  const r = await api("/sign-in/social", { provider: "google", callbackURL: afterSignIn(), errorCallbackURL: "/login?error=google" });
  if (r.body?.url) location.href = r.body.url;
  return r;
}

async function loginPage() {
  const s = await session();
  const msg = msgEl();
  if (s?.user) {
    show(h("h2", { class: "auth-title" }, "You're signed in"),
      h("p", { class: "auth-lede" }, ...(byPasskey(s.user) ? ["with your passkey"] : ["as ", h("b", {}, s.user.email)])),
      h("div", { class: "auth-actions" },
        btn("Continue", { primary: true, id: "continue", onclick: continueAfterSignIn }),
        btn("Add a passkey", { id: "add-passkey", icon: IC.key, onclick: async () => {
          const r = await addPasskey().catch((e) => ({ ok: false, body: { message: String(e) } }));
          r.ok ? say(msg, "Passkey added. Next time, sign in with it.", "ok") : say(msg, `Couldn't add a passkey: ${r.body?.message ?? r.status}`);
        } })),
      msg,
      h("p", { class: "auth-foot" }, "Not you? ", h("button", { type: "button", id: "sign-out", onclick: async () => { await api("/sign-out", {}); location.reload(); } }, "Sign out")));
    return;
  }
  const opts = await fetch("/api/sign-in-options").then((r) => r.json()).catch(() => ({ google: true, password: false }));
  if (qs.get("error")) say(msg, "Sign-in didn't finish. Try again.");
  if (qs.has("deleted")) say(msg, "Your account and everything in it was deleted.", "ok");
  const email = h("input", { name: "email", type: "email", autocomplete: "username", placeholder: "Email", class: "auth-input", required: true });
  const pw = h("input", { name: "password", type: "password", autocomplete: "current-password", placeholder: "Password", class: "auth-input", required: true });
  const name = h("input", { name: "name", placeholder: "Name (new accounts)", autocomplete: "name", class: "auth-input" });
  const go = async (path) => {
    const r = await api(path, path.includes("sign-up") ? { email: email.value, password: pw.value, name: name.value || email.value } : { email: email.value, password: pw.value });
    if (r.ok) continueAfterSignIn(); else say(msg, r.body?.message ?? `Sign-in failed (${r.status})`);
  };
  show(h("div", { class: "auth-actions" },
      opts.google && btn("Continue with Google", { primary: true, id: "google", icon: IC.google, onclick: googleSignIn }),
      btn("Sign in with a passkey", { primary: !opts.google, id: "passkey", icon: IC.key, onclick: async () => {
        const r = await passkeySignIn().catch((e) => ({ ok: false, body: { message: String(e) } }));
        if (r.ok) continueAfterSignIn(); else say(msg, r.body?.message?.includes("NotAllowed") ? "Passkey sign-in was cancelled." : `Passkey sign-in failed: ${r.body?.message ?? r.status}`);
      } })),
    msg,
    h("p", { class: "auth-foot" }, "New here? ", h("button", { type: "button", id: "passkey-new", onclick: async () => {
      const r = await addPasskey(true).catch((e) => ({ ok: false, body: { message: String(e) } }));
      if (r.ok) continueAfterSignIn(); else say(msg, String(r.body?.message).includes("NotAllowed") ? "Passkey creation was cancelled." : `Couldn't create a passkey: ${r.body?.message ?? r.status}`);
    } }, "Create a passkey")),
    opts.password && [h("div", { class: "auth-divider" }, "test deployment"),
      // TEMPORARY (remove before launch): one click, a new throwaway account (test deployments only)
      h("p", { class: "auth-foot" }, h("button", { type: "button", id: "test-signin", onclick: async () => {
        // Its own reserved domain (.test: no mail is ever delivered), so OpenBelt makes each one its own workspace instead of
        // offering the one an earlier throwaway made for a shared domain.
        const t = Date.now();
        const r = await api("/sign-up/email", { email: `test-${t}@t${t}.test`, password: crypto.randomUUID(), name: "Test" });
        if (r.ok) continueAfterSignIn(); else say(msg, r.body?.message ?? `Test sign-in failed (${r.status})`);
      } }, "Test sign-in (new throwaway account)")),
      h("details", { id: "test-login", class: "auth-more" }, h("summary", {}, "Use email and password"),
        h("form", { class: "auth-form", onsubmit: (e) => { e.preventDefault(); go("/sign-in/email"); } }, email, pw, name,
          h("div", { class: "auth-actions pair" }, btn("Sign in", { primary: true, id: "signin", type: "submit" }),
            btn("Create account", { id: "signup", onclick: () => go("/sign-up/email") }))))]);
}

async function consentPage() {
  const s = await session();
  if (!s?.user) { location.href = `/login${location.search}`; return; }
  const scopes = (qs.get("scope") ?? "").split(/\s+/).filter(Boolean);
  const msg = msgEl();
  const send = async (accept) => {
    const r = await api("/oauth2/consent", { accept, oauth_query: location.search.slice(1) });
    if (r.body?.url || r.body?.redirect_uri) location.href = r.body.url ?? r.body.redirect_uri; else say(msg, r.body?.error_description ?? `Failed (${r.status})`);
  };
  const can = ["Read your memos and their transcripts", "Send back research and mark memos done"];
  if (scopes.includes("offline_access")) can.push("Stay connected until you disconnect it in Connections");
  show(h("h2", { class: "auth-title" }, "Connect an assistant?"),
    h("p", { class: "auth-lede" }, "An app is asking to use the paperbot of ", whoEl(s.user), ". It will be able to:"),
    h("ul", { class: "auth-list" }, can.map((t) => h("li", {}, IC.check(), t))),
    h("div", { class: "auth-actions pair" }, btn("Allow", { primary: true, id: "allow", onclick: () => send(true) }), btn("Deny", { id: "deny", onclick: () => send(false) })),
    msg);
}

({ login: loginPage, consent: consentPage })[page]?.();
