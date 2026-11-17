# /// script
# dependencies = ["pyserial"]
# ///
"""Send commands to the board's serial console and print its log.

Usage: uv run tools/devcmd.py [--reset] SECONDS "cmd1" "cmd2" ...   (e.g. "stay 1" "sim 4000" "stat")
--reset pulses RTS first (wakes a sleeping board; it then stays awake ~20 s for commands).
Opens the port with DTR/RTS released; on the ESP32-C6 the open itself may reset the chip, so
commands are sent once the firmware reports READY (or after 4 s).
"""
import glob, sys, time
import serial

args = sys.argv[1:]
reset = args[:1] == ["--reset"]
args = args[1:] if reset else args
secs, cmds = float(args[0]), args[1:]


def open_quiet():
    for _ in range(100):
        ports = glob.glob("/dev/cu.usbmodem*")
        if ports:
            try:
                p = serial.Serial()
                p.port, p.baudrate, p.timeout = ports[0], 921600, 0.2
                p.dtr = False
                p.rts = False
                p.open()
                return p
            except serial.SerialException:
                pass
        time.sleep(0.05)
    sys.exit("no serial port")


s = open_quiet()
if reset:
    s.rts = True
    time.sleep(0.1)
    s.rts = False
    s.close()
    time.sleep(0.5)
    s = open_quiet()
t0 = time.time()
sent = False
while time.time() - t0 < secs:
    try:
        line = s.readline().decode(errors="replace").rstrip()
    except (serial.SerialException, OSError):
        print("-- usb dropped --", flush=True)
        break
    if line:
        print(time.strftime("%H:%M:%S"), line[:240], flush=True)
    if not sent and ("screen=READY" in line or time.time() - t0 > 4):
        for c in cmds:
            s.write((c + "\n").encode())
            time.sleep(0.3)
        sent = True
