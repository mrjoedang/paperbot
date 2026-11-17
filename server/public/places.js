// The Wi-Fi page of Settings (settings.js): the networks paperbot knows, synced to the device (GET /v1/wifi).
// Passwords never come back from the server; they can only be replaced.
import { h, ic, api, toast } from "./dom.js";
import { parseWifiQR } from "./wifiqr.js";

let S0 = null, form = null, scanner = null, again = () => {};
document.addEventListener('pointerdown',event=>{
  for(const menu of document.querySelectorAll('.places-network-menu[open]')) if(!menu.contains(event.target)) menu.open=false;
});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape') for(const menu of document.querySelectorAll('.places-network-menu[open]')) {menu.open=false;menu.querySelector('summary').focus();event.stopPropagation();}
});
const bytes = (s) => new TextEncoder().encode(s).length;
// Every change re-renders the whole Settings page, which calls renderWifi again.
const render = () => again();

/** Draw the Wi-Fi page into body. rerender redraws the Settings page; an open form survives it. */
export function renderWifi(S, body, rerender) {
  S0 = S; again = rerender;
  const w = S.wifi;
  if (!w) { body.replaceChildren(h("p", { class: "muted" }, "loading…")); return; }
  if (form) {
    const formEl = body.querySelector(".form");
    const back = h('button',{type:'button',class:'places-back',onclick:()=>{stopScan();form=null;render();}},'← Networks');
    if(formEl) {
      body.replaceChildren(back,formEl);
      if(scanner && !formEl.contains(scanner.video)) formEl.querySelector('.scan-slot')?.replaceChildren(scanView());
    }
    else body.replaceChildren(back,formView(body));
    return;
  }
  const add = h('button',{type:'button',class:'btn primary places-add',disabled:w.networks.length>=w.max||null,onclick:()=>{
    form={mode:'add',v:{ssid:'',psk:'',name:'',note:'',open:false,fallback:false}};render();body.scrollTop=0;body.querySelector('input')?.focus();
  }},...(w.networks.length>=w.max?[`Full (${w.max} of ${w.max})`]:[h('span',{'aria-hidden':'true'},'+'),'Add network']));
  body.replaceChildren(w.networks.length
    ? h('section',{class:'acct-group'},h('div',{class:'places-intro'},syncCard(w)),netList(w),add)
    : h('section',{class:'empty-state'},wifiArt(),h('strong',null,'No networks yet'),h('p',null,'Add the Wi-Fi networks paperbot should join.'),add));
}

/** Leaving the page or closing Settings: stop the camera, drop a half-filled form. */
export function closeWifi() { stopScan(); form = null; }

// The Wi-Fi page's empty state: paperbot with its signal, drawn in the icons' line (currentColor).
function wifiArt() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 120 96', width: 120, height: 96, class: 'empty-art', 'aria-hidden': 'true', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) svg.setAttribute(k, v);
  svg.innerHTML = '<rect x="42" y="40" width="36" height="50" rx="9" class="fill"/><rect x="49" y="48" width="22" height="16" rx="3"/><path d="M57 77h6"/>'
    + '<path d="M44 22a24 24 0 0 1 32 0" class="soft"/><path d="M36 13a36 36 0 0 1 48 0" class="faint"/><path d="M52 30a12 12 0 0 1 16 0"/>';
  return svg;
}

