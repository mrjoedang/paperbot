// Settings (research, recording, account), the Devices, Apps and Assistants parts of Connections, and the
// first-visit setup card. Server: /api/me, /api/research, /api/tz, /api/export, /api/account, /api/boards,
// /api/openbelt, /api/assistants (src/index.ts). Untrusted strings only go through h() children.
import { openbeltMark } from "./icons.js";
import { h, api, toast, openDrawer, BASE } from "./dom.js";
import { ago } from "./util.js";

export const MCP_URL = () => `${location.origin}/v1/mcp`;
export const ASK = "Check my paperbot work memos and research them";

/** A command or address with a Copy button. */
export function cmd(text) {
  const b = h("button", { type: "button", class: "cmd-copy", onclick: async () => {
    try { await navigator.clipboard.writeText(text); b.textContent = "Copied"; setTimeout(() => (b.textContent = "Copy"), 1500); }
    catch { toast("Couldn't copy. Select the text instead.", { bad: true }); }
  } }, "Copy");
  return h("div", { class: "cmd" }, h("code", null, text), b);
}
const group = (title, ...kids) => h("section", { class: "acct-group" }, h("h3", null, title), ...kids);
const p = (...kids) => h("p", { class: "acct-p" }, ...kids);
const fmtDate = (t) => (t ? new Date(typeof t === "number" ? t : Date.parse(t)).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "");

// ---------------------------------------------------------------- Settings
let me = null;
export async function loadMe(S) {
  try { me = await api("api/me"); S.me = me; } catch { /* signed out: the next request redirects */ }
  return me;
}

export async function signOut() {
  try { await fetch("/api/auth/sign-out", { method: "POST", headers: { "content-type": "application/json" }, body: "{}", credentials: "same-origin" }); } catch {}
  location.href = "/login";
}

export function openSettings(S) {
  const open = !document.getElementById("drawer").hidden && document.getElementById("drawer-title").textContent === "Settings";
  if (!open) openDrawer("Settings", (body) => { body.append(h("p", { class: "muted" }, "loading…")); }, { hash: "settings" });
  loadMe(S).then(() => renderSettings(S));
}

function renderSettings(S) {
  const body = document.getElementById("drawer-body");
  if (!me || document.getElementById("drawer-title").textContent !== "Settings") return;
  const typed = body.querySelector("#byok")?.value ?? ""; // a re-render (fresh data) never drops a key being typed
  body.replaceChildren(researchGroup(S), recordingGroup(), accountGroup(S));
  const key = body.querySelector("#byok");
  if (key && typed) key.value = typed;
}

function researchGroup(S) {
  const r = me.research ?? {};
  const choice = (id, title, desc, tag, more, current) =>
    h("div", { class: `choice${current ? " current" : ""}`, "data-choice": id },
      h("div", { class: "choice-h" }, h("span", null, h("b", null, title), h("span", { class: "muted" }, desc)), tag ? h("span", { class: `tag${current ? " ok" : ""}` }, tag) : null),
      more ? h("div", { class: "choice-more" }, more) : null);

  // own key
  const key = h("input", { id: "byok", type: "password", autocomplete: "off", spellcheck: "false", placeholder: r.hint ? `sk-ant-…${r.hint}` : "sk-ant-…" });
  const res = h("span", { class: "acct-result", role: "status" });
  const save = h("button", { class: "btn primary", type: "button", onclick: async () => {
    const v = key.value.trim();
    if (!v) { res.textContent = "Paste your Anthropic API key first."; res.className = "acct-result bad"; return; }
    save.disabled = true; res.className = "acct-result"; res.textContent = "Checking the key…";
    try { me.research = await api("api/research", { method: "POST", body: { provider: "anthropic", key: v } }); key.value = ""; toast("Key saved. Work memos are researched on it."); renderSettings(S); }
    catch (e) { res.textContent = e.message; res.className = "acct-result bad"; save.disabled = false; }
  } }, r.mode === "key" ? "Replace key" : "Save and check key");
  const remove = r.mode === "key" ? h("button", { class: "btn", type: "button", onclick: async () => {
    if (!confirm("Remove your API key? Work memos will wait for your assistant instead.")) return;
    try { me.research = await api("api/research", { method: "DELETE" }); toast("Key removed."); renderSettings(S); } catch (e) { toast(e.message, { bad: true }); }
  } }, "Remove key") : null;
  const keyMore = [
    h("div", { class: "field" }, h("label", { for: "byok" }, "Anthropic API key"), key),
    h("div", { class: "row" }, save, remove, res),
    h("p", { class: "muted small" }, "Stored encrypted. Research stops at $5 a day."),
  ];

  const assistantMore = [
    h("div", { class: "field" }, h("span", { class: "lbl" }, "Claude Code: run in a terminal (it opens your browser to sign in)"),
      cmd(`claude mcp add --scope user --transport http paperbot ${MCP_URL()} && claude mcp login paperbot`)),
    h("div", { class: "field" }, h("span", { class: "lbl" }, "claude.ai or ChatGPT: add a custom connector with this address"), cmd(MCP_URL())),
    h("div", { class: "field" }, h("span", { class: "lbl" }, "Then ask it"), cmd(ASK)),
  ];

  const kids = [];
  if (r.mode === "included") kids.push(choice("included", "Included", "Research runs on paperbot's own account.", "On", null, true));
  kids.push(
    choice("key", "Use my API key", "Automatic: memos are researched as soon as you record them.", r.mode === "key" ? `Key …${r.hint ?? ""}` : "Not set", keyMore, r.mode === "key"),
    choice("assistant", "Ask my assistant", "Free with Claude or ChatGPT. Memos wait until you ask it to check paperbot.", r.mode === "assistant" ? "On" : null, assistantMore, r.mode === "assistant"),
    choice("chatgpt", "Use my ChatGPT plan", "Automatic, on your Plus or Pro allowance.", "Coming soon", null, false),
  );
  return group("Research", ...kids);
}

