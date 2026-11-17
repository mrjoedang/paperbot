// pvsim: host simulator for the pocket voice core.
//   pvsim --serve [--port 8090]          interactive browser UI (see sim/README.md)
//   pvsim --test [scenario ...]          headless scenarios -> build/sim-test/report.html
// Common: --server URL (default http://127.0.0.1:8788 = mock)  --prod (production Worker,
//   token from .secrets.env, ids prefixed "sim-")  --token-env VAR  --run-dir DIR
//   --audio file:PATH|tone:HZ|silence|noise  --usb  --battery MV  --drain  --seed N  -v
//   --ui bolt|classic (screen layout)   --bolt-dump FILE (Bolt frames of the design states as JSON)
//   --setup-frames FILE (the /setup page's own Bolt screens as JSON: a real face + the page's caption)
//   --fw-version X.Y.Z (factory firmware in slot 0 of a fresh <run-dir>/flash; default PV_FW_VERSION)
//   --generic (release image: no server, token or built-in Wi-Fi; set up with `pocketbot setup --sim`)
//   --serial-pty LINK (serve: the console on a pseudo-terminal, LINK = symlink to it)
#include <curl/curl.h>
#include "pv_gfx.h"
#include <fcntl.h>
#include <sys/file.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <filesystem>
#include <string>
#include <vector>
#include "sim.h"

namespace sim {
int runWeb(Sim &s, int port, const std::string &webdir);
int runScenarios(const Options &base, const std::vector<std::string> &names, const std::string &report_dir);
pv::Config defaultConfig(const Options &o);
}  // namespace sim

static std::string projectRoot(const char *argv0) {
  // build/sim/pvsim -> project root
  char buf[4096];
  if (realpath(argv0, buf)) {
    std::string p(buf);
    size_t k = p.rfind("/build/sim/");
    if (k != std::string::npos) return p.substr(0, k);
  }
  char cwd[4096];
  return getcwd(cwd, sizeof(cwd)) ? cwd : ".";
}

// Reads KEY=value from a dotenv file without echoing it anywhere.
static std::string readEnvFile(const std::string &path, const std::string &key) {
  FILE *f = fopen(path.c_str(), "r");
  if (!f) return "";
  char line[512];
  std::string v;
  while (fgets(line, sizeof(line), f)) {
    if (strncmp(line, key.c_str(), key.size()) || line[key.size()] != '=') continue;
    v = line + key.size() + 1;
    while (!v.empty() && (v.back() == '\n' || v.back() == '\r' || v.back() == ' ')) v.pop_back();
    if (v.size() >= 2 && (v[0] == '"' || v[0] == '\'')) v = v.substr(1, v.size() - 2);
  }
  fclose(f);
  return v;
}

