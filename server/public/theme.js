// The theme picked in the app (pv-theme), applied before the first paint: pages start light (<html data-theme="light">).
// A classic script in <head>, so the sign-in pages never flash light for someone who picked Dark.
try { const t = localStorage.getItem("pv-theme"); if (t === "dark") document.documentElement.dataset.theme = "dark"; else if (t === "system") delete document.documentElement.dataset.theme; } catch {}
