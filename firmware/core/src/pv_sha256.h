// SHA-256 (FIPS 180-4), portable and allocation-free. Used to check firmware images while they
// stream into the inactive OTA slot (the same code runs in the simulator).
#pragma once
#include <stddef.h>
#include <stdint.h>

namespace pv {

class Sha256 {
 public:
  Sha256() { reset(); }
  void reset();
  void update(const void *data, size_t n);
  void finish(uint8_t out[32]);  // the object must be reset() before reuse

 private:
  void block(const uint8_t *p);
  uint32_t h_[8];
  uint64_t len_ = 0;
  uint8_t buf_[64];
  size_t used_ = 0;
};

void sha256(const void *data, size_t n, uint8_t out[32]);
// out: 65 bytes (64 lowercase hex chars + NUL).
void hexEncode(const uint8_t *in, size_t n, char *out);
// Decodes exactly 2*n hex chars (either case) followed by NUL; false otherwise.
bool hexDecode(const char *in, uint8_t *out, size_t n);

}  // namespace pv
