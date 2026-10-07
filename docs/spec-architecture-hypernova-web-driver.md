---
title: Hypernova Web Driver - WebHID configuration app for the Cosmic Byte Hypernova mouse
version: 1.1
date_created: 2026-10-07
last_updated: 2026-10-07
owner: ohmygodashish
tags: [architecture, app, webhid, pwa, cloudflare-workers, hardware]
---

# Introduction

The Hypernova Web Driver is a static web application that reads and changes the settings of a Cosmic Byte Hypernova gaming mouse from a Chromium-based browser using the WebHID API. It replaces the vendor's Windows-only configuration program, so the mouse can be configured from Windows, macOS, or Linux by opening a URL. The app is hosted as static files on Cloudflare Workers, deployed automatically from a GitHub repository, and is installable as a Progressive Web App.

## 1. Purpose & Scope

**Purpose.** Define the architecture, device protocol contract, safety rules, user-facing behaviour, hosting, and tests for version 1 of the web driver.

**In scope (v1):**

- Connecting to the mouse (wired cable or 4K wireless dongle) through WebHID.
- Reading and displaying: report rate, DPI stages (count, active stage, value, colour), lift-off distance, sensor mode, motion sync, angle snapping, ripple control, debounce time, mouse sleep time, peak performance (switch and time), battery level, firmware version.
- Changing every setting listed above, except battery level and firmware version, which are read-only.
- Exporting settings to a JSON file and restoring them from that file.
- Hosting as static assets on Cloudflare Workers, auto-deployed from GitHub on push to `main`.
- Installable PWA with offline-capable app shell.

**Out of scope (v1):** button remapping, macros, firmware update, dongle pairing, RGB lighting (`0xA0` block), DPI indicator LED effects (`0x4C`-`0x5F`), long-range mode, onboard profile switching, factory reset, separate X/Y DPI, Bluetooth connection, Firefox and Safari support, mobile browsers.

**Audience.** Developers and AI coding agents implementing or modifying the app.

**Assumptions.**

- One Hypernova mouse is connected at a time.
- The device protocol is as documented in [spec-data-hypernova-hid-protocol.md](spec-data-hypernova-hid-protocol.md) (the "protocol spec"). Section 4 of this spec restates the subset the app uses. If the two disagree, this spec governs the app and the protocol spec must be corrected.
- Protocol facts used here were confirmed against a real device on 2026-10-07 (firmware v2.17), over both the 4K dongle and the cable: reads, 2-byte writes, and 4-byte writes.

## 2. Definitions

| Term | Definition |
|---|---|
| WebHID | Browser API (`navigator.hid`) that lets a web page exchange HID reports with a USB/Bluetooth HID device after the user grants access. Available in Chromium-based desktop browsers only. |
| HID | Human Interface Device. USB device class used by mice and keyboards. |
| Report ID | First byte of a HID report that identifies the report type. This device uses report ID `0x08`. |
| Output report | Report sent from host to device (`HIDDevice.sendReport`). |
| Input report | Report sent from device to host (`inputreport` event). |
| Usage page | HID descriptor value that classifies a collection. The configuration collection uses vendor-defined usage page `0xFF02`. |
| VID / PID | USB Vendor ID / Product ID. |
| Packet | One 17-byte report: report ID + 16 payload bytes. |
| Packet checksum | Last packet byte, chosen so that all 17 bytes sum to `0x55` modulo 256. |
| Flash | The mouse's onboard non-volatile memory that stores its settings. Addressed by byte offset. |
| Field | A setting stored in flash: value bytes followed by one check byte. |
| Check byte | Last byte of a field, chosen so that all bytes of the field sum to `0x55` modulo 256. |
| DPI | Dots per inch. Mouse sensitivity. |
| DPI stage | One of up to 6 stored DPI presets that the mouse's DPI button cycles through. |
| LOD | Lift-off distance. Height at which the sensor stops tracking. |
| Motion sync | Sensor feature that aligns sensor frames with USB polling. |
| Angle snapping | Sensor feature that straightens near-horizontal/vertical movement. |
| Ripple control | Sensor feature that smooths jitter at high DPI. |
| Debounce | Minimum time between two registered clicks of one button. |
| Peak performance | Feature that keeps the sensor in high-performance mode for a set time. |
| Dongle | The USB wireless receiver (4K = 4000 Hz capable). |
| PWA | Progressive Web App. A website with a manifest and service worker that the browser can install like an app. |
| Service worker | Browser background script that intercepts the site's network requests (used here for offline caching). |
| Workers static assets | Cloudflare Workers feature that serves a directory of static files. |
| Workers Builds | Cloudflare's Git integration that builds and deploys a Worker on every push. |
| Wrangler | Cloudflare's CLI for developing and deploying Workers. |
| CSP | Content Security Policy. HTTP header that restricts what a page may load or execute. |

