#!/usr/bin/env python3
"""Local stand-in for the pocket-voice server's device API (stdlib only).

  python3 sim/mock_server.py [--port 8788] [--token sim-token] [--store DIR]

Implements the PLANNED async contract (docs/device-api.md) and, with {"mode":"sync"}, the
current production behaviour (server/src/index.ts: PUT returns the routed task, 200).

Device API (Bearer token required):
  PUT /v1/recordings/:id   WAV body. async: 202 {id,status:"processing"} once stored; a repeat PUT
                           of a known id returns the same record with "duplicate":true (202, with
                           the result fields when already finished). sync: 200 task JSON (legacy).
  GET /v1/recordings/:id   {id,status,kind,title,due,summary?,error?}; 404 if unknown (or for
                           not_found_ms after the PUT - eventual consistency)
  GET /v1/updates?ids=a,b  {"items":[<same objects>]} for the known ids (unknown ids omitted);
                           404 in sync mode or with updates_api=false (= older server)
  GET /v1/tasks            last 10 records (id, kind, title, due, status)

  status: processing -> done | researching -> done | paused_budget | stopped ; error
  kind:   note | todo | reminder | work | unsure | noise   (only work has the research phase)

Time: requests from the simulator carry X-Sim-Now-Ms (its virtual clock); all delays below are
in that time, so a 10-minute research takes 10 virtual minutes. Without the header: wall clock.

Control API (no auth; used by the simulator, tests and the browser UI):
  GET  /__mock/state       counters, per-id stats, recent records, config
  POST /__mock/reset       forget everything (config too)
  POST /__mock/config      JSON merged into the config:
     mode            "async" (default) | "sync" (legacy synchronous 200 replies)
     process_ms      transcription + routing time (default 1500 -> ready within the device's
                     ~6 s poll window; e.g. 20000 = "late", shown on a later wake)
     kind            force the routed kind; kinds = rotation list (default note,todo,reminder,work,unsure)
     research_ms     work items: time in "researching" (default 600000)
     work_outcome    done | stopped | paused_budget (default done)
     not_found_ms    GETs answer 404 for this long after the PUT (default 0)
     updates_api     false = no /v1/updates (device must fall back to per-id GETs)
     latency_ms      virtual latency of PUT replies (X-Sim-Latency-Ms header), get_latency_ms for GETs
     real_delay_ms   actually sleep before replying (interactive testing)
     script / always         behaviours for the next PUTs / every PUT:
                             {"status":500} {"malformed":true} {"status":200,"body":"{}"}
                             {"duplicate":true} {"drop":true} (stored, reply lost)
                             plus per-record overrides: kind, title, process_ms, research_ms, work_outcome
     get_script / get_always the same for GETs (both endpoints): {"status":500} {"status":404}
                             {"malformed":true} {"drop":true} {"latency_ms":20000}
     fw              firmware the server offers (docs/device-api.md section 6), e.g.
                     {"version":"1.1.0","size":1800000,"crash_ms":0,"hint":true,"kbps":120,"fault":null}
                     version   offered when newer than the device's ?current= (always with fault downgrade)
                     size      image size (a simulator image: sim::makeSimImage format)
                     crash_ms  the image "crashes" this long after booting (rollback test)
                     hint      add X-PV-FW-Latest: <version> to every /v1/ reply (default true)
                     kbps      virtual download speed (X-Sim-Kbps), abs_url: absolute download URL
                               on a different host name (device must not send its token there)
                     fault     corrupt | wrong_hash (other valid image) | truncated | short_length |
                               drop | bin_404 | bin_500 | meta_404 | meta_500 | meta_malformed |
                               bad_sig | unsigned | downgrade | oversize
     fw_bin_script   faults for the next binary downloads only, e.g. ["truncated","corrupt"]
     fw.release      instead of a simulator image, serve a REAL signed release directory made by
                     tools/ota/release.sh (manifest.json + paperbot-<v>.bin) - for a board
                     whose SERVER_URL points at this mock: {"fw":{"release":"dist/fw/1.0.1"}}

     status_script / status_always   replies to POST /v1/status (default 204):
                             {"want_log":"body"} (200 {"want_log":true}) | {"want_log":"header"}
                             (204 + X-PV-Want-Log: 1) | {"status":404} (older server) | {"status":500}
                             | {"latency_ms":20000} (slow, virtual) | {"real_delay_ms":N} | {"drop":true}

     wifi            the device's Wi-Fi list (docs/device-api.md section 8): {"rev":2,"networks":[{"ssid",
                     "psk","prio"}]}; /v1/ replies carry X-PV-Wifi-Rev: <rev> while the device is behind. wifi_raw: serve this
                     text for GET /v1/wifi instead (malformed / too big lists); wifi_status: e.g. 500
     conn_close      true = "Connection: close" on every reply (no keep-alive; device must reconnect)

Wi-Fi API (Bearer token): GET /v1/wifi -> the list (404 without "wifi" config = older server).
Each request's X-PV-Wifi-Rev is recorded (wifi_rev_seen); wifi_gets counts list fetches;
connections counts TCP connections accepted (keep-alive check).

Status API (Bearer token, docs/device-api.md section 7): POST /v1/status, JSON <= 2 KB. Every
report is validated against the contract and stored: GET /__mock/status -> {"count","invalid",
"reports":[...]} (newest last; each with the body's fields, stats_<name>, and _t/_code/_bytes/
_valid/_err/_log_n/_log_text added by the mock).

Firmware API (Bearer token): GET /v1/firmware?current=<ver>&device=<id> -> 200 {version,url,size,
sha256,sig} | 204;  GET /v1/firmware/<version>.bin -> the image. Every request's X-PV-FW header
(running version) is counted (fw_seen).
"""
import argparse, hashlib, json, os, random, re, subprocess, tempfile, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ID_RE = re.compile(r"^[A-Za-z0-9_-]{3,64}$")
DEFAULT_KINDS = ["note", "todo", "reminder", "work", "unsure"]
TITLES = {
    "note": "Idea: robot face for the voice gadget", "todo": "Buy AA batteries", "reminder": "Call the dentist",
    "work": "Research e-paper fonts at 200px", "unsure": "Something about the garden", "noise": "(no speech)",
    "shopping": "Eggs", "done": "Eggs", "removed": "Lesson at 1:30", "answer": "Tell me a joke", "error": "",
}
SUMMARY = "3 good bitmap fonts found; Spleen 8x16 reads best"
ANSWER = "Why don't skeletons fight each other? They don't have the guts."
lock = threading.Lock()
state = {}


