// Browser UI + JSON API for the interactive simulator (cpp-httplib, localhost only).
#include <dirent.h>
#include <sys/stat.h>
#include <string>
#include "httplib.h"
#include "sim.h"
#include "wavfile.h"

namespace sim {

std::string jsonEsc(const std::string &s) {
  std::string o;
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') { o += '\\'; o += (char)c; }
    else if (c == '\n') o += "\\n";
    else if (c < 0x20) { char b[8]; snprintf(b, sizeof(b), "\\u%04x", c); o += b; }
    else o += (char)c;
  }
  return o;
}

static std::string q(const std::string &s) { return "\"" + jsonEsc(s) + "\""; }

static std::string stateJson(Sim &s) {
  Sim::Snapshot sn = s.snapshot();
  const pv::AppStatus &st = sn.st;
  const Energy &e = sn.energy;
  const EnergyModel &m = s.energyModel();
  Faults &f = s.faults();
  uint64_t t = s.now();
  double hours = t / 3600000.0;
  double mah = e.total_mah();
  double avg_ma = t ? mah / hours : 0;
  char b[8192];
  snprintf(b, sizeof(b),
           "{\"t_ms\":%llu,\"powered\":%s,\"sleeping\":%s,\"state\":%s,\"screen\":{\"id\":%s,\"title\":%s,\"detail\":%s,\"footer\":%s,\"kind\":%s},"
           "\"queued\":%u,\"queue_files\":%u,\"cycle\":%u,\"backoff_ms\":%u,\"next_retry_ms\":%llu,\"sd_ok\":%s,\"pwr_wake\":%s,"
           "\"stats\":{\"clips\":%u,\"too_short\":%u,\"uploaded\":%u,\"dups\":%u,\"upload_fail\":%u,\"wifi_fail\":%u,\"quarantined\":%u,"
           "\"sessions\":%u,\"wakes\":%u,\"timer_wakes\":%u,\"boot_wakes\":%u,\"pwr_wakes\":%u,\"heap_cycle_delta\":%d,\"dropped\":%u},"
           "\"heap\":{\"free\":%u,\"min\":%u,\"tracked\":%lld,\"lvgl_used\":%u,\"lvgl_frag\":%u,\"open_files\":%u},"
           "\"energy\":{\"mah\":%.3f,\"avg_ma\":%.3f,\"sleep_ms\":%llu,\"awake_ms\":%llu,\"rec_ms\":%llu,\"wifi_ms\":%llu,\"refreshes\":%u,"
           "\"beeps\":%u,\"days_est\":%.1f,\"capacity\":%.0f},"
           "\"fb_seq\":%u,\"beep_seq\":%u,\"led\":%s,\"wifi_on\":%s,\"boots\":%u,\"battery_mv\":%d,\"battery_pct\":%d,\"usb\":%s,"
           "\"boot\":%s,\"pwr\":%s,\"audio\":%s,\"speed\":%.2f,\"sleep_warp\":%.0f,"
           "\"faults\":{\"wifi_offline\":%s,\"wifi_bad_pass\":%s,\"wifi_hang\":%s,\"dns_fail\":%s,\"http_timeout\":%s,\"slow_ms\":%u,"
           "\"sd_missing\":%s,\"sd_write_fail\":%s,\"wifi_leak_bytes\":%u},\"server\":%s}",
           (unsigned long long)t, s.powered() ? "true" : "false", s.sleeping() ? "true" : "false", q(pv::stateName(st.state)).c_str(),
           q(pv::screenName(st.screen.id)).c_str(), q(st.screen.title).c_str(), q(st.screen.detail).c_str(), q(st.screen.footer).c_str(),
           q(st.screen.kind).c_str(), st.queued, s.queueFiles(), st.cycle, st.backoff_ms, (unsigned long long)st.next_retry_ms,
           st.sd_ok ? "true" : "false", st.pwr_wake_enabled ? "true" : "false", st.stats.clips, st.stats.too_short, st.stats.uploaded,
           st.stats.dups, st.stats.upload_fail, st.stats.wifi_fail, st.stats.quarantined, st.stats.sessions, st.stats.wakes,
           st.stats.timer_wakes, st.stats.boot_wakes, st.stats.pwr_wakes, st.stats.heap_cycle_delta, st.stats.dropped_bytes,
           sn.heap_free, sn.heap_min, (long long)sn.tracked_bytes, sn.lvgl_used, sn.lvgl_frag, sn.open_files, mah, avg_ma,
           (unsigned long long)e.sleep_ms, (unsigned long long)e.awake_ms, (unsigned long long)e.rec_ms, (unsigned long long)e.wifi_ms,
           e.refreshes, e.beeps, avg_ma > 0 ? m.capacity_mah / avg_ma / 24 : 0, m.capacity_mah, sn.fb_seq, sn.beep_seq,
           sn.led ? "true" : "false", sn.wifi_on ? "true" : "false", sn.boots, s.batteryNow(), pv::batteryPercent(s.batteryNow()),
           s.usbConnected() ? "true" : "false", s.button(pv::Button::Boot) ? "true" : "false",
           s.button(pv::Button::Pwr) ? "true" : "false", q(s.audioName()).c_str(), s.speed.load(), s.sleep_warp.load(),
           f.wifi_offline ? "true" : "false", f.wifi_bad_pass ? "true" : "false", f.wifi_hang ? "true" : "false",
           f.dns_fail ? "true" : "false", f.http_timeout ? "true" : "false", f.slow_ms, f.sd_missing ? "true" : "false",
           f.sd_write_fail ? "true" : "false", f.wifi_leak_bytes, q(s.options().server_url).c_str());
  std::string out(b);
  // recent beeps
  out.pop_back();
  out += ",\"beeps\":[";
  for (size_t i = 0; i < sn.beeps.size(); i++)
    out += (i ? "," : "") + std::string("[") + std::to_string(sn.beeps[i].t) + "," + std::to_string(sn.beeps[i].hz) + "," +
           std::to_string(sn.beeps[i].ms) + "]";
  out += "]";
  // async results + layout
  std::string pend;
  if (FILE *pf = fopen(s.sdPath("/pv_pending.txt").c_str(), "rb")) {
    char b[1024];
    size_t n = fread(b, 1, sizeof(b) - 1, pf);
    fclose(pf);
    b[n] = 0;
    pend = b;
  }
  char x[512];
  snprintf(x, sizeof(x),
           ",\"pending\":%u,\"next_check_ms\":%llu,\"batt_level\":%d,\"refreshes_asleep\":%u,\"ui\":%s,\"pending_file\":%s,"
           "\"res\":{\"accepted\":%u,\"results\":%u,\"checks\":%u,\"check_fail\":%u,\"gets\":%u,\"gave_up\":%u,\"noise\":%u}}",
           st.pending, (unsigned long long)st.next_check_ms, (int)st.batt, e.refreshes_asleep, q(s.ui()).c_str(), q(pend).c_str(),
           st.stats.accepted, st.stats.results, st.stats.checks, st.stats.check_fail, st.stats.gets, st.stats.gave_up, st.stats.noise);
  out += x;
  // firmware / OTA slots (the sim's flash model)
  out.pop_back();
  out += ",\"fw\":{\"version\":" + q(sn.fw) + ",\"slot\":" + std::to_string(sn.slot) + ",\"boot_slot\":" + std::to_string(sn.boot_slot) +
         ",\"verifying\":" + (st.fw_verifying ? "true" : "false") + ",\"bricked\":" + (sn.bricked ? "true" : "false") +
         ",\"rollbacks\":" + std::to_string(sn.rollbacks) + ",\"slots\":[{\"state\":" + q(sn.slot_state[0]) + ",\"version\":" +
         q(sn.slot_fw[0]) + "},{\"state\":" + q(sn.slot_state[1]) + ",\"version\":" + q(sn.slot_fw[1]) + "}]}}";
  // status reports (POST /v1/status): counters + the last body as sent
  out.pop_back();
  out += ",\"status\":{\"posts\":" + std::to_string(sn.status_posts) + ",\"sent\":" + std::to_string(st.stats.status_sent) +
         ",\"fail\":" + std::to_string(st.stats.status_fail) + ",\"skipped\":" + std::to_string(st.stats.status_skipped) +
         ",\"last_code\":" + std::to_string(sn.status_last_code) + ",\"last_t\":" + std::to_string(sn.status_last_t) +
         ",\"last\":" + q(sn.status_last) + ",\"reset\":" + q(sn.reset_reason) + "}}";
  // Wi-Fi world + HTTP connections
  out.pop_back();
  out += ",\"wifi\":{\"place\":" + q(s.place()) + ",\"joined\":" + q(sn.wifi_ssid) + ",\"rev\":" + std::to_string(sn.wifi_rev_sent) +
         ",\"requests\":" + std::to_string(sn.http_requests) + ",\"handshakes\":" + std::to_string(sn.http_handshakes) +
         ",\"leaks\":" + std::to_string(sn.conn_leaks) + ",\"keepalive\":" + (f.no_keepalive ? "false" : "true") + ",\"aps\":[";
  auto aps = s.aps();
  for (size_t i = 0; i < aps.size(); i++)
    out += (i ? ",{" : "{") + std::string("\"ssid\":") + q(aps[i].ssid) + ",\"place\":" + q(aps[i].place) + ",\"on\":" +
           (aps[i].on ? "true" : "false") + ",\"rssi\":" + std::to_string(aps[i].rssi) + ",\"ch\":" + std::to_string(aps[i].channel) + "}";
  out += "]}}";
  return out;
}

