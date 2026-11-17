import { setupInstall } from "./install.js";
import { consumeRefreshState, setupAppUpdates } from "./updates.js";
// paperbot web app: live inbox over a WebSocket (Inbox Durable Object hub); the device replica is the robot.
import { drawMirror, MOODS } from "./bolt.js";
import { renderMarkdown, shortUrl } from "./md.js";
import { ago, dueInfo, usd, dur, clock, startOfDay } from "./util.js";
import { BASE, h, ic, api, toast, cssVar, reducedMotion, openDrawer, closeDrawer, initDrawer, paintCrisp } from "./dom.js";
import { openHealth, refreshHealth, setDeviceContent } from "./health.js";
import { openPlaces, refreshPlaces } from "./places.js";
import { openSettings, setupCard, loadLinks, cmd, ASK, signOut, connectOpenbelt } from "./account.js";
import { beltChanged, memoDone, setupBelt, showTab } from "./belt.js";

// ---------- state ----------
const S = {
  recs: new Map(), devices: [], budget: null, wifi: null, conn: "connecting", ready: false,
  view: "open", kind: "all", noise: false, q: "", expanded: new Set(), showAll: false, showDone: false,
  incoming: new Map(), newSteps: new Set(), skew: 0, rtt: null,
};
// A memo's kind is what the router did with it (server/src/pipeline.ts); a saved item lives in the person's OpenBelt list.
const KINDS = [["all", "All", "list"], ["save", "Saved", "todo"], ["answer", "Answers", "assistant"], ["research", "Research", "work"], ["app", "Apps", "apps"]];
const KIND_ICON = { save: "todo", answer: "assistant", research: "work", app: "apps", ignore: "noise" };
const KIND_WORD = { save: "saved", answer: "answer", research: "research", app: "app", ignore: "ignored" };
const LIST_ICON = { todo: "todo", shopping: "box", reminder: "reminder", note: "note" };
const AGENT_KINDS = ["research", "app"];
const kindIcon = (r) => (r.kind === "save" ? LIST_ICON[r.items?.[0]?.list] ?? "todo" : KIND_ICON[r.kind] ?? "note");
const kindWord = (r) => { const it = r.items?.[0]; return r.kind === "save" ? (it?.op === "done" ? "checked off" : it?.op === "drop" ? "removed" : it?.list ?? "saved") : KIND_WORD[r.kind] ?? r.kind; };
const kindLabel = (k) => (KINDS.find(([x]) => x === k)?.[1] ?? KIND_WORD[k] ?? k).toLowerCase();
// Latency probes for tests: event arrival and first render per record (same clock as the test harness).
const probe = (window.__pv = { S, events: 0, seen: {}, log: [] });

const refreshedState = consumeRefreshState();
if (refreshedState) {
  S.q = typeof refreshedState.q === "string" ? refreshedState.q : "";
  S.view = refreshedState.view === "archived" ? "archived" : "open";
  S.kind = KINDS.some(([kind]) => kind === refreshedState.kind) ? refreshedState.kind : "all";
  S.noise = !!refreshedState.noise; S.showAll = !!refreshedState.showAll;
}

// ---------- connection: WebSocket with backoff, polling fallback ----------
let ws = null, wsTries = 0, reconnectTimer = 0, hbTimer = 0, pingAt = 0, pollTimer = 0;
const wsUrl = () => `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${BASE}api/live`;

function connect() {
  clearTimeout(reconnectTimer);
  try { ws = new WebSocket(wsUrl()); } catch { scheduleReconnect(); return; }
  const sock = ws;
  let opened = false;
  sock.onopen = () => {
    opened = true; wsTries = 0; setConn("live"); stopPolling();
    clearInterval(hbTimer);
    hbTimer = setInterval(() => {
      if (sock.readyState !== 1) return;
      if (pingAt && Date.now() - pingAt > 10_000) { sock.close(4000, "heartbeat timeout"); return; } // no pong: dead link
      pingAt = Date.now(); sock.send("ping");
    }, 20_000);
  };
  sock.onmessage = (e) => {
    if (e.data === "pong") { S.rtt = Date.now() - pingAt; pingAt = 0; updateConn(); return; }
    let ev; try { ev = JSON.parse(e.data); } catch { return; }
    handle(ev);
  };
  sock.onclose = () => {
    clearInterval(hbTimer); pingAt = 0;
    if (sock !== ws) return;
    if (!opened) wsTries++;
    else wsTries = 0; // a socket that worked: first retry after ~0.5 s
    scheduleReconnect();
  };
  sock.onerror = () => {};
}
function scheduleReconnect() {
  const delay = Math.min(15_000, 500 * 2 ** Math.min(wsTries, 5)) * (0.8 + Math.random() * 0.4);
  setConn(wsTries >= 3 ? "polling" : "reconnecting", delay);
  if (wsTries >= 3) startPolling();
  reconnectTimer = setTimeout(connect, delay);
}
function startPolling() {
  if (pollTimer) return;
  const tick = async () => {
    try { handle({ t: "snapshot", ...(await api("api/snapshot")) }); if (S.conn !== "live") setConn("polling"); }
    catch { setConn("offline"); }
  };
  tick(); pollTimer = setInterval(tick, 5000);
}
function stopPolling() { clearInterval(pollTimer); pollTimer = 0; }
document.addEventListener("visibilitychange", () => { if (!document.hidden && (!ws || ws.readyState > 1)) { wsTries = 0; connect(); } });
window.addEventListener("online", () => { wsTries = 0; connect(); });

function setConn(c, retryIn) { S.conn = c; S.retryIn = retryIn; updateConn(); updateBolt(); }
function updateConn() {
  const b = document.getElementById("conn");
  if (!b) return;
  b.className = `conn ${S.conn}`;
  const label = { live: "live", reconnecting: "reconnecting", polling: "polling", offline: "offline", connecting: "connecting" }[S.conn];
  b.querySelector("span").textContent = label;
  b.title = S.conn === "live" ? `Live updates over WebSocket${S.rtt != null ? ` · ping ${S.rtt} ms` : ""}` :
    S.conn === "polling" ? "WebSocket unavailable: checking every 5 s" : "Trying to reach the server";
}
document.getElementById("conn")?.addEventListener("click", () => { if (S.conn !== "live") { wsTries = 0; connect(); } else toast(`live · ping ${S.rtt ?? "?"} ms`); });

// ---------- events ----------
function handle(ev) {
  probe.events++;
  if (ev.now) S.skew = ev.now - Date.now();
  switch (ev.t) {
    case "snapshot": {
      const first = !S.ready;
      const prev = S.recs;
      S.recs = new Map(ev.records.map((r) => [r.id, r]));
      S.budget = ev.budget; S.devices = ev.devices ?? []; S.wifi = ev.wifi ?? S.wifi;
      for (const r of ev.records) noteSeen(r);
      S.ready = true;
      void first; void prev;
      renderAll(); refreshHealth?.(S); refreshPlaces?.(S);
      if (first) { appUpdates.onReady(); window.paperbotBoot?.ready(); }
      if (first && refreshedState) requestAnimationFrame(() => {
        inboxScroll = refreshedState.inboxScroll || 0;
        window.scrollTo(0, refreshedState.scroll || 0);
      });
      break;
    }
    case "rec": {
      const r = ev.rec, prev = S.recs.get(r.id);
      S.recs.set(r.id, r);
      S.incoming.delete(r.id);
      noteSeen(r);
      if (!prev) narrateNew(r);
      else if (prev.status !== r.status || prev.kind !== r.kind || prev.title !== r.title || prev.transcript !== r.transcript || prev.agent_state !== r.agent_state) narrateChange(prev, r);
      // a memo that saved to the list or built an app: List and Apps read OpenBelt again
      if ((r.kind === "save" || r.kind === "app") && (prev?.status !== r.status || prev?.agent_state !== r.agent_state || JSON.stringify(prev?.items) !== JSON.stringify(r.items))) beltChanged();
      schedule();
      break;
    }
    case "incoming":
      S.incoming.set(ev.id, Date.now());
      probe.seen[ev.id] = { ...(probe.seen[ev.id] ?? {}), incoming: Date.now() };
      mood("listen", 9000, "ooh, a clip is coming in…");
      schedule();
      setTimeout(schedule, 61_000);
      break;
    case "step": {
      const r = S.recs.get(ev.id);
      if (!r) return;
      if (ev.step) { r.steps = [...(r.steps ?? []), ev.step]; S.newSteps.add(`${ev.id}:${ev.step.at}:${ev.step.text}`); narrateStep(r, ev.step); }
      if (ev.progress) r.agent_progress = ev.progress;
      schedule();
      break;
    }
    case "device": {
      if (!ev.device) return;
      const i = S.devices.findIndex((d) => d.key === ev.device.key);
      const prev = i >= 0 ? S.devices[i] : null;
      if (i >= 0) S.devices[i] = ev.device; else S.devices.unshift(ev.device);
      if (i < 0 && S.boards && !S.boards.length) loadLinks(S).then(() => schedule()); // just set up: drop the setup card
      S.devices.sort((a, b) => b.last_seen - a.last_seen);
      S.devChanged = { batt: prev && prev.batt_mv !== ev.device.batt_mv, usb: prev && prev.usb !== ev.device.usb, fw: prev && prev.fw !== ev.device.fw };
      const newCrash = ev.device.alerts?.find((a) => a.code === "crash" && !(prev?.alerts ?? []).some((p) => p.code === "crash" && p.at === a.at));
      if (newCrash) mood("error", 12_000, crashLine(newCrash), { label: "show me", run: () => openHealth(S) });
      renderSide(); refreshHealth?.(S); refreshPlaces?.(S);
      break;
    }
    case "device_event": refreshHealth?.(S, true); break;
    case "budget": S.budget = ev.budget; renderSide(); break;
    case "wifi": S.wifi = ev.wifi; refreshPlaces?.(S); updateHeaderBadges(); break;
    case "resync": if (ws?.readyState === 1) ws.send("snapshot"); break;
  }
}
function noteSeen(r) {
  const p = (probe.seen[r.id] ??= {});
  p.firstEvent ??= Date.now();
  if (r.status !== "processing" && !p.result) p.result = Date.now();
}

