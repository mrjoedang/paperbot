#include "pv_recorder.h"
#include <stdio.h>

namespace pv {

void Recorder::begin(const char *path) {
  snprintf(path_, sizeof(path_), "%s", path);
  written_ = 0;
  dropped_ = 0;
  open_failed_ = false;
  write_failed_ = false;
  stop_req_ = false;
  done_ = false;
  ring_.reset();
  active_ = true;
  open_req_.store(true, std::memory_order_release);
}

void Recorder::push(const int16_t *s, size_t n) {
  size_t bytes = n * 2;
  size_t sent = ring_.push(s, bytes);
  if (sent < bytes) dropped_ += bytes - sent;
}

void Recorder::stop() { stop_req_.store(true, std::memory_order_release); }

uint32_t Recorder::step() {
  if (!active_.load(std::memory_order_acquire)) return 100;
  if (open_req_.load(std::memory_order_acquire)) {
    fd_ = hal_.fsOpen(path_, "wb");
    open_failed_ = fd_ < 0;
    if (fd_ >= 0) {
      uint8_t h[WAV_HEADER_BYTES];
      wavHeader(h, rate_, 0);  // patched on stop; a power cut leaves a repairable 0-length header
      if (hal_.fsWrite(fd_, h, sizeof(h)) != (int)sizeof(h)) write_failed_ = true;
    }
    open_req_ = false;
  }
  size_t n = ring_.pop(out_, sizeof(out_));
  if (n) {
    if (fd_ >= 0 && !write_failed_) {
      int w = hal_.fsWrite(fd_, out_, n);
      if (w > 0) written_ += w;
      if (w != (int)n) {
        write_failed_ = true;
        dropped_ += n - (w > 0 ? w : 0);
      }
    } else {
      dropped_ += n;
    }
    return 0;
  }
  if (stop_req_.load(std::memory_order_acquire)) {
    if (fd_ >= 0) {
      uint8_t h[WAV_HEADER_BYTES];
      wavHeader(h, rate_, written_);
      if (!hal_.fsSeek(fd_, 0) || hal_.fsWrite(fd_, h, sizeof(h)) != (int)sizeof(h)) write_failed_ = true;
      if (!hal_.fsClose(fd_, true)) write_failed_ = true;
      fd_ = -1;
    }
    stop_req_ = false;
    active_ = false;
    done_.store(true, std::memory_order_release);
    return 100;
  }
  return 5;
}

}  // namespace pv