## 3. Requirements, Constraints & Guidelines

### Functional requirements

- **REQ-001**: The app shall request device access with `navigator.hid.requestDevice` using exactly the filters in section 4.2, triggered only by a user click on a "Connect" button.
- **REQ-002**: On page load the app shall call `navigator.hid.getDevices()` and connect automatically to a previously granted matching device. It shall handle `navigator.hid` `connect` and `disconnect` events. Limit: the mouse reports no USB serial number (protocol spec 4.1), so Chrome grants only a session permission that ends when the device is unplugged. After a replug or a browser restart the page cannot see the mouse until the user clicks Connect; the disconnect status says so.
- **REQ-003**: After connecting, the app shall read flash `0x00`-`0xBF` (20 reads of 10 bytes, the last read 2 bytes), the battery level (cmd `0x04`), and the firmware version (cmd `0x12`).
- **REQ-004**: The app shall display every in-scope setting decoded into human units (Hz, DPI, mm, ms, seconds, on/off, LP/HP).
- **REQ-005**: When the user changes a setting, the app shall write only the field(s) for that setting, then read them back and display the value read back from the device (see SAF-006).
- **REQ-006**: DPI stages: the user can set the stage count (1-6), the active stage, each stage's DPI (50-26000 in steps of 50), and each stage's indicator colour.
- **REQ-007**: The app shall refresh battery level every 60 seconds while connected and while the page is visible.
- **REQ-008**: The app shall re-read all settings when the page becomes visible again (`visibilitychange`), because the mouse's DPI button can change the active stage.
- **REQ-009**: Backup: the app shall export current settings as a JSON file matching section 4.7.
- **REQ-010**: Restore: the app shall import a JSON file matching section 4.7, validate it, show which settings differ, and on user confirmation write only the differing fields.
- **REQ-011**: If `navigator.hid` is undefined, the app shall show a message that a Chromium-based desktop browser is required, and hide device controls.
- **REQ-012**: The app shall show a persistent status line: disconnected / connecting / connected (wired or wireless) / busy / error message.
- **REQ-013**: The app shall be installable as a PWA (manifest + service worker per section 4.10) and its app shell shall load offline.
- **REQ-014**: Values that do not match any known option shall be displayed as `Unknown (0xNN)` and their control shall remain unchanged until the user picks a valid option.
- **REQ-015**: When the battery charging flag is `1`, the app shall display "Charging" and shall not display the percent byte, which is inflated while charging.
- **REQ-016**: Connection-dependent options, matching the vendor app:
  - **Report rate:** 8000 Hz is offered only over the cable (PID `0xF5FA`).
  - **Sensor mode:** over the cable it is displayed as "Corded" with the control disabled, and the stored value is neither shown nor written. Over the dongle the options are LP and HP.

### Safety requirements

- **SAF-001**: Command allowlist. The transport shall only send commands `0x04` (battery), `0x07` (write flash), `0x08` (read flash), `0x12` (version). Any other command shall throw before anything is sent.
- **SAF-002**: Write allowlist. Command `0x07` shall only target the address and length of a writable field in section 4.4. Any other address or length shall throw before sending.
- **SAF-003**: Every value shall be validated against the field's allowed set or range before encoding. Invalid values shall throw. `device.js` shall additionally reject 8000 Hz and any `sensorMode` write when connected over the dongle or cable respectively, per REQ-016.
- **SAF-004**: At most one command shall be in flight. Commands shall be queued and sent in order, at least 8 ms apart.
- **SAF-005**: A command with no matching reply within 600 ms shall be resent, up to 4 attempts in total. After the 4th timeout the command fails with a visible error.
- **SAF-006**: Every write shall be verified by reading the written range back. If it does not match, the write and verify shall be repeated once. If it still does not match, the app shall show an error and display the device's actual value.
- **SAF-007**: When the stage count is reduced below `activeStage + 1`, the app shall first write `dpiActiveStage = newCount - 1`, then write `dpiStageCount`.
- **SAF-008**: If any field read in REQ-003 fails its check-byte validation, the app shall show a warning naming the field. Writing a valid value to that field is permitted, because it repairs the field.
- **SAF-009**: The app shall never write fields marked read-only/preserved in section 4.4.

### Security requirements