// ---------- the robot: one status line + the device replica's face ----------
// Event moods only change the status line (the replica already shows the device's state); pokes and trouble
// (offline, crash, battery) also change the replica's face.
const FACE_MOODS = new Set(["awake", "happy", "wink", "love", "dizzy", "think", "sad", "error"]);
const bolt = { transient: null, until: 0, f: 0, say: "", sayAct: null, pokes: [], face: null, faceUntil: 0 };
function mood(m, ms, text, act = null, face = false) {
  bolt.transient = m; bolt.until = Date.now() + ms;
  if (face && FACE_MOODS.has(m)) { bolt.face = m; bolt.faceUntil = Date.now() + ms; }
  if (text) say(text, act);
  renderSide();
}
function say(text, act = null) {
  if (text === bolt.say && !act === !bolt.sayAct) return;
  bolt.say = text; bolt.sayAct = act;
  const p = document.getElementById("say");
  p.replaceChildren(document.createTextNode(text));
  if (act) p.appendChild(h("button", { class: "act-link", type: "button", onclick: act.run }, `${act.label} →`));
}
const T = (s, n = 60) => { s = String(s ?? "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
function narrateNew(r) {
  if (r.status === "processing") { mood("listen", 6000, "got a clip. listening…"); return; }
  narrateChange({}, r);
}
function narrateChange(prev, r) {
  if (r.status === "processing") {
    if (r.transcript && !prev.transcript) mood("think", 8000, `heard “${T(r.transcript, 70)}”`);
    else if (!prev.status || prev.status !== "processing") mood("think", 8000, "running it through again…");
    return;
  }
  if (prev.status === r.status && prev.kind === r.kind && prev.agent_state === r.agent_state) return; // edits: no fanfare
  const due = dueInfo(r.due);
  if (r.status === "error") return mood("error", 8000, `couldn't process that clip (${T(r.error, 40)}).`);
  if (r.kind === "ignore") return mood("confused", 6000, "didn't catch that one.");
  if (AGENT_KINDS.includes(r.kind)) {
    if (r.status === "researching" && r.agent_state === "queued") return mood("research", 5000, `queued: ${T(r.title)}`);
    if (r.status === "researching") return mood("research", 6000, `researching: ${T(r.title)}`);
    if (r.status === "paused_budget") return mood("paused", 10_000, "today's research budget is spent; paused.");
    if (r.status === "stopped") return mood("sad", 10_000, `gave up on “${T(r.title, 40)}”: ${T(r.error, 40)}.`);
    if (r.status === "done") return mood("idea", 10_000, `done: ${T((r.summary ?? "").replace(/^\? /, ""), 90)}`);
  }
  if (r.kind === "answer") return mood("idea", 10_000, T(r.summary ?? r.title, 110));
  const it = r.items?.[0], names = T((r.items ?? []).map((i) => i.title).join(", "), 60);
  if (r.kind === "save" && it) {
    if (it.why === "not connected") return mood("unsure", 8000, `connect your list and I'll save “${names}”.`);
    if (!it.ok) return mood("unsure", 7000, `nothing changed: ${T(it.why, 40)}.`);
    if (it.op === "done") return mood("happy", 7000, `checked off: ${names}`);
    if (it.op === "drop") return mood("wink", 7000, `removed: ${names}`);
    return mood(it.list === "reminder" ? "wink" : "happy", 7000, `${it.list === "shopping" ? "on the list" : "got it"}: ${names}${due ? ` · ${due.text}` : ""}`);
  }
  return mood("idea", 7000, `noted: ${T(r.title)}`);
}
function narrateStep(r, s) {
  const txt = s.kind === "search" ? `searching “${T(s.text, 50)}”…` : s.kind === "read" ? `reading ${T(s.text.split("/")[0], 40)}…`
    : s.kind === "think" ? `“${T(s.text, 80)}”` : s.kind === "write" ? "writing up the report…" : s.kind === "error" ? T(s.text, 60) : null;
  if (txt) { bolt.transient = "research"; bolt.until = Date.now() + 8000; say(txt); }
}
const crashLine = (a) => {
  const d = new Date(a.at), why = a.text.match(/\(([^)]+)\)/)?.[1] ?? a.text.replace(/ reset.*$/, "");
  return `crashed at ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")} (${why}).`;
};

/** [mood, text, action, face] when nothing transient is going on. face = the replica's expression override. */
function baseMood() {
  if (S.conn === "offline" || (S.conn === "reconnecting" && wsTries >= 2)) return ["sad", "can't reach the server. retrying…", null, "sad"];
  if (!S.ready) return ["think", "connecting…"];
  const recs = [...S.recs.values()];
  if (recs.some((r) => r.status === "processing")) return ["think", "thinking…"];
  const res = recs.filter((r) => r.status === "researching");
  if (res.length) return ["research", `researching ${res.length > 1 ? `${res.length} things` : `“${T(res[0].title, 40)}”`}…`];
  const dev = S.devices[0];
  const crash = dev?.alerts?.find((a) => a.code === "crash");
  if (crash) return ["sad", crashLine(crash), { label: "see what happened", run: () => openHealth(S) }, "error"];
  if (dev?.alerts?.some((a) => a.code === "battery_low")) return ["sad", `battery at ${dev.batt_pct}%. charge me?`, null, "sad"];
  if (dev && Date.now() - dev.last_seen > 26 * 3600_000) return ["sad", "haven't heard from the device in over a day.", null, "sad"];
  if (S.conn === "polling") return ["sleep", "live link is down; checking every few seconds."];
  const open = recs.filter((r) => r.state === "open" && r.kind !== "ignore" && r.status === "done");
  const over = open.filter((r) => dueInfo(r.due)?.overdue).length;
  if (over) return ["sleep", `${over} overdue reminder${over > 1 ? "s" : ""}.`];
  return ["sleep", open.length ? `${open.length} open. hold ☀ to add more.` : "all clear. hold ☀ and tell me something."];
}
function currentFace() {
  if (bolt.face && Date.now() < bolt.faceUntil) return bolt.face;
  bolt.face = null;
  return baseMood()[3] ?? null;
}
function updateBolt() {
  if (bolt.transient && Date.now() < bolt.until) return;
  bolt.transient = null;
  const [, text, act] = baseMood();
  say(text, act ?? null);
}
document.getElementById("bot-btn").addEventListener("click", () => {
  const now = Date.now();
  bolt.pokes = [...bolt.pokes.filter((t) => now - t < 3000), now];
  if (bolt.pokes.length >= 5) { bolt.pokes = []; return mood("dizzy", 3500, "ok ok, I'm dizzy now.", null, true); }
  const r = [["awake", "hey!"], ["happy", "beep boop."], ["wink", "that tickles."], ["love", "<3"], ["think", "*whirr* … nothing new."]];
  const [m, t] = r[Math.floor(Math.random() * r.length)];
  mood(m, 2200, t, null, true);
});

// ---------- rendering ----------
let rafPending = false;
function schedule() { if (!rafPending) { rafPending = true; requestAnimationFrame(() => { rafPending = false; renderAll(); }); } }

function changeList(update) {
  update(); renderAll();
}

function renderAll() {
  renderChips(); renderSections(); renderItem(); renderReportModal(); updateBolt(); renderSide(); updateHeaderBadges();
}

const isNow = (r) => r.agent_state !== "needs_openbelt" && (r.status === "processing" || r.status === "researching" || r.agent_state === "queued" || r.agent_state === "running");
// Memos are open or archived. A saved memo whose List items are all checked off is done (belt.js memoDone): it folds under Done.
function inView(r) {
  return S.view === "archived" ? r.state === "archived" : r.state === "open" || isNow(r);
}
function matchesQ(r) {
  if (!S.q) return true;
  const q = S.q.toLowerCase();
  return [r.title, r.transcript, r.summary, r.kind].some((x) => x && String(x).toLowerCase().includes(q));
}
function filtered() {
  return [...S.recs.values()].filter((r) => inView(r) && matchesQ(r) && (S.kind === "all" ? (S.noise || r.kind !== "ignore" || isNow(r)) : r.kind === S.kind))
    .sort((a, b) => b.received_at - a.received_at);
}

function renderChips() {
  const base = [...S.recs.values()].filter((r) => inView(r) && matchesQ(r));
  const n = (k) => base.filter((r) => (k === "all" ? r.kind !== "ignore" : r.kind === k)).length;
  const box = document.getElementById("chips");
  // only the kinds you have (and the one picked); ignored clips and the archive are in the ⋮ menu
  const kids = KINDS.filter(([k]) => k === "all" || k === S.kind || n(k) > 0).map(([k, label]) => h("button", { class: "chip", type: "button", "aria-pressed": String(S.kind === k), "data-k": k, onclick: () => changeList(() => { S.kind = k; S.showAll = false; }) },
    label, h("span", { class: "c" }, n(k))));
  if (S.noise) kids.push(h("button", { class: "chip", type: "button", "aria-pressed": "true", title: "Hide ignored clips", onclick: () => changeList(() => { S.noise = false; }) }, "Ignored", h("span", { class: "c" }, n("ignore")), ic("close", 12)));
  if (S.view === "archived") kids.push(h("button", { class: "chip", type: "button", "aria-pressed": "true", title: "Back to your memos", onclick: () => changeList(() => { S.view = "open"; S.showAll = false; }) }, "Archive", ic("close", 12)));
  box.replaceChildren(...kids);
  const activeFilters = Number(S.view !== "open") + Number(S.kind !== "all") + Number(S.noise);
  const filterButton = document.getElementById("mobile-filters");
  filterButton.replaceChildren(ic("filters", 18), h("span", null, "Filters"));
  if (activeFilters) filterButton.append(h("span", { class: "filter-count" }, activeFilters));
  filterButton.setAttribute("aria-label", activeFilters ? `Filters, ${activeFilters} active` : "Filters");
  const filterSummary = document.getElementById("mobile-filter-summary");
  filterSummary.hidden = !activeFilters;
  filterSummary.textContent = [S.view === "archived" ? "Archive" : null, KINDS.find(([k]) => k === S.kind)?.[1] || "All", S.noise ? "Including ignored" : null].filter(Boolean).join(" · ");
}

const cardCache = new Map(); // id -> {key, el}
const players = new Map();
function renderSections() {
  const host = document.getElementById("sections");
  const focusedId = document.activeElement?.closest?.("#sections .card")?.dataset.id;
  const focusedIdx = focusedId ? [...host.querySelectorAll(".card[data-id]")].findIndex((c) => c.dataset.id === focusedId) : -1;
  const focusedSel = focusedId ? focusKey(document.activeElement) : null;
  const list = filtered();
  const now = Date.now(), today = startOfDay(now);
  const ghosts = [...S.incoming.entries()].filter(([id, at]) => !S.recs.has(id) && now - at < 60_000);
  const happening = list.filter(isNow), done = S.view === "archived" ? [] : list.filter((r) => !isNow(r) && memoDone(r));
  const rest = list.filter((r) => !isNow(r) && !done.includes(r));
  const todayL = rest.filter((r) => r.received_at >= today), earlier = rest.filter((r) => r.received_at < today);
  const out = [];
  if (!S.ready) { host.replaceChildren(h("p", { class: "muted mono" }, "connecting…")); return; }
  if (happening.length || ghosts.length)
    out.push(section("now", "Happening now", happening.length + ghosts.length, [...ghosts.map(([id]) => ghostCard(id)), ...happening.map(card)]));
  if (todayL.length) out.push(section("today", "Today", todayL.length, todayL.map(card)));
  if (earlier.length) {
    const lim = S.showAll ? earlier.length : Math.max(0, 40 - todayL.length);
    const shown = earlier.slice(0, Math.max(lim, 12));
    const more = earlier.length - shown.length;
    out.push(section("earlier", "Earlier", earlier.length, [...shown.map(card),
      more > 0 ? h("button", { class: "more", type: "button", onclick: () => { S.showAll = true; renderAll(); } }, `show ${more} more`) : null]));
  }
  if (done.length) out.push(h("section", { class: "sec done-fold", "aria-label": "Done" },
    h("button", { class: "fold-toggle", type: "button", "aria-expanded": String(S.showDone), onclick: () => changeList(() => { S.showDone = !S.showDone; }) },
      "Done", h("span", { class: "n" }, done.length)),
    S.showDone ? done.map(card) : null));
  if (!out.length) out.push(emptyState());
  host.replaceChildren(...out);
  for (const el of host.querySelectorAll(".card[data-id]")) { const p = probe.seen[el.dataset.id]; if (p && !p.rendered) p.rendered = Date.now(); if (p && p.result && !p.renderedResult && !el.classList.contains("busy")) p.renderedResult = Date.now(); }
  if (focusedId) {
    const el = cardCache.get(focusedId)?.el;
    const target = (focusedSel && el?.querySelector(`[data-fk="${focusedSel}"]`)) || el;
    if (target && document.contains(target)) target.focus({ preventScroll: true });
    else { // the card left this view (done / archived): keep the keyboard flow on the next one
      const list = [...host.querySelectorAll(".card[data-id]:not(.ghost)")];
      list[Math.min(Math.max(0, focusedIdx), list.length - 1)]?.focus({ preventScroll: true });
    }
  }
  S.newSteps.clear();
}
const focusKey = (el) => el?.dataset?.fk ?? null;
function section(cls, title, n, kids) {
  return h("section", { class: `sec ${cls}`, "aria-label": title }, h("div", { class: "sec-h" }, h("h2", null, title), h("span", { class: "n" }, n)), kids);
}
function emptyState() {
  if (S.boards && !S.boards.length && !S.recs.size && !S.q && S.view !== "archived") return setupCard(S, () => openSettings(S));
  const msg = S.q ? `nothing matches “${S.q}”.` : S.view === "archived" ? "the archive is empty." : S.kind !== "all" ? `no ${kindLabel(S.kind)} here.` : "all clear. nothing open.";
  return h("div", { class: "empty" }, h("p", null, msg), !S.q && S.view !== "archived" ? h("p", { class: "hint" }, "hold", ic("sun"), "on the device to add something") : null);
}
function ghostCard(id) {
  return h("article", { class: "card ghost busy", "data-id": id, "aria-label": "Clip arriving" },
    h("div", { class: "card-top" }, h("span", { class: "kind" }, ic("cloud"), "incoming"), h("span", { class: "pill busy" }, "uploading"), h("span", { class: "when mono" }, "now")),
    h("div", { class: "card-main" }, h("span"), h("p", { class: "title placeholder" }, "a clip is on its way…")));
}

function cardKey(r) {
  return JSON.stringify([r.status, r.state, r.kind, r.title, r.due, r.transcript, r.summary, r.error, r.agent_state, r.agent_result ? 1 : 0, (r.steps ?? []).length,
    r.agent_progress?.turns, r.agent_progress?.cost, S.expanded.has(r.id), S.q, r.gen, memoDone(r)]);
}
function card(r) {
  const key = cardKey(r), c = cardCache.get(r.id);
  if (c && c.key === key) return c.el;
  const el = buildCard(r);
  cardCache.set(r.id, { key, el });
  return el;
}

function hl(text) { // search highlight, text-only
  const s = String(text ?? "");
  if (!S.q) return [s];
  const out = [], q = S.q.toLowerCase(), low = s.toLowerCase();
  let i = 0, j;
  while ((j = low.indexOf(q, i)) >= 0) { out.push(s.slice(i, j), h("mark", { class: "mark" }, s.slice(j, j + q.length))); i = j + q.length; }
  out.push(s.slice(i));
  return out;
}

function statusPill(r, onPage = false) {
  const building = r.kind === "app" && (r.agent_state === "running" || r.agent_state === "queued");
  if (building) return onPage ? null : h("span", { class: "mini-spin", role: "img", "aria-label": r.agent_state === "queued" ? "Queued to build" : "Building" });
  // waiting for Connect OpenBelt: a quiet mark in the list; the memo's page says why
  if (r.agent_state === "needs_openbelt") return onPage ? null : h("span", { class: "needs-mark", role: "img", "aria-label": "Not connected", title: "Not connected" }, ic("alert", 14));
  if (r.status === "processing") return h("span", { class: "pill busy" }, r.transcript ? "sorting" : "listening");
  if (r.status === "researching") return h("span", { class: "pill busy" }, r.agent_state === "queued" ? "queued" : r.agent_state === "external" ? "for your assistant" : r.kind === "app" ? "building" : "researching");
  if (r.status === "paused_budget") return h("span", { class: "pill warn" }, "paused · budget");
  if (r.status === "stopped") return h("span", { class: "pill warn" }, "stopped");
  if (r.status === "error") return h("span", { class: "pill warn" }, "error");
  return null;
}

function buildCard(r, expanded = false) {
  const busy = r.status === "processing";
  const kind = r.kind ?? (busy ? null : "ignore");
  const el = h("article", { class: `card${expanded ? " expanded" : ""} st-${r.state} k-${kind ?? "pending"}${busy ? " busy" : ""}${memoDone(r) ? " is-done" : ""}`, tabindex: "0", "data-id": r.id, "aria-labelledby": `${expanded ? "detail" : "t"}-${r.id}`,
    onclick: expanded ? null : (e) => {
      if (e.target.closest("button, a, input, select, textarea, summary, audio, .wave")) return;
      if (window.getSelection()?.toString()) return;
      toggleExpand(r.id);
    } });
  const when = h("time", { class: "when", datetime: new Date(r.received_at).toISOString(), title: new Date(r.received_at).toLocaleString(), "data-ts": r.received_at }, ago(r.received_at));
  el.append(h("div", { class: "card-top" },
    kind ? h("span", { class: `kind k-${kind}` }, ic(kindIcon({ ...r, kind })), kindWord({ ...r, kind })) : h("span", { class: "kind" }, ic("cloud"), "clip"),
    statusPill(r), when));

  const done = memoDone(r);
  const title = busy && !r.title ? h("p", { class: "title placeholder", id: `${expanded ? "detail" : "t"}-${r.id}` }, r.transcript ? "sorting it out…" : "listening to your clip…")
    : h("h3", { class: "title", id: `${expanded ? "detail" : "t"}-${r.id}` }, hl(r.title || "(untitled)"));
  el.append(h("div", { class: "card-main" },
    h("span", { class: "lead", ...(done ? { role: "img", "aria-label": "Done: checked off on your list", title: "Checked off on your list" } : { "aria-hidden": "true" }) }, done ? ic("check") : null),
    h("div", null, title, metaRow(r, expanded))));

  if (expanded && r.transcript && r.kind !== "ignore") {
    const long = r.transcript.length > 140;
    el.append(h("p", { class: `transcript${long && !expanded ? " clamp" : ""}` }, h("q", null, hl(r.transcript))));
  } else if (r.kind === "ignore" && r.noise_reason) el.append(h("p", { class: "transcript" }, `nothing usable (${r.noise_reason})`));
  if (r.kind === "answer" && r.summary) el.append(h("p", { class: "summary" }, hl(r.summary)));
  if (r.status === "error") el.append(h("p", { class: "err" }, `${r.error ?? "error"}${r.detail ? ` — ${String(r.detail).slice(0, 160)}` : ""}`));
  if (AGENT_KINDS.includes(r.kind) || r.agent_result || (r.agent_state && r.kind !== "save")) el.append(...workBlocks(r, expanded));
  if (expanded && r.audio_key) el.append(player(r).root);
  if (expanded) el.append(actions(r));
  if (expanded) el.append(detailsBlock(r));
  if (!expanded && !busy) enableArchiveSwipe(el, r);
  return el;
}

// Touch events deliberately arbitrate scrolling on the first move. Pointer capture
// cannot prevent Safari from taking over a diagonal pan and cancelling the drag.
let openSwipe = null;
document.addEventListener("touchstart", e => {
  if (openSwipe && !openSwipe.row.contains(e.target)) openSwipe.close();
}, { passive: true });
function enableArchiveSwipe(row, record) {
  const content = h("div", { class: "swipe-content" }, [...row.childNodes]);
  const label = record.state === "archived" ? "Restore" : "Archive";
  const action = h("button", { type: "button", class: "swipe-action", tabindex: "-1", onclick: e => {
    e.stopPropagation(); commit();
  } }, ic(record.state === "archived" ? "unarchive" : "archive", 20), h("span", null, label));
  const reveal = h("div", { class: "swipe-reveal", inert: "" }, action);
  row.append(reveal, content);
  row.classList.add("swipe-row");
  let gesture = null, suppressUntil = 0, opened = false, committing = false;
  let motion = [];
  const width = 88;
  const paint = distance => {
    content.style.transform = `translate3d(${-distance}px,0,0)`;
    reveal.style.width = `${Math.max(width, distance)}px`;
  };
  const stopMotion = () => {
    const distance = -new DOMMatrixReadOnly(getComputedStyle(content).transform).m41;
    for (const animation of motion) animation.cancel();
    motion = [];
    paint(distance);
    return distance;
  };
  const settle = (distance, velocity = 0) => {
    const start = stopMotion();
    paint(distance);
    row.classList.toggle("swipe-open", distance > 0);
    reveal.inert = distance === 0;
    action.tabIndex = distance > 0 ? 0 : -1;
    if (reducedMotion() || Math.abs(start - distance) < .5) return;
    // Critically damped spring: retain release velocity without a bouncy overshoot.
    const frames = Array.from({ length: 29 }, (_, i) => {
      const t = i / 28 * .44, delta = start - distance;
      const value = i === 28 ? distance : Math.max(0,
        distance + (delta + (velocity * 1000 + 22 * delta) * t) * Math.exp(-22 * t));
      return { value, offset: i / 28 };
    });
    const options = { duration: 440, easing: "linear" };
    motion = [
      content.animate(frames.map(({ value, offset }) => ({ transform: `translate3d(${-value}px,0,0)`, offset })), options),
      reveal.animate(frames.map(({ value, offset }) => ({ width: `${Math.max(width, value)}px`, offset })), options),
    ];
  };
  const commit = async () => {
    if (committing) return;
    committing = true; gesture = null; opened = false;
    if (openSwipe?.row === row) openSwipe = null;
    suppressUntil = Date.now() + 1000;
    row.classList.remove("swiping");
    row.classList.add("swipe-committing", "swipe-ready");
    reveal.inert = true;
    action.tabIndex = -1;
    const start = stopMotion(), end = row.clientWidth + 1;
    paint(end);
    if (!reducedMotion()) {
      await Promise.all([
        content.animate([{ transform: `translate3d(${-start}px,0,0)` }, { transform: `translate3d(${-end}px,0,0)` }],
          { duration: 180, easing: "cubic-bezier(.2,.65,.3,1)" }).finished,
        reveal.animate([{ width: `${Math.max(width, start)}px` }, { width: `${end}px` }],
          { duration: 180, easing: "cubic-bezier(.2,.65,.3,1)" }).finished,
      ]).catch(() => {});
      const height = row.getBoundingClientRect().height;
      await row.animate([
        { height: `${height}px`, opacity: 1, borderTopWidth: "1px" },
        { height: "0px", opacity: 0, borderTopWidth: "0px" },
      ], { duration: 220, easing: "cubic-bezier(.4,0,.2,1)", fill: "forwards" }).finished.catch(() => {});
    }
    // A live update may have already archived this record during the animation.
    const current = S.recs.get(record.id);
    // Undo and failed saves must build a fresh row, without the collapsed animation.
    if (cardCache.get(record.id)?.el === row) cardCache.delete(record.id);
    if (current && current.state === record.state && current.status !== "processing") toggleArchive(record.id);
    else renderAll();
  };
  const close = () => {
    if (committing) return;
    gesture = null; opened = false;
    row.classList.remove("swiping", "swipe-ready"); settle(0);
    if (openSwipe?.row === row) openSwipe = null;
  };
  row.addEventListener("click", e => {
    if (committing) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    if (reveal.contains(e.target)) return;
    if (Date.now() < suppressUntil) {
      e.preventDefault(); e.stopImmediatePropagation(); return;
    }
    if (opened) { e.preventDefault(); e.stopImmediatePropagation(); close(); }
  }, true);
  row.addEventListener("touchstart", e => {
    if (committing) return;
    if (e.touches.length !== 1) { close(); return; }
    if (!matchMedia("(max-width: 640px)").matches) return;
    if (e.target.closest("button, a, input, select, textarea, summary, .wave")) return;
    const touch = e.touches[0];
    // Preserve Safari's screen-edge navigation and pinch zoom.
    if (touch.clientX < 20 || touch.clientX > innerWidth - 20) return;
    const start = stopMotion();
    gesture = { id: touch.identifier, x: touch.clientX, y: touch.clientY,
      locked: false, distance: start, start, lastX: touch.clientX, lastTime: e.timeStamp, velocity: 0 };
  }, { passive: true });
  row.addEventListener("touchmove", e => {
    if (!gesture) return;
    if (e.touches.length !== 1) { close(); return; }
    const touch = [...e.touches].find(t => t.identifier === gesture.id);
    if (!touch) return;
    const dx = touch.clientX - gesture.x, dy = touch.clientY - gesture.y;
    if (!gesture.locked) {
      // Decide on the first directional move, before Safari begins scrolling.
      if (Math.abs(dy) >= Math.abs(dx) || (!opened && dx >= 0)) {
        close(); return;
      }
      if (!e.cancelable) { close(); return; }
      gesture.locked = true;
      row.classList.add("swiping");
    }
    if (e.cancelable) e.preventDefault();
    const dt = e.timeStamp - gesture.lastTime;
    if (dt > 0) gesture.velocity = Math.max(-1.5, Math.min(1.5, (gesture.lastX - touch.clientX) / dt));
    gesture.lastX = touch.clientX; gesture.lastTime = e.timeStamp;
    const raw = Math.max(0, gesture.start - dx), limit = row.clientWidth * .8;
    // A little resistance at the end of travel instead of a hard stop.
    gesture.distance = raw <= limit ? raw : limit + (raw - limit) * .2;
    suppressUntil = Date.now() + 500;
    paint(gesture.distance);
    row.classList.toggle("swipe-ready", gesture.distance >= row.clientWidth * .6);
  }, { passive: false });
  row.addEventListener("touchend", e => {
    if (!gesture || ![...e.changedTouches].some(t => t.identifier === gesture.id)) return;
    const { locked, distance, velocity: lastVelocity, lastTime } = gesture;
    const velocity = e.timeStamp - lastTime > 80 ? 0 : lastVelocity;
    gesture = null;
    row.classList.remove("swiping", "swipe-ready");
    if (!locked) return;
    e.preventDefault(); // Never turn the swipe into a row-navigation tap.
    suppressUntil = Date.now() + 500;
    if (distance >= row.clientWidth * .6 && S.recs.get(record.id)?.status !== "processing") {
      commit();
    } else {
      opened = distance + velocity * 100 >= width * .45;
      settle(opened ? width : 0, velocity);
      if (opened) openSwipe = { row, close };
      else if (openSwipe?.row === row) openSwipe = null;
    }
  }, { passive: false });
  row.addEventListener("touchcancel", close);
}

/** A built app's address (the agent wrote it: http(s) only), or null. */
const appUrlOf = (r) => /^https?:\/\//.test(r.agent_result?.app_url ?? "") ? r.agent_result.app_url : null;
/** The actions a memo can be switched to on the web (server WEB_KINDS), with its own first. */
function kindOptions(r) {
  const ks = ["research", "app", "ignore"];
  return [...(r.kind && !ks.includes(r.kind) ? [r.kind] : []), ...ks].map((k) => h("option", { value: k, selected: r.kind === k || null, disabled: !ks.includes(k) || null }, k === r.kind ? kindWord(r) : KIND_WORD[k]));
}
/** A saved memo: what changed in the person's OpenBelt list, a link to it, or Connect when it waits. */
function savedBlock(r) {
  const its = r.items, it = its[0];
  const what = its.map((i) => `${i.op === "done" ? "Checked off" : i.op === "drop" ? "Removed" : `Added to ${i.list}`}: ${i.title}${i.ok || i.why === "not connected" || i.why === "before OpenBelt" ? "" : ` (${i.why})`}`).join(" · ");
  if (it.why === "not connected") return connectInvite("list", "Your list isn't connected");
  if (its.some((i) => i.ok)) return h("div", { class: "rows" }, row({ href: "#list" }, ic("list", 20), "Open your list", what, true));
  return h("p", { class: "item-placeholder" }, it.why === "before OpenBelt" ? `${what} (kept here, from before your list was connected)` : what);
}

/** A memo waiting for a connection: what's missing and a way to Settings → Connections → Apps, where the provider is named. */
const connectInvite = (icon, title) => h("div", { class: "ob-invite" }, h("span", { class: "ob-invite-icon" }, ic(icon, 20)),
  h("strong", null, title), h("a", { class: "btn", href: "#connections/apps" }, "Connect"));

/** One row of the memo page's result: icon, what it does, a line under it, ↗ (opens elsewhere) or → (here). A link (attrs.href) or a button. */
function row(attrs, icon, title, line, oneLine = false) {
  return h(attrs.href ? "a" : "button", { class: "report-launch", ...(attrs.href ? {} : { type: "button" }), ...attrs },
    h("span", { class: "report-launch-icon" }, icon),
    h("span", { class: "report-launch-copy" }, h("strong", null, title), line == null ? null : h("span", { class: oneLine ? "one-line" : null }, line)),
    h("span", { "aria-hidden": "true", class: "report-launch-arrow" }, attrs.target === "_blank" ? "↗" : "→"));
}

// The item page has its own hierarchy rather than an expanded inbox row.
function buildItem(r) {
  const busy = r.status === "processing";
  const researching = r.status === "researching" || ["running", "queued"].includes(r.agent_state);
  const archived = r.state === "archived";
  const page = h("article", { class: "card item-page", tabindex: "-1", "data-id": r.id, "aria-labelledby": `detail-${r.id}` });
  const category = h("select", { "aria-label": "Change category", "data-fk": "kind", disabled: busy || researching || r.status === "error" || null,
    onchange: e => { e.target.closest(".item-more").open=false; reclassify(r.id, e.target.value); } },
    kindOptions(r));
  const stamp = new Date(r.received_at);
  const header = h("header", { class: "item-header" },
    h("div", { class: "item-eyebrow" },
      h("span", { class: "item-category item-category-label" }, r.kind ? kindWord(r) : "Recording"),
      statusPill(r, true)),
    h("h1", { class: "title", id: `detail-${r.id}` }, r.title || (busy ? "Listening to your recording…" : "Untitled recording")),
    h('div',{class:'item-dateline'},h('time',{datetime:stamp.toISOString(),title:stamp.toLocaleString()},`Captured ${ago(r.received_at)}`)),
    metaRow({ ...r, seconds: null }),
    h("div", { class: "item-actions" },
      h("div", { class: "item-primary-action" }, h("button", { class: "btn archive-action", type: "button", "data-fk": "check", disabled: busy || null, onclick: () => toggleArchive(r.id) }, ic(archived ? "unarchive" : "archive", 14), archived ? "Restore item" : "Archive")),
      h('details',{class:'item-more'},h('summary',{'aria-label':'Item actions'},'⋮'),h('div',{class:'item-more-menu'},
        h('button',{type:'button','data-fk':'edit',disabled:busy||null,onclick:()=>editTitle(r.id)},ic('pencil',16),'Edit title'),
        h('label',{class:'item-menu-category'},h('span',null,'Change category'),category),
        h('button',{type:'button','data-fk':'technical',onclick:()=>openTechnical(r.id)},ic('filters',16),'Details'),
        h('button',{type:'button','data-fk':'archive',disabled:busy||null,onclick:()=>toggleArchive(r.id)},ic(archived?'unarchive':'archive',16),archived?'Restore item':'Archive')))));
  page.append(header);
  const section = (title, cls, ...children) => h("section", { class: `item-section ${cls}`, "aria-label": title }, h("h2", null, title), children);
  const isNote=r.kind==='save' && r.items?.[0]?.list==='note';
  if(isNote && r.transcript && r.transcript.trim()!==r.title?.trim()) page.append(section('Note','item-note',h('p',{class:'item-transcript-text'},r.transcript)));
  const build = r.kind === "app" || !!appUrlOf(r);
  if (r.kind === "answer" && r.summary) page.append(section("Answer", "item-result", h("p", { class: "item-answer" }, r.summary)));
  if (r.kind === "save" && r.items?.length) page.append(section("Saved", "item-result", savedBlock(r)));
  else if (r.agent_state === "needs_openbelt") {
    // An app memo before Connect: one row, the same as the build's and the app's below.
    page.append(section("App", "item-result", connectInvite("apps", "Apps aren't connected")));
  } else if (r.agent_state === "external" || (r.status === "stopped" && !r.agent_result?.report)) {
    // nothing to open: say what's needed (ask the assistant / fix the key) right here
    page.append(section(build ? "App" : "Research", "item-result", workBlocks(r, true)));
  } else if (build && (researching || appUrlOf(r))) {
    const app = appUrlOf(r);
    page.append(section("App", "item-result", h("div", { class: "rows" },
      app ? row({ href: app, target: "_blank", rel: "noopener noreferrer" }, ic("apps", 20), "Open app", null, true) : null,
      researching
        ? row({ onclick: () => openReport(r.id), "data-fk": "report" }, h("span", { class: "spin", "aria-hidden": "true" }), "Building your app", "Takes a minute or two")
        : row({ onclick: () => openReport(r.id), "data-fk": "report" }, ic("log", 22), "How it was built", "Steps, files and cost"))));
  } else if (AGENT_KINDS.includes(r.kind) || r.agent_result) {
    page.append(section(researching ? "Research in progress" : "Report", "item-result",
      row({ onclick: () => openReport(r.id), "data-fk": "report" }, ic("note", 20), researching ? "View research progress" : "Read report", r.summary?.replace(/^\? /, "") || "Open the full report and sources")));
  }
  if (r.status === "error") page.append(h("div", { class: "item-error", role: "status" }, h("strong", null, "This recording couldn't be processed"), h("p", null, r.error || "Try processing the recording again.")));
  const source=h('details',{class:'item-source','data-disclosure':'source'},
    h('summary',null,h('span',null,ic('noise',16),'Recording'),h('span',{class:'item-source-chev','aria-hidden':'true'},ic('chevron-down',16))));
  if(r.audio_key) source.append(h('section',{class:'item-recording','aria-label':'Audio'},player(r).root));
  if(!isNote) source.append(section('Transcript','item-transcript',h('p',{class:r.transcript?'item-transcript-text':'item-placeholder'},r.transcript || (busy?'Transcribing…':'No transcript available.'))));
  if(r.audio_key || !isNote) page.append(source);
  return page;
}

document.addEventListener('pointerdown',event=>{
  const menu=document.querySelector('#item-content .item-more[open]');
  if(menu && !menu.contains(event.target))menu.open=false;
});
document.addEventListener('keydown',event=>{
  const menu=document.querySelector('#item-content .item-more[open]');
  if(event.key==='Escape' && menu){menu.open=false;menu.querySelector('summary').focus();}
});
let technicalModal=null, technicalReturn=null;
function openTechnical(id) {
  const r=S.recs.get(id);if(!r)return;
  technicalReturn=document.querySelector('#item-content .item-more > summary');
  const menu=document.querySelector('#item-content .item-more');if(menu)menu.open=false;
  if(!technicalModal) {
    technicalModal=h('dialog',{class:'install-modal technical-modal','aria-labelledby':'technical-title'});
    document.body.append(technicalModal);
    technicalModal.addEventListener('close',()=>{if(technicalReturn?.isConnected)technicalReturn.focus({preventScroll:true});});
    technicalModal.addEventListener('click',event=>{
      if(event.target!==technicalModal)return;
      const rect=technicalModal.getBoundingClientRect();
      if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)technicalModal.close();
    });
  }
  const close=h('button',{type:'button',class:'icon-btn','aria-label':'Close details',onclick:()=>technicalModal.close()},ic('close',20));
  const busy=r.status==='processing'||r.status==='researching'||['running','queued'].includes(r.agent_state);
  technicalModal.replaceChildren(
    h('header',{class:'install-header'},h('h2',{id:'technical-title'},'Details'),close),
    h('div',{class:'technical-modal-body'},detailsBlock(r),
      r.audio_key?h('div',{class:'item-reprocess'},h('div',null,h('p',{class:'reprocess-label'},'Reprocess recording'),h('p',{class:'reprocess-help'},'Run transcription and classification again.')),
        h('button',{type:'button',class:'btn',disabled:busy||null,onclick:()=>{technicalModal.close();reprocess(id);}},ic('redo',16),'Reprocess')):null));
  technicalModal.showModal();close.focus();
}