static std::string listDir(const std::string &dir, bool wav_only) {
  std::string out = "[";
  DIR *d = opendir(dir.c_str());
  bool first = true;
  if (d) {
    while (struct dirent *e = readdir(d)) {
      std::string n = e->d_name;
      if (n[0] == '.') continue;
      if (wav_only && !pv::isClipName(n.c_str())) continue;
      struct stat st;
      if (stat((dir + "/" + n).c_str(), &st) || !S_ISREG(st.st_mode)) continue;
      out += (first ? "" : ",") + std::string("{\"name\":") + q(n) + ",\"size\":" + std::to_string(st.st_size) + "}";
      first = false;
    }
    closedir(d);
  }
  return out + "]";
}

int runWeb(Sim &s, int port, const std::string &webdir) {
  httplib::Server srv;
  if (!srv.set_mount_point("/", webdir)) fprintf(stderr, "web dir %s missing\n", webdir.c_str());
  srv.Get("/api/state", [&](const httplib::Request &, httplib::Response &res) { res.set_content(stateJson(s), "application/json"); });
  srv.Get("/api/frame", [&](const httplib::Request &, httplib::Response &res) {
    Sim::Snapshot sn = s.snapshot();
    res.set_content(std::string((const char *)sn.fb, pv::FB_BYTES), "application/octet-stream");
  });
  srv.Get("/api/frame.png", [&](const httplib::Request &req, httplib::Response &res) {
    Sim::Snapshot sn = s.snapshot();
    int scale = req.has_param("scale") ? atoi(req.get_param_value("scale").c_str()) : 3;
    res.set_content(framePng(sn.fb, pv::EPD_W, pv::EPD_H, scale < 1 ? 1 : scale > 8 ? 8 : scale), "image/png");
  });
  srv.Get("/api/log", [&](const httplib::Request &req, httplib::Response &res) {
    uint32_t since = req.has_param("since") ? (uint32_t)atol(req.get_param_value("since").c_str()) : 0;
    auto lines = s.logSince(since, 400);
    std::string out = "{\"lines\":[";
    for (size_t i = 0; i < lines.size(); i++) out += (i ? ",[" : "[") + std::to_string(lines[i].first) + "," + q(lines[i].second) + "]";
    out += "]}";
    res.set_content(out, "application/json");
  });
  srv.Post("/api/button", [&](const httplib::Request &req, httplib::Response &res) {
    std::string name = req.get_param_value("name"), action = req.get_param_value("action");
    if (name == "reset") s.reset();
    else if (name == "boot" || name == "pwr") {
      pv::Button b = name == "boot" ? pv::Button::Boot : pv::Button::Pwr;
      s.setButton(b, action == "down");
    } else return void(res.status = 400);
    res.set_content("{\"ok\":true}", "application/json");
  });
  srv.Post("/api/set", [&](const httplib::Request &req, httplib::Response &res) {
    std::string k = req.get_param_value("key"), v = req.get_param_value("value");
    bool on = v == "1" || v == "true";
    Faults &f = s.faults();
    if (k == "usb") s.setUsb(on);
    else if (k == "battery_mv") s.setBatteryMv(atoi(v.c_str()));
    else if (k == "speed") s.speed = atof(v.c_str());
    else if (k == "sleep_warp") s.sleep_warp = atof(v.c_str());
    else if (k == "wifi_offline") f.wifi_offline = on;
    else if (k == "wifi_bad_pass") f.wifi_bad_pass = on;
    else if (k == "wifi_hang") f.wifi_hang = on;
    else if (k == "dns_fail") f.dns_fail = on;
    else if (k == "http_timeout") f.http_timeout = on;
    else if (k == "slow_ms") f.slow_ms = atoi(v.c_str());
    else if (k == "sd_missing") f.sd_missing = on;
    else if (k == "sd_write_fail") f.sd_write_fail = on;
    else if (k == "wifi_leak_bytes") f.wifi_leak_bytes = atoi(v.c_str());
    else if (k == "place") s.setPlace(v);  // home | venue | street | ...
    else if (k == "ap") {                  // "<index>:0|1" switches an access point
      size_t i = (size_t)atoi(v.c_str()), c = v.find(':');
      auto aps = s.aps();
      if (c == std::string::npos || i >= aps.size()) return void(res.status = 400);
      s.setApOn(aps[i].ssid, v.substr(c + 1) == "1");
    } else if (k == "keepalive") f.no_keepalive = !on;
    else if (k == "ui") {  // bolt | classic: re-boots the device (SD card kept)
      if (v != "bolt" && v != "classic") return void(res.status = 400);
      s.setUi(v);
      s.reset();
    }
    else if (k == "audio") {
      if (!s.setAudio(v)) return void(res.status = 400);
    } else if (k == "cmd") s.command(v);
    else return void(res.status = 400);
    res.set_content("{\"ok\":true}", "application/json");
  });
  srv.Get("/api/audio", [&](const httplib::Request &, httplib::Response &res) {
    std::string root = s.options().root;
    res.set_content("{\"recordings\":" + listDir(root + "/sim/audio", true) + ",\"sd\":[]" + "}",
                    "application/json");
  });
  srv.Get("/api/files", [&](const httplib::Request &, httplib::Response &res) {
    res.set_content("{\"queue\":" + listDir(s.sdPath("/REC"), true) + ",\"bad\":" + listDir(s.sdPath("/REC_BAD"), false) +
                        ",\"root\":" + listDir(s.sdPath(""), false) + "}",
                    "application/json");
  });
  // Proxy to the mock's control API (same origin for the page).
  srv.Get("/api/mock", [&](const httplib::Request &, httplib::Response &res) {
    std::string r = s.mockRequest("GET", "/__mock/state");
    res.set_content(r.empty() ? "{\"error\":\"mock not reachable\"}" : r, "application/json");
  });
  srv.Post("/api/mock", [&](const httplib::Request &req, httplib::Response &res) {
    std::string path = req.get_param_value("op") == "reset" ? "/__mock/reset" : "/__mock/config";
    std::string r = s.mockRequest("POST", path, req.body.empty() ? "{}" : req.body);
    res.set_content(r.empty() ? "{\"error\":\"mock not reachable\"}" : r, "application/json");
  });
  printf("pvsim: open http://localhost:%d\n", port);
  if (!srv.listen("127.0.0.1", port)) {
    fprintf(stderr, "cannot listen on port %d\n", port);
    return 1;
  }
  return 0;
}

}  // namespace sim
