// Formatting helpers (pure; unit-tested with node --test).

const pad = (n) => String(n).padStart(2, "0");
const DAY = 86400_000;
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
export const hhmm = (d) => `${d.getHours()}:${pad(d.getMinutes())}`;

/** "just now", "5m ago", "3h ago", "yesterday", "Mon", "Oct 3" */
export function ago(t, now = Date.now()) {
  const s = Math.round((now - t) / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  const d = new Date(t);
  if (startOfDay(t) === startOfDay(now)) return `${Math.floor(s / 3600)}h ago`;
  if (startOfDay(t) === startOfDay(now - DAY)) return `yesterday ${hhmm(d)}`;
  if (now - t < 6 * DAY) return `${WD[d.getDay()]} ${hhmm(d)}`;
  return `${MON[d.getMonth()]} ${d.getDate()}`;
}

/** Parse a local ISO due ("2026-10-18" or "2026-10-18T09:00"). */
export function parseDue(due) {
  const m = String(due ?? "").match(/^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d))?/);
  if (!m) return null;
  const hasTime = m[4] != null;
  return { at: new Date(+m[1], +m[2] - 1, +m[3], hasTime ? +m[4] : 23, hasTime ? +m[5] : 59).getTime(), hasTime, day: new Date(+m[1], +m[2] - 1, +m[3]).getTime() };
}

/** Friendly due: {text, overdue, soon}. "today 15:00", "tomorrow 9:00", "Fri 9:00", "Oct 25", "overdue · yesterday". */
export function dueInfo(due, now = Date.now()) {
  const p = parseDue(due);
  if (!p) return null;
  const d = new Date(p.at), today = startOfDay(now), diff = Math.round((p.day - today) / DAY);
  const time = p.hasTime ? ` ${hhmm(d)}` : "";
  let text;
  if (diff === 0) text = `today${time}`;
  else if (diff === 1) text = `tomorrow${time}`;
  else if (diff === -1) text = `yesterday${time}`;
  else if (diff > 1 && diff < 7) text = `${WD[d.getDay()]}${time}`;
  else text = `${MON[d.getMonth()]} ${d.getDate()}${time}${d.getFullYear() !== new Date(now).getFullYear() ? " " + d.getFullYear() : ""}`;
  const overdue = p.at < now;
  return { text, overdue, soon: !overdue && p.at - now < 3 * 3600_000 };
}

export const usd = (v) => (v == null ? "–" : v < 0.01 && v > 0 ? `$${v.toFixed(4)}` : `$${v.toFixed(v < 1 ? 3 : 2)}`);
export function dur(ms) {
  if (ms == null || !isFinite(ms)) return "–";
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${pad(s % 60)}s` : `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
}
export const clock = (sec) => `${Math.floor(sec / 60)}:${pad(Math.floor(sec % 60))}`;
