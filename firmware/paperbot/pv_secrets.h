// Build-time settings. A developer build takes them from secrets.h (gitignored, see
// secrets.example.h); a release build (build.sh with PV_GENERIC=1, or no secrets.h) has none:
// the server URL, device token and Wi-Fi list are provisioned into NVS by `pocketbot setup`
// (docs/setup.md) and replace these at runtime anyway.
#pragma once
#if !defined(PV_GENERIC) && __has_include("secrets.h")
#include "secrets.h"
#endif
#ifndef WIFI_SSID
#define WIFI_SSID ""
#endif
#ifndef WIFI_PASSWORD
#define WIFI_PASSWORD ""
#endif
#ifndef SERVER_URL
#define SERVER_URL ""
#endif
#ifndef DEVICE_TOKEN
#define DEVICE_TOKEN ""
#endif