function recordingGroup() {
  const u = me.usage ?? {}, cap = u.audio_cap_min ?? 0, used = Math.round((u.audio_seconds_24h ?? 0) / 60);
  if (!(cap > 0)) return group("Recording", p("Transcription has no daily limit on this account."));
  const pct = Math.min(100, (used / cap) * 100);
  return group("Recording",
    h("div", { class: `meter${pct > 85 ? " hot" : ""}`, role: "meter", "aria-label": "Audio transcribed in the last 24 hours", "aria-valuemin": "0", "aria-valuemax": String(cap), "aria-valuenow": String(used) },
      h("span", { class: "fill", style: { width: `${pct}%` } })),
    h("p", { class: "muted small" }, `${used} of ${cap} minutes in the last 24 hours.`));
}

function accountGroup(S) {
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tzRow = h("dd", null, me.tz, here && here !== me.tz ? h("button", { class: "link-inline", type: "button", onclick: async () => {
    try { await api("api/tz", { method: "POST", body: { tz: here } }); me.tz = here; toast(`Time zone set to ${here}`); renderSettings(S); } catch (e) { toast(e.message, { bad: true }); }
  } }, ` use ${here}`) : null);
  const out = h("button", { class: "btn", type: "button", onclick: signOut }, "Sign out");
  const del = me.owner ? null : h("button", { class: "btn danger", type: "button", onclick: async () => {
    const typed = prompt(`This deletes your memos, recordings, Wi-Fi networks and boards for ${/@passkey\.invalid$/.test(me.email) ? "this account" : me.email}. It can't be undone.\n\nType DELETE to confirm.`);
    if (typed !== "DELETE") return;
    try { await api("api/account", { method: "DELETE" }); location.href = "/login?deleted=1"; } catch (e) { toast(e.message, { bad: true }); }
  } }, "Delete account");
  return group("Account",
    h("dl", { class: "kv" }, h("dt", null, "Signed in as"), h("dd", null, /@passkey\.invalid$/.test(me.email) ? "a passkey" : me.email), h("dt", null, "Time zone"), tzRow),
    h("div", { class: "row" }, h("a", { class: "btn", href: `${BASE}api/export`, download: "paperbot-export.json" }, "Download my data"), out, del));
}

// ---------------------------------------------------------------- Connections: devices and assistants
export async function loadLinks(S) {
  const [boards, assistants, openbelt] = await Promise.all([api("api/boards").catch(() => null), api("api/assistants").catch(() => null), api("api/openbelt").catch(() => null)]);
  if (boards) S.boards = boards;
  if (assistants) S.assistants = assistants;
  if (openbelt) S.openbelt = openbelt;
}

/** Where Connect OpenBelt starts: OpenBelt's own sign-in (an email code), then back here. */
export const connectOpenbelt = (next = "/#connections/apps") => `${BASE}api/openbelt/connect?next=${encodeURIComponent(next)}`;