function syncCard(w) {
  const dev=S0?.devices?.[0];
  const synced=dev?.wifi_rev!=null && dev.wifi_rev>=w.rev;
  return h('span',{class:`places-sync${synced?' synced':''}`,role:'status'},ic(synced?'check':'redo',14),synced?'Up to date':'Sync pending');
}
function netList(w) {
  const nets=w.networks, normal=nets.filter(n=>!n.fallback);
  if(!nets.length) return null;
  return h('ul',{class:'places-networks'},nets.map(n=>{
    const i=normal.indexOf(n),label=n.name||n.ssid;
    const action=(text,run,disabled=false)=>h('button',{type:'button',disabled:disabled||null,onclick:event=>{event.currentTarget.closest('details').open=false;run();}},text);
    const menu=h('details',{class:'places-network-menu'},h('summary',{'aria-label':`Options for ${label}`},'•••'),
      h('div',{class:'places-network-options'},
        action(n.has_psk?'Change password':'Add password',()=>edit(n,'psk'),n.open),
        action('Move up',()=>reorder(normal,i,-1),n.fallback||i<=0),
        action('Move down',()=>reorder(normal,i,1),n.fallback||i>=normal.length-1),
        action(n.fallback?'Use as preferred network':'Use as backup network',()=>save(n.id,{fallback:!n.fallback},'Network updated')),
        action('Remove network',()=>remove(n))));
    menu.addEventListener('toggle',()=>{if(menu.open) for(const other of document.querySelectorAll('.places-network-menu[open]'))if(other!==menu)other.open=false;});
    return h('li',{class:'places-network'},
      h('button',{type:'button',class:'places-network-main',onclick:()=>edit(n,'edit')},
        h('span',{class:'places-network-icon'},ic('wifi',20)),h('span',{class:'places-network-copy'},h('strong',null,label),
          n.name && n.name!==n.ssid?h('span',null,n.ssid):null,
          h('small',{class:n.needs_psk?'places-needs-password':''},n.needs_psk?'Password needed':n.fallback?'Backup network':`Priority ${i+1}`))),menu);
  }));
}

function edit(n, mode) {
  form = mode === "psk" ? { mode: "psk", id: n.id, ssid: n.ssid, v: { psk: "", open: false } }
    : { mode: "edit", id: n.id, v: { ssid: n.ssid, name: n.name, note: n.note } };
  render();
  document.querySelector(".form input")?.focus();
}

