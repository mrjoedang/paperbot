// The pages of Settings (settings.js draws the window and the menu): Research, Recording, Devices, Apps,
// Assistants and Account, and the first-visit setup card. Server: /api/me, /api/research, /api/tz, /api/export, /api/account, /api/boards,
// /api/openbelt, /api/assistants (src/index.ts). Untrusted strings only go through h() children.
import { openbeltMark } from "./icons.js";
import { h, api, toast, BASE } from "./dom.js";
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
const KEYS_URL = "https://platform.claude.com/settings/keys";
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

/** Research: one radio per way to research; only the picked one's setup shows. S.researchPick is the radio
 * picked on this visit (settings.js clears it on open); "On" marks the mode the server runs. */
export function researchGroup(S, rerender) {
  const r = me.research ?? {};
  const pick = S.researchPick ?? r.mode;
  const opt = (id, title, desc, soon = false) => h("label", { class: `opt${soon ? " soon" : ""}${id === r.mode ? " current" : ""}`, "data-choice": id },
    h("input", { type: "radio", name: "research", value: id, checked: id === pick || null, disabled: soon || null, onchange: () => { S.researchPick = id; rerender(); } }),
    h("span", { class: "opt-t" }, h("b", null, title), h("span", null, desc)),
    soon ? h("span", { class: "tag" }, "Soon") : id === r.mode ? h("span", { class: "tag ok" }, id === "key" && r.hint ? `Key …${r.hint}` : "On") : null);

  const opts = h("div", { class: "opts", role: "radiogroup", "aria-label": "How memos are researched" },
    r.mode === "included" ? opt("included", "Included", "Research runs on paperbot's own account.") : null,
    opt("assistant", "Ask my assistant", "Free with Claude or ChatGPT. Memos wait until you ask."),
    opt("key", "Use my API key", "Memos are researched as you record them, and your daily limits are 4× higher."),
    opt("chatgpt", "Use my ChatGPT plan", "On your Plus or Pro allowance.", true));

  const removeKey = () => h("button", { class: "btn", type: "button", onclick: async (e) => {
    if (!confirm("Remove your API key? Work memos will wait for your assistant instead.")) return;
    e.currentTarget.classList.add("loading");
    try { me.research = await api("api/research", { method: "DELETE" }); delete S.researchPick; toast("Key removed."); rerender(); } catch (x) { toast(x.message, { bad: true }); rerender(); }
  } }, "Remove key");

  let more = null;
  if (pick === "key") {
    const key = h("input", { id: "byok", type: "password", autocomplete: "off", spellcheck: "false", placeholder: r.hint ? `sk-ant-…${r.hint}` : "sk-ant-…" });
    const res = h("span", { class: "acct-result", role: "status" });
    const save = h("button", { class: "btn primary", type: "button", onclick: async () => {
      const v = key.value.trim();
      if (!v) { res.textContent = "Paste your Anthropic API key first."; res.className = "acct-result bad"; return; }
      save.disabled = true; save.classList.add("loading"); res.className = "acct-result"; res.textContent = "";
      try { me.research = await api("api/research", { method: "POST", body: { provider: "anthropic", key: v } }); key.value = ""; delete S.researchPick; toast("Key saved. Work memos are researched on it."); rerender(); }
      catch (e) { res.textContent = e.message; res.className = "acct-result bad"; save.disabled = false; save.classList.remove("loading"); }
    } }, r.mode === "key" ? "Replace key" : "Save and check key");
    more = h("section", { class: "settings-card-box" },
      h("div", { class: "field" }, h("div", { class: "field-head" }, h("label", { for: "byok" }, "Anthropic API key"),
        h("a", { class: "link-inline", href: KEYS_URL, target: "_blank", rel: "noopener noreferrer" }, "Get a key")), key),
      h("div", { class: "row" }, save, r.mode === "key" ? removeKey() : null, res),
      h("p", { class: "muted small" }, "Uses API credit, not a Claude plan. Up to $0.15 a memo and $5 a day. Stored encrypted."));
  } else if (pick === "assistant") {
    const tab = S.researchTab ?? "cc";
    const tabs = [["cc", "Claude Code"], ["web", "claude.ai"], ["gpt", "ChatGPT"]];
    more = h("section", { class: "settings-card-box" },
      r.mode === "key" ? h("div", { class: "row" }, h("p", { class: "acct-p" }, "Your API key runs research now."), removeKey()) : null,
      h("div", { class: "tabs", role: "tablist", "aria-label": "Assistant" }, tabs.map(([id, label]) =>
        h("button", { type: "button", role: "tab", "aria-selected": String(id === tab), onclick: () => { S.researchTab = id; rerender(); } }, label))),
      tab === "cc"
        ? h("div", { class: "field" }, h("span", { class: "lbl" }, "Run in a terminal"), cmd(`claude mcp add --scope user --transport http paperbot ${MCP_URL()} && claude mcp login paperbot`))
        : h("div", { class: "field" }, h("span", { class: "lbl" }, "Add a custom connector"), cmd(MCP_URL())),
      h("div", { class: "field" }, h("span", { class: "lbl" }, "Then ask it"), cmd(ASK)));
  }
  return group("Research", opts, more);
}

export function recordingGroup(S) {
  const u = me.usage ?? {}, cap = u.audio_cap_min ?? 0, used = Math.round((u.audio_seconds_24h ?? 0) / 60);
  const usd = u.house_cap_usd ?? 0;
  if (!(cap > 0) && !(usd > 0)) return group("Recording", p("No daily limits on this account."));
  const meter = (label, now, max, text) => {
    const pct = Math.min(100, (now / max) * 100);
    return [h("div", { class: `meter${pct > 85 ? " hot" : ""}`, role: "meter", "aria-label": label, "aria-valuemin": "0", "aria-valuemax": String(max), "aria-valuenow": String(now) },
      h("span", { class: "fill", style: { width: `${pct}%` } })), h("p", { class: "muted small" }, text)];
  };
  return group("Recording",
    ...(cap > 0 ? meter("Audio transcribed in the last 24 hours", used, cap, `${used} of ${cap} minutes in the last 24 hours.`) : []),
    ...(usd > 0 ? meter("Answers in the last 24 hours", u.house_usd_24h ?? 0, usd, `${Math.min(100, Math.round(((u.house_usd_24h ?? 0) / usd) * 100))}% of today's answers used.`) : []),
    u.own_key ? null : h("a", { class: "btn", href: "#settings/research", onclick: () => { S.researchPick = "key"; } }, "Raise limits with your API key"));
}

export function accountGroup(S, rerender) {
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const tzRow = h("dd", null, me.tz, here && here !== me.tz ? h("button", { class: "link-inline", type: "button", onclick: async () => {
    try { await api("api/tz", { method: "POST", body: { tz: here } }); me.tz = here; toast(`Time zone set to ${here}`); rerender(); } catch (e) { toast(e.message, { bad: true }); }
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
export const connectOpenbelt = (next = "/#settings/apps") => `${BASE}api/openbelt/connect?next=${encodeURIComponent(next)}`;

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
  return group("Devices", ...list, h("div", { class: "row" }, h("a", { class: "btn", href: "/setup" }, boards?.length ? "Set up another" : "Set up a board"),
    boards?.length ? h("a", { class: "btn", href: "#health" }, "Health and logs") : null));
}

export function assistantsGroup(S, rerender) {
  const a = S.assistants;
  const list = !a ? [h("p", { class: "muted" }, "loading…")]
    : !a.length ? [h("p", { class: "muted" }, "None yet."), h("a", { class: "btn", href: "#settings/research" }, "Connect an assistant")]
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