- **SEC-001**: All scripts, styles, icons, and fonts shall be served from the app's own origin. No CDN, analytics, fonts service, or other third party.
- **SEC-002**: The app shall make no network requests other than loading its own static files. No device data leaves the browser.
- **SEC-003**: Responses shall carry the headers in section 4.9 (CSP, Permissions-Policy, and others).
- **SEC-004**: The app shall only be served over HTTPS (production) or `http://localhost` (development). WebHID requires a secure context.

### Constraints

- **CON-001**: WebHID is available only in Chromium-based desktop browsers (Chrome, Edge, Opera, Brave, Arc). Firefox and Safari are unsupported.
- **CON-002**: Hosting is static only: Cloudflare Workers with static assets, no Worker script (`main` is not set), no server-side code, no storage bindings.
- **CON-003**: No front-end framework, bundler, transpiler, or runtime dependency. Source files are native ES modules served as-is.
- **CON-004**: The only development dependency is `wrangler`. Tests use Node's built-in test runner (`node:test`).
- **CON-005**: The repository and deployed site shall not contain any file, image, icon, or text copied from the vendor's software. The UI is original.
- **CON-006**: `HIDDevice.sendReport(reportId, data)` takes the report ID separately. `data` is the 16 payload bytes. The packet checksum is still computed over the report ID plus the first 15 payload bytes.
- **CON-007**: On Linux the user must install a udev rule granting access to the hidraw device (see section 9). The README shall document it.
- **CON-008**: The official vendor program may hold the device open at the same time. The README shall tell users to close it while using the web driver.

### Guidelines and patterns

- **GUD-001**: Keep protocol logic pure (no DOM, no WebHID, no timers) in `protocol.js` so it runs in Node tests.
- **GUD-002**: Use native HTML controls (`select`, `input type="number|color|checkbox|range"`, `button`), each with a visible `label`. Keyboard operable.
- **GUD-003**: Support light and dark themes via `prefers-color-scheme`.
- **GUD-004**: Mark deliberate simplifications in code with a `ponytail:` comment naming the limit and the upgrade path.
- **PAT-001**: Table-driven fields. A single `FIELDS` table in `protocol.js` describes every setting (address, size, decode, encode, allowed values). Transport, UI, backup, and tests all use it. No address constants elsewhere.
- **PAT-002**: Device is the source of truth. The UI never shows a value that was not read from the device (no optimistic updates).

## 4. Interfaces & Data Contracts

### 4.1 Repository layout

```
hypernova/
├── public/                     # deployed as-is (Workers static assets directory)
│   ├── index.html
│   ├── style.css
│   ├── app.js                  # UI only: DOM binding, events, status line
│   ├── device.js               # WebHID transport, command queue, retries
│   ├── protocol.js             # pure: packets, checksums, FIELDS, codecs
│   ├── sw.js                   # service worker (network-first, cache fallback)
│   ├── manifest.webmanifest
│   ├── _headers                # response headers (section 4.9)
│   └── icons/                  # icon.svg, icon-192.png, icon-512.png (original artwork)
├── test/
│   └── protocol.test.js        # node:test unit tests
├── snapshots/
│   └── flash-baseline-2026-10-07.bin   # 512-byte flash dump, test fixture + restore reference
├── docs/
│   ├── spec-architecture-hypernova-web-driver.md   # this document
│   └── spec-data-hypernova-hid-protocol.md         # complete device protocol reference
├── README.md                   # usage, browser support, Linux udev rule
├── package.json                # "type": "module", scripts, devDependency wrangler
├── wrangler.jsonc
└── .gitignore
```

### 4.2 Device selection

```js
const FILTERS = [
  { vendorId: 0x3554, productId: 0xF5FA, usagePage: 0xFF02 }, // wired
  { vendorId: 0x3554, productId: 0xF5FB, usagePage: 0xFF02 }, // 4K dongle
];
```

- Vendor `0x3554` is shared by other mice built on the same platform with different flash layouts. Matching by PID is therefore mandatory. Do not broaden the filter to vendor-only.
- On Windows each HID collection is a separate `HIDDevice`. The usage-page filter selects the configuration collection (interface 1, collection 5, 17-byte in/out reports).
- The UI labels the connection "Wired" for PID `0xF5FA` and "Wireless (4K dongle)" for `0xF5FB`.

### 4.3 Packet format and commands

Full 17-byte packet (byte 0 is the report ID):

| Byte | Content |
|---|---|
| 0 | `0x08` report ID |
| 1 | command |
| 2 | `0x00` |
| 3 | address high byte |
| 4 | address low byte |
| 5 | length (0-10) |
| 6-15 | data (zero-padded) |
| 16 | packet checksum = `(0x55 - sum(bytes 0..15)) & 0xFF` |

