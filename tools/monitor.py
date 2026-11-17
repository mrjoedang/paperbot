# /// script
# dependencies = ["pyserial"]
# ///
"""Print the board's serial log with timestamps (resets the board first to catch boot)."""
import sys, time
import serial

s = serial.Serial(sys.argv[1] if len(sys.argv) > 1 else "/dev/cu.usbmodem2101", 921600, timeout=0.5)
s.dtr = False
s.rts = True
time.sleep(0.1)
s.rts = False
while True:
    line = s.readline()
    if line:
        print(time.strftime("%H:%M:%S"), line.decode(errors="replace").rstrip(), flush=True)
