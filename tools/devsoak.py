# /// script
# dependencies = ["pyserial"]
# ///
"""Soak the board over serial: N simulated recordings (`sim MS`), one per completed upload session.

Usage: uv run tools/devsoak.py N [MS]   -> prints per-cycle heap/timing summary from NET/UP/CYCLE lines.
"""
import glob, re, sys, time
import serial

n, ms = int(sys.argv[1]), int(sys.argv[2]) if len(sys.argv) > 2 else 3000
p = serial.Serial()
p.port, p.baudrate, p.timeout = glob.glob("/dev/cu.usbmodem*")[0], 921600, 0.2
p.dtr = False
p.rts = False
p.open()
done, sent_at, crashes, t0 = 0, 0.0, 0, time.time()
rows = []
p.write(f"sim {ms}\n".encode()); sent_at = time.time()
while done < n and time.time() - t0 < n * 90:
    try:
        line = p.readline().decode(errors="replace").rstrip()
    except (serial.SerialException, OSError):
        print("usb dropped"); break
    if not line:
        if time.time() - sent_at > 60:  # stuck: nudge
            print("  no session in 60 s, re-sending"); p.write(f"sim {ms}\n".encode()); sent_at = time.time()
        continue
    if any(k in line for k in ("assert failed", "Guru Meditation", "panic", "abort()", "HAL,reset")):
        crashes += 1; print("  !!", line[:160])
    if ",UP," in line:
        m = re.search(r"status=(-?\d+).*?ms=(\d+)", line); up = m.groups() if m else ("?", "?")
    if ",NET," in line:
        f = dict(kv.split("=", 1) for kv in line.split(",") if "=" in kv)
        done += 1
        rows.append(f)
        print(f"{done:3d} status={f.get('last_status')} up={f.get('uploaded')} connect={f.get('connect_ms')}ms "
              f"session={f.get('session_ms')}ms heap_before={f.get('heap_before')} after={f.get('heap_after')} min={f.get('heap_min')}", flush=True)
        time.sleep(2)
        p.write(f"sim {ms}\n".encode()); sent_at = time.time()
print(f"cycles={done} crashes={crashes} elapsed={time.time()-t0:.0f}s")
if rows:
    a = [int(r["heap_after"]) for r in rows if r.get("heap_after", "").isdigit()]
    print(f"heap_after first={a[0]} last={a[-1]} delta={a[-1]-a[0]} min_of_min={min(int(r['heap_min']) for r in rows)}")