WebHID mapping: `sendReport(0x08, payload)` where `payload = bytes[1..16]` (16 bytes). In `inputreport` events, `event.reportId === 0x08` and `event.data` holds `bytes[1..16]`.

A reply is valid when `event.reportId === 0x08` and `(0x08 + sum(payload)) & 0xFF === 0x55`. A reply matches a request when `payload[0]` (command), `payload[2]` (addr high), and `payload[3]` (addr low) equal the request's. Non-matching or invalid input reports are ignored.

Allowlisted commands (SAF-001):

| Cmd | Name | Request addr / len / data | Reply data (`payload[5..]`) |
|---|---|---|---|
| `0x04` | Read battery | 0 / 0 / none | `[percent, charging, mV_hi, mV_lo]`. `charging` = `1` while charging, when `percent` is inflated (REQ-015) |
| `0x07` | Write flash | field addr / field size / field bytes incl. check byte | echo of the request |
| `0x08` | Read flash | addr / 1-10 / none | `len` bytes of flash starting at addr |
| `0x12` | Read version | 0 / 0 / none | `[major, minor]`, displayed as `${major.toString(16)}.${minor.toString(16).padStart(2,'0')}` (e.g. `02 17` → `2.17`) |

### 4.4 Settings fields (flash map)

Field byte layout: value bytes followed by one check byte so the field sums to `0x55`. 2-byte fields: `[v, (0x55 - v) & 0xFF]`. 4-byte fields: `[a, b, c, (0x55 - a - b - c) & 0xFF]`.

**Writable fields:**

| Key | Addr | Size | Allowed values (human → raw) |
|---|---|---|---|
| `reportRateHz` | `0x00` | 2 | 125→`0x08`, 250→`0x04`, 500→`0x02`, 1000→`0x01`, 2000→`0x10`, 4000→`0x20`. Cable only: 8000→`0x40` (REQ-016) |
| `dpiStageCount` | `0x02` | 2 | 1-6 → same |
| `dpiActiveStage` | `0x04` | 2 | 0 to `dpiStageCount - 1` → same |
| `lodMm` | `0x0A` | 2 | 1→`1`, 2→`2`. Raw `3` decodes to 0.7 (display-only; the vendor app offers 0.7 mm only for PAW3950 mice) |
| `dpiStages[i].dpi` (i = 0-5) | `0x0C + 4i` | 4 | 50-26000, multiple of 50 → DPI codec (4.5) |
| `dpiStages[i].color` (i = 0-5) | `0x2C + 4i` | 4 | `#rrggbb` → `[R, G, B]` |
| `debounceMs` | `0xA9` | 2 | 0-20 → same. Show a low-debounce warning for values ≤ 3 (as the vendor app does) |
| `motionSync` | `0xAB` | 2 | false→`0`, true→`1` |
| `sleepSeconds` | `0xAD` | 2 | 10, 30, 60, 300, 600, 900, 1200, 1500, 1800, 2100, 2400 → value / 10 |
| `angleSnapping` | `0xAF` | 2 | false→`0`, true→`1` |
| `rippleControl` | `0xB1` | 2 | false→`0`, true→`1` |
| `peakPerformance` | `0xB5` | 2 | false→`0`, true→`1` |
| `peakPerformanceTime` | `0xB7` | 2 | "30 s"→`3`, "1 min"→`6`, "2 min"→`30`, "5 min"→`60`, "10 min"→`90`, "15 min"→`120`. Labels and raw values are copied from the vendor app so both tools agree; the true durations are unconfirmed (protocol spec OQ-001) |
| `sensorMode` | `0xB9` | 2 | "LP"→`0`, "HP"→`1`. Dongle only (REQ-016). Raw `2` decodes to "Corded" (display-only) |

**Read-only / preserved (never written, SAF-009):** `0x06`, `0x08` (unknown "spindown" fields), `0x4C`-`0x5F` (DPI indicator LED), `0x60`-`0x9F` (button map), `0xA0`-`0xA8` (lighting), `0xB3` (move-off LED), `0xBB` (unknown). DPI stage slots 6-7 (`0x24`-`0x2B`, `0x44`-`0x4B`) are also preserved.

### 4.5 DPI codec

```
encode(dpi):  v  = dpi / 50 - 1                 // 0..519
              hi = (v >> 8) & 0x3
              bytes = [v & 0xFF, v & 0xFF, (hi << 2) | (hi << 6)]
decode(a,b,c): vx = a | (((c >> 2) & 0x3) << 8);  vy = b | (((c >> 6) & 0x3) << 8)
              dpiX = (vx + 1) * 50;  dpiY = (vy + 1) * 50
```

