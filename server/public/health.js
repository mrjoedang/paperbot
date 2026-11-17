// Device health drawer: paperbot's self-report (status reports, battery chart, crashes with logs, Wi-Fi stats).
import { B, boxBot, MOODS, tw } from "./bolt.js";
import { ago, dur } from "./util.js";
import { h, ic, api, toast, cssVar, openDrawer, paintCrisp } from "./dom.js";

let deviceContent=null, deviceStorage=null, deviceBudget=null;
export function setDeviceContent(content) {
  deviceContent=content;
  deviceBudget=content.querySelector('.budget');
  deviceStorage=h('div',{hidden:true});
  document.body.append(deviceStorage);
  deviceStorage.append(content);
}

let open = false, data = null, devKey = null, S0 = null, fetching = null, lastFetch = 0;

export function openHealth(S) {
  S0 = S;
  devKey = devKey && S.devices.some((d) => d.key === devKey) ? devKey : S.devices[0]?.key ?? null;
  open = true;
  openDrawer("Device", (body) => render(body), { hash: "health", onClose: () => { open = false; if(deviceContent) {deviceStorage.append(deviceContent); if(deviceBudget) deviceContent.append(deviceBudget);} document.getElementById('drawer-body').classList.remove('device-panel'); } });
  load(true);
}
export function refreshHealth(S, refetch = false) {
  if (!open) return;
  S0 = S;
  if (refetch || Date.now() - lastFetch > 15_000) load(false);
  else render(document.getElementById("drawer-body"));
}
async function load(ack) {
  if (!devKey) return render(document.getElementById("drawer-body"));
  fetching = api(`api/device/${encodeURIComponent(devKey)}/health`).then((d) => { data = d; lastFetch = Date.now(); }).catch((e) => toast(`health: ${e.message}`, { bad: true }));
  await fetching;
  if (ack && data?.device?.alerts?.some((a) => a.code === "crash")) api(`api/device/${encodeURIComponent(devKey)}/ack`, { method: "POST" }).catch(() => {}); // seen: stop worrying
  if (open) render(document.getElementById("drawer-body"));
}

const fmtT = (t) => { const d = new Date(t); return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, "0")} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; };
const kb = (b) => (b == null ? "–" : `${Math.round(b / 1024)} KB`);
const pctS = (v) => (v == null ? "–" : `${(v * 100).toFixed(v < 0.01 ? 2 : 1)}%`);

