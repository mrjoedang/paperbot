// WAV loading (any PCM16 file -> 16 kHz mono) and PNG output for the simulator.
#pragma once
#include <stdint.h>
#include <string>
#include <vector>

namespace sim {
bool loadWavMono16k(const std::string &path, std::vector<int16_t> &out);
// 1-bit frame (MSB first, 1 = white) -> grayscale PNG scaled by `scale`, e-paper tones.
std::string framePng(const uint8_t *fb, int w, int h, int scale);
bool writeFile(const std::string &path, const std::string &data);
}  // namespace sim
