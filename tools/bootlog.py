# /// script
# dependencies = ["pyserial"]
# ///
"""Print the board's log (reset it first with `esptool --after hard-reset read-mac`), reopening the port across USB re-enumeration/sleep."""
import glob, sys, time
import serial

secs = float(sys.argv[1]) if len(sys.argv) > 1 else 30
end = time.time() + secs

def open_quiet(port):
    # Opening with DTR asserted + an RTS edge puts the C6's USB-Serial/JTAG into download mode:
    # keep both lines released.
    p = serial.Serial()
    p.port, p.baudrate, p.timeout = port, 921600, 0.2
    p.dtr = False
    p.rts = False
    p.open()
    return p


s = None
last = time.time()
while time.time() < end:
    if s is None:
        ports = glob.glob("/dev/cu.usbmodem*")
        if not ports:
            time.sleep(0.05)
            continue
        try:
            s = open_quiet(ports[0])
        except serial.SerialException:
            time.sleep(0.05)
            continue
    try:
        line = s.readline()
    except (serial.SerialException, OSError):
        s = None
        print(time.strftime("%H:%M:%S"), "-- usb dropped --", flush=True)
        continue
    if not line and not glob.glob(s.port):
        s.close()  # port vanished (sleep/reset): reopen when it returns. Never reopen a live port:
        s = None   # on the C6 every open can reset the chip.
        continue
    if line:
        last = time.time()
        print(time.strftime("%H:%M:%S"), line.decode(errors="replace").rstrip()[:220], flush=True)