function field(label, input, help) { return h("div", { class: "field" }, h("label", { for: input.id }, label), input, help ?? null); }
function formView(body) {
  const f = form, v = f.v;
  const el = h("form", { class: "form", novalidate: true, "aria-label": f.mode === "add" ? "Add a network" : "Edit network" });
  const kids = [h('h3',{class:'places-form-title'},f.mode==='add'?'Add network':f.mode==='psk'?'Change password':'Edit network')];
  if (f.mode === "psk") kids.push(h("p", { style: { margin: 0 } }, "password for ", h("b", null, f.ssid)));
  let ssidHelp, pskHelp;
  if (f.mode !== "psk") {
    const ssid = h("input", { id: "f-ssid", type: "text", value: v.ssid, autocomplete: "off", autocapitalize: "none", spellcheck: "false", required: true, "aria-describedby": "f-ssid-h" });
    ssidHelp = h("div", { class: "help", id: "f-ssid-h" }, h("span", null, "Enter the name exactly as shown in Wi-Fi settings."), h("span", { class: "mono" }));
    const upd = () => { v.ssid = ssid.value; const n = bytes(ssid.value); ssidHelp.lastChild.textContent = `${n}/32 bytes`; ssidHelp.classList.toggle("bad", n > 32); };
    ssid.addEventListener("input", upd); upd();
    kids.push(field("Network name", ssid, ssidHelp));
  }
  if (f.mode !== "edit") {
    const pw = h("input", { id: "f-psk", type: "password", value: v.psk, autocomplete: "off", autocapitalize: "none", spellcheck: "false", "aria-describedby": "f-psk-h", disabled: v.open || null });
    const eye = h("button", { type: "button", "aria-pressed": "false", "aria-label": "Show password", onclick: () => { const show = pw.type === "password"; pw.type = show ? "text" : "password"; eye.textContent = show ? "hide" : "show"; eye.setAttribute("aria-pressed", String(show)); } }, "show");
    pskHelp = h("div", { class: "help", id: "f-psk-h" }, h("span", null, "8–63 characters"), h("span", { class: "mono" }));
    const upd = () => { v.psk = pw.value; pskHelp.lastChild.textContent = pw.value ? `${pw.value.length} chars` : ""; pskHelp.classList.toggle("bad", !!pw.value && (pw.value.length < 8 || pw.value.length > 63)); };
    pw.addEventListener("input", upd); upd();
    const openBox = h("input", { type: "checkbox", id: "f-open", checked: v.open || null, onchange: (e) => { v.open = e.target.checked; pw.disabled = v.open; if (v.open) { pw.value = ""; v.psk = ""; } } });
    kids.push(h("div", { class: "field" }, h("label", { for: "f-psk" }, "Password"), h("div", { class: "pw" }, pw, eye), pskHelp),
      h("label", { class: "check-row" }, openBox, "No password required"));
  }
  if (f.mode !== "psk") {
    const name = h("input", { id: "f-name", type: "text", value: v.name ?? "", maxlength: "40", placeholder: "e.g. Home, Office, Mom's" });
    name.addEventListener("input", () => (v.name = name.value));
    const note = h("input", { id: "f-note", type: "text", value: v.note ?? "", maxlength: "120", placeholder: "optional" });
    note.addEventListener("input", () => (v.note = note.value));
    const options=h('details',{class:'places-form-options'},h('summary',null,'More options'),field('Nickname (optional)',name),field('Note (optional)',note));
    kids.push(options);
    if (f.mode === "add") options.append(h("label", { class: "check-row" }, h("input", { type: "checkbox", checked: v.fallback || null, onchange: (e) => (v.fallback = e.target.checked) }), "Use as backup network"));
  }
  if (f.mode === "add") kids.push(h("div", { class: "scan-slot" }, scanner ? scanView() : h("div", { class: "row" },
    h("button", { class: "btn", type: "button", onclick: () => startScan() }, ic("search"), "Scan Wi-Fi QR"),
    h("label", { class: "btn", style: { cursor: "pointer" } }, "Choose QR photo", h("input", { type: "file", accept: "image/*", class: "sr-only", onchange: (e) => decodeFile(e.target.files?.[0]) })))));
  const err = h("p", { class: "err", role: "alert", style: { margin: 0 } });
  kids.push(err, h("div", { class: "row" },
    h("button", { class: "btn primary", type: "submit" }, f.mode === "add" ? "Add network" : f.mode === "psk" ? "Save password" : "Save changes"),
    h("button", { class: "btn", type: "button", onclick: () => { stopScan(); form = null; render(); } }, "Cancel")));
  el.append(...kids);
  el.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    const problem = check(f);
    if (problem) { err.textContent = problem; return; }
    const payload = (f.mode === "psk" || (f.mode === "add" && (S0?.wifi?.networks ?? []).some((n) => n.ssid === v.ssid))) ? (v.open ? { open: true } : { psk: v.psk, open: false })
      : f.mode === "edit" ? { ssid: v.ssid, name: v.name ?? "", note: v.note ?? "" }
      : { ssid: v.ssid, psk: v.open ? "" : v.psk, open: !!v.open, name: v.name ?? "", note: v.note ?? "", fallback: !!v.fallback };
    const dup = f.mode === "add" ? (S0?.wifi?.networks ?? []).find((n) => n.ssid === v.ssid) : null;
    if (dup && (v.psk || v.open)) { f.mode = "psk"; f.id = dup.id; }
    try {
      const w = f.mode === "add" ? await api("api/wifi", { method: "POST", body: payload }) : await api(`api/wifi/${encodeURIComponent(f.id)}`, { method: "PATCH", body: payload });
      S0.wifi = w; stopScan(); form = null; render();
      toast(f.mode === "add" ? "Network added" : "Changes saved");
    } catch (x) { err.textContent = x.message; }
  });
  return el;
}
function check(f) {
  const v = f.v;
  if (f.mode !== "psk") { if (!v.ssid) return "the network name is missing"; if (bytes(v.ssid) > 32) return `that name is ${bytes(v.ssid)} bytes; Wi-Fi allows 32`; }
  if (f.mode !== "edit" && !v.open) {
    if (!v.psk && f.mode === "psk") return "type the password (or tick “open network”)";
    if (v.psk && (v.psk.length < 8 || v.psk.length > 63)) return "WPA passwords are 8–63 characters";
    if (v.psk && !/^[\x20-\x7e]*$/.test(v.psk)) return "the password has characters Wi-Fi passphrases can't use";
  }
  return null;
}

