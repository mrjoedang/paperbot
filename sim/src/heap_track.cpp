// Counting allocator: global new/delete account the bytes allocated on threads that opted
// in (the simulated app thread while it runs core code), so per-cycle leaks show up.
#include <malloc/malloc.h>
#include <stdlib.h>
#include <atomic>
#include <new>
#include "sim.h"

static thread_local bool t_track = false;
static std::atomic<int64_t> g_bytes{0};

namespace sim {
int64_t trackedBytes() { return g_bytes.load(); }
bool trackThisThread(bool on) {
  bool prev = t_track;
  t_track = on;
  return prev;
}
}  // namespace sim

static void *alloc(size_t n) {
  void *p = malloc(n ? n : 1);
  if (!p) throw std::bad_alloc();
  if (t_track) g_bytes += (int64_t)malloc_size(p);
  return p;
}
static void release(void *p) noexcept {
  if (!p) return;
  if (t_track) g_bytes -= (int64_t)malloc_size(p);
  free(p);
}

void *operator new(size_t n) { return alloc(n); }
void *operator new[](size_t n) { return alloc(n); }
void *operator new(size_t n, const std::nothrow_t &) noexcept { try { return alloc(n); } catch (...) { return nullptr; } }
void *operator new[](size_t n, const std::nothrow_t &) noexcept { try { return alloc(n); } catch (...) { return nullptr; } }
void operator delete(void *p) noexcept { release(p); }
void operator delete[](void *p) noexcept { release(p); }
void operator delete(void *p, size_t) noexcept { release(p); }
void operator delete[](void *p, size_t) noexcept { release(p); }