def reset():
    state.clear()
    state.update(tasks={}, order=[], puts=0, ok=0, errors=0, per_id={}, config={"script": [], "get_script": [], "status_script": []}, bytes=0,
                 bad_headers=0, gets=0, get_recording=0, get_updates=0, get_errors=0, now=0,
                 fw_checks=0, fw_offers=0, fw_downloads=0, fw_bytes=0, fw_bin_auth=0, fw_seen={}, fw_last="", fw_check_log=[],
                 status=[], status_posts=0, status_ok=0, status_invalid=0, wifi_gets=0, wifi_rev_seen=-1, connections=0)


STATUS_INT = ("slot", "boot_n", "up_s", "batt_mv", "usb", "rssi", "connect_ms", "heap", "heap_min", "q", "pending", "awake_ms",
              "sleep_ms")
STATUS_STATS = ("clips", "uploads", "upload_fail", "wifi_fail", "dups", "quarantined", "dropped_bytes", "too_short", "epd_timeouts",
                "results", "check_fail")
RESETS = ("poweron", "sw", "panic", "int_wdt", "task_wdt", "wdt", "brownout", "usb", "deepsleep", "other")


def check_status(raw, ctype):
    """Validates a status report against the contract; returns (parsed or None, error or "")."""
    if len(raw) > 2048:
        return None, f"body {len(raw)} B > 2048"
    if not (ctype or "").startswith("application/json"):
        return None, f"content-type {ctype!r}"
    try:
        b = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as e:
        return None, f"bad json: {e}"
    if not isinstance(b, dict) or b.get("v") != 1:
        return b, "not an object with v=1"
    for k in ("id", "fw", "reset"):
        if not isinstance(b.get(k), str):
            return b, f"{k} missing"
    if b["reset"] not in RESETS:
        return b, f"reset {b['reset']!r}"
    for k in STATUS_INT:
        if not isinstance(b.get(k), int) or isinstance(b.get(k), bool):
            return b, f"{k} not an integer"
    st = b.get("stats")
    if not isinstance(st, dict) or any(not isinstance(st.get(k), int) for k in STATUS_STATS):
        return b, "stats incomplete"
    if "ssid" in b and (not isinstance(b["ssid"], str) or len(b["ssid"].encode()) > 32):
        return b, "ssid not a string of <= 32 bytes"
    if "log" in b:
        lg = b["log"]
        if not isinstance(lg, list) or len(lg) > 40 or any(not isinstance(x, str) or len(x) > 160 for x in lg):
            return b, "log not <= 40 strings of <= 160 chars"
    return b, ""