async function save(id, body, msg) {
  try { S0.wifi = await api(`api/wifi/${encodeURIComponent(id)}`, { method: "PATCH", body }); render(); if (msg) toast(msg); }
  catch (e) { toast(e.message, { bad: true }); }
}
async function reorder(normal, i, d) {
  const ids = normal.map((n) => n.id);
  [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
  try { S0.wifi = await api("api/wifi/order", { method: "POST", body: { ids } }); render(); }
  catch (e) { toast(e.message, { bad: true }); }
}
async function remove(n) {
  if (!confirm(`Forget “${n.name || n.ssid}”? paperbot drops it the next time it syncs.`)) return;
  try { S0.wifi = await api(`api/wifi/${encodeURIComponent(n.id)}`, { method: "DELETE" }); render(); toast("forgotten."); }
  catch (e) { toast(e.message, { bad: true }); }
}

// ---------- QR scanning: BarcodeDetector when available, jsQR (vendored, Apache-2.0) otherwise ----------
function scanView() {
  return h("div", { class: "scan" }, scanner.video, h("div", { class: "reticle" }), scanner.msg);
}
async function startScan() {
  if (scanner) return;
  if (!navigator.mediaDevices?.getUserMedia) { toast("no camera here: try “photo of a QR”", { bad: true }); return; }
  const video = h("video", { playsinline: true, muted: true, autoplay: true, "aria-label": "Camera preview" });
  scanner = { video, msg: h("p", null, "point the camera at the Wi-Fi QR code…"), stream: null, timer: 0 };
  render();
  try {
    scanner.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    video.srcObject = scanner.stream; await video.play();
  } catch (e) { stopScan(); toast(`camera unavailable (${e.name ?? e.message}). try “photo of a QR”`, { bad: true }); render(); return; }
  const detect = await detector();
  const cv = document.createElement("canvas"), g = cv.getContext("2d", { willReadFrequently: true });
  const tick = async () => {
    if (!scanner) return;
    try {
      let text = null;
      if (detect.native) { const r = await detect.native.detect(video); text = r[0]?.rawValue ?? null; }
      else if (video.videoWidth) {
        cv.width = video.videoWidth; cv.height = video.videoHeight; g.drawImage(video, 0, 0);
        text = detect.js(g.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height)?.data ?? null;
      }
      if (text && found(text)) return;
    } catch {}
    scanner && (scanner.timer = setTimeout(tick, 180));
  };
  tick();
}
function stopScan() { if (!scanner) return; clearTimeout(scanner.timer); scanner.stream?.getTracks().forEach((t) => t.stop()); scanner = null; }
async function detector() {
  if ("BarcodeDetector" in window) { try { if ((await BarcodeDetector.getSupportedFormats()).includes("qr_code")) return { native: new BarcodeDetector({ formats: ["qr_code"] }) }; } catch {} }
  if (!window.jsQR) await new Promise((res, rej) => { const s = document.createElement("script"); s.src = new URL("./vendor/jsQR.js", import.meta.url).href; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
  return { js: (d, w, hh) => window.jsQR(d, w, hh, { inversionAttempts: "attemptBoth" }) };
}
async function decodeFile(file) {
  if (!file) return;
  try {
    const bmp = await createImageBitmap(file);
    const cv = document.createElement("canvas"), sc = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    cv.width = Math.round(bmp.width * sc); cv.height = Math.round(bmp.height * sc);
    const g = cv.getContext("2d"); g.drawImage(bmp, 0, 0, cv.width, cv.height);
    const d = await detector();
    const text = d.native ? (await d.native.detect(cv))[0]?.rawValue : d.js(g.getImageData(0, 0, cv.width, cv.height).data, cv.width, cv.height)?.data;
    if (!text) { toast("couldn't find a QR code in that photo", { bad: true }); return; }
    found(text);
  } catch (e) { toast(`couldn't read that image (${e.message})`, { bad: true }); }
}
function found(text) {
  const q = parseWifiQR(text);
  if (!q) { if (scanner) scanner.msg.textContent = "that's a QR code, but not a Wi-Fi one. keep looking…"; else toast("that's not a Wi-Fi QR code", { bad: true }); return false; }
  stopScan();
  const known = (S0?.wifi?.networks ?? []).find((n) => n.ssid === q.ssid); // exact bytes: ’ and ' are different networks
  form = known ? { mode: "psk", id: known.id, ssid: known.ssid, v: { psk: q.psk, open: q.type === "nopass" } }
    : { mode: "add", v: { ssid: q.ssid, psk: q.psk, open: q.type === "nopass", name: form?.v?.name || "", note: form?.v?.note || "", fallback: !!form?.v?.fallback } };
  const body = document.getElementById("drawer-body");
  body.querySelector(".form")?.remove();
  render();
  toast(known ? `“${known.name || q.ssid}” is already on the list: saving updates its password.` : `found “${q.ssid}”. check it and save.`);
  return true;
}