If `dpiX !== dpiY` (set by another tool), display both values ("X / Y"). Editing writes the same value to both.

### 4.6 Module interfaces

`protocol.js` (pure, no side effects):

```js
export const REPORT_ID = 0x08;
export const CMD = { BATTERY: 0x04, WRITE: 0x07, READ: 0x08, VERSION: 0x12 };
export const FIELDS;                                   // section 4.4, see PAT-001
export function buildPayload(cmd, addr, len, data = []) // → Uint8Array(16); enforces SAF-001/002
export function parseReply(reportId, payload)          // → { cmd, addr, len, data } | null
export function encodeField(key, value)                // → Uint8Array incl. check byte; enforces SAF-003
export function decodeSettings(flash)                  // flash: Uint8Array(192) → { settings, errors: [{ key, addr }] }
export function diffSettings(a, b)                     // → array of keys whose values differ
export function encodeDpi(dpi) / decodeDpi(bytes)
```

`device.js`:

```js
export class Hypernova extends EventTarget {
  static async request()            // REQ-001, returns instance or null if user cancels
  static async reconnect()          // REQ-002, returns instance or null
  get connection()                  // "wired" | "wireless"
  async readSettings()              // → { settings, errors }
  async writeSetting(key, value)    // writes + verifies (SAF-005..007), → read-back value
  async readBattery()               // → { percent, charging, millivolts }
  async readVersion()               // → "2.17"
  async close()
  // events: "disconnect"
}
```

`app.js` uses only the `Hypernova` API and `FIELDS` metadata. It never builds packets.

### 4.7 Backup file format

```json
{
  "format": "hypernova-settings",
  "version": 1,
  "exportedAt": "2026-10-07T12:00:00.000Z",
  "firmware": "2.17",
  "settings": {
    "reportRateHz": 1000,
    "dpiStageCount": 1,
    "dpiActiveStage": 0,
    "dpiStages": [
      { "dpi": 800, "color": "#ff0000" },
      { "dpi": 2400, "color": "#00ff00" },
      { "dpi": 3200, "color": "#0000ff" },
      { "dpi": 4800, "color": "#ffff00" },
      { "dpi": 8000, "color": "#00ffff" },
      { "dpi": 26000, "color": "#ff00ff" }
    ],
    "lodMm": 1,
    "debounceMs": 2,
    "motionSync": true,
    "sleepSeconds": 300,
    "angleSnapping": false,
    "rippleControl": false,
    "peakPerformance": false,
    "peakPerformanceTime": "1 min",
    "sensorMode": "LP"
  }
}
```

Import rejects files where `format` is not `hypernova-settings`, `version` is not `1`, a key is missing, or a value fails SAF-003. Unknown extra keys are ignored. Values not allowed on the current connection are skipped with a notice: `reportRateHz: 8000` over the dongle, and `sensorMode` over the cable. `sensorMode` is exported only when connected over the dongle.

### 4.8 Deployment

`wrangler.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "hypernova",
  "compatibility_date": "2026-10-01",
  "assets": { "directory": "./public" }
}
```

`package.json` scripts: `"test": "node --test"`, `"dev": "wrangler dev"`, `"deploy": "wrangler deploy"`.

Cloudflare Workers Builds (configured once in the Cloudflare dashboard, connected to the GitHub repo):

| Setting | Value |
|---|---|
| Production branch | `main` |
| Build command | `npm test` |
| Deploy command | `npx wrangler deploy` |
| Root directory | `/` |

A failing test aborts the build, so broken code is never deployed. Pushes to other branches create preview versions.

### 4.9 Response headers (`public/_headers`)

```
/*
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
  Permissions-Policy: hid=(self)
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
```

### 4.10 PWA

- `manifest.webmanifest`: `name` "Hypernova Web Driver", `short_name` "Hypernova", `start_url` "/", `scope` "/", `display` "standalone", `background_color` and `theme_color` matching the page, icons 192×192 and 512×512 PNG (`purpose: "any"`).
- `sw.js`: precache the app shell (all files in `public/` except `_headers`). Fetch strategy is network-first with cache fallback, so a new deployment is picked up on the next online load. Cache name includes a version string. `activate` deletes caches with other names.
- The service worker only handles same-origin `GET` requests.

## 5. Acceptance Criteria