// ---------------------------------------------------------------- Connections: apps (OpenBelt)
export function appsGroup(S, rerender) {
  const o = S.openbelt;
  if (!o) return group("Apps", h("p", { class: "muted" }, "loading…"));
  if (!o.connected) return group("Apps",
    h("a", { class: "btn primary ob-btn", href: connectOpenbelt() }, openbeltMark(18), "Connect OpenBelt"));
  return group("Apps",
    h("div", { class: "acct-item ob-account" },
      h("span", { class: "ob-account-icon" }, openbeltMark(20)),
      h("div", null, h("b", null, o.workspace || "your workspace"), h("span", { class: "muted" }, o.email || "OpenBelt")),
      h("button", { class: "btn small", type: "button", onclick: async () => {
        if (!confirm("Disconnect OpenBelt? paperbot stops building apps until you connect again. Your apps stay in your OpenBelt workspace.")) return;
        try { S.openbelt = await api("api/openbelt", { method: "DELETE" }); toast("OpenBelt disconnected."); rerender(); } catch (e) { toast(e.message, { bad: true }); }
      } }, "Disconnect")));
}

export function devicesGroup(S, rerender) {
  const boards = S.boards;
  const list = !boards ? [h("p", { class: "muted" }, "loading…")]
    : !boards.length ? [h("p", { class: "muted" }, "No board linked yet.")]
    : boards.map((b) => {
      const t = b.telemetry, seen = t?.last_seen ?? b.seen_at;
      const facts = [seen ? `Online ${ago(seen)}` : "Not online yet", b.builtin ? "set up before accounts" : null, (t?.fw ?? b.fw) ? `firmware ${t?.fw ?? b.fw}` : null, t?.batt_pct != null ? `battery ${t.batt_pct}%` : null].filter(Boolean).join(", ");
      return h("div", { class: "acct-item" }, h("div", null, h("b", null, `paperbot ${b.device ?? ""}`.trim()), h("span", { class: "muted" }, facts)),
        b.device && !b.builtin ? h("button", { class: "btn", type: "button", onclick: async () => {
          if (!confirm(`Remove paperbot ${b.device} from your account? It stops syncing right away. Set it up again to link it.`)) return;
          try { await api(`api/boards/${b.device}`, { method: "DELETE" }); S.boards = S.boards.filter((x) => x !== b); toast("Board removed."); rerender(); } catch (e) { toast(e.message, { bad: true }); }
        } }, "Remove") : null);
    });
  return group("Devices", ...list, h("a", { class: "btn", href: "/setup" }, boards?.length ? "Set up another" : "Set up a board"));
}

export function assistantsGroup(S, rerender) {
  const a = S.assistants;
  const list = !a ? [h("p", { class: "muted" }, "loading…")]
    : !a.length ? [h("p", { class: "muted" }, "None yet. Settings → Research shows how to connect Claude or ChatGPT.")]
    : a.map((x) => h("div", { class: "acct-item" },
      h("div", null, h("b", null, x.name || "Assistant"), h("span", { class: "muted" }, [`Allowed ${fmtDate(x.allowed_at)}`, x.last_used ? `last used ${ago(typeof x.last_used === "number" ? x.last_used : Date.parse(x.last_used))}` : null].filter(Boolean).join(", "))),
      h("button", { class: "btn", type: "button", onclick: async () => {
        if (!confirm(`Disconnect ${x.name || "this assistant"}? It can't read your memos any more (an hour at most for one already signed in).`)) return;
        try { await api(`api/assistants/${encodeURIComponent(x.client_id)}`, { method: "DELETE" }); S.assistants = S.assistants.filter((y) => y !== x); toast("Disconnected."); rerender(); } catch (e) { toast(e.message, { bad: true }); }
      } }, "Disconnect")));
  return group("Assistants", ...list);
}

// ---------------------------------------------------------------- first visit
export function setupCard(S, onSettings) {
  return h("section", { class: "setup-card", "aria-labelledby": "setup-h" },
    h("h2", { id: "setup-h" }, "Set up your paperbot"),
    p("Plug it into your computer with a USB-C cable, then open setup in Chrome, Edge or Firefox."),
    h("a", { class: "btn", href: "/setup" }, "Open setup"),
    h("p", { class: "muted small" }, h("button", { class: "link-inline", type: "button", onclick: onSettings }, "Set up research")));
}
