// Recording pipeline: capture thread pushes mono samples into a lock-free ring; the writer
// (a background task on the ESP32, inline on the host) opens the clip lazily, drains the ring
// to the SD file and patches the WAV header when recording stops.
#pragma once
#include <atomic>
#include "pv_hal.h"
#include "pv_util.h"

namespace pv {

class Recorder {
 public:
  Recorder(Hal &hal, uint8_t *ring_buf, size_t ring_cap, uint32_t rate) : hal_(hal), ring_(ring_buf, ring_cap), rate_(rate) {}

  // ---- capture side ----
  void begin(const char *path);           // arms a new clip (file opens in the writer)
  void push(const int16_t *s, size_t n);  // never blocks; overflow counts as dropped
  void stop();                            // request finalize
  bool finalized() const { return done_.load(); }
  bool openFailed() const { return open_failed_.load(); }

  // ---- writer side ----
  uint32_t step();  // one unit of writer work; returns ms until it wants to run again
  static uint32_t task(void *self) { return ((Recorder *)self)->step(); }

  uint32_t written() const { return written_.load(); }  // PCM bytes in the file
  uint32_t dropped() const { return dropped_.load(); }
  bool writeFailed() const { return write_failed_.load(); }
  bool active() const { return active_.load(); }

 private:
  Hal &hal_;
  Ring ring_;
  uint32_t rate_;
  char path_[96] = "";
  int fd_ = -1;
  uint8_t out_[4096];
  std::atomic<bool> open_req_{false}, stop_req_{false}, done_{true}, active_{false};
  std::atomic<bool> open_failed_{false}, write_failed_{false};
  std::atomic<uint32_t> written_{0}, dropped_{0};
};

}  // namespace pv