- **AC-001**: Given Chrome on Windows with the dongle plugged in, When the user clicks Connect and selects the device, Then all in-scope settings, battery percent, and firmware version are displayed within 3 seconds while the mouse is awake.
- **AC-002**: Given a previously granted device, When the page is reloaded, Then it connects without showing the device chooser (REQ-002).
- **AC-003**: Given the connected mouse, When the user turns angle snapping on, Then exactly one `0x07` packet `08 07 00 00 AF 02 01 54 …` is sent, the read-back shows `01 54`, and the toggle shows "on".
- **AC-004**: Given the connected mouse, When the user sets stage 1 to 1600 DPI, Then flash `0x0C`-`0x0F` reads back `1F 1F 00 17` and the UI shows 1600.
- **AC-005**: Given stage count 4 with active stage 3, When the user sets stage count to 2, Then `dpiActiveStage` is written to 1 before `dpiStageCount` is written to 2 (SAF-007).
- **AC-006**: Given the mouse is idle and drops the first command, When the app reads settings, Then the dropped command is retried and the read completes without user action (SAF-005).
- **AC-007**: Given the mouse is switched off, When the user changes a setting, Then after 4 attempts the status line shows an error, and the control shows the last value read from the device.
- **AC-008**: Given any code path, When a command other than `0x04`, `0x07`, `0x08`, `0x12` is passed to the transport, Then it throws and nothing is sent (SAF-001).
- **AC-009**: Given Firefox or Safari, When the page loads, Then a message says a Chromium-based desktop browser is required and no device controls are shown.
- **AC-010**: Given an exported backup, When the user changes several settings and then restores the backup, Then the differing settings are listed, and after confirmation a fresh read equals the backup.
- **AC-011**: Given a malformed backup file, When it is imported, Then it is rejected with a message and nothing is written.
- **AC-012**: Given a push to `main` with a failing unit test, When Workers Builds runs, Then the deployment is not published.
- **AC-013**: Given the site was visited once, When the browser is offline and the page is opened, Then the app shell loads.
- **AC-014**: Given the deployed site, When its response headers are inspected, Then they include the CSP and `Permissions-Policy: hid=(self)` from section 4.9.
- **AC-015**: Given a cable connection, When the report rate options are shown, Then 8000 Hz is offered and sensor mode shows "Corded" (disabled). Given a dongle connection, Then 8000 Hz is not offered and sensor mode offers LP and HP.
- **AC-016**: Given the mouse is charging, When battery is displayed, Then the app shows "Charging" and no percentage.

## 6. Test Automation Strategy

- **Test levels**:
  - Unit (automated): `protocol.js` via `node:test`.
  - Hardware integration (manual): checklist in section 10, run against a real mouse before tagging a release.
- **Frameworks**: Node built-in `node:test` and `node:assert/strict`. No third-party test libraries.
- **Test data**: `snapshots/flash-baseline-2026-10-07.bin` (512 bytes, read from the device on 2026-10-07) and the captured packets in section 9. Fixtures are read-only and never regenerated by tests.
- **Required unit tests**:
  - Packet checksum reproduces every captured packet in section 9.
  - `parseReply` accepts the captured replies and rejects a reply with one corrupted byte.
  - `decodeSettings(baseline)` returns the settings object in section 4.7 with `errors` empty.
  - Every writable field: encode → decode round-trip for every allowed value; check byte valid.
  - DPI codec: 50, 800, 12800, 12850, 25600, 26000. 800 → `0F 0F 00`, 26000 → `07 07 88`.
  - `buildPayload` throws for disallowed commands, preserved addresses, and wrong lengths.
  - `encodeField` throws for out-of-range or non-multiple-of-50 DPI, unknown enum values.
- **CI/CD**: Workers Builds runs `npm test` before `npx wrangler deploy` on every push (section 4.8).
- **Coverage**: every `FIELDS` entry and every exported function of `protocol.js` has at least one test. No numeric percentage target.
- **Performance**: manual check that a full settings read (20 commands) completes in under 2 seconds with the mouse awake.

## 7. Rationale & Context