function metaRow(r, expanded = false) {
  const items = [];
  const d = dueInfo(r.due);
  if (d) items.push(h("span", { class: `due${d.overdue && r.state === "open" ? " overdue" : ""}${d.soon ? " soon" : ""}`, title: r.due },
    ic("reminder"), d.overdue && r.state === "open" ? h("span", { class: "over" }, "overdue") : null, d.text));
  if (expanded && r.seconds) items.push(h("span", null, `${(+r.seconds).toFixed(1)}s clip`));
  return items.length ? h("div", { class: "meta-row" }, items) : null;
}

function workBlocks(r, expanded = false) {
  const out = [];
  const live = r.status === "researching" || r.agent_state === "running" || r.agent_state === "queued";
  const steps = r.steps ?? [];
  const p = r.agent_progress;
  if (live) {
    const box = h("div", { class: "research live", "aria-live": "polite" });
    if (r.agent_state === "needs_openbelt") { // an app memo: it waits for Connect OpenBelt, then builds by itself
      return out;
    }
    if (!expanded) return out; // the list stays calm: the steps are on the memo's page
    if (r.agent_state === "external") { // nothing runs on paperbot: say what to do instead of a timer and an empty log
      box.append(h("div", { class: "research-h" }, ic("work"), "waiting for your assistant"),
        h("div", { class: "research-body" }, cmd(ASK)));
      out.push(box);
      return out;
    }
    const head = h("div", { class: "research-h" }, ic("work"), r.agent_state === "queued" ? (r.kind === "app" ? "queued to build" : "queued for research") : r.kind === "app" ? "building your app" : "researching",
      h("span", { class: "mono" }, p ? `turn ${p.turns} · ${usd(p.cost)} · ` : "", h("span", { "data-since": r.agent_started_at ?? r.done_at ?? r.received_at }, dur(Date.now() - (r.agent_started_at ?? r.done_at ?? r.received_at)))));
    box.append(head, logList(r.id, steps.slice(-12)));
    if (p) {
      const pct = Math.min(100, (p.cost / (p.cap || 0.15)) * 100);
      box.append(h("div", { class: `meter${pct > 75 ? " hot" : ""}`, role: "meter", "aria-label": "Task budget used", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": Math.round(pct) },
        h("span", { class: "fill", style: { width: `${pct}%` } })));
    }
    out.push(box);
  }
  const a = r.agent_result;
  const app = appUrlOf(r);
  if (app && !expanded) { // a built app: its address, once
    out.push(h("p", { class: "summary app-line" }, h("a", { href: app, target: "_blank", rel: "noopener noreferrer" }, "Open app ↗")));
    return out;
  }
  if (r.summary || a) {
    const unsure = r.agent_outcome === "unsure" || /^\? /.test(r.summary ?? "");
    const summary = (r.summary ?? a?.summary ?? "").replace(/^\? /, "");
    if (summary) out.push(h(expanded ? "div" : "p", { class: expanded ? "report-takeaway" : "summary" },
      expanded ? h("span", { class: "takeaway-label" }, unsure ? "Tentative finding" : "At a glance") : h("b", null, unsure ? "Probably: " : "Answer: "),
      h(expanded ? "p" : "span", null, hl(summary))));
    if (a?.answer && (!expanded || !a.report)) { const ans = h("div", { class: "report answer" }); ans.innerHTML = renderMarkdown(a.answer); out.push(ans); } // escaped-first renderer
  }
  if (a && !live && expanded) {
    const box = h("div", { class: "research report-reading" });
    if (a.report) {
      const rep = h("div", { class: "report" });
      rep.innerHTML = renderMarkdown(a.report); // escaped-first renderer (public/md.js), http(s) links only
      box.append(rep);
    }
    const ver = a.citations?.verified ?? [], unv = a.citations?.unverified ?? [];
    if (ver.length || unv.length) {
      box.append(h("details", { class: "fold report-sources", "data-disclosure": "sources" }, h("summary", null, ic("search"), "Sources", h("span", { class: "source-count" }, ver.length + unv.length)),
        h("ul", { class: "sources" }, [...ver.map((u) => [u, true]), ...unv.map((u) => [u, false])].map(([u, ok]) =>
          h("li", null, h("span", { class: `badge ${ok ? "ok" : "unv"}`, title: ok ? "the agent read this page" : "cited, but the agent never opened it" }, ok ? "Read" : "Unverified"),
            /^https?:\/\//i.test(u) ? h("a", { href: u, target: "_blank", rel: "noopener noreferrer nofollow" }, shortUrl(u)) : h("span", null, u))))));
    }
    if (steps.length) box.append(h("details", { class: "fold report-activity", "data-disclosure": "activity" }, h("summary", null, ic("log"), r.kind === "app" ? "Build steps" : "Research activity", h("span", { class: "source-count" }, steps.length)), logList(r.id, steps)));
    const wall = a.wall_ms ?? (r.agent_finished_at && r.agent_started_at ? r.agent_finished_at - r.agent_started_at : null);
    box.append(h("div", { class: "rfoot" }, h("span", null, (r.agent_model ?? "").replace(/^.*\//, "")), h("span", null, dur(wall)), h("span", null, usd(r.agent_cost)),
      a.counters ? h("span", null, `${a.counters.web_calls} web · ${a.counters.turns} turns`) : null, a.budget_note ? h("span", null, `budget: ${a.budget_note}`) : null));
    out.push(box);
  }
  if (r.status === "paused_budget") out.push(h("p", { class: "err" }, "Paused: today's research budget is used up. Reprocess it tomorrow to try again."));
  if (r.status === "stopped") {
    out.push(h("p", { class: "err" }, /API key/.test(r.error ?? "") ? "Your API key was rejected." : `Stopped: ${r.error ?? "agent failed"}`));
    if (/API key/.test(r.error ?? "")) out.push(h("div", { class: "err-action" }, h("button", { class: "btn", type: "button", onclick: (e) => { e.stopPropagation(); openSettings(S); } }, "Check your key in Settings")));
  }
  return out;
}
const STEP_TAG = { search: "search", read: "read", write: "write", think: "think", note: "note", error: "oops" };
function logList(id, steps) {
  return h("ol", { class: "log" }, steps.map((s) => {
    const isNew = S.newSteps.has(`${id}:${s.at}:${s.text}`) && !reducedMotion();
    return h("li", { class: `k-${s.kind}${isNew ? " new" : ""}` }, h("span", { class: "lk" }, STEP_TAG[s.kind] ?? s.kind), h("span", { class: "lt" }, s.text));
  }));
}

function detailsBlock(r) {
  const rows = [
    ["Recording ID", r.id],
    ["Recorded", new Date(r.received_at).toLocaleString(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" })],
    ["Duration", r.seconds != null ? `${Number(r.seconds).toFixed(1)} seconds` : null],
    ["Source", r.via], ["Firmware", r.fw],
    ["Audio level", r.rms != null ? String(r.rms) : null],
    ["Active audio", r.active_sec != null ? `${r.active_sec} seconds` : null],
    ["Action", r.kind ? `${r.kind}${(r.items ?? []).map((i) => ` · ${i.op} ${i.list}${i.ok ? "" : ` (${i.why})`}`).join("")}` : null],
    ["Model cost", r.agent_cost != null ? usd(r.agent_cost) : null],
    ...Object.entries(r.timings ?? {}).map(([key, value]) => [`Timing · ${key}`, String(value)]),
    ["Device", r.device != null ? JSON.stringify(r.device) : null],
  ].filter(([, value]) => value != null && value !== "");
  return h("dl", { class: "stats" }, rows.map(([label, value]) => h("div", null, h("dt", null, label), h("dd", { class: label === "Recording ID" ? "recording-id" : "" }, String(value)))));
}

function actions(r) {
  const busy = r.status === "processing", researching = r.status === "researching" || r.agent_state === "running" || r.agent_state === "queued";
  const sel = h("select", { "aria-label": "Change kind", "data-fk": "kind", disabled: busy || researching || r.status === "error" || null,
    onchange: (e) => reclassify(r.id, e.target.value) },
    kindOptions(r));
  return h("div", { class: "actions" },
    h("button", { class: "act", type: "button", "data-fk": "archive", title: r.state === "archived" ? "unarchive (e)" : "archive (e)", "aria-label": r.state === "archived" ? "Unarchive" : "Archive",
      disabled: busy || null, onclick: () => toggleArchive(r.id) }, ic(r.state === "archived" ? "unarchive" : "archive"), h("span", { class: "lbl" }, r.state === "archived" ? "unarchive" : "archive")),
    h("button", { class: "act", type: "button", "data-fk": "edit", title: "edit title (t)", "aria-label": "Edit title", disabled: busy || null, onclick: () => editTitle(r.id) }, ic("pencil"), h("span", { class: "lbl" }, "edit")),
    r.audio_key ? h("button", { class: "act", type: "button", "data-fk": "redo", title: "reprocess the audio (r)", "aria-label": "Reprocess", disabled: busy || null, onclick: () => reprocess(r.id) }, ic("redo"), h("span", { class: "lbl" }, "redo")) : null,
    h("span", { class: "kind-select" }, sel),
    h("span", { class: "spacer" }));
}

// ---------- audio player with a 1-bit waveform ----------
const loadQueue = []; let loading = 0;
const io = new IntersectionObserver((entries) => { for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); const pl = players.get(e.target.dataset.pid); if (pl) enqueue(pl); } }, { rootMargin: "200px" });
function enqueue(pl) { loadQueue.push(pl); pump(); }
function pump() { while (loading < 2 && loadQueue.length) { const pl = loadQueue.shift(); loading++; pl.load().finally(() => { loading--; pump(); }); } }
function player(r) {
  let p = players.get(r.id);
  if (p && p.gen === r.gen) return p;
  p = new Player(r);
  players.set(r.id, p);
  return p;
}
class Player {
  constructor(r) {
    this.id = r.id; this.gen = r.gen; this.secs = +r.seconds || 0; this.peaks = null; this.audio = null; this.loaded = null; this.position=0; this.dragging=false;
    this.btn = h("button", { class: "play", type: "button", "aria-label": "Play recording", "data-fk": "play", onclick: () => this.toggle() }, ic("play"));
    this.canvas = h("canvas", { class: "wave", tabindex: "0", role: "slider", "aria-label": "Seek", "aria-valuemin": "0", "aria-valuemax": String(Math.round(this.secs)), "aria-valuenow": "0" });
    this.time = h("span", { class: "ptime" }, `0:00 / ${clock(this.secs)}`);
    this.bubble=h('span',{class:'scrub-bubble','aria-hidden':'true'},'0:00');
    this.track=h('div',{class:'scrub-track'},this.canvas,h('span',{class:'scrub-playhead','aria-hidden':'true'}),this.bubble);
    this.root = h("div", { class: "player", "data-pid": r.id }, this.btn, this.track, this.time);
    this.canvas.addEventListener('pointerdown',e=>{
      if(e.button!==0) return;
      this.dragging=true;this.wasPlaying=!!this.audio&&!this.audio.paused;
      this.audio?.pause();this.track.classList.add('scrubbing');
      this.canvas.setPointerCapture(e.pointerId);this.previewAt(e);
    });
    this.canvas.addEventListener('pointermove',e=>{if(this.dragging)this.previewAt(e);});
    const finish=e=>{
      if(!this.dragging)return;
      if(e.type!=='pointercancel')this.previewAt(e);
      this.dragging=false;this.track.classList.remove('scrubbing');
      this.seek(this.position);
      if(this.wasPlaying)this.audio?.play().catch(()=>{});
    };
    this.canvas.addEventListener('pointerup',finish);
    this.canvas.addEventListener('pointercancel',finish);
    this.canvas.addEventListener('lostpointercapture',finish);
    this.canvas.addEventListener("keydown", (e) => { if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); this.seek((this.position ?? 0) + (e.key === "ArrowRight" ? 1 : -1)); } });
    io.observe(this.root);
    new ResizeObserver(() => this.draw()).observe(this.canvas);
  }
  load() {
    return (this.loaded ??= (async () => {
      const res = await fetch(`${BASE}audio/${encodeURIComponent(this.id)}`, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`audio ${res.status}`);
      const buf = await res.arrayBuffer();
      this.url = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
      try {
        const ctx = new OfflineAudioContext(1, 1, 16000);
        const data = (await ctx.decodeAudioData(buf.slice(0))).getChannelData(0);
        const N = 400, step = Math.max(1, Math.floor(data.length / N)), peaks = new Float32Array(N);
        for (let i = 0; i < N; i++) { let m = 0; for (let j = i * step; j < Math.min(data.length, (i + 1) * step); j++) m = Math.max(m, Math.abs(data[j])); peaks[i] = m; }
        const mx = Math.max(0.05, ...peaks);
        this.peaks = peaks.map((v) => Math.sqrt(v / mx));
        this.secs = data.length / 16000 || this.secs;
      } catch { this.peaks = new Float32Array(400).fill(0.3); }
      this.draw();
    })().catch(() => { this.time.textContent = "no audio"; }));
  }
  draw() {
    const c = this.canvas, dpr = devicePixelRatio || 1, w = Math.max(10, Math.round(c.clientWidth * dpr)), hgt = Math.round(48 * dpr);
    if (!c.clientWidth) return;
    c.width = w; c.height = hgt;
    const g = c.getContext("2d"), ink = cssVar("--ink"), red = cssVar("--red"), px = Math.max(1, Math.round(dpr));
    g.clearRect(0, 0, w, hgt);
    const bar = 2 * px, gap = px, n = Math.floor(w / (bar + gap));
    const duration=this.audio?.duration || this.secs;
    if(!this.dragging && this.audio) this.position=this.audio.currentTime;
    const prog=duration?Math.max(0,Math.min(1,this.position/duration)):0;
    this.track.style.setProperty('--scrub-progress',`${prog*100}%`);
    this.bubble.textContent=clock(this.position);
    for (let i = 0; i < n; i++) {
      const x = i * (bar + gap);
      const v = this.peaks ? this.peaks[Math.floor((i / n) * this.peaks.length)] : 0;
      g.fillStyle = i / n < prog ? red : ink;
      g.globalAlpha=i/n<prog?1:.28;
      if (!this.peaks) { if (i % 2 === 0) g.fillRect(x, hgt / 2 - px / 2, bar, px); continue; }
      const bh = Math.max(px, Math.round((v * (hgt - 2 * px)) / (2 * px)) * 2 * px);
      g.beginPath(); g.roundRect(x, Math.round((hgt - bh) / 2), bar, bh, bar / 2); g.fill();
    }
    const t = this.position;
    this.time.textContent = `${clock(t)} / ${clock(this.secs)}`;
    this.canvas.setAttribute("aria-valuenow", String(t));
    this.canvas.setAttribute('aria-valuemax',String(this.secs));
    this.canvas.setAttribute('aria-valuetext',`${clock(t)} of ${clock(this.secs)}`);
  }
  async ensureAudio() {
    if (!this.audio) {
      await this.load();
      if (!this.url) return;
      this.audio = new Audio(this.url);
      this.audio.addEventListener("ended", () => { this.setIcon(false); this.draw(); });
      this.audio.addEventListener("pause", () => this.setIcon(false));
      this.audio.addEventListener("play", () => { this.setIcon(true); const tick = () => { this.draw(); if (!this.audio.paused) requestAnimationFrame(tick); }; tick(); });
    }
    return this.audio;
  }
  async toggle() {
    await this.ensureAudio();
    if(!this.audio)return;
    if(this.audio.ended) {this.position=0;this.audio.currentTime=0;}
    else if(this.position && this.audio.paused) this.audio.currentTime=this.position;
    for (const [, p] of players) if (p !== this && p.audio && !p.audio.paused) p.audio.pause();
    if (this.audio.paused) this.audio.play(); else this.audio.pause();
  }
  setIcon(playing) { this.btn.replaceChildren(ic(playing ? "pause" : "play")); this.btn.setAttribute("aria-label", playing ? "Pause recording" : "Play recording"); }
  previewAt(e) {
    const rect=this.canvas.getBoundingClientRect();
    this.position=Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width))*(this.audio?.duration||this.secs);
    this.draw();
  }
  async seek(t) {
    this.position=Math.max(0,Math.min(t,this.audio?.duration||this.secs));
    const desired=this.position;
    await this.ensureAudio();
    if(!this.audio)return;
    const apply=()=>{this.audio.currentTime=Math.min(desired,this.audio.duration||this.secs);this.position=this.audio.currentTime;this.draw();};
    if(this.audio.readyState>=1)apply();else this.audio.addEventListener('loadedmetadata',apply,{once:true});
  }
}

// ---------- actions (optimistic, rolled back on error) ----------
async function patch(id, body, { label, undo, quiet=false } = {}) {
  const r = S.recs.get(id);
  if (!r) return;
  const before = { ...r };
  S.recs.set(id, { ...r, ...body });
  renderAll();
  try {
    const fresh = await api(`api/tasks/${encodeURIComponent(id)}`, { method: "PATCH", body });
    S.recs.set(id, fresh);
    renderAll();
    if (label) toast(label, undo ? { action: "undo", onAction: () => patch(id, undo) } : {});
    return true;
  } catch (e) {
    S.recs.set(id, before);
    renderAll();
    if(!quiet) toast(`couldn't save that: ${e.message}`, { bad: true });
    return false;
  }
}
function toggleArchive(id) {
  const r = S.recs.get(id); if (!r || r.status === "processing") return;
  const to = r.state === "archived" ? "open" : "archived";
  patch(id, { state: to }, { label: to === "archived" ? "Item archived" : "Item restored", undo: { state: r.state } });
}
function reclassify(id, kind) {
  const r = S.recs.get(id); if (!r || r.kind === kind) return;
  const agent = AGENT_KINDS.includes(kind);
  patch(id, { kind }, { label: kind === "app" ? "building it as an app" : kind === "research" ? "researching it" : "ignored", undo: agent || AGENT_KINDS.includes(r.kind) ? null : { kind: r.kind } });
}
async function reprocess(id) {
  const r = S.recs.get(id); if (!r) return;
  if (AGENT_KINDS.includes(r.kind) && !confirm(`Reprocess this ${r.kind} memo? It may run the agent again (counts against today's budget).`)) return;
  const before = { ...r };
  S.recs.set(id, { ...r, status: "processing", title: null, kind: null, transcript: null, summary: null, agent_result: null, steps: [] });
  renderAll();
  try { await api(`api/tasks/${encodeURIComponent(id)}/reprocess`, { method: "POST" }); mood("think", 4000, "running it through again…"); }
  catch (e) { S.recs.set(id, before); renderAll(); toast(`reprocess failed: ${e.message}`, { bad: true }); }
}
let itemId = null, itemCard = null, itemKey = null, inboxScroll = 0;
function toggleExpand(id) { location.hash = `item/${encodeURIComponent(id)}`; }
function backToInbox() { location.hash = ""; }
document.getElementById("back-inbox").onclick = backToInbox;
function renderItem() {
  const host = document.getElementById("item-content");
  const record = S.recs.get(itemId);
  if (!itemId) return;
  if (!record) {
    host.replaceChildren(h("p", { class: "muted" }, S.ready ? "This item is no longer available." : "Loading item…"));
    itemKey = null; itemCard = null; return;
  }
  const key = cardKey(record);
  if (key === itemKey) return;
  const focused = document.activeElement?.closest("#item-content") ? focusKey(document.activeElement) : null;
  const disclosures = [...host.querySelectorAll("details")].map((el, i) => el.open ? el.dataset.disclosure || el.dataset.fk || `fold-${i}` : null).filter(Boolean);
  itemCard = buildItem(record);
  for (const [i, el] of [...itemCard.querySelectorAll("details")].entries()) {
    if (disclosures.includes(el.dataset.disclosure || el.dataset.fk || `fold-${i}`)) el.open = true;
  }
  host.replaceChildren(itemCard); itemKey = key;
  if (focused) itemCard.querySelector(`[data-fk="${focused}"]`)?.focus({ preventScroll: true });
}
const filterModal = document.getElementById("filter-modal");
document.getElementById("filter-close").append(ic("close", 20));
document.getElementById("mobile-filters").onclick = () => {
  document.getElementById("filter-view").value = S.view;
  document.getElementById("filter-kind").value = S.kind === "ignore" ? "all" : S.kind;
  document.getElementById("filter-noise").checked = S.noise;
  filterModal.showModal(); document.body.classList.add("filters-open");
};
document.getElementById("filter-close").onclick = () => filterModal.close();
filterModal.addEventListener("close", () => { document.body.classList.remove("filters-open"); document.getElementById("mobile-filters").focus({ preventScroll: true }); });
filterModal.addEventListener("click", e => {
  const rect = filterModal.getBoundingClientRect();
  if (e.target === filterModal && (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom)) filterModal.close();
});
document.getElementById("filter-reset").onclick = () => {
  document.getElementById("filter-view").value = "open";
  document.getElementById("filter-kind").value = "all";
  document.getElementById("filter-noise").checked = false;
};
document.getElementById("filter-apply").onclick = () => {
  S.view = document.getElementById("filter-view").value;
  S.kind = document.getElementById("filter-kind").value;
  S.noise = document.getElementById("filter-noise").checked;
  S.showAll = false; filterModal.close();
  renderAll();
};
// List actions use the current view and exclude recordings still processing.
{
  const bulk=h('button',{type:'button',class:'bulk-archive'},ic('archive',18),h('span',null,'Archive all…'));
  const showArchive=h('button',{type:'button',class:'bulk-archive',onclick:()=>{menu.open=false;changeList(()=>{S.view=S.view==='archived'?'open':'archived';S.showAll=false;});}},ic('archive',18),h('span',null,'Archive'));
  const showIgnored=h('button',{type:'button',class:'bulk-archive',onclick:()=>{menu.open=false;changeList(()=>{S.noise=!S.noise;if(S.kind==='ignore')S.kind='all';});}},ic('noise',18),h('span',null,'Show ignored clips'));
  const menu=h('details',{class:'list-actions-menu'},
    h('summary',{'aria-label':'List actions',title:'List actions'},'⋮'),
    h('div',{class:'list-actions-popover'},showArchive,showIgnored,bulk));
  document.querySelector('.toolbar').append(menu);
  document.addEventListener('pointerdown',event=>{if(!menu.contains(event.target)) menu.open=false;});
  menu.addEventListener('keydown',event=>{if(event.key==='Escape'){menu.open=false;menu.querySelector('summary').focus();}});
  const getScope=()=>{
    const view=S.view;
    const kind=S.kind;
    const noise=S.noise;
    return [...S.recs.values()].filter(r=>r.state==='open' && !isNow(r) && view!=='archived' && matchesQ(r) && (kind==='all'?(noise||r.kind!=='ignore'):r.kind===kind));
  };
  const scoped=()=>!!S.q || S.kind!=='all';
  const update=()=>{
    const count=getScope().length;
    bulk.lastChild.textContent=`${scoped()?'Archive matching items':'Archive all'}…`;
    bulk.disabled=!count || S.view==='archived';
    showArchive.lastChild.textContent=S.view==='archived'?'Back to memos':'Archive';
    showIgnored.lastChild.textContent=S.noise?'Hide ignored clips':'Show ignored clips';
  };
  menu.addEventListener('toggle',()=>{if(menu.open)update();});
  document.getElementById('mobile-filters').addEventListener('click',update);
  document.getElementById('filter-reset').addEventListener('click',update);
  const title=h('h2',{id:'archive-confirm-title'}), description=h('p');
  const cancel=h('button',{type:'button',class:'btn',onclick:()=>confirm.close()},'Cancel');
  const apply=h('button',{type:'button',class:'btn primary'},'Archive');
  const confirm=h('dialog',{class:'archive-confirm install-modal','aria-labelledby':'archive-confirm-title'},
    h('div',{class:'archive-confirm-content'},title,description),h('footer',{class:'install-footer'},cancel,apply));
  document.body.append(confirm);
  let selected=[];
  bulk.onclick=()=>{
    selected=getScope();
    title.textContent=`Archive ${scoped()?'these ': 'all '}${selected.length} memo${selected.length===1?'':'s'}?`;
    description.textContent='They’ll move to Archive. You can restore them anytime.';
    menu.open=false;confirm.showModal();cancel.focus();
  };
  confirm.addEventListener('close',()=>menu.querySelector('summary').focus({preventScroll:true}));
  let archiving=false;
  confirm.addEventListener('cancel',event=>{if(archiving)event.preventDefault();});
  apply.onclick=async()=>{
    if(archiving) return;
    archiving=true;apply.disabled=true;cancel.disabled=true;
    const archived=[];
    for(const record of selected) {
      const current=S.recs.get(record.id);
      if(!current || current.state==='archived' || isNow(current)) continue;
      const before={id:current.id,state:current.state};
      apply.textContent=`Archiving ${archived.length+1} of ${selected.length}…`;
      if(await patch(current.id,{state:'archived'},{quiet:true})) archived.push(before);
    }
    archiving=false;apply.disabled=false;cancel.disabled=false;apply.textContent='Archive';confirm.close();
    const failed=selected.length-archived.length;
    if(!archived.length) {toast('No items archived. Please try again.',{bad:true});return;}
    toast(`${archived.length} items archived${failed?` · ${failed} not archived`:''}`,{action:'undo',onAction:async()=>{
      let restored=0, errors=0;
      for(const r of archived) if(S.recs.get(r.id)?.state==='archived') {
        if(await patch(r.id,{state:r.state},{quiet:true})) restored++;else errors++;
      }
      toast(`${restored} items restored${errors?` · ${errors} couldn’t be restored`:''}`,{bad:!!errors});
    }});
  };
}

const reportModal = document.getElementById("report-modal");
let reportId = null, reportKey = null;
document.getElementById("report-close").append(ic("close", 20));
document.getElementById("report-close").onclick = () => reportModal.close();
reportModal.addEventListener("click", e => {
  if (e.target !== reportModal) return;
  const rect = reportModal.getBoundingClientRect();
  if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) reportModal.close();
});
reportModal.addEventListener("close", () => {
  reportId = null; reportKey = null;
  document.body.classList.remove("report-open");
  document.querySelector('#item-content [data-fk="report"]')?.focus({ preventScroll: true });
});
function openReport(id) {
  reportId = id; reportKey = null; renderReportModal();
  reportModal.showModal(); document.body.classList.add("report-open");
  document.getElementById("report-close").focus();
}
function renderReportModal() {
  if (!reportId) return;
  const record = S.recs.get(reportId);
  if (!record) { if (reportModal.open) reportModal.close(); return; }
  const key = JSON.stringify([record.summary, record.agent_result, record.status, record.steps, record.agent_progress, record.error]);
  if (key === reportKey) return;
  const host = document.getElementById("report-content");
  const scroll = reportModal.scrollTop;
  const opened = [...host.querySelectorAll("details[open][data-disclosure]")].map(el => el.dataset.disclosure);
  host.replaceChildren(...workBlocks(record, true));
  for (const el of host.querySelectorAll("details[data-disclosure]")) el.open = opened.includes(el.dataset.disclosure);
  document.getElementById("report-modal-title").textContent = record.title || "Untitled report";
  reportModal.scrollTop = scroll; reportKey = key;
}
let detailTransition = null, detailRouteSerial = 0;
function routeItem(id, { animate = true } = {}) {
  const serial = ++detailRouteSerial;
  detailTransition?.skipTransition();
  if (id === itemId) return;
  const update = () => { if (serial === detailRouteSerial) applyItemRoute(id); };
  if (!animate || !document.startViewTransition || reducedMotion() || !S.ready || document.visibilityState !== "visible") {
    update(); return;
  }
  const root = document.documentElement;
  root.dataset.detailTransition = id ? "forward" : "back";
  const transition = document.startViewTransition(update);
  detailTransition = transition;
  // Skipped transitions still navigate; they must never leave stale direction styles.
  transition.ready.catch(() => {});
  transition.finished.then(() => {
    if (detailTransition === transition) {
      detailTransition = null;
      delete root.dataset.detailTransition;
    }
  }, () => {
    if (detailTransition === transition) {
      detailTransition = null;
      delete root.dataset.detailTransition;
    }
  });
}
function applyItemRoute(id) {
  if (reportModal.open) reportModal.close();
  const entering = id && !itemId, leaving = !id && itemId;
  const previous = itemId;
  if (entering) inboxScroll = window.scrollY;
  itemId = id; itemKey = null; S.expanded.clear();
  if (id) S.expanded.add(id);
  document.body.classList.toggle("viewing-item", !!id);
  document.getElementById("item-view").hidden = !id;
  renderAll();
  if (id) { window.scrollTo(0, 0); document.getElementById("back-inbox").focus({ preventScroll: true }); }
  else if (leaving) {
    for (const p of players.values()) p.audio?.pause();
    itemCard = null;
    document.getElementById("item-content").replaceChildren();
    window.scrollTo(0, inboxScroll);
    cardCache.get(previous)?.el.focus({ preventScroll: true });
  }
}
function editTitle(id) {
  const r = S.recs.get(id), el = itemId === id ? itemCard : cardCache.get(id)?.el;
  if (!r || !el) return;
  const t = el.querySelector(".title");
  const input = h("input", { class: "title-edit", type: "text", value: r.title ?? "", maxlength: "120", "aria-label": "Title" });
  let done = false;
  const finish = (save) => {
    if (done) return; done = true;
    const v = input.value.replace(/\s+/g, " ").trim();
    if (save && v && v !== r.title) patch(id, { title: v }, { label: "renamed", undo: { title: r.title } });
    else { itemKey = null; cardCache.delete(id); renderAll(); }
    requestAnimationFrame(() => (itemId === id ? itemCard : cardCache.get(id)?.el)?.focus());
  };
  input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); });
  input.addEventListener("blur", () => finish(true));
  t.replaceWith(input);
  input.focus(); input.select();
}

