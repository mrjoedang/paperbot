---
name: boundary-discipline
description: Principle. Validate and normalize data where it enters paperbot (serial commands, HTTP requests from the device, the web app and MCP clients, JSON from storage, server replies on the device) so the code inside can trust it. Use when adding an endpoint, a serial command, a stored format or a parser.
---

# Boundary discipline

Parse at the edge, trust inside.

- **Device side:** every server reply, serial line and NVS value is untrusted. Parse strictly
  (`pv_json`), check sizes against fixed buffers, and reject the whole thing on any error (a Wi-Fi list
  is adopted only if all of it is valid). Never act on half-parsed input.
- **Server side:** every request body, query, header and MCP tool argument gets validated where it
  arrives (`logic.ts` validators, `ID_RE`, size limits), with an error that says how to fix the input.
  Device replies stay within the 2 KB the device reads.
- **Durable Object RPC and stored JSON** are boundaries too: read them back defensively once, where they
  land, not with `?.` sprinkled through the code.
- **Normalize once** (trim, case, SSID bytes exactly as given, dates to ISO) so the rest of the code sees
  one representation.
- Untrusted text (transcripts, device logs, memo titles) is shown as text only, never as HTML.
