#!/usr/bin/env python3
"""Drive a running pvsim (--serve) against the v2 server: record clips via BOOT, log every screen
change and HTTP line, then wait for pending work results on timer wakes.
usage: e2e_sim.py <sim base url> <out.json> clip.wav ...   (clips relative to server/test/wav)"""
import json, sys, time, urllib.request, wave, threading, os
B, OUT, clips = sys.argv[1], sys.argv[2], sys.argv[3:]
WAV = os.path.join(os.path.dirname(os.path.abspath(__file__)), "wav")
def get(p): return json.loads(urllib.request.urlopen(B + p, timeout=10).read())
def post(p): urllib.request.urlopen(urllib.request.Request(B + p, data=b"", method="POST"), timeout=10).read()
T0 = time.time()
timeline, logs, stop = [], [], False
def watch():
    last, since = None, 0
    while not stop:
        try:
            s = get("/api/state")
            sc = s["screen"]
            key = (s["state"], sc["title"], sc["detail"], sc.get("kind"), s["pending"])
            if key != last:
                timeline.append({"t": round(time.time() - T0, 2), "vt_s": round(s["t_ms"] / 1000, 1), "state": s["state"], "title": sc["title"], "detail": sc["detail"], "kind": sc.get("kind"), "pending": s["pending"], "sleeping": s["sleeping"]})
                print(f'{timeline[-1]["t"]:7.2f}s v{timeline[-1]["vt_s"]:8.1f}s {s["state"]:<10} {sc["title"]!r:<24} {sc["detail"]!r} pend={s["pending"]}', flush=True)
                last = key
            l = get(f"/api/log?since={since}")
            for n, line in l.get("lines", []):
                logs.append(line); since = max(since, n)
                if any(k in line for k in (",PUT,", ",GET,", "RESULT", ",UPLOAD", "HTTP")): print("      log", line[:160], flush=True)
        except Exception as e:
            pass
        time.sleep(0.15)
th = threading.Thread(target=watch, daemon=True); th.start()
post("/api/set?key=sleep_warp&value=20")
for c in clips:
    with wave.open(os.path.join(WAV, c)) as w: dur = w.getnframes() / w.getframerate()
    post("/api/set?key=audio&value=file:" + os.path.join(WAV, c))
    print(f"=== {c} ({dur:.1f}s)", flush=True)
    timeline.append({"t": round(time.time() - T0, 2), "clip": c})
    # wake if asleep, then hold BOOT for the clip length
    post("/api/button?name=boot&action=down"); time.sleep(dur + 0.6); post("/api/button?name=boot&action=up")
    # wait until the device is done with this clip (result shown, or SENT and asleep)
    t = time.time()
    while time.time() - t < 40:
        s = get("/api/state")
        if s["state"] not in ("REC", "SENDING", "UPLOADING") and s["queued"] == 0 and s["screen"]["title"] not in ("REC", "SENDING"): 
            time.sleep(1.0); break
        time.sleep(0.2)
    time.sleep(2)
# wait for pending results (work research) on timer wakes
t = time.time()
while time.time() - t < 240:
    s = get("/api/state")
    if s["pending"] == 0: break
    time.sleep(1)
time.sleep(2)
stop = True; th.join(1)
s = get("/api/state")
json.dump({"timeline": timeline, "final_state": s, "log": logs}, open(OUT, "w"), indent=1)
print("final", s["state"], s["screen"], "pending", s["pending"], "stats", s["stats"], "res", s["res"])