// ---------- side panel: device, budget, counts ----------
const REQ_TEXT = { upload: "clip upload", result: "result check", updates: "result check", firmware: "update check", status: "status report", wifi: "Wi-Fi sync", tasks: "task list", other: "request" };
function mirrorModel(dev) {
  const recs = [...S.recs.values()].filter((r) => !dev || r.id.includes(dev.key)).sort((a, b) => b.received_at - a.received_at);
  const last = recs[0], pct = dev?.batt_pct ?? null, now = Date.now();
  const inc = [...S.incoming.entries()].find(([id, at]) => (!dev || id.includes(dev.key)) && now - at < 15_000 && !S.recs.has(id));
  const base = { pct, queued: false };
  if (inc) return { ...base, screen: "Sending" };
  if (!last) return { ...base, screen: "Ready" };
  const age = now - last.received_at;
  if (last.status === "processing") return { ...base, screen: age < 6000 ? "Sending" : "Sent" };
  if (last.status === "error") return { ...base, screen: "ResultError", error: last.error };
  const dk = last.device?.kind ?? last.kind; // what the board shows (server deviceView)
  if (dk === "noise") return { ...base, screen: "Noise" };
  if (dk === "answer") return { ...base, screen: "Answer", summary: last.device?.summary ?? last.summary ?? "" };
  if (dk === "work") {
    const title = last.device?.title ?? last.title;
    if (last.status === "researching") return { ...base, screen: "Researching", title };
    if (last.status === "paused_budget") return { ...base, screen: "WorkPaused", title };
    if (last.status === "stopped") return { ...base, screen: "WorkStopped", title };
    return { ...base, screen: "WorkDone", summary: last.device?.summary ?? last.summary ?? title };
  }
  return { ...base, screen: "Result", kind: dk, title: last.device?.title ?? last.title ?? "", due: last.device?.due ?? last.due };
}
const ANIM_SCREENS = new Set(["Sending", "Researching"]);
let mirrorKey = "";
function drawRobot() {
  const dev = S.devices[0];
  const m = mirrorModel(dev);
  const face = currentFace();
  if (face) m.expr = MOODS[face];
  const animated = !reducedMotion() && (ANIM_SCREENS.has(m.screen) || face);
  const key = JSON.stringify(m) + (animated ? bolt.f : "");
  if (key === mirrorKey) return;
  mirrorKey = key;
  const c = document.getElementById("mirror");
  const max = 200;
  paintCrisp(c, drawMirror(m, animated ? bolt.f : 0), max, cssVar("--panel-ink"), cssVar("--panel-paper"));
  c.setAttribute("aria-label", `paperbot's screen: ${m.screen}${m.title ? `, ${m.title}` : ""}${m.summary ? `, ${m.summary}` : ""}`);
}
function renderSide() {
  drawRobot();
  const dev = S.devices[0];
  const facts = document.getElementById("facts");
  if (!dev) facts.replaceChildren(h("span", null, "device not seen yet"));
  else {
    const low = dev.batt_pct != null && dev.batt_pct < 15 && !dev.usb;
    facts.replaceChildren(...[
      h("span", { title: `last: ${REQ_TEXT[dev.last_req] ?? dev.last_req ?? ""}` }, "heard ", h("span", { "data-ts": dev.last_seen }, ago(dev.last_seen))),
      dev.batt_pct != null ? h("span", { class: low ? "low" : "", title: dev.batt_mv ? `${(dev.batt_mv / 1000).toFixed(2)} V` : "" }, `${dev.batt_pct}%${dev.usb ? " ⚡" : ""}`) : null,
      dev.trend?.days_left != null && !dev.usb ? h("span", null, `~${dev.trend.days_left}d left`) : null,
      dev.fw ? h("span", null, `v${dev.fw}`) : null,
      dev.pending ? h("span", null, `waiting on ${dev.pending}`) : null,
      dev.sim ? h("span", null, "sim") : null].filter(Boolean));
  }
  const al = document.getElementById("dev-alerts");
  al.replaceChildren(...(dev?.alerts ?? []).filter((a) => a.code !== "crash").map((a) => h("div", { class: `alert ${a.level}` }, ic(a.code === "battery_low" ? "batt0" : a.code === "wifi" ? "wifi" : "alert", 14), a.text)));

  const b = S.budget;
  if (b) {
    const meter = document.getElementById("bud-meter");
    const spent = Math.min(100, (b.spent_usd / b.daily_cap_usd) * 100), res = Math.min(100 - spent, ((b.running * b.task_cap_usd) / b.daily_cap_usd) * 100);
    meter.querySelector(".fill").style.width = `${spent}%`;
    const rv = meter.querySelector(".reserve"); rv.style.left = `${spent}%`; rv.style.width = `${res}%`;
    meter.classList.toggle("hot", spent > 85);
    meter.setAttribute("aria-valuemax", String(b.daily_cap_usd)); meter.setAttribute("aria-valuenow", String(b.spent_usd));
    meter.setAttribute("aria-label", `Research spend today ${usd(b.spent_usd)} of ${usd(b.daily_cap_usd)}`);
    document.getElementById("bud-line").textContent = `${usd(b.spent_usd)} of ${usd(b.daily_cap_usd)}${b.running ? ` · ${b.running} running` : ""}${b.queued ? ` · ${b.queued} queued` : ""}`;
  }
}
function updateHeaderBadges() {
  const dev = S.devices[0];
  document.getElementById("btn-health").classList.toggle("has-alert", !!dev?.alerts?.some((a) => a.level === "bad"));
  const nets = S.wifi?.networks ?? [];
  document.getElementById("btn-places").classList.toggle("has-alert", nets.some((n) => n.needs_psk));
}