- **Browser-side only.** USB devices are only reachable from the computer they are plugged into, through the browser. A server (Cloudflare or a Docker container) cannot reach them, so the server only delivers static files. This keeps hosting free and removes all backend security concerns.
- **Cloudflare Workers static assets** instead of Pages: Cloudflare recommends Workers for new projects. Static asset requests are free, HTTPS is automatic, and Workers Builds gives push-to-deploy from GitHub with a test gate.
- **No framework or bundler.** The app is one page with about a dozen controls. Native ES modules and HTML controls are enough, and there is no build output to keep in sync.
- **Per-field writes with read-back** mirror what the vendor program does (it diffs and writes changed fields only). This minimises flash writes and makes every change verifiable.
- **Allowlists (SAF-001, SAF-002).** The protocol includes commands that change USB IDs, enter the bootloader, or re-pair the dongle. Making them unreachable in code is the main protection against bricking.
- **Retries (SAF-005).** On 2026-10-07 the dongle was observed silently dropping the first command after the mouse had been idle. Command `0x03` (online status) answered `01` even while drops happened, so it cannot be used as a wake check. Retrying is the only reliable method.
- **PID-specific filter.** Vendor ID `0x3554` is used by other products on the same platform. Writing this layout to a different product could misconfigure it.
- **Excluded features.** Button remapping and macros are not needed by the owner. LED effects, lighting, long-range mode, and profiles have undecoded encodings (protocol spec OQ-003 to OQ-006).
- **Vendor-matching option lists.** Option lists (LOD, report rates, peak performance labels) copy the vendor app so the two tools always display the same choice for the same stored value.

### 7.1 Open questions

Resolved on 2026-10-07:

- ~~OQ-001~~: Debounce range is 0-20 ms (vendor app dropdown, confirmed by owner).
- ~~OQ-002~~: Battery byte 2 is the charging flag (`01` observed while charging over the cable).
- ~~OQ-003~~: Cable mode verified: same collection layout, reads and writes work identically.
- ~~OQ-004~~: 4-byte writes verified over the cable: stage 0 DPI 800 → 1600 → 800 and colour red → green → red, each read back. Final diff against the pre-test read was empty.

Open:

- **OQ-005**: True duration of peak performance times above 1 min (protocol spec OQ-001). The app follows the vendor labels. No action needed for v1.

## 8. Dependencies & External Integrations

### External Systems

- **EXT-001**: Cosmic Byte Hypernova mouse, firmware v2.17 (tested), via USB cable (PID `0xF5FA`) or 4K dongle (PID `0xF5FB`). HID output/input reports, report ID `0x08`.

### Third-Party Services

- **SVC-001**: Cloudflare Workers (free plan): static asset hosting over HTTPS on `*.workers.dev`, optional custom domain.
- **SVC-002**: Cloudflare Workers Builds: builds on push from GitHub, runs the test gate, deploys.
- **SVC-003**: GitHub: source repository and push trigger.

### Infrastructure Dependencies

- **INF-001**: None besides SVC-001. No databases, KV, R2, queues, or server code.

### Data Dependencies

- **DAT-001**: `docs/spec-data-hypernova-hid-protocol.md`: complete reverse-engineered protocol reference.
- **DAT-002**: `snapshots/flash-baseline-2026-10-07.bin`: device flash snapshot used as a test fixture and restore reference.

### Technology Platform Dependencies

- **PLT-001**: Chromium-based desktop browser with WebHID (Chrome/Edge 89+ era API; current versions).
- **PLT-002**: Node.js current LTS for tests and Wrangler (local and in Workers Builds).
- **PLT-003**: Wrangler CLI (development dependency only).

### Compliance Dependencies

- **COM-001**: The app is an unofficial interoperability tool. The README and page footer shall state it is not affiliated with Cosmic Byte. No vendor assets are redistributed (CON-005).

## 9. Examples & Edge Cases

Captured packets (full 17 bytes; WebHID payload = bytes 1-16):

```text
Read flash 0x00, 10 bytes
TX 08 08 00 00 00 0A 00 00 00 00 00 00 00 00 00 00 3B
RX 08 08 00 00 00 0A 01 54 01 54 00 55 00 55 00 55 92

Write angle snapping = on (0xAF)
TX 08 07 00 00 AF 02 01 54 00 00 00 00 00 00 00 00 40
RX 08 07 00 00 AF 02 01 54 00 00 00 00 00 00 00 00 40

Battery
TX 08 04 00 00 00 00 00 00 00 00 00 00 00 00 00 00 49
RX 08 04 00 00 00 02 28 00 0E E0 00 00 00 00 00 00 31     -> 40 %, not charging, 3808 mV
RX 08 04 00 00 00 02 5F 01 10 01 00 00 00 00 00 00 D6     -> charging (percent byte 95 is inflated), 4097 mV

Write stage 0 DPI = 1600 (4-byte field)
TX 08 07 00 00 0C 04 1F 1F 00 17 00 00 00 00 00 00 E1
RX 08 07 00 00 0C 04 1F 1F 00 17 00 00 00 00 00 00 E1

Version
TX 08 12 00 00 00 00 00 00 00 00 00 00 00 00 00 00 3B
RX 08 12 00 00 00 02 02 17 00 00 00 00 00 00 00 00 20     -> 2.17
```

