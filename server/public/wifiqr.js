// Wi-Fi QR codes: WIFI:S:<ssid>;T:<WPA|WEP|nopass>;P:<pass>;H:<true|false>;;
// Special characters \ ; , : " are backslash-escaped. Fields may come in any order.

/** Parse a WIFI: payload. Returns {ssid, type, psk, hidden} or null when it is not a Wi-Fi code. */
export function parseWifiQR(text) {
  const s = String(text ?? "");
  if (!/^WIFI:/i.test(s)) return null;
  const fields = {};
  let i = 5, key = "", val = "", inKey = true;
  const flush = () => { if (key) fields[key.toUpperCase()] = val; key = ""; val = ""; inKey = true; };
  while (i < s.length) {
    const c = s[i];
    if (c === "\\" && i + 1 < s.length) { (inKey ? (key += s[i + 1]) : (val += s[i + 1])); i += 2; continue; }
    if (inKey && c === ":") { inKey = false; i++; continue; }
    if (c === ";") { flush(); i++; continue; }
    if (inKey) key += c; else val += c;
    i++;
  }
  flush();
  if (fields.S == null) return null;
  let ssid = fields.S;
  // Some generators hex-encode or quote SSIDs: "My Net" -> My Net
  if (/^".*"$/.test(ssid) && ssid.length >= 2) ssid = ssid.slice(1, -1);
  const t = (fields.T ?? "").toUpperCase();
  const type = t === "" || t === "NOPASS" ? (fields.P ? "WPA" : "nopass") : t;
  let psk = type === "nopass" ? "" : fields.P ?? "";
  if (/^".*"$/.test(psk) && psk.length >= 2) psk = psk.slice(1, -1);
  return { ssid, type, psk, hidden: /^true$/i.test(fields.H ?? "") };
}

/** Build a WIFI: payload (for tests / sharing). */
export function wifiQR({ ssid, type = "WPA", psk = "", hidden = false }) {
  const e = (v) => String(v).replace(/([\\;,:"])/g, "\\$1");
  return `WIFI:T:${type};S:${e(ssid)};${psk ? `P:${e(psk)};` : ""}${hidden ? "H:true;" : ""};`;
}