function render(host) {
  if (!host || !open) return;
  const scroll = host.scrollTop;
  const diagnosticsOpen=!!host.querySelector('.device-diagnostics[open]');
  const openLogs = new Set([...host.querySelectorAll("details[open][data-ev]")].map((d) => d.dataset.ev));
  const dev = (S0?.devices ?? []).find((d) => d.key === devKey) ?? data?.device ?? null;
  host.replaceChildren();
  host.classList.add('device-panel');
  const overview=h('section',{class:'device-overview','aria-label':'Overview'},h('h3',null,'Overview'));
  if(deviceContent) overview.append(deviceContent);
  const activity=h('section',{class:'device-activity','aria-label':'Research usage'});
  if(deviceBudget) activity.append(deviceBudget);
  const body=h('div',{class:'device-diagnostic-body'});
  const diagnostics=h('details',{class:'device-diagnostics',open:diagnosticsOpen || null},h('summary',null,h('span',null,'Diagnostics'),ic('filters',16)),body);
  diagnostics.addEventListener('toggle',()=>{ if(diagnostics.open) { const c=body.querySelector('canvas.chart'); if(c && data?.series?.length>=2) requestAnimationFrame(()=>drawChart(c,data.series,dev?.trend)); } });
  host.append(overview,activity,diagnostics);
  if (!dev) { body.append(says("sleep", "I haven't heard from a device yet. Once it sends anything, its health shows up here.")); return; }
  if ((S0?.devices ?? []).length > 1) {
    body.append(h("div", { class: "seg", role: "radiogroup", "aria-label": "Device", style: { marginBottom: "14px" } }, S0.devices.map((d) =>
      h("button", { type: "button", role: "radio", "aria-checked": String(d.key === devKey), onclick: () => { devKey = d.key; data = null; load(true); } }, `${d.sim ? "sim" : "board"} ·${d.key.slice(-4)}`))));
  }
  // newest value of each field across recent reports (a partial report doesn't blank the tiles)
  const st = dev.status ? { ...Object.fromEntries((data?.reports ?? []).slice().reverse().flatMap((r) => Object.entries(r).filter(([, v]) => v != null))), ...Object.fromEntries(Object.entries(dev.status).filter(([, v]) => v != null)) } : null;
  const hl = dev.health, tr = dev.trend;
  const events = data?.events ?? [];
  const crash = events.find((e) => e.kind === "crash" && Date.now() - e.at < 7 * 86400_000);
  // its own words
  if (crash) {
    const d = new Date(crash.at);
    body.append(says("error", `I crashed at ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")} on ${d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })} (${crash.reset}). ${crash.log ? "here's what I was doing:" : "no log came with it — ask me for one below."}`, true));
    if (crash.log) body.append(h("pre", { class: "loglines", style: { border: "2px solid var(--red)", borderTop: "0" } }, crash.log.join("\n")));
  } else if (dev.alerts?.length) body.append(says("sad", dev.alerts.map((a) => a.text).join(" · ") + "."));
  else body.append(says("happy", `all good! last ${st ? "report" : "request"} ${ago(dev.status_at ?? dev.last_seen)}.${tr?.days_left != null ? ` battery should last ~${tr.days_left} more days.` : ""}`));

  // tiles
  const tile = (l, v, s, bad) => h("div", { class: `tile${bad ? " bad" : ""}` }, h("span", { class: "l" }, l), h("span", { class: "v" }, v), s ? h("span", { class: "s" }, s) : null);
  body.append(h("h3", null, "Right now"), h("div", { class: "hgrid" },
    tile("battery", dev.batt_pct == null ? "–" : `${dev.batt_pct}%`, [dev.batt_mv ? `${(dev.batt_mv / 1000).toFixed(2)} V` : "", tr ? `${tr.mv_per_h > 0 ? "+" : ""}${tr.mv_per_h} mV/h` : ""].filter(Boolean).join(" · "), dev.batt_pct != null && dev.batt_pct < 15 && !dev.usb),
    tile("power", dev.usb ? "USB" : dev.usb === false ? "battery" : "–", dev.usb ? "charging" : tr?.days_left != null ? `~${tr.days_left} days left` : "estimate needs 2 h off USB"),
    tile("heard", ago(dev.last_seen), `${dev.reqs} requests`),
    tile("firmware", dev.fw ? `v${dev.fw}` : "–", [st?.slot != null ? `slot ${st.slot}` : null, st?.boot_n != null ? `boot #${st.boot_n}` : null].filter(Boolean).join(" · ") || null),
    tile("uptime", st?.up_s != null ? dur(st.up_s * 1000) : "–", st?.reset ? `last reset: ${st.reset}` : null, st?.reset && ["panic", "int_wdt", "task_wdt", "wdt", "brownout"].includes(st.reset)),
    tile("wi-fi", st?.rssi != null ? `${st.rssi} dBm` : "–", hl ? `connect ${hl.connect_avg_ms ?? "?"} ms avg · ${hl.wifi_fail_24h} fails/24h` : st?.connect_ms != null ? `connect ${st.connect_ms} ms` : null, (hl?.wifi_fail_24h ?? 0) >= 3),
    tile("awake", pctS(hl?.duty_24h ?? hl?.duty_last), hl ? `${dur(hl.awake_ms_24h)} awake in 24 h` : "duty cycle"),
    tile("memory", kb(st?.heap), st?.heap_min != null ? `low-water ${kb(st.heap_min)}` : null),
    tile("queue", st ? `${st.q ?? 0} clip${st.q === 1 ? "" : "s"}` : "–", `${dev.pending ?? st?.pending ?? 0} result${(dev.pending ?? st?.pending ?? 0) === 1 ? "" : "s"} pending`),
  ));
  if (st?.stats && Object.keys(st.stats).length) {
    const s = st.stats;
    body.append(h("p", { class: "mono muted", style: { fontSize: "12px", margin: "10px 0 0" } },
      `since boot: ${s.clips ?? 0} clips · ${s.uploads ?? 0} uploads (${s.upload_fail ?? 0} failed) · ${s.results ?? 0} results · ${s.too_short ?? 0} too short · ${s.dups ?? 0} dups · ${s.quarantined ?? 0} set aside · ${s.epd_timeouts ?? 0} display timeouts · ${s.check_fail ?? 0} failed checks`));
  }

  // battery chart
  body.append(h("h3", null, "Battery"));
  const series = data?.series ?? [];
  if (series.length < 2) body.append(h("p", { class: "muted" }, "Not enough battery readings yet (one is kept every 5 minutes while the device talks to the server)."));
  else {
    const c = h("canvas", { class: "chart", role: "img", "aria-label": `Battery voltage over time, ${series.length} readings` });
    body.append(c, h("div", { class: "chart-legend" }, h("span", null, h("i"), "voltage"), h("span", null, h("i", { class: "usb" }), "on USB"), tr?.days_left != null ? h("span", null, "- - - projection to empty") : null));
    requestAnimationFrame(() => drawChart(c, series, tr));
  }

  // logs + events
  body.append(h("h3", null, "Crashes, restarts & logs"));
  body.append(h("div", { class: "row", style: { marginBottom: "12px" } },
    h("button", { class: dev.want_log ? "btn" : "btn primary", type: "button", onclick: () => requestLog(!dev.want_log) }, ic("log"), dev.want_log ? "cancel log request" : "request logs"),
    h("span", { class: "muted", style: { fontSize: "14px", flex: "1 1 200px" } }, dev.want_log ? "asked: the device attaches its last 40 log lines to the report after its next Wi-Fi session." : "the device sends its recent log with the next report after this.")));
  if (!events.length) body.append(h("p", { class: "muted" }, "nothing yet. no news is good news."));
  else body.append(h("ul", { class: "timeline" }, events.map((e) => {
    const id = `${e.at}-${e.kind}`;
    return h("li", { class: e.kind }, h("div", { class: "ev" }, ic(e.kind === "crash" ? "alert" : e.kind === "log" ? "log" : e.kind === "firmware" ? "power" : "redo"), h("b", null, e.kind), h("span", null, e.text),
      h("span", { class: "mono" }, `${fmtT(e.at)}${e.fw ? ` · v${e.fw}` : ""}${e.boot_n != null ? ` · boot #${e.boot_n}` : ""}`)),
      e.log ? h("details", { "data-ev": id, open: openLogs.has(id) || null }, h("summary", { class: "mono", style: { padding: "0 10px 8px", cursor: "pointer", fontSize: "12px" } }, `${e.log.length} log lines`),
        h("pre", { class: "loglines" }, e.log.join("\n"))) : null);
  })));

  // reports table
  const reps = data?.reports ?? [];
  if (reps.length) {
    body.append(h("h3", null, "Recent reports"));
    const cols = [["time", (r) => fmtT(r.at)], ["batt", (r) => (r.batt_mv ? `${(r.batt_mv / 1000).toFixed(2)}V` : "–")], ["usb", (r) => (r.usb ? "yes" : "no")], ["rssi", (r) => r.rssi ?? "–"],
      ["conn", (r) => (r.connect_ms != null ? `${r.connect_ms}ms` : "–")], ["awake", (r) => (r.awake_ms != null ? dur(r.awake_ms) : "–")], ["sleep", (r) => (r.sleep_ms != null ? dur(r.sleep_ms) : "–")],
      ["q", (r) => r.q ?? "–"], ["heap", (r) => kb(r.heap)], ["reset", (r) => r.reset ?? "–"], ["boot", (r) => r.boot_n ?? "–"], ["wifi fail", (r) => r.stats?.wifi_fail ?? 0]];
    body.append(h("div", { class: "rtable-wrap" }, h("table", { class: "rtable" }, h("thead", null, h("tr", null, cols.map(([c]) => h("th", { scope: "col" }, c)))),
      h("tbody", null, reps.slice(0, 30).map((r) => h("tr", null, cols.map(([c, f]) => h("td", { class: c === "reset" && ["panic", "int_wdt", "task_wdt", "wdt", "brownout"].includes(r.reset) ? "bad" : "" }, String(f(r))))))))));
  }
  host.scrollTop = scroll;
}

function says(mood, text, bad = false) {
  const c = h("canvas", { class: "px", "aria-hidden": "true" });
  const b = new B(96, 70); boxBot(b, 12, 18, 72, 50, MOODS[mood] ?? MOODS.awake, 0);
  requestAnimationFrame(() => paintCrisp(c, b, 96, cssVar(bad ? "--red" : "--ink")));
  return h("div", { class: `bolt-says${bad ? " bad" : ""}` }, c, h("p", null, text));
}

async function requestLog(on) {
  try { await api(`api/device/${encodeURIComponent(devKey)}/request-log`, { method: "POST", body: { on } }); toast(on ? "ok! I'll send my log next time I'm online." : "never mind then."); }
  catch (e) { toast(`couldn't ask: ${e.message}`, { bad: true }); }
}

/** 1-bit battery chart: voltage line, USB stretches dithered, projection dashed, 5x7 labels. */
function drawChart(canvas, series, trend) {
  const cssW = Math.max(240, canvas.parentElement.clientWidth - 4);
  const W = Math.floor(cssW / 2), H = 96, L = 26, R = W - 4, T = 6, Bt = H - 14;
  const b = new B(W, H);
  const t0 = series[0][0], now = Date.now();
  const t1 = Math.max(series[series.length - 1][0], now - 60_000);
  const proj = trend?.days_left != null && trend.days_left < 30 ? Math.min(t1 + trend.days_left * 86400_000, t1 + (t1 - t0) * 0.6) : null;
  const tEnd = proj ?? t1;
  const lo = 3300, hi = 4250;
  const X = (t) => L + Math.round(((t - t0) / Math.max(1, tEnd - t0)) * (R - L));
  const Y = (mv) => T + Math.round(((hi - Math.max(lo, Math.min(hi, mv))) / (hi - lo)) * (Bt - T));
  for (const v of [3400, 3600, 3800, 4000, 4200]) { const y = Y(v); for (let x = L; x <= R; x += 3) b.px(x, y); b.text((v / 1000).toFixed(1), 1, y - 3, 1); }
  b.rect(L, T, 1, Bt - T + 1); b.rect(L, Bt, R - L + 1, 1);
  // USB stretches: dithered band along the bottom
  for (let i = 0; i < series.length - 1; i++) if (series[i][2]) { const x0 = X(series[i][0]), x1 = X(series[i + 1][0]); for (let x = x0; x <= x1; x++) for (let y = Bt - 6; y < Bt; y++) if ((x + y) % 2 === 0) b.px(x, y); }
  // voltage line (2 px)
  for (let i = 0; i < series.length - 1; i++) b.line(X(series[i][0]), Y(series[i][1]), X(series[i + 1][0]), Y(series[i + 1][1]), 2);
  const last = series[series.length - 1];
  b.circle(X(last[0]), Y(last[1]), 2.5);
  if (proj) { // dashed projection to 3.3 V
    const x0 = X(last[0]), y0 = Y(last[1]), x1 = X(proj), y1 = Y(lo);
    const n = Math.max(1, Math.abs(x1 - x0));
    for (let k = 0; k <= n; k++) if (Math.floor(k / 3) % 2 === 0) b.rect(Math.round(x0 + ((x1 - x0) * k) / n), Math.round(y0 + ((y1 - y0) * k) / n), 1, 1);
  }
  // x labels
  const span = tEnd - t0, fmt = (t) => { const d = new Date(t); return span > 2 * 86400_000 ? `${d.getMonth() + 1}-${d.getDate()}` : `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`; };
  const a = fmt(t0), z = fmt(tEnd);
  b.text(a, L, Bt + 4, 1); b.text(z, R - tw(z, 1), Bt + 4, 1);
  if (R - L > 120) { const m = fmt((t0 + tEnd) / 2); b.text(m, Math.round((L + R) / 2 - tw(m, 1) / 2), Bt + 4, 1); }
  paint2x(canvas, b);
}
function paint2x(canvas, b) {
  paintCrisp(canvas, b, b.w * 2, cssVar("--ink"));
}