# ---- firmware (simulator images + ECDSA P-256 signatures with the TEST key) ----
HERE = os.path.dirname(os.path.abspath(__file__))
TEST_KEY = os.path.join(HERE, "ota", "test_signing_key.pem")
_img_cache, _sig_cache, _other_key = {}, {}, []


def parse_ver(v):
    m = re.match(r"^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})$", v or "")
    return tuple(int(x) for x in m.groups()) if m else None


def sim_image(version, size, crash_ms=0):
    """Same layout as sim::makeSimImage: 256-byte header, filler, SHA-256 of the rest."""
    key = (version, size, crash_ms)
    if key not in _img_cache:
        size = max(size, 512)
        hdr = f"PVSIMFW1 version={version} crash_ms={crash_ms}\n".encode().ljust(256, b"\0")
        body = hdr + random.Random(f"{version}/{size}").randbytes(size - 32 - 256)
        _img_cache[key] = body + hashlib.sha256(body).digest()
    return _img_cache[key]


def sign(message, other_key=False):
    """DER ECDSA-P256-SHA256 signature (hex) of message, via the openssl CLI."""
    key = TEST_KEY
    if other_key:
        if not _other_key:
            fd, path = tempfile.mkstemp(suffix=".pem")
            os.close(fd)
            subprocess.run(["openssl", "ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", path], check=True,
                           capture_output=True)
            _other_key.append(path)
        key = _other_key[0]
    ck = (message, key)
    if ck not in _sig_cache:
        out = subprocess.run(["openssl", "dgst", "-sha256", "-sign", key], input=message, capture_output=True, check=True)
        _sig_cache[ck] = out.stdout.hex()
    return _sig_cache[ck]


def manifest(version, size, sha_hex):
    return f"pocket-voice-fw/1\n{version}\n{size}\n{sha_hex}\n".encode()


reset()


def view(t, now, legacy=False):
    """The record as the device sees it at virtual time now."""
    if legacy:
        kind = {"noise": "inbox", "unsure": "inbox"}.get(t["kind"], t["kind"])
        return {k: v for k, v in dict(t, kind=kind, status="open").items() if not k.startswith("_")}
    age = now - t["created"]
    out = {"id": t["id"]}
    if age < t["_process_ms"]:
        out["status"] = "processing"
        return out
    out.update(kind=t["kind"], title=t["title"], due=t["due"])
    if t["kind"] == "error":
        out.update(status="error", kind=None, error="transcription failed")
    elif t["kind"] == "answer":  # the router answered at once (firmware 1.2.0+: its own screen)
        out.update(status="done", summary=ANSWER[:120])
    elif t["kind"] != "work":
        out["status"] = "done"
    elif age < t["_process_ms"] + t["_research_ms"]:
        out["status"] = "researching"
    else:
        oc = t["_outcome"]
        out["status"] = oc
        if oc == "done":
            out["summary"] = SUMMARY[:60]
        elif oc == "paused_budget":
            out["error"] = "daily budget reached"
        else:
            out["error"] = "agent failed"
    return out


