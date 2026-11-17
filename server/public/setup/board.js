// The board over Web Serial (Chrome, Edge, Firefox 151+): its console (docs/setup.md "Board serial commands") and the
// release image (esptool-js). Lessons from the hardware (2026-11-15):
// - opening the port resets the board (USB-Serial/JTAG): open it once and keep it open; it answers ~3 s later, and a
//   board that was set up before first runs its check-in (up to ~25 s)
// - DTR/RTS released right after opening (DTR + an RTS edge = download mode)
// - one pending reader.read() at a time: a read dropped by a timeout loses its bytes
// - after flashing, esptool's hard reset restarts it on the new firmware: no replug, no buttons
// esptool-js (316 KB) loads only for an install, after the page is up: flasher() (setup.js warms it while idle)
let esptool = null;
export const flasher = () => (esptool ??= import("./vendor/esptool.js").catch((e) => { esptool = null; throw e; }));

export const ESPRESSIF = 0x303a;
export const BOARD_MS = 45_000; // a board answers between network sessions only
export const supported = () => "serial" in navigator;

const espressif = (p) => p.getInfo().usbVendorId === ESPRESSIF;

export class Board {
  constructor({ onLine = () => {}, onGone = () => {} } = {}) {
    this.port = null;
    this.onLine = onLine;
    this.onGone = onGone;
    this.subs = new Set();
    this.gone = false;
    navigator.serial.addEventListener("disconnect", (e) => {
      if (e.target === this.port) this.lost();
    });
  }

  /** A port this site may already use (granted before): no picker. */
  static async granted() {
    return (await navigator.serial.getPorts()).find(espressif) || null;
  }
  /** Chrome's picker, only Espressif boards listed. Needs a click. */
  static pick() {
    return navigator.serial.requestPort({ filters: [{ usbVendorId: ESPRESSIF }] });
  }

  async open(port) {
    this.port = port;
    this.gone = false;
    await port.open({ baudRate: 115200 });
    await port.setSignals({ dataTerminalReady: false, requestToSend: false }).catch(() => {});
    this.reading = this.readLoop();
  }

  async readLoop() {
    const dec = new TextDecoder();
    let buf = "";
    this.reader = this.port.readable.getReader();
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          this.onLine(line);
          for (const f of [...this.subs]) f(line);
        }
      }
    } catch {
      this.lost(); // unplugged, or the board reset into another USB device
    } finally {
      try { this.reader.releaseLock(); } catch {}
    }
  }

  lost() {
    if (this.gone) return;
    this.gone = true;
    this.onGone();
  }

  async close() {
    const p = this.port;
    if (!p) return;
    try { await this.reader?.cancel(); } catch {}
    await this.reading?.catch(() => {});
    try { await p.close(); } catch {}
  }

  /** The next line matching `test`, or null after `ms`. */
  waitLine(test, ms) {
    return new Promise((resolve) => {
      const f = (l) => { if (test(l)) { done(); resolve(l); } };
      const t = setTimeout(() => { done(); resolve(null); }, ms);
      const done = () => { clearTimeout(t); this.subs.delete(f); };
      this.subs.add(f);
    });
  }

  /** One console command, sent once; its @{...} reply (null if none in time). */
  async ask(cmd, ms = BOARD_MS) {
    const reply = this.waitLine((l) => l.includes("@{") && parse(l) !== null, ms).then((l) => (l ? parse(l) : null));
    const w = this.port.writable.getWriter();
    try {
      const data = new TextEncoder().encode(cmd + "\n");
      for (let i = 0; i < data.length; i += 256) { // paced: the board drains its USB buffer between loop passes
        await w.write(data.slice(i, i + 256));
        if (data.length > 256) await sleep(20);
      }
    } finally { w.releaseLock(); }
    return reply;
  }

  /** Right after open (which reset the board): wait for it to boot, then `info`. null = no paperbot answering. */
  async hello() {
    // paperbot logs its version ~0.5 s after the reset and its first screen ~2.8 s after; other firmware never does
    const boot = await this.waitLine((l) => l.includes("PVFW-VERSION:") || l.includes(",UI,screen="), 4000);
    if (boot) return this.ask("info", BOARD_MS);
    return this.ask("info", 2500); // no paperbot boot log (other firmware, or it booted before we listened)
  }

  /** Waits for the board to be on USB again (after a reset or a replug), opens it, says hello. */
  async reconnect(maxMs = 120_000) {
    await this.close();
    const end = Date.now() + maxMs;
    while (Date.now() < end) {
      const p = await Board.granted();
      if (p) {
        try {
          await this.open(p);
          return await this.hello();
        } catch { await this.close(); }
      }
      await sleep(1000);
    }
    throw new Error("board gone");
  }

  /** Writes the release image (files: [{data, address}]) and restarts the board on it. */
  async flash(files, onPct) {
    const { ESPLoader, Transport } = await flasher();
    await this.close();
    const transport = new Transport(this.port, false);
    const quiet = { clean() {}, writeLine() {}, write() {} };
    const loader = new ESPLoader({ transport, baudrate: 921600, terminal: quiet });
    try {
      await loader.main();
      const total = files.reduce((n, f) => n + f.data.length, 0);
      const before = files.map((_, i) => files.slice(0, i).reduce((n, f) => n + f.data.length, 0));
      await loader.writeFlash({
        fileArray: files, flashMode: "keep", flashFreq: "keep", flashSize: "keep", eraseAll: false, compress: true,
        reportProgress: (i, w, t) => onPct(Math.min(99, Math.round((100 * (before[i] + files[i].data.length * (t ? w / t : 0))) / total))),
      });
      await loader.after("hard_reset");
    } finally {
      await transport.disconnect().catch(() => {});
    }
    onPct(100);
  }
}

function parse(l) {
  try { return JSON.parse(l.slice(l.indexOf("@{") + 1)); } catch { return null; }
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The release image from this server: manifest + files, each checked against its sha256. */
export async function releaseImage() {
  const man = await (await fetch("/v1/setup/firmware/manifest.json", { cache: "no-store" })).json();
  const files = await Promise.all(man.files.map(async (f) => {
    const data = new Uint8Array(await (await fetch(`/v1/setup/firmware/${encodeURIComponent(f.name)}`)).arrayBuffer());
    const sum = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (sum !== f.sha256) throw new Error(`${f.name} was corrupted`);
    return { data, address: parseInt(f.offset, 16) };
  }));
  return { version: man.version, files };
}

export const older = (a, b) => {
  const x = String(a || "0").split(".").map(Number), y = String(b || "0").split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0);
  return false;
};
