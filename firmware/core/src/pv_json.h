// Minimal strict JSON reader (no allocation): validates a whole document and copies out
// selected top-level members of an object. Enough for the server's task replies.
#pragma once
#include <stddef.h>

namespace pv {

enum class JsonType : unsigned char { Missing, String, Bool, Number, Null, Object, Array };

struct JsonField {
  const char *key;
  char *str = nullptr;  // optional output for strings (UTF-8, truncated to cap-1)
  size_t cap = 0;
  JsonType type = JsonType::Missing;
  bool b = false;
  double num = 0;
};

// Returns false if text is not valid JSON or not an object. Fields not present stay Missing.
bool jsonReadObject(const char *text, JsonField *fields, int n);
// Like jsonReadObject, but for the object starting at text; whatever follows it is ignored.
bool jsonReadObjectPrefix(const char *text, JsonField *fields, int n);
// For a valid JSON object document: calls cb(element) for each object element of its array
// member `key` (element points at the element's '{'; read it with jsonReadObjectPrefix).
// Returns the number of object elements, or -1 if text is invalid / key is not an array.
int jsonForEachObject(const char *text, const char *key, void (*cb)(const char *obj, void *ctx), void *ctx);

}  // namespace pv
