// Small, safe Markdown -> HTML for agent reports (untrusted text).
// Everything is HTML-escaped FIRST; only tags generated here are emitted. Links: http(s) only.

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const SAFE_URL = /^https?:\/\/[^\s<>"'`]+$/i;

/** Inline Markdown on raw (unescaped) text. Returns HTML. */
export function inline(raw) {
  const slots = [];
  const put = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let s = String(raw ?? "").replace(/\u0000/g, "");
  // code spans first (their content is literal)
  s = s.replace(/`([^`\n]+)`/g, (_, c) => put(`<code>${esc(c)}</code>`));
  // [text](url)
  s = s.replace(/\[([^\]\n]{1,300})\]\(\s*<?([^)\s>]+)>?\s*\)/g, (m, text, url) =>
    SAFE_URL.test(url) ? put(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer nofollow">${inlineText(text)}</a>`) : put(esc(text)));
  // bare URLs
  s = s.replace(/https?:\/\/[^\s<>"'`)\]\u0000]+/g, (u) => {
    const trail = u.match(/[.,;:!?]+$/)?.[0] ?? "";
    const url = trail ? u.slice(0, -trail.length) : u;
    return put(`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer nofollow">${esc(shortUrl(url))}</a>`) + trail;
  });
  // citation-guard markers
  s = s.replace(/\[unverified\]/gi, () => put('<span class="badge unv" title="cited but not actually read by the agent">? unverified</span>'));
  return inlineText(s, slots);
}
function inlineText(s, slots = []) {
  let h = esc(s);
  h = h.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  h = h.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>").replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  h = h.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  return h.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[+i] ?? "");
}
export function shortUrl(u) {
  try { const x = new URL(u); const p = x.pathname.length > 28 ? x.pathname.slice(0, 27) + "…" : x.pathname; return x.hostname.replace(/^www\./, "") + (p === "/" ? "" : p); }
  catch { return u; }
}

/** Block-level Markdown: headings, lists, quotes, code fences, tables, rules, paragraphs. */
export function renderMarkdown(src) {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").replace(/\u0000/g, "").split("\n");
  const out = [];
  let i = 0;
  const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
  const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i++; continue; }
    let m;
    if ((m = l.match(/^\s*```\s*([\w-]*)/))) {
      const buf = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    if ((m = l.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/))) {
      const n = Math.min(6, m[1].length + 2); // report h1 -> h3 (cards already have titles)
      out.push(`<h${n}>${inline(m[2])}</h${n}>`); i++; continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
    if (/^\s*>/.test(l)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${renderMarkdown(buf.join("\n"))}</blockquote>`);
      continue;
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(l)) {
      const ordered = /^\s*\d+[.)]/.test(l);
      const items = [];
      while (i < lines.length && (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (/^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ""));
        else items[items.length - 1] += " " + lines[i].trim();
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((t) => {
        const task = t.match(/^\[([ xX])\]\s+(.*)$/);
        return task ? `<li class="task">${task[1] === " " ? "☐" : "☑"} ${inline(task[2])}</li>` : `<li>${inline(t)}</li>`;
      }).join("")}</${tag}>`);
      continue;
    }
    if (l.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(l); i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      out.push(`<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${
        rows.map((r) => `<tr>${head.map((_, k) => `<td>${inline(r[k] ?? "")}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|#{1,6}\s|>|[-*+]\s|\d+[.)]\s)/.test(lines[i])) buf.push(lines[i++].trim());
    if (!buf.length) { buf.push(lines[i++].trim()); }
    out.push(`<p>${buf.map(inline).join("<br>")}</p>`);
  }
  return out.join("\n");
}
