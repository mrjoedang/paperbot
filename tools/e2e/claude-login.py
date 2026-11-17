# Drives `claude mcp login <name> --no-browser` on a pty (it needs a terminal): writes the authorize URL it prints
# to <dir>/url.txt and the whole transcript to <dir>/login.log. The browser side (consent) is done by accounts.mjs;
# Claude Code's own localhost callback finishes the login.
import os, pty, re, select, subprocess, sys, time
name, d = sys.argv[1], sys.argv[2]
m, s = pty.openpty()
p = subprocess.Popen(["claude", "mcp", "login", name, "--no-browser"], cwd=d, stdin=s, stdout=s, stderr=s, close_fds=True)
os.close(s)
log = open(os.path.join(d, "login.log"), "wb"); buf = b""; t0 = time.time()
while time.time() - t0 < 240 and p.poll() is None:
    r, _, _ = select.select([m], [], [], 0.5)
    if not r: continue
    try: chunk = os.read(m, 4096)
    except OSError: break
    if not chunk: break
    log.write(chunk); log.flush(); buf += chunk
    u = re.search(rb"https://[^\s\x1b]+authorize[^\s\x1b]+", buf)
    if u and not os.path.exists(os.path.join(d, "url.txt")): open(os.path.join(d, "url.txt"), "wb").write(u.group(0))
time.sleep(1)
try:
    while select.select([m], [], [], 0.3)[0]:
        c = os.read(m, 4096)
        if not c: break
        log.write(c)
except OSError: pass
log.write(f"\n[exit {p.poll()}]\n".encode()); log.close()
