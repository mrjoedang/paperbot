// Settings: one window with a menu of pages. Wider than 700px the menu is a sidebar beside the open page
// (Research when none is named); narrower, the menu is its own page and each page has a back button.
// The address names the page: #settings, #settings/<page> (app.js routeHash).
import { h, ic, api, openDrawer } from "./dom.js";
import { loadMe, loadLinks, researchGroup, recordingGroup, accountGroup, devicesGroup, appsGroup, assistantsGroup } from "./account.js";
import { renderWifi, closeWifi } from "./places.js";

const PAGES = {
  research: ["Research", "search"], recording: ["Recording", "mic"],
  devices: ["Devices", "device"], wifi: ["Wi-Fi", "wifi"], apps: ["Apps", "apps"], assistants: ["Assistants", "assistant"],
  account: ["Account", "user"],
};
const MENU = [[null, ["research", "recording"]], ["Connections", ["devices", "wifi", "apps", "assistants"]], [null, ["account"]]];
const wide = matchMedia("(min-width: 701px)");

let open = false, page = null, shownBefore = null, S0 = null;

export function openSettings(S, to = null, researchPick = null) {
  S0 = S;
  if (!PAGES[to]) to = null;
  if (!open) {
    delete S.researchPick;
    if (researchPick) S.researchPick = researchPick;
    openDrawer("Settings", () => { open = true; }, { hash: to ? `settings/${to}` : "settings", onClose });
    document.querySelector(".drawer-card").classList.add("settings-card");
    loadMe(S).then(render);
    loadLinks(S).then(render);
    if (!S.wifi) api("api/wifi").then((w) => { S.wifi = w; render(); }).catch(() => {});
  }
  show(to);
}

/** Fresh data (a device or Wi-Fi event): redraw the open page. */
export function refreshSettings(S) { if (open) { S0 = S; render(); } }

function onClose() {
  open = false; page = null; shownBefore = null;
  closeWifi();
  const card = document.querySelector(".drawer-card");
  card.classList.remove("settings-card", "at-menu");
  card.querySelector(".settings-nav")?.remove();
  card.querySelector(".settings-back")?.remove();
  document.getElementById("drawer-body").classList.remove("places-panel");
}

function show(to) {
  if (page === "wifi" && to !== "wifi") closeWifi();
  page = to;
  history.replaceState(null, "", `${location.pathname}${location.search}#settings${to ? `/${to}` : ""}`);
  render();
}

wide.addEventListener("change", () => render());

const needsYou = (id) =>
  id === "wifi" ? !!S0?.wifi?.networks?.some((n) => n.needs_psk)
  : id === "devices" ? !!S0?.devices?.[0]?.alerts?.some((a) => a.level === "bad")
  : false;

function render() {
  if (!open) return;
  const card = document.querySelector(".drawer-card"), body = document.getElementById("drawer-body");
  const shown = page ?? (wide.matches ? "research" : null);
  card.classList.toggle("at-menu", !shown);

  const nav = h("nav", { class: "settings-nav", "aria-label": "Settings" }, h("h2", null, "Settings"),
    ...MENU.map(([title, ids]) => h("div", { class: "settings-nav-group" }, title ? h("h3", null, title) : null,
      ...ids.map((id) => h("button", { type: "button", "aria-current": id === shown ? "page" : null, onclick: () => { show(id); body.scrollTop = 0; } },
        ic(PAGES[id][1], 18), h("span", null, PAGES[id][0]),
        needsYou(id) ? h("i", { class: "settings-alert", title: "Needs you" }) : null,
        h("span", { class: "settings-chev", "aria-hidden": "true" }, ic("chevron-right", 18)))))));
  const oldNav = card.querySelector(".settings-nav");
  if (oldNav) oldNav.replaceWith(nav); else card.prepend(nav);

  if (!card.querySelector(".settings-back")) card.querySelector(".drawer-h").prepend(
    h("button", { class: "icon-btn settings-back", type: "button", "aria-label": "Back to Settings", onclick: () => show(null) }, ic("chevron-left", 20)));
  document.getElementById("drawer-title").textContent = shown ? PAGES[shown][0] : "Settings";

  // A re-render keeps the scroll, a key being typed and the focused radio.
  const scroll = shown === shownBefore ? body.scrollTop : 0;
  const typed = body.querySelector("#byok")?.value ?? "";
  const focused = document.activeElement?.matches?.("input[type=radio]") ? document.activeElement.value : null;
  shownBefore = shown;
  body.classList.toggle("places-panel", shown === "wifi");
  if (shown === "wifi") renderWifi(S0, body, render);
  else body.replaceChildren(...(shown ? content(shown) : []));
  const key = body.querySelector("#byok");
  if (key && typed) key.value = typed;
  if (focused) body.querySelector(`input[type=radio][value="${focused}"]`)?.focus();
  body.scrollTop = scroll;
}

function content(id) {
  const me = S0.me;
  if (["research", "recording", "account"].includes(id) && !me) return [h("p", { class: "muted" }, "loading…")];
  if (id === "research") return [researchGroup(S0, render)];
  if (id === "recording") return [recordingGroup(S0)];
  if (id === "account") return [accountGroup(S0, render)];
  if (id === "devices") return [devicesGroup(S0, render)];
  if (id === "apps") return [appsGroup(S0, render)];
  if (id === "assistants") return [assistantsGroup(S0, render)];
  return [];
}
