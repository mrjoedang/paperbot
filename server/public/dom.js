// Tiny DOM helpers. Untrusted strings only ever go through textContent (h() children) — never innerHTML.
import { iconSVG } from "./icons.js";

export const BASE = new URL(".", location.href).pathname; // "/" in production, "/admin/app/" on the test mount

/** h("div", {class: "x", onclick: fn}, "text", child, [more]) */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  add(el, kids);
  return el;
}
function add(el, kids) {
  for (const k of kids) {
    if (k == null || k === false) continue;
    if (Array.isArray(k)) add(el, k);
    else if (k instanceof Node) el.appendChild(k);
    else el.appendChild(document.createTextNode(String(k)));
  }
}
export const ic = (name, size = 16, title = "") => iconSVG(name, size, title);

let writes = 0;
export const pendingWrites = () => writes > 0;
export async function api(path, opts = {}) {
  const writing = !["GET", "HEAD"].includes((opts.method ?? "GET").toUpperCase());
  if (writing) writes++;
  try {
    const init = { method: opts.method ?? "GET", headers: {}, credentials: "same-origin" };
    if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers["content-type"] = "application/json"; }
    const res = await fetch(BASE + path.replace(/^\//, ""), init);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
    if (!res.ok) { const e = new Error(data?.error ?? `HTTP ${res.status}`); e.status = res.status; throw e; }
    return data;
  } finally { if (writing) writes--; }
}

export const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
export const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** toast("archived", {action: "undo", onAction}) */
export function toast(msg, opts = {}) {
  const box = document.getElementById("toasts");
  const t = h("div", { class: `toast${opts.bad ? " bad" : ""}` },
    h("span", { class: "toast-icon", "aria-hidden": "true" }, ic(opts.bad ? "alert" : "check", 18)),
    h("span", { class: "toast-message" }, msg),
    opts.action ? h("button", { type: "button", onclick: () => { opts.onAction?.(); t.remove(); } }, opts.action === "undo" ? "Undo" : opts.action) : null);
  box.appendChild(t);
  while (box.children.length > 1) box.firstChild.remove();
  setTimeout(() => t.remove(), opts.ms ?? (opts.action ? 6000 : 3500));
  return t;
}

// ---------- drawer (dialog) ----------
let lastFocus = null, onCloseCb = null;
export function openDrawer(title, build, { hash, onClose } = {}) {
  const d = document.getElementById("drawer"), body = document.getElementById("drawer-body");
  if (d.hidden) lastFocus = document.activeElement;
  onCloseCb?.();
  onCloseCb = onClose ?? null;
  document.getElementById("drawer-title").textContent = title;
  body.replaceChildren();
  build(body);
  d.hidden = false;
  document.body.style.overflow = "hidden";
  d.querySelector(".drawer-card").focus();
  if (hash && location.hash !== `#${hash}`) history.pushState(null, "", `#${hash}`);
}
export function closeDrawer(fromHash = false) {
  const d = document.getElementById("drawer");
  if (d.hidden) return;
  d.hidden = true;
  document.body.style.overflow = "";
  onCloseCb?.(); onCloseCb = null;
  if (!fromHash && location.hash) history.pushState(null, "", location.pathname + location.search);
  lastFocus?.focus?.();
}
export const drawerOpen = () => !document.getElementById("drawer").hidden;
export function initDrawer() {
  const d = document.getElementById("drawer");
  d.querySelector(".drawer-h [data-close]").appendChild(ic("close", 16));
  d.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) closeDrawer(); });
  d.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); closeDrawer(); }
    if (e.key !== "Tab") return;
    const f = [...d.querySelectorAll("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter((x) => !x.disabled && x.offsetParent);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  });
}

/** Paint a 1-bit bitmap crisply into a canvas at a CSS width ≤ maxCss. */
import { paint, crispScale } from "./bolt.js";
export function paintCrisp(canvas, b, maxCss, ink, paper = null) {
  paint(canvas, b, ink, paper);
  const s = crispScale(b.w, maxCss);
  canvas.style.width = `${b.w * s}px`;
  canvas.style.height = `${b.h * s}px`;
}