// Standard keyboard activation for focusable list rows.
document.getElementById("sections").addEventListener("keydown", event => {
  if ((event.key === "Enter" || event.key === " ") && event.target.matches(".card[data-id]:not(.ghost)")) {
    event.preventDefault(); toggleExpand(event.target.dataset.id);
  }
});

// ---------- chrome ----------
function setupChrome() {
  document.getElementById("search-ic").append(ic("search"));
  document.getElementById("settings-toggle").append(ic("gear", 20));
  const settings = document.querySelector(".settings");
  document.addEventListener("pointerdown", event => {
    if (settings.open && !settings.contains(event.target)) settings.open = false;
  }, { capture: true });
  settings.addEventListener("keydown", event => {
    if (event.key === "Escape" && settings.open) {
      event.preventDefault(); event.stopPropagation();
      settings.open = false;
      document.getElementById("settings-toggle").focus({ preventScroll: true });
    }
  });
  document.getElementById("btn-health").prepend(ic("bolt", 20));
  document.getElementById("btn-places").prepend(ic("wifi", 20));
  document.getElementById("btn-settings").prepend(ic("gear", 20));
  document.getElementById("btn-settings").onclick = () => { document.querySelector(".settings").open = false; openSettings(S); };
  document.getElementById("btn-health").onclick = () => openHealth(S);
  document.getElementById("btn-places").onclick = () => openPlaces(S);
  if (BASE !== "/" || /test/.test(location.hostname)) document.getElementById("envtag").hidden = false;
  // Back from Connect OpenBelt with a problem (src/index.ts /api/openbelt/callback): say it once, then drop it from the address.
  const obError = new URLSearchParams(location.search).get("openbelt_error");
  if (obError) {
    toast(obError === "denied" ? "Connection was denied." : "Couldn't connect.",
      { bad: true, action: obError === "denied" ? "Connect" : "Try again", onAction: () => { location.href = connectOpenbelt(); }, ms: 12000 });
    history.replaceState(null, "", location.pathname + location.hash);
  }
  const q = document.getElementById("q");
  q.value = S.q;
  const search = event => {
    if (event.isComposing) return;
    S.q = q.value.trim(); S.showAll = false; schedule();
  };
  q.addEventListener("input", search);
  q.addEventListener("compositionend", search);
  // theme: light (default) -> dark -> system. Stored in pv-theme; the pages start light (<html data-theme="light">).
  let theme = "light"; try { theme = ["light", "dark", "system"].includes(localStorage.getItem("pv-theme")) ? localStorage.getItem("pv-theme") : "light"; } catch {}
  const applyTheme = () => {
    if (theme === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = theme;
    const b = document.getElementById("btn-theme");
    b.replaceChildren(ic(theme === "dark" ? "moon" : theme === "light" ? "sun" : "monitor", 20),
      h("span", null, "Theme"), h("span", { class: "setting-value" }, theme === "dark" ? "Dark" : theme === "light" ? "Light" : "System"));
    b.setAttribute("aria-label", `Theme: ${theme} (click to change)`); b.title = `Theme: ${theme === "system" ? "system (follows your device)" : theme}`;
    mirrorKey = ""; renderSide(); for (const p of players.values()) p.draw();
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", cssVar("--paper"));
  };
  document.getElementById("btn-theme").onclick = () => {
    theme = theme === "light" ? "dark" : theme === "dark" ? "system" : "light";
    try { localStorage.setItem("pv-theme", theme); } catch {}
    applyTheme();
  };
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (theme === "system") applyTheme();
  });
  applyTheme();
  initDrawer();
  window.addEventListener("hashchange", routeHash);
  window.addEventListener("popstate", event => {
    // Safari has already shown its interactive history snapshot. Update immediately
    // before the following hashchange instead of playing a second slide over it.
    if (event.hasUAVisualTransition) routeHash(event);
  });
  window.addEventListener("resize", () => { mirrorKey = ""; drawRobot(); });
}
function routeHash(event) {
  const animate = !event?.hasUAVisualTransition;
  const hsh = location.hash.slice(1);
  if (hsh.startsWith("item/")) {
    closeDrawer(true);
    let id; try { id = decodeURIComponent(hsh.slice(5)); } catch { id = hsh.slice(5); }
    showTab("memos"); routeItem(id, { animate }); return;
  }
  if (hsh === "list" || hsh === "apps") { routeItem(null, { animate: false }); closeDrawer(true); showTab(hsh); return; }
  if (!hsh) { showTab("memos"); routeItem(null, { animate }); }
  if (hsh === "health") openHealth(S); else if (hsh === "settings") openSettings(S); else if (hsh === "connections" || hsh === "places") openPlaces(S); else if (/^connections\/(devices|wifi|apps|assistants)$/.test(hsh)) openPlaces(S, hsh.slice(12)); else closeDrawer(true);
}

