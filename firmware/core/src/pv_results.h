// Async results (docs/device-api.md): parsing of the server's receipt / result JSON and the
// small persisted list of recording ids whose result the device is still waiting for.
#pragma once
#include "pv_hal.h"

namespace pv {

// ---------- replies ----------
enum class RStatus : uint8_t { Invalid, Processing, Done, Researching, PausedBudget, Stopped, Error };
const char *rstatusName(RStatus s);

struct ResultReply {
  char id[48] = "";
  char kind[12] = "";     // todo | shopping | reminder | note | done | removed | answer | work | noise ("" while processing)
  char title[96] = "";
  char due[24] = "";
  char detail[128] = "";  // work summary or answer (done), or error / reason text
  RStatus status = RStatus::Invalid;
  bool duplicate = false;
  bool legacy = false;    // old synchronous server (no lifecycle status): show as a plain result
  bool final() const { return status == RStatus::Done || status == RStatus::PausedBudget || status == RStatus::Stopped || status == RStatus::Error; }
};

// Parses a PUT receipt (202 {id,status:"processing"}), a legacy synchronous task reply
// (200 {id,kind,title,...}) or a GET result. Returns false (status Invalid) if the JSON is
// broken or says nothing usable. Legacy "inbox" maps to unsure ("(no speech)" -> noise).
bool parseResultReply(const char *body, ResultReply *out);
bool parseResultObject(const char *obj, ResultReply *out);  // object at obj, rest ignored

// ---------- result-check schedule ----------
// Delay before scheduled check number `step` (0-based): 30 s, 2 min, 5 min, 15 min, then
// every 30 min. An item is given up once the schedule has covered RESULT_MAX_AGE_MS.
uint32_t checkDelayMs(uint8_t step);
uint64_t checkAgeMs(uint8_t step);  // sum of the delays of steps 0..step-1
static const uint64_t RESULT_MAX_AGE_MS = 24ull * 3600 * 1000;

// ---------- pending list ----------
enum class Phase : uint8_t { Await = 0, Researching = 1 };

struct PendingItem {
  char id[48];
  Phase phase;
  uint8_t step;     // scheduled checks done
  uint8_t misses;   // consecutive 404s on scheduled checks
  bool fresh;       // accepted in the current session (poll window), RAM only
  uint64_t next_ms; // next scheduled check (RAM only; re-derived after boot)
};

// Up to MAX ids, persisted on the SD card as text ("PV1" header, one "<phase> <step> <misses>
// <id>" line per item, "END" trailer) via write-temp + rename, so a power cut never loses the
// list. Items survive reboots; after a boot the first check is due after the step's delay
// capped at 30 s.
class PendingResults {
 public:
  static const int MAX = 8;
  PendingResults(Hal &hal, const char *path) : hal_(hal), path_(path) {}
  int load(uint64_t now);  // returns items loaded
  bool save();
  int count() const { return n_; }
  PendingItem &at(int i) { return items_[i]; }
  PendingItem *find(const char *id);
  // Adds (or refreshes) id; when full the oldest item is dropped (returned in dropped, if any).
  PendingItem *add(const char *id, Phase phase, uint64_t now, char *dropped = nullptr, size_t dropped_cap = 0);
  void remove(const char *id);
  uint64_t nextDue() const;  // 0 = nothing pending
  bool anyDue(uint64_t now) const { uint64_t t = nextDue(); return t && t <= now; }
  void allDueNow(uint64_t now);
  // After a scheduled check that did not finish the item: step++ and the next time (at least
  // min_interval_ms away). Returns false when the item exhausted RESULT_MAX_AGE_MS (caller
  // removes it).
  bool reschedule(PendingItem &it, uint64_t now, uint32_t min_interval_ms);

 private:
  bool readFile(const char *path, bool need_end);
  Hal &hal_;
  const char *path_;
  PendingItem items_[MAX];
  int n_ = 0;
};

}  // namespace pv