int main(int argc, char **argv) {
  curl_global_init(CURL_GLOBAL_DEFAULT);
  setvbuf(stdout, nullptr, _IOLBF, 0);
  sim::Options o;
  o.root = projectRoot(argv[0]);
  o.run_dir = o.root + "/build/sim/run";
  std::string mode = "serve", audio = "file:sim/audio/R0001.WAV", report = o.root + "/build/sim-test";
  int port = 8090;
  bool run_dir_set = false;
  std::vector<std::string> names;
  std::string bolt_dump, serial_link;
  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    auto next = [&]() -> std::string { return i + 1 < argc ? argv[++i] : ""; };
    if (a == "--serve") mode = "serve";
    else if (a == "--test") mode = "test";
    else if (a == "--port") port = atoi(next().c_str());
    else if (a == "--server") o.server_url = next();
    else if (a == "--token-env") { const char *t = getenv(next().c_str()); o.token = t ? t : ""; }
    else if (a == "--prod") {
      o.server_url = "https://pocket-voice.mrjoedang.workers.dev";
      o.token = readEnvFile(o.root + "/.secrets.env", "DEVICE_TOKEN");
      o.id_prefix = "sim-";
      if (o.token.empty()) { fprintf(stderr, "--prod: DEVICE_TOKEN not found in .secrets.env\n"); return 2; }
    }
    else if (a == "--prefix") o.id_prefix = next();
    else if (a == "--run-dir") { o.run_dir = next(); run_dir_set = true; }
    else if (a == "--report-dir") report = next();
    else if (a == "--audio") audio = next();
    else if (a == "--usb") o.usb = true;
    else if (a == "--battery") o.battery_mv = atoi(next().c_str());
    else if (a == "--drain") o.drain = true;
    else if (a == "--ui") o.ui = next();  // bolt | classic
    else if (a == "--seed") o.seed = atoi(next().c_str());
    else if (a == "--fw-version") o.fw_version = next();  // factory image version on a fresh flash
    else if (a == "--generic") o.generic = true;  // the release image: no secrets.h
    else if (a == "--serial-pty") serial_link = next();  // symlink to the console pty (make e2e bridges it to /setup)
    else if (a == "-v") o.echo_log = true;
    else if (a == "--bolt-dump") { mode = "bolt-dump"; bolt_dump = next(); }
    else if (a == "--setup-frames") { mode = "setup-frames"; bolt_dump = next(); }
    else if (a[0] != '-' && mode == "test") names.push_back(a);
    else { fprintf(stderr, "unknown argument %s (see header of sim/src/main.cpp)\n", a.c_str()); return 2; }
  }
  if (const char *t = getenv("PV_SIM_TOKEN"); t && o.id_prefix.empty()) o.token = t;
  if (mode == "bolt-dump") {
    // Bolt frames for the design's V1 states as JSON {state: "0101..."} (compared against
    // design/bolt-variations.html by sim/tools/bolt_compare.sh).
    struct M { const char *key; pv::Screen id; const char *kind, *detail, *due; uint32_t queued, f, sec; };
    const M ms[] = {
      { "ready", pv::Screen::Ready, "", "", "", 0, 0, 0 },
      { "rec", pv::Screen::Rec, "", "", "", 0, 0, 7 },
      { "send", pv::Screen::Sending, "", "1 queued", "", 0, 0, 0 },
      { "todo", pv::Screen::Result, "todo", "Buy AA batteries", "", 0, 0, 0 },
      { "reminder", pv::Screen::Result, "reminder", "Call the dentist", "Tomorrow 9:00", 0, 0, 0 },
      { "work", pv::Screen::Result, "work", "Research e-paper fonts at 200px", "", 0, 0, 0 },
      { "note", pv::Screen::Result, "note", "Idea: robot face for the voice gadget", "", 0, 0, 0 },
      { "queued", pv::Screen::Queued, "", "offline\n3 queued\nwill retry", "", 3, 0, 0 },
      { "short", pv::Screen::TooShort, "", "", "", 0, 0, 0 },
      { "nosd", pv::Screen::NoSd, "", "", "", 0, 0, 0 },
    };
    std::string out = "{";
    static uint8_t bits[pv::FB_BYTES];
    for (const M &m : ms) {
      pv::ScreenModel sm;
      sm.id = m.id;
      snprintf(sm.kind, sizeof(sm.kind), "%s", m.kind);
      snprintf(sm.detail, sizeof(sm.detail), "%s", m.detail);
      snprintf(sm.due, sizeof(sm.due), "%s", m.due);
      sm.queued = m.queued;
      sm.battery_pct = 67;
      pv::BoltLayout::render(bits, sm, m.f, m.sec);
      std::string b;
      for (int i = 0; i < pv::EPD_W * pv::EPD_H; i++) b += (bits[i / 8] >> (7 - i % 8) & 1) ? '1' : '0';
      out += std::string(out.size() > 1 ? "," : "") + "\"" + m.key + "\":\"" + b + "\"";
    }
    FILE *f = fopen(bolt_dump.c_str(), "w");
    if (!f) return 2;
    fputs((out + "}").c_str(), f);
    fclose(f);
    return 0;
  }
  if (mode == "setup-frames") {
    // The browser setup (server/public/setup) shows the board's screen on its 3D model. Steps the board never shows
    // itself (plug me in, sign in, pick Wi-Fi...) get frames drawn here: the face of a real Screen (its mood), then
    // the bottom third replaced by the step's caption in the same 5x7 font. PNGs: server/public/setup/frames.py.
    struct F { const char *key; pv::Screen face; const char *big, *small; int bs; };
    const F fs[] = {
      { "plug", pv::Screen::Off, "plug me in", "usb-c, into the bottom", 2 },
      { "hello", pv::Screen::Sent, "hi!", "sign in on your computer", 3 },
      { "install", pv::Screen::Updating, "installing", "keep me plugged in", 2 },
      { "wifi", pv::Screen::Sending, "wi-fi?", "pick a network", 3 },
      { "joining", pv::Screen::Researching, "joining...", "one moment", 2 },
      { "wrong", pv::Screen::Queued, "hmm", "that didn't work", 3 },
      { "online", pv::Screen::WorkDone, "online!", "", 3 },
    };
    std::string out = "{";
    static uint8_t bits[pv::FB_BYTES];
    for (const F &f : fs) {
      pv::ScreenModel sm;
      sm.id = f.face;
      sm.battery_pct = 67;
      pv::BoltLayout::render(bits, sm, 0, 0);
      pv::Gfx g(bits, pv::EPD_W, pv::EPD_H);
      g.rect(0, 112, 200, 88, 0);  // the text area (y0 = 116)
      bool two = f.small[0];
      int y = f.bs == 3 ? (two ? 128 : 138) : (two ? 134 : 144);
      g.ctext(f.big, y, f.bs);
      if (two) g.ctext(f.small, y + (f.bs == 3 ? 36 : 26), 1);
      std::string b;
      for (int i = 0; i < pv::EPD_W * pv::EPD_H; i++) b += (bits[i / 8] >> (7 - i % 8) & 1) ? '1' : '0';
      out += std::string(out.size() > 1 ? "," : "") + "\"" + f.key + "\":\"" + b + "\"";
    }
    FILE *fo = fopen(bolt_dump.c_str(), "w");
    if (!fo) return 2;
    fputs((out + "}").c_str(), fo);
    fclose(fo);
    return 0;
  }
  if (mode == "test") return sim::runScenarios(o, names, report);

  // Each interactive sim owns its SD card: two sims sharing one folder upload and delete each other's clips.
  if (!run_dir_set) o.run_dir = o.root + "/build/sim/run-" + std::to_string(port);
  std::filesystem::create_directories(o.run_dir);
  int lock_fd = open((o.run_dir + "/.lock").c_str(), O_CREAT | O_RDWR, 0644);
  if (lock_fd < 0 || flock(lock_fd, LOCK_EX | LOCK_NB) != 0) {
    fprintf(stderr, "pvsim: %s is in use by another pvsim; pass a different --port or --run-dir\n", o.run_dir.c_str());
    return 2;
  }
  sim::Sim s(o);
  if (!s.setAudio(audio)) s.setAudio("tone:440");
  if (!serial_link.empty()) {
    std::string dev = s.openSerialPty();
    if (dev.empty()) { fprintf(stderr, "pvsim: openpty failed\n"); return 2; }
    unlink(serial_link.c_str());
    if (symlink(dev.c_str(), serial_link.c_str()) != 0) { fprintf(stderr, "pvsim: cannot link %s\n", serial_link.c_str()); return 2; }
    printf("pvsim: serial console %s -> %s\n", serial_link.c_str(), dev.c_str());
  }
  s.start(sim::defaultConfig(o));
  s.startPacer();
  printf("pvsim: server %s%s, sd card %s/sdcard\n", o.server_url.c_str(), o.id_prefix.empty() ? "" : (" (ids prefixed " + o.id_prefix + ")").c_str(),
         o.run_dir.c_str());
  int rc = sim::runWeb(s, port, o.root + "/sim/web");
  s.stop();
  return rc;
}