// ticker: the replica animates only while the device would (sending / researching) or after a poke; times refresh
setInterval(() => {
  bolt.f++;
  if (bolt.f % 2 === 0) drawRobot();
  if (bolt.transient && Date.now() >= bolt.until) updateBolt();
  if (bolt.face && Date.now() >= bolt.faceUntil) { bolt.face = null; drawRobot(); }
  if (bolt.f % 4 === 0) for (const el of document.querySelectorAll("[data-since]")) el.textContent = dur(Date.now() - +el.dataset.since);
  if (bolt.f % 60 === 0) for (const el of document.querySelectorAll("[data-ts]")) el.textContent = ago(+el.dataset.ts);
}, 250);

function setupDeviceActivity() {
  const content=document.querySelector('.device-content');
  document.querySelector('#open-health').remove();
  setDeviceContent(content);
  document.querySelector('.side').remove();
}
setupChrome();
setupDeviceActivity();
const appUpdates = setupAppUpdates({
  restored: refreshedState,
  getState: () => ({ q:S.q, view:S.view, kind:S.kind, noise:S.noise, showAll:S.showAll, scroll:window.scrollY, inboxScroll }),
  isBusy: () => !!document.querySelector('.title-edit, .swipe-committing, dialog[open]') || !document.getElementById('drawer').hidden,
});
setupInstall();
document.querySelector(".settings-menu").append( // last, after Refresh app (updates.js)
  h("div", { class: "settings-divider", role: "separator" }),
  h("button", { type: "button", class: "icon-btn", id: "btn-sign-out", onclick: signOut }, ic("sign-out", 20), h("span", null, "Sign out")));
updateConn();
renderAll();
connect();
setupBelt(schedule);
routeHash();
loadLinks(S).then(() => schedule()); // boards: the first-visit setup card
