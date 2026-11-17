// OpenBelt for the e2e scripts (belt.mjs, site-shots.mjs): a workspace's MCP as the person, and the list app paperbot deploys.
//   --openbelt <workspace URL> and OPENBELT_TOKEN (or OPENBELT_TOKEN_FILE): a local OpenBelt (`bun run dev` in an OpenBelt
//   checkout prints both).
import { readFileSync } from "node:fs";

/** The workspace URL and token from the command line and environment; exits with how to set them when missing. */
export function openbeltArgs(args) {
  const i = args.indexOf("--openbelt");
  const url = (i >= 0 ? args[i + 1] ?? "" : "").replace(/\/$/, "");
  if (!url) { console.error("--openbelt <workspace URL> is required"); process.exit(2); }
  const token = (process.env.OPENBELT_TOKEN ?? readFileSync(process.env.OPENBELT_TOKEN_FILE ?? "/dev/null", "utf8")).trim();
  if (!token) { console.error("set OPENBELT_TOKEN or OPENBELT_TOKEN_FILE"); process.exit(2); }
  return { url, token };
}

/** A tool caller on <url>/mcp as the token's person (the same calls paperbot makes). Returns the parsed text answer. */
export function mcpClient(url, token, name = "e2e") {
  let session = null, id = 0;
  const post = async (payload) => {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}`, "mcp-protocol-version": "2025-06-18" };
    if (session) headers["mcp-session-id"] = session;
    const r = await fetch(`${url}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...payload }) });
    session = r.headers.get("mcp-session-id") ?? session;
    const t = await r.text();
    const line = t.trim().startsWith("{") ? t : t.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5)).findLast((l) => l.includes('"id"'));
    return line ? JSON.parse(line) : null;
  };
  return async (tool, args) => {
    if (!session) { await post({ id: ++id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name, version: "1" } } }); await post({ method: "notifications/initialized" }); }
    const m = await post({ id: ++id, method: "tools/call", params: { name: tool, arguments: args } });
    const text = (m?.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (m?.result?.isError || m?.error) throw new Error(`${tool}: ${text || JSON.stringify(m?.error)}`);
    try { return JSON.parse(text); } catch { return text; }
  };
}

/** Deploy paperbot's list app (server/src/inbox-app) and replace its items: [id, list, title, due, done]. */
export async function seedList(mcp, root, items) {
  const dir = `${root}/server/src/inbox-app`;
  await mcp("deploy_app", { app: "paperbot", files: [{ path: "index.html", content: readFileSync(`${dir}/index.html`, "utf8") }, { path: "openbelt.json", content: JSON.stringify(JSON.parse(readFileSync(`${dir}/openbelt.json`, "utf8")), null, 2) + "\n" }] });
  await mcp("collection_delete", { app: "paperbot", collection: "items", all: true });
  await mcp("collection_add", { app: "paperbot", collection: "items", docs: items.map(([id, list, title, due, done]) => ({ id, data: { list, title, due, done, memo: id } })) });
}
