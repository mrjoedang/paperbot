#include "wavfile.h"
#include <stdio.h>
#include <string.h>
#include <zlib.h>

namespace sim {

static uint32_t rd32(const uint8_t *p) { return p[0] | p[1] << 8 | p[2] << 16 | (uint32_t)p[3] << 24; }
static uint16_t rd16(const uint8_t *p) { return p[0] | p[1] << 8; }

bool loadWavMono16k(const std::string &path, std::vector<int16_t> &out) {
  FILE *f = fopen(path.c_str(), "rb");
  if (!f) return false;
  std::vector<uint8_t> d;
  uint8_t buf[65536];
  size_t n;
  while ((n = fread(buf, 1, sizeof(buf), f)) > 0) d.insert(d.end(), buf, buf + n);
  fclose(f);
  if (d.size() < 12 || memcmp(d.data(), "RIFF", 4) || memcmp(d.data() + 8, "WAVE", 4)) return false;
  uint16_t fmt = 0, ch = 0, bits = 0;
  uint32_t rate = 0;
  const uint8_t *pcm = nullptr;
  size_t pcm_len = 0;
  for (size_t off = 12; off + 8 <= d.size();) {
    uint32_t len = rd32(&d[off + 4]);
    const uint8_t *body = &d[off + 8];
    size_t avail = d.size() - off - 8;
    if (!memcmp(&d[off], "fmt ", 4) && len >= 16) {
      fmt = rd16(body); ch = rd16(body + 2); rate = rd32(body + 4); bits = rd16(body + 14);
    } else if (!memcmp(&d[off], "data", 4)) {
      pcm = body;
      pcm_len = len && len <= avail ? len : avail;  // header may still say 0 after a power cut
    }
    off += 8 + len + (len & 1);
    if (!len && !memcmp(&d[off - 8], "data", 4)) break;
  }
  if (fmt != 1 || bits != 16 || !ch || !rate || !pcm) return false;
  size_t frames = pcm_len / (2 * ch);
  size_t outn = (size_t)((double)frames * 16000 / rate);
  out.resize(outn);
  for (size_t i = 0; i < outn; i++) {
    size_t src = (size_t)((double)i * rate / 16000);
    out[i] = (int16_t)rd16(pcm + src * 2 * ch);  // first channel (the board's mic is on the left)
  }
  return true;
}

static void chunk(std::string &png, const char *type, const std::string &data) {
  uint8_t len[4] = { (uint8_t)(data.size() >> 24), (uint8_t)(data.size() >> 16), (uint8_t)(data.size() >> 8), (uint8_t)data.size() };
  png.append((char *)len, 4);
  std::string td = std::string(type, 4) + data;
  png += td;
  uint32_t crc = crc32(0, (const Bytef *)td.data(), (uInt)td.size());
  uint8_t c[4] = { (uint8_t)(crc >> 24), (uint8_t)(crc >> 16), (uint8_t)(crc >> 8), (uint8_t)crc };
  png.append((char *)c, 4);
}

std::string framePng(const uint8_t *fb, int w, int h, int scale) {
  int W = w * scale, H = h * scale;
  std::string raw;
  raw.reserve((W + 1) * H);
  for (int y = 0; y < H; y++) {
    raw += '\0';
    int sy = y / scale;
    for (int x = 0; x < W; x++) {
      int sx = x / scale;
      bool white = fb[sy * (w / 8) + sx / 8] & (0x80 >> (sx & 7));
      raw += (char)(white ? 0xE4 : 0x22);  // paper / ink
    }
  }
  uLongf zn = compressBound(raw.size());
  std::string z(zn, '\0');
  compress2((Bytef *)&z[0], &zn, (const Bytef *)raw.data(), raw.size(), 6);
  z.resize(zn);
  std::string png("\x89PNG\r\n\x1a\n", 8);
  std::string ihdr(13, '\0');
  ihdr[0] = W >> 24; ihdr[1] = W >> 16; ihdr[2] = W >> 8; ihdr[3] = W;
  ihdr[4] = H >> 24; ihdr[5] = H >> 16; ihdr[6] = H >> 8; ihdr[7] = H;
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 0;  // grayscale
  chunk(png, "IHDR", ihdr);
  chunk(png, "IDAT", z);
  chunk(png, "IEND", "");
  return png;
}

bool writeFile(const std::string &path, const std::string &data) {
  FILE *f = fopen(path.c_str(), "wb");
  if (!f) return false;
  fwrite(data.data(), 1, data.size(), f);
  return fclose(f) == 0;
}

}  // namespace sim