def status_at(t, now):
    return view(t, now)["status"]


class H(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *a):
        if ARGS.verbose:
            super().log_message(fmt, *a)

    def reply(self, status, obj=None, raw=None, headers=None, ctype="application/json"):
        body = raw if raw is not None else (json.dumps(obj).encode() if obj is not None else b"")
        self.send_response(status)
        if status != 204:
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
        for k, v in (headers or {}).items():
            self.send_header(k, str(v))
        self.fw_hint_header()
        self.end_headers()
        if status != 204:
            self.wfile.write(body)

    def setup(self):
        super().setup()
        with lock:
            state["connections"] += 1

    def fw_hint_header(self):
        with lock:
            close = bool(state["config"].get("conn_close"))
        if close:
            self.send_header("Connection", "close")
            self.close_connection = True
        if not self.path.startswith("/v1/"):
            return
        with lock:
            fw = state["config"].get("fw")
            wifi = state["config"].get("wifi")
        if fw and fw.get("hint", True) and fw.get("version"):
            self.send_header("X-PV-FW-Latest", fw["version"])
        dev = self.headers.get("X-PV-Wifi-Rev") or "0"
        if isinstance(wifi, dict) and wifi.get("rev") and (not dev.isdigit() or int(dev) < int(wifi["rev"])):
            self.send_header("X-PV-Wifi-Rev", str(wifi["rev"]))  # only while the device is behind (section 9.1)

    def note_fw(self):
        w = self.headers.get("X-PV-Wifi-Rev")
        if w is not None:
            with lock:
                state["wifi_rev_seen"] = int(w) if w.isdigit() else -2
        v = self.headers.get("X-PV-FW")
        if v:
            with lock:
                state["fw_seen"][v] = state["fw_seen"].get(v, 0) + 1
                state["fw_last"] = v

    # ---- firmware ----
    def firmware(self, u):
        with lock:
            fw = dict(state["config"].get("fw") or {})
        fault = fw.get("fault")
        if fw.get("release"):
            return self.firmware_release(u, fw["release"])
        if u.path == "/v1/firmware":
            q = parse_qs(u.query)
            cur = (q.get("current") or [""])[0]
            with lock:
                state["fw_checks"] += 1
                state["fw_check_log"].append({"current": cur, "device": (q.get("device") or [""])[0], "now": state["now"]})
            if not fw.get("version"):
                return self.reply(204)
            if fault == "meta_404":
                return self.reply(404, {"error": "not found"})
            if fault == "meta_500":
                return self.reply(500, {"error": "injected"})
            if fault == "meta_malformed":
                return self.reply(200, raw=b'{"version": "' + fw["version"].encode() + b'", "size": ')
            ov, cv = parse_ver(fw["version"]), parse_ver(cur)
            if fault != "downgrade" and (cv is None or ov is None or ov <= cv):
                return self.reply(204)
            img = sim_image(fw["version"], int(fw.get("size", 1800000)), int(fw.get("crash_ms", 0)))
            size, sha = len(img), hashlib.sha256(img).hexdigest()
            if fault == "oversize":
                size = 4 * 1024 * 1024
            offer = {"version": fw["version"], "size": size, "sha256": sha,
                     "url": f"/v1/firmware/{fw['version']}.bin"}
            if fw.get("abs_url"):
                offer["url"] = f"http://localhost:{ARGS.port}/public/fw/{fw['version']}.bin"
            if fault != "unsigned":
                offer["sig"] = sign(manifest(fw["version"], size, sha), other_key=fault == "bad_sig")
            with lock:
                state["fw_offers"] += 1
            return self.reply(200, offer)
        m = re.match(r"^/(?:v1/firmware|public/fw)/([^/]+)\.bin$", u.path)
        if not m or not fw.get("version") or m.group(1) != fw["version"]:
            return self.reply(404, {"error": "no such firmware"})
        with lock:
            script = state["config"].get("fw_bin_script") or []
            if script:
                fault = script.pop(0)
            state["fw_downloads"] += 1
            if self.headers.get("Authorization"):
                state["fw_bin_auth"] += 1
        if fault == "bin_404":
            return self.reply(404, {"error": "gone"})
        if fault == "bin_500":
            return self.reply(500, {"error": "injected"})
        size, crash = int(fw.get("size", 1800000)), int(fw.get("crash_ms", 0))
        img = sim_image(fw["version"], size, crash)
        if fault == "wrong_hash":  # a valid image, but not the one the offer describes
            img = sim_image("6.6.6", size, 0)
        if fault == "corrupt":
            b = bytearray(img)
            for i in range(len(b) // 2, len(b) // 2 + 64):
                b[i] ^= 0x5A
            img = bytes(b)
        send, length = img, len(img)
        if fault == "short_length":
            send = img[:len(img) - 4096]
            length = len(send)
        elif fault in ("truncated", "drop"):
            send = img[:int(len(img) * (0.6 if fault == "truncated" else 0.0))]
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(length))
        if fw.get("kbps"):
            self.send_header("X-Sim-Kbps", str(fw["kbps"]))
        self.fw_hint_header()
        self.end_headers()
        try:
            self.wfile.write(send)
        except OSError:
            pass
        with lock:
            state["fw_bytes"] += len(send)
        if len(send) < length:
            self.drop()

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def authed(self):
        return self.headers.get("Authorization", "") == f"Bearer {ARGS.token}"

    def now(self):
        v = self.headers.get("X-Sim-Now-Ms")
        with lock:
            if v is not None:
                state["now"] = int(v)
            else:
                state["now"] = int(time.time() * 1000)
            return state["now"]

    def drop(self):
        self.close_connection = True
        try:
            self.connection.shutdown(2)
        except OSError:
            pass

    # ---- control ----
    def control(self, method):
        if self.path == "/__mock/state" and method == "GET":
            with lock:
                per = state["per_id"]
                now = state["now"]
                recs = [dict(view(state["tasks"][i], now), age_ms=now - state["tasks"][i]["created"]) for i in state["order"][-20:]]
                s = {
                    "puts": state["puts"], "ok": state["ok"], "errors": state["errors"], "tasks": len(state["tasks"]),
                    "max_ok_per_id": max([p["ok"] for p in per.values()] or [0]),
                    "max_puts_per_id": max([p["puts"] for p in per.values()] or [0]),
                    "dup_replies": sum(p["dup"] for p in per.values()), "bytes": state["bytes"], "bad_headers": state["bad_headers"],
                    "gets": state["gets"], "get_recording": state["get_recording"], "get_updates": state["get_updates"],
                    "get_errors": state["get_errors"], "now": now,
                    "fw_checks": state["fw_checks"], "fw_offers": state["fw_offers"], "fw_downloads": state["fw_downloads"],
                    "fw_bytes": state["fw_bytes"], "fw_bin_auth": state["fw_bin_auth"], "fw_seen": state["fw_seen"],
                    "fw_last": state["fw_last"], "fw_check_log": state["fw_check_log"][-20:],
                    "status_posts": state["status_posts"], "status_ok": state["status_ok"],
                    "status_invalid": state["status_invalid"], "status_last": (state["status"] or [None])[-1],
                    "wifi_gets": state["wifi_gets"], "wifi_rev_seen": state["wifi_rev_seen"], "connections": state["connections"],
                    "unfinished": sum(1 for t in state["tasks"].values() if status_at(t, now) in ("processing", "researching")),
                    "per_id": per, "records": recs, "config": state["config"],
                }
            return self.reply(200, s)
        if self.path == "/__mock/status" and method == "GET":
            with lock:
                out = {"count": state["status_posts"], "ok": state["status_ok"], "invalid": state["status_invalid"],
                       "reports": state["status"][-60:]}
            return self.reply(200, out)
        if self.path == "/__mock/reset" and method == "POST":
            self.body()
            with lock:
                reset()
            return self.reply(200, {"ok": True})
        if self.path == "/__mock/config" and method == "POST":
            try:
                cfg = json.loads(self.body() or b"{}")
            except ValueError:
                return self.reply(400, {"error": "bad json"})
            with lock:
                state["config"].update(cfg)
                out = dict(state["config"])
            return self.reply(200, out)
        return self.reply(404, {"error": "not found"})

    def get_action(self):
        with lock:
            cfg = state["config"]
            act = cfg["get_script"].pop(0) if cfg.get("get_script") else dict(cfg.get("get_always") or {})
            hdr = {"X-Sim-Latency-Ms": int(act.get("latency_ms", cfg.get("get_latency_ms", 0)))}
        return act, hdr

    def firmware_release(self, u, rel):
        d = rel if os.path.isabs(rel) else os.path.join(HERE, "..", rel)
        with open(os.path.join(d, "manifest.json")) as f:
            offer = json.load(f)
        if u.path == "/v1/firmware":
            cur = parse_ver((parse_qs(u.query).get("current") or [""])[0])
            with lock:
                state["fw_checks"] += 1
            if cur is not None and parse_ver(offer["version"]) <= cur:
                return self.reply(204)
            with lock:
                state["fw_offers"] += 1
            return self.reply(200, offer)
        if u.path != offer["url"]:
            return self.reply(404, {"error": "no such firmware"})
        with open(os.path.join(d, f"paperbot-{offer['version']}.bin"), "rb") as f:
            img = f.read()
        with lock:
            state["fw_downloads"] += 1
            state["fw_bytes"] += len(img)
        return self.reply(200, raw=img, ctype="application/octet-stream")

    def do_GET(self):
        if self.path.startswith("/__mock/"):
            return self.control("GET")
        if self.path.startswith("/public/fw/"):  # a "third-party" download host: no token needed
            return self.firmware(urlparse(self.path))
        if not self.path.startswith("/v1/"):
            return self.reply(404, {"error": "not found"})
        if urlparse(self.path).path == "/v1/ping":  # "wifi test": the server is reachable (no token)
            return self.reply(204, raw=b"")
        if not self.authed():
            return self.reply(401, raw=b"unauthorized")
        now = self.now()
        self.note_fw()
        u = urlparse(self.path)
        if u.path == "/v1/firmware" or u.path.startswith("/v1/firmware/"):
            return self.firmware(u)
        if u.path == "/v1/wifi":
            with lock:
                cfg = state["config"]
                wifi, raw, st = cfg.get("wifi"), cfg.get("wifi_raw"), cfg.get("wifi_status")
                state["wifi_gets"] += 1
            if st:
                return self.reply(int(st), {"error": "injected"})
            if raw is not None:
                return self.reply(200, raw=raw.encode())
            if not isinstance(wifi, dict):
                return self.reply(404, {"error": "not found"})
            return self.reply(200, {"rev": wifi.get("rev", 0), "networks": wifi.get("networks", [])})
        with lock:
            cfg = dict(state["config"])
        sync = cfg.get("mode") == "sync"
        if u.path == "/v1/tasks":
            with lock:
                out = [{k: view(state["tasks"][i], now, sync).get(k) for k in ("id", "kind", "title", "due", "status")}
                       for i in reversed(state["order"][-10:])]
            return self.reply(200, out)
        m = re.match(r"^/v1/recordings/([^/]+)$", u.path)
        is_updates = u.path == "/v1/updates"
        if not m and not is_updates:
            return self.reply(404, raw=b"not found")
        if is_updates and (sync or cfg.get("updates_api") is False):
            return self.reply(404, {"error": "not found"})  # an older server
        act, hdr = self.get_action()
        with lock:
            state["gets"] += 1
            state["get_updates" if is_updates else "get_recording"] += 1
        if act.get("drop"):
            return self.drop()
        if "status" in act and act["status"] != 200:
            with lock:
                state["get_errors"] += 1
            return self.reply(act["status"], {"error": "injected"}, headers=hdr)
        if act.get("malformed"):
            return self.reply(200, raw=b'{"id": "x", "status": ', headers=hdr)
        nf = int(cfg.get("not_found_ms", 0))

        def visible(rid):
            t = state["tasks"].get(rid)
            return t if t is not None and now - t["created"] >= nf else None

        with lock:
            if m:
                rid = m.group(1)
                t = visible(rid)
                if rid in state["per_id"]:
                    state["per_id"][rid]["gets"] = state["per_id"][rid].get("gets", 0) + 1
                out = view(t, now, sync) if t else None
            else:
                ids = [i for i in (parse_qs(u.query).get("ids", [""])[0]).split(",") if i]
                items = []
                for rid in ids[:20]:
                    t = visible(rid)
                    if rid in state["per_id"]:
                        state["per_id"][rid]["gets"] = state["per_id"][rid].get("gets", 0) + 1
                    if t:
                        items.append(view(t, now))
                out = {"items": items}
        if out is None:
            return self.reply(404, {"error": "not found"}, headers=hdr)
        return self.reply(200, out, headers=hdr)

    def do_POST(self):
        if self.path.startswith("/__mock/"):
            return self.control("POST")
        if self.path == "/v1/status":
            return self.status_post()
        self.body()
        return self.reply(404, raw=b"not found")

    def status_post(self):
        raw = self.body()
        if not self.authed():
            return self.reply(401, raw=b"unauthorized")
        now = self.now()
        self.note_fw()
        with lock:
            cfg = state["config"]
            act = cfg["status_script"].pop(0) if cfg.get("status_script") else dict(cfg.get("status_always") or {})
        delay = act.get("real_delay_ms", 0)
        if delay:
            time.sleep(delay / 1000)
        b, err = check_status(raw, self.headers.get("Content-Type"))
        code = int(act.get("status", 200 if act.get("want_log") == "body" else 204))
        rec = {k: v for k, v in (b or {}).items() if k not in ("stats", "log")} if isinstance(b, dict) else {}
        for k, v in ((b or {}).get("stats") or {}).items() if isinstance(b, dict) else []:
            rec["stats_" + k] = v
        lg = b.get("log") if isinstance(b, dict) else None
        rec.update(_t=now, _code=0 if act.get("drop") else code, _bytes=len(raw), _valid=not err, _err=err,
                   _log_n=len(lg) if isinstance(lg, list) else -1,
                   _log_text="\n".join(x for x in lg if isinstance(x, str)) if isinstance(lg, list) else "",
                   _want_log=act.get("want_log") or "")
        with lock:
            state["status_posts"] += 1
            state["status_invalid"] += bool(err)
            if 200 <= rec["_code"] < 300:
                state["status_ok"] += 1
            state["status"].append(rec)
            del state["status"][:-200]
        if act.get("drop"):
            return self.drop()
        hdr = {"X-Sim-Latency-Ms": int(act.get("latency_ms", 0))}
        if act.get("want_log") == "header":
            hdr["X-PV-Want-Log"] = "1"
        if code == 200:
            return self.reply(200, {"want_log": True} if act.get("want_log") == "body" else {}, headers=hdr)
        if code == 204:
            return self.reply(204, headers=hdr)
        return self.reply(code, {"error": "injected" if code != 404 else "not found"}, headers=hdr)

    def do_PUT(self):
        m = re.match(r"^/v1/recordings/([^/]+)$", self.path)
        data = self.body()
        if not m:
            return self.reply(404, raw=b"not found")
        if not self.authed():
            return self.reply(401, raw=b"unauthorized")
        now = self.now()
        self.note_fw()
        rid = m.group(1)
        with lock:
            cfg = state["config"]
            act = cfg["script"].pop(0) if cfg.get("script") else dict(cfg.get("always") or {})
            state["puts"] += 1
            per = state["per_id"].setdefault(rid, {"puts": 0, "ok": 0, "dup": 0, "gets": 0, "bytes": len(data)})
            per["puts"] += 1
            hdr = {"X-Sim-Latency-Ms": int(act.get("latency_ms", cfg.get("latency_ms", 0)))}
            sync = cfg.get("mode") == "sync"
        delay = act.get("real_delay_ms", cfg.get("real_delay_ms", 0))
        if delay:
            time.sleep(delay / 1000)
        if not ID_RE.match(rid):
            return self.fail(400, {"error": "bad id"}, hdr)
        if "status" in act and not (200 <= act["status"] < 300):
            return self.fail(act["status"], {"error": "injected"}, hdr)
        if len(data) < 44 or data[:4] != b"RIFF":
            return self.fail(400, {"error": "expected a WAV body"}, hdr)
        with lock:
            existing = state["tasks"].get(rid)
            dup = existing is not None
            if not dup:
                n = len(state["order"])
                byte_rate = int.from_bytes(data[28:32], "little") or 32000
                secs = round((len(data) - 44) / byte_rate, 2)
                kinds = cfg.get("kinds") or DEFAULT_KINDS
                kind = act.get("kind") or cfg.get("kind") or kinds[n % len(kinds)]
                # A data-chunk size that disagrees with the body (e.g. 0 after a power cut) makes
                # typical WAV decoders read no audio: model it as Whisper hearing nothing.
                hdr_ok = int.from_bytes(data[40:44], "little") == len(data) - 44
                if not hdr_ok:
                    state["bad_headers"] += 1
                    kind = "noise"
                title = TITLES.get(kind, kind)
                if act.get("title") is not None:  # scripted title (escaping tests)
                    title = act["title"]
                elif kind not in ("noise", "error"):
                    title = f"{title} #{n + 1} ({secs:.1f} s)"[:96]
                existing = {
                    "id": rid, "created": now, "created_at": int(time.time() * 1000), "kind": kind, "title": title,
                    "due": "2026-10-18T09:00:00Z" if kind == "reminder" else None, "transcript": "", "audio_key": f"audio/{rid}.wav",
                    "seconds": secs,
                    "_process_ms": int(act.get("process_ms", cfg.get("process_ms", 1500))),
                    "_research_ms": int(act.get("research_ms", cfg.get("research_ms", 600000))),
                    "_outcome": act.get("work_outcome", cfg.get("work_outcome", "done")),
                }
                state["tasks"][rid] = existing
                state["order"].append(rid)
                state["bytes"] += len(data)
                if ARGS.store:
                    os.makedirs(ARGS.store, exist_ok=True)
                    with open(os.path.join(ARGS.store, rid + ".wav"), "wb") as f:
                        f.write(data)
            else:
                per["dup"] += 1
            if sync:
                reply = view(existing, now, legacy=True)
            elif dup:
                reply = view(existing, now)   # same record, current state
            else:
                reply = {"id": rid, "status": "processing"}  # receipt: audio durably stored
            if dup or act.get("duplicate"):
                reply["duplicate"] = True
            if not act.get("drop"):
                per["ok"] += 1
                state["ok"] += 1
        if act.get("drop"):
            return self.drop()  # stored, but the device never hears back
        if act.get("malformed"):
            return self.reply(200, raw=b'{"id": "' + rid.encode() + b'", "kind": "note", "title": ', headers=hdr)
        if "body" in act:
            return self.reply(act.get("status", 200), raw=act["body"].encode(), headers=hdr)
        return self.reply(200 if sync else 202, reply, headers=hdr)

    def fail(self, status, obj, hdr):
        with lock:
            state["errors"] += 1
        return self.reply(status, obj, headers=hdr)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8788)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--token", default=os.environ.get("PV_SIM_TOKEN", "sim-token"))
    ap.add_argument("--store", default="", help="directory to save received WAVs")
    ap.add_argument("-v", "--verbose", action="store_true")
    ARGS = ap.parse_args()
    srv = ThreadingHTTPServer((ARGS.host, ARGS.port), H)
    print(f"mock pocket-voice server on http://{ARGS.host}:{ARGS.port}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