Checksum and field encoding:

```js
const checksum = (bytes) => (0x55 - bytes.reduce((s, b) => s + b, 0)) & 0xFF;

checksum([0x08, 0x07, 0, 0, 0xAF, 0x02, 0x01, 0x54, 0, 0, 0, 0, 0, 0, 0, 0]); // 0x40
encodeField('angleSnapping', true);        // Uint8Array [0x01, 0x54]
encodeField('reportRateHz', 4000);         // Uint8Array [0x20, 0x35]
encodeField('sleepSeconds', 300);          // Uint8Array [0x1E, 0x37]
encodeDpi(26000);                          // [0x07, 0x07, 0x88]  (+ check 0xBF)
encodeField('reportRateHz', 3000);         // throws (not an option)
encodeField('lodMm', 0.7);                 // throws (not offered for the PAW3395)
encodeField('dpiStages.0.dpi', 825);       // throws (not a multiple of 50)
buildPayload(0x0D, 0, 0);                  // throws (bootloader command, not allowlisted)
buildPayload(0x07, 0x60, 4, [1, 1, 0, 0x53]); // throws (button map is preserved)
```

Edge cases:

| Case | Required behaviour |
|---|---|
| Mouse asleep / first command dropped | Retry per SAF-005. Status shows "Waiting for mouse... move it to wake it" after the 2nd attempt. |
| Mouse switched off, dongle present | Fail after 4 attempts with a clear error. Controls keep last read values. |
| Device unplugged mid-write | `disconnect` event → status "Disconnected. Plug the mouse back in, then click Connect.", controls disabled, queue rejected. |
| Device replugged | No `connect` event reaches the page (no serial number, see REQ-002). The user clicks Connect. |
| Raw value not in option table (e.g. report rate `0x40`) | Display `Unknown (0x40)` (REQ-014). Do not write until the user chooses a valid option. |
| Check byte invalid on read | Warning naming the field (SAF-008). Value shown as `Invalid`. |
| DPI X ≠ Y in flash | Display "X / Y". Editing writes the same value to both. |
| Active stage ≥ stage count in flash | Display a warning and offer to set active stage to 0. |
| Vendor app open at the same time | Works, but both programs may overwrite each other. The README tells users to close it. |
| Both cable and dongle granted | Use the device the user picked. On auto-reconnect prefer wired. |
| Linux without udev rule | `open()` fails. Show a message linking to the README udev section. |
| Mouse charging | Show "Charging", hide percent (REQ-015). |
| Report rate is 8000 Hz and user switches to the dongle | Display the value read from the device; if it is unknown or unsupported on this connection, follow REQ-014. |

Linux udev rule (README):

```text
# /etc/udev/rules.d/70-hypernova.rules
SUBSYSTEM=="hidraw", ATTRS{idVendor}=="3554", ATTRS{idProduct}=="f5fa|f5fb", TAG+="uaccess"
```

## 10. Validation Criteria

The implementation complies with this spec when:

1. `npm test` passes and covers every item listed under "Required unit tests" in section 6.
2. A code search finds no flash address literals outside `FIELDS` in `protocol.js` (PAT-001), and no `sendReport` call outside `device.js`.
3. The deployed site returns the headers in section 4.9 and loads no third-party resources (DevTools network panel shows only same-origin requests).
4. Lighthouse (or Chrome's install prompt) reports the app as installable.
5. Manual hardware checklist, run over the 4K dongle and over the cable:
   - Connect, all values match the vendor app's display.
   - Change and restore each writable setting once. Each change verified by read-back.
   - DPI: set stage values 800, 1600, 26000. Add and remove stages, including SAF-007 ordering.
   - Export backup, change settings, restore backup, re-read equals backup.
   - Leave the mouse idle for 1 minute, then read settings: completes via retries.
   - Final state equals `snapshots/flash-baseline-2026-10-07.bin` for `0x00`-`0xBF` (or the user's intended settings).
6. Open questions in section 7.1 are resolved or explicitly deferred.

## 11. Related Specifications / Further Reading

- [spec-data-hypernova-hid-protocol.md](spec-data-hypernova-hid-protocol.md): complete device protocol reference, including commands and fields that are out of scope here.
- [WebHID API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/WebHID_API)
- [WebHID specification (WICG)](https://wicg.github.io/webhid/)
- [Cloudflare Workers static assets](https://developers.cloudflare.com/workers/static-assets/)
- [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
- [Web app manifest (MDN)](https://developer.mozilla.org/en-US/docs/Web/Manifest)
