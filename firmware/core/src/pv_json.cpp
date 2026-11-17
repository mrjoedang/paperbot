#include "pv_json.h"
#include <stdlib.h>
#include <string.h>

namespace pv {
namespace {

struct Reader {
  const char *p;
  int depth = 0;

  void ws() {
    while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
  }

  static int hex(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
  }

  bool hex4(unsigned *v) {
    *v = 0;
    for (int i = 0; i < 4; i++) {
      int h = hex(p[i]);
      if (h < 0) return false;
      *v = *v << 4 | h;
    }
    p += 4;
    return true;
  }

  // Parses a string at p (which points at '"'); copies UTF-8 into out if given.
  bool str(char *out, size_t cap) {
    if (*p != '"') return false;
    p++;
    size_t n = 0;
    auto put = [&](char c) {
      if (out && n + 1 < cap) out[n++] = c;
    };
    for (;;) {
      unsigned char c = (unsigned char)*p;
      if (c == 0 || c < 0x20) return false;
      p++;
      if (c == '"') break;
      if (c != '\\') { put((char)c); continue; }
      char e = *p++;
      switch (e) {
        case '"': put('"'); break;
        case '\\': put('\\'); break;
        case '/': put('/'); break;
        case 'b': put('\b'); break;
        case 'f': put('\f'); break;
        case 'n': put('\n'); break;
        case 'r': put('\r'); break;
        case 't': put('\t'); break;
        case 'u': {
          unsigned cp;
          if (!hex4(&cp)) return false;
          if (cp >= 0xD800 && cp < 0xDC00) {  // surrogate pair
            unsigned lo;
            if (p[0] != '\\' || p[1] != 'u') return false;
            p += 2;
            if (!hex4(&lo) || lo < 0xDC00 || lo > 0xDFFF) return false;
            cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
          }
          if (cp < 0x80) put((char)cp);
          else if (cp < 0x800) { put((char)(0xC0 | cp >> 6)); put((char)(0x80 | (cp & 0x3F))); }
          else if (cp < 0x10000) { put((char)(0xE0 | cp >> 12)); put((char)(0x80 | (cp >> 6 & 0x3F))); put((char)(0x80 | (cp & 0x3F))); }
          else { put((char)(0xF0 | cp >> 18)); put((char)(0x80 | (cp >> 12 & 0x3F))); put((char)(0x80 | (cp >> 6 & 0x3F))); put((char)(0x80 | (cp & 0x3F))); }
          break;
        }
        default: return false;
      }
    }
    if (out && cap) {
      // Never cut a UTF-8 sequence in half: drop an incomplete last sequence.
      if (n > 0) {
        size_t k = n - 1;
        while (k > 0 && ((unsigned char)out[k] & 0xC0) == 0x80) k--;
        unsigned char lead = (unsigned char)out[k];
        size_t need = lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : lead >= 0xC0 ? 2 : 1;
        if (n - k < need) n = k;
      }
      out[n] = 0;
    }
    return true;
  }

  bool number(double *v) {
    const char *s = p;
    if (*p == '-') p++;
    if (*p == '0') p++;
    else if (*p >= '1' && *p <= '9') while (*p >= '0' && *p <= '9') p++;
    else return false;
    if (*p == '.') {
      p++;
      if (!(*p >= '0' && *p <= '9')) return false;
      while (*p >= '0' && *p <= '9') p++;
    }
    if (*p == 'e' || *p == 'E') {
      p++;
      if (*p == '+' || *p == '-') p++;
      if (!(*p >= '0' && *p <= '9')) return false;
      while (*p >= '0' && *p <= '9') p++;
    }
    if (v) *v = strtod(s, nullptr);
    return true;
  }

  bool lit(const char *w) {
    size_t n = strlen(w);
    if (strncmp(p, w, n)) return false;
    p += n;
    return true;
  }

  // Parses any value; if f is given, stores its type/content there.
  bool value(JsonField *f) {
    ws();
    if (++depth > 32) return false;
    bool ok = true;
    JsonType t;
    switch (*p) {
      case '"': t = JsonType::String; ok = str(f ? f->str : nullptr, f ? f->cap : 0); break;
      case '{': t = JsonType::Object; ok = object(nullptr, 0); break;
      case '[': t = JsonType::Array; ok = array(); break;
      case 't': t = JsonType::Bool; ok = lit("true"); if (f) f->b = true; break;
      case 'f': t = JsonType::Bool; ok = lit("false"); if (f) f->b = false; break;
      case 'n': t = JsonType::Null; ok = lit("null"); break;
      default: t = JsonType::Number; ok = number(f ? &f->num : nullptr); break;
    }
    depth--;
    if (ok && f) f->type = t;
    return ok;
  }

  bool array() {
    p++;
    ws();
    if (*p == ']') { p++; return true; }
    for (;;) {
      if (!value(nullptr)) return false;
      ws();
      if (*p == ',') { p++; continue; }
      if (*p == ']') { p++; return true; }
      return false;
    }
  }

  bool object(JsonField *fields, int n) {
    p++;
    ws();
    if (*p == '}') { p++; return true; }
    for (;;) {
      ws();
      char key[48];
      if (!str(key, sizeof(key))) return false;
      ws();
      if (*p++ != ':') return false;
      JsonField *f = nullptr;
      for (int i = 0; i < n; i++)
        if (!strcmp(fields[i].key, key)) f = &fields[i];
      if (!value(f)) return false;
      ws();
      if (*p == ',') { p++; continue; }
      if (*p == '}') { p++; return true; }
      return false;
    }
  }
};

}  // namespace

bool jsonReadObjectPrefix(const char *text, JsonField *fields, int n) {
  for (int i = 0; i < n; i++) {
    fields[i].type = JsonType::Missing;
    if (fields[i].str && fields[i].cap) fields[i].str[0] = 0;
  }
  if (!text) return false;
  Reader r{text};
  r.ws();
  if (*r.p != '{') return false;
  r.depth = 1;
  return r.object(fields, n);
}

int jsonForEachObject(const char *text, const char *key, void (*cb)(const char *obj, void *ctx), void *ctx) {
  if (!jsonReadObject(text, nullptr, 0)) return -1;  // validate the whole document first
  Reader r{text};
  r.ws();
  r.p++;  // '{'
  r.depth = 1;
  for (;;) {
    r.ws();
    if (*r.p == '}') return -1;
    char k[48];
    if (!r.str(k, sizeof(k))) return -1;
    r.ws();
    r.p++;  // ':'
    r.ws();
    if (!strcmp(k, key)) {
      if (*r.p != '[') return -1;
      r.p++;
      int count = 0;
      for (;;) {
        r.ws();
        if (*r.p == ']') return count;
        if (*r.p == '{') {
          cb(r.p, ctx);
          count++;
        }
        if (!r.value(nullptr)) return -1;
        r.ws();
        if (*r.p == ',') r.p++;
      }
    }
    if (!r.value(nullptr)) return -1;
    r.ws();
    if (*r.p == ',') r.p++;
  }
}

bool jsonReadObject(const char *text, JsonField *fields, int n) {
  for (int i = 0; i < n; i++) {
    fields[i].type = JsonType::Missing;
    if (fields[i].str && fields[i].cap) fields[i].str[0] = 0;
  }
  if (!text) return false;
  Reader r{text};
  r.ws();
  if (*r.p != '{') return false;
  r.depth = 1;
  if (!r.object(fields, n)) return false;
  r.ws();
  return *r.p == 0;
}

}  // namespace pv
