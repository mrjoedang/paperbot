// List and Apps: what paperbot keeps in the person's OpenBelt workspace, shown here (GET /api/belt, src/items.ts).
// paperbot keeps no copy: each look reads OpenBelt again, and a check-off here is written there (POST /api/belt/items/<id>).
import { BASE, h, ic, api, toast } from "./dom.js";
import { dueInfo } from "./util.js";
import { connectOpenbelt } from "./account.js";
import { openbeltMark } from "./icons.js";

const LISTS = [["reminder", "Reminders"], ["todo", "Todo"], ["shopping", "Shopping"], ["note", "Notes"]];
const B = { tab: "memos", view: null, loading: false, error: false, pending: new Set(), showDone: false, at: 0, onChange: () => {} };
const host = () => document.getElementById("belt");

/** Show a tab: memos (the inbox), list or apps. */
export function showTab(tab) {
  B.tab = tab;
  document.body.dataset.tab = tab;
  for (const b of document.querySelectorAll("#tabs [data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  host().hidden = tab === "memos";
  render();
  if (tab !== "memos" || !B.view) load();
}

/** A saved memo is done when the items it put on the List are all checked off, and a memo that checked off or removed an item
 *  is done once that worked. Not done while the List isn't known (not connected, not loaded yet) or holds none of its items
 *  (just saved and not read again yet, or deleted in OpenBelt). */
export function memoDone(r) {
  if (r.kind !== "save" || !r.items?.length || !B.view?.connected || !B.view.items) return false;
  const adds = r.items.filter((i) => i.op === "add");
  if (!adds.length) return r.items.every((i) => i.ok);
  if (!adds.every((i) => i.ok)) return false; // not saved yet (waiting for Connect, or failed)
  const mine = B.view.items.filter((i) => i.memo === r.id);
  return mine.length > 0 && mine.every((i) => i.done);
}

/** Something that may have changed the list or the apps (a memo saved or built): read again. */
export function beltChanged() {
  clearTimeout(beltChanged.t);
  beltChanged.t = setTimeout(load, 600);
}

/** Read the List now and when the page comes back after a while away (it may have changed in OpenBelt). onChange: the Memos
 *  tab draws again (which memos are done). */
export function setupBelt(onChange) {
  B.onChange = onChange;
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && Date.now() - B.at > 5000) load(); });
  load();
}

async function load() {
  if (B.loading) return;
  B.loading = true; render();
  try { B.view = await api("api/belt"); B.error = false; B.at = Date.now(); }
  catch { B.error = true; }
  finally { B.loading = false; render(); B.onChange(); }
}

function render() {
  const el = host();
  if (!el || B.tab === "memos") return;
  const v = B.view;
  if (!v) { el.replaceChildren(B.error ? problem() : h("p", { class: "muted belt-wait" }, "Loading…")); return; }
  if (!v.connected) { el.replaceChildren(invite()); return; }
  el.replaceChildren(...(B.tab === "list" ? listView(v) : appsView(v)));
}

function problem() {
  return h("div", { class: "empty" }, h("p", null, B.tab === "list" ? "Couldn't load your list." : "Couldn't load your apps."),
    h("button", { class: "btn", type: "button", onclick: load }, "Try again"));
}

/** Not connected: one line on what Connect is for, and Connect straight to OpenBelt's sign-in, back to this tab. */
function invite() {
  const list = B.tab === "list";
  return h("div", { class: "ob-invite belt-invite" }, h("span", { class: "ob-invite-icon" }, ic(list ? "list" : "apps", 20)),
    h("strong", null, `Connect to OpenBelt to manage your ${list ? "list" : "apps"}`),
    h("a", { class: "btn", href: connectOpenbelt(list ? "/#list" : "/#apps") }, openbeltMark(13), "Connect"));
}

// ---------- List ----------
function listView(v) {
  if (v.items === null) return [problem()];
  const open = v.items.filter((i) => !i.done), done = v.items.filter((i) => i.done);
  const out = [];
  for (const [key, label] of LISTS) {
    const mine = open.filter((i) => i.list === key).sort((a, b) => (a.due ?? "9").localeCompare(b.due ?? "9"));
    if (mine.length) out.push(group(label, mine));
  }
  if (!open.length) out.push(h("div", { class: "empty" }, h("p", null, "Nothing on your list."),
    h("p", { class: "hint" }, "hold", ic("sun"), "on the device and say what to remember")));
  if (done.length) {
    out.push(h("button", { class: "belt-done-toggle", type: "button", "aria-expanded": String(B.showDone), onclick: () => { B.showDone = !B.showDone; render(); } },
      `Done`, h("span", { class: "n" }, done.length)));
    if (B.showDone) out.push(h("ul", { class: "belt-items" }, ...done.slice(0, 100).map(item)));
  }
  return out;
}

function group(label, items) {
  return h("section", { class: "sec belt-group", "aria-label": label }, h("div", { class: "sec-h" }, h("h2", null, label), h("span", { class: "n" }, items.length)),
    h("ul", { class: "belt-items" }, ...items.map(item)));
}

function item(i) {
  const busy = B.pending.has(i.id), due = dueInfo(i.due);
  return h("li", { class: `belt-item${i.done ? " done" : ""}` },
    h("button", { class: `check${busy ? " busy" : ""}`, type: "button", role: "checkbox", "aria-checked": String(i.done), "aria-label": i.done ? `Mark “${i.title}” as open` : `Mark “${i.title}” as done`,
      disabled: busy || null, onclick: () => toggle(i) }, ic("check")),
    h("span", { class: "belt-title" }, i.title),
    due ? h("span", { class: `belt-due${due.overdue && !i.done ? " overdue" : ""}` }, ic("reminder", 14), due.text) : null);
}

async function toggle(i) {
  if (B.pending.has(i.id)) return;
  const was = i.done;
  i.done = !was; B.pending.add(i.id); render();
  try { await api(`api/belt/items/${encodeURIComponent(i.id)}`, { method: "POST", body: { done: i.done } }); }
  catch (e) {
    i.done = was;
    toast(e.status === 404 ? "That item is gone from your list." : "Couldn't save that.", { bad: true });
    if (e.status === 404) B.view.items = B.view.items.filter((x) => x.id !== i.id);
  } finally { B.pending.delete(i.id); render(); B.onChange(); }
}

// ---------- Apps ----------
function appsView(v) {
  if (v.apps === null) return [problem()];
  if (!v.apps.length) return [h("div", { class: "empty" }, h("p", null, "No apps yet."),
    h("p", { class: "hint" }, "hold", ic("sun"), "and say “build me an app that…”"))];
  const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  return [h("ul", { class: "belt-apps" }, ...v.apps.map((a) => h("li", null,
    h("a", { class: "belt-app", href: a.url, target: "_blank", rel: "noopener noreferrer" },
      h("span", { class: "belt-pic" }, h("span", { class: "belt-pic-letter", "aria-hidden": "true" }, a.app.slice(0, 1).toUpperCase()),
        h("img", { src: `${BASE}api/belt/apps/${encodeURIComponent(a.app)}/picture${dark ? "?theme=dark" : ""}`, alt: "", loading: "lazy", decoding: "async",
          onload: (e) => e.target.parentElement.classList.add("has-pic"), onerror: (e) => e.target.remove() })),
      h("span", { class: "belt-app-copy" }, h("strong", null, a.app), a.description ? h("span", null, a.description) : null)))))];
}
