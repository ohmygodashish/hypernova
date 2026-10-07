# Plan: Hypernova Web Driver v1

- **Spec (binding):** `docs/spec-architecture-hypernova-web-driver.md`
- **Protocol reference:** `docs/spec-data-hypernova-hid-protocol.md`
- **Branch:** `feat/web-driver`
- **Test fixture:** `snapshots/flash-baseline-2026-10-07.bin` (512 bytes, read-only)

Six tasks, executed in order. Each task ends with passing tests (where it has any) and one or more commits.

## Global Constraints

- **G1 Stack:** No framework, bundler, transpiler, or runtime dependency. Browser code is native ES modules in `public/`, served as-is. The only devDependency is `wrangler`. Tests use only `node:test` and `node:assert/strict`.
- **G2 Layout:**
  - `public/`: `index.html`, `style.css`, `app.js`, `device.js`, `protocol.js`, `sw.js`, `manifest.webmanifest`, `_headers`, `icons/`
  - `test/`: unit tests
  - `scripts/`: icon generator only
  - root: `package.json`, `package-lock.json`, `wrangler.jsonc`, `README.md`, `.gitattributes`, `.gitignore`
  - already present (leave as is): `LICENSE`, `docs/`, `snapshots/`

  Do not add other files or directories.
- **G3 Single source:** Flash addresses and sizes appear only in `FIELDS` in `public/protocol.js`. Only `public/device.js` calls `sendReport`. `app.js` never builds packets.
- **G4 Safety:**
  - The transport sends only commands `0x04`, `0x07`, `0x08`, `0x12`.
  - `0x07` targets only the exact address and size of a writable `FIELDS` entry.
  - Every value is validated before encoding.
  - Preserved regions are never written.
- **G5 No hardware:** No code, test, or command in this plan opens or sends to a real HID device. Tests use in-memory fakes. Live device testing is done by the controller after the final review.
- **G6 CSP:** The page runs under `default-src 'self'; script-src 'self'; style-src 'self'; …` (spec 4.9). This rules out:
  - inline `<script>` or `<style>` blocks
  - `style="…"` attributes
  - `on*=` handler attributes
  - `eval` or `new Function`
  - any external URL

  Use classes and the `hidden` attribute for visual state.
- **G7 Originality:** No file, image, icon, or text from the vendor's software. The page footer states: "Unofficial project. Not affiliated with Cosmic Byte."
- **G8 Commits:**
  - Format: Conventional Commits, `type(scope): summary`. Types: `feat`, `fix`, `test`, `docs`, `build`, `chore`, `refactor`, `style`. Scopes: `protocol`, `device`, `ui`, `pwa`, `build`, `docs`, `test`.
  - **No `Co-Authored-By` trailer and no trailer or text crediting Claude or any AI.**
  - Commit with the repository's configured git identity. Never modify git config.
- **G9 Line endings:** LF (enforced by `.gitattributes` from Task 1).
- **G10 Tests:** `npm test` (= `node --test`) passes with pristine output (no warnings) on Node ≥ 22.
- **G11 Simplicity:** One responsibility per file. Mark deliberate simplifications with a `// ponytail:` comment naming the limit and the upgrade path.

---

### Task 1: Project scaffold and deploy configuration

**Goal:** A deployable, empty-but-valid Workers static-assets project with security headers and LF line endings.

**Files to create:**

1. `package.json` (exactly these fields; the wrangler version is whatever `npm install` resolves, written by npm):
   ```json
   {
     "name": "hypernova",
     "private": true,
     "type": "module",
     "scripts": {
       "test": "node --test",
       "dev": "wrangler dev",
       "deploy": "wrangler deploy"
     },
     "devDependencies": {}
   }
   ```
   Then run `npm install --save-dev wrangler` so `devDependencies.wrangler` and `package-lock.json` are populated. Commit `package-lock.json`. Do not commit `node_modules/`.
2. `wrangler.jsonc`:
   ```jsonc
   {
     "$schema": "node_modules/wrangler/config-schema.json",
     "name": "hypernova",
     "compatibility_date": "2026-10-01",
     "assets": { "directory": "./public" }
   }
   ```
3. `public/_headers` (verbatim; two-space indentation under `/*`):
   ```
   /*
     Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
     Permissions-Policy: hid=(self)
     X-Content-Type-Options: nosniff
     Referrer-Policy: no-referrer
   ```
4. `.gitattributes`:
   ```
   * text=auto eol=lf
   *.bin binary
   *.png binary
   ```
   After adding it, run `git add --renormalize .` and include any renormalized files in the same commit.

**Verify:**
- `npx wrangler deploy --dry-run` succeeds, which validates the config. It must not deploy anything.
- `git status` is clean after committing.

**Commits:** `build: add package.json, wrangler config, security headers and gitattributes` (one commit is fine).

---

### Task 2: `public/protocol.js` (pure protocol logic) and `test/protocol.test.js`

**Goal:** All packet building, parsing, field encoding/decoding, backup serialization, and validation as pure functions. No DOM, no WebHID, no timers.

**Exports (exact names and signatures):**

```js
export const REPORT_ID = 0x08;
export const CMD = Object.freeze({ BATTERY: 0x04, WRITE: 0x07, READ: 0x08, VERSION: 0x12 });
export const SETTINGS_SIZE = 0xC0;   // bytes read on connect: flash 0x00..0xBF
export const STAGES = 6;             // DPI stages exposed by the app
export const FIELDS;                 // frozen array, see table below
export function checksum(bytes)                     // (0x55 - sum(bytes)) & 0xFF
export function buildPayload(cmd, addr = 0, len = 0, data = [])  // → Uint8Array(16)
export function parseReply(reportId, payload)       // → { cmd, addr, len, data } | null
export function encodeField(key, value)             // → Uint8Array(size), check byte included
export function decodeField(key, bytes)             // → { value } | { error: 'bad-check' | 'unknown-value', raw: number[] }
export function decodeSettings(flash)               // → { settings, errors }
export function getSetting(settings, key)           // reads a FIELDS key from a nested settings object
export function diffSettings(a, b)                  // → FIELDS keys (in FIELDS order) whose values differ
export function encodeDpi(dpi)                      // → [b0, b1, b2] (no check byte); throws if invalid
export function decodeDpi(bytes)                    // → { x, y }
export function decodeBattery(data)                 // → { percent, charging, millivolts }
export function decodeVersion(data)                 // → string, e.g. "2.17"
export function toBackup(settings, { firmware, connection, now })  // → backup object (spec 4.7)
export function parseBackup(input, { connection })  // → { settings, skipped: [{ key, reason }] }; throws Error on invalid
```

**`FIELDS` entries.** Each entry is `{ key, addr, size, kind, options?, readOnlyOptions?, min?, max? }`, frozen, in this exact order:

| key | addr | size | kind | values (human → raw) |
|---|---|---|---|---|
| `reportRateHz` | `0x00` | 2 | `enum` | options: 125→`0x08`, 250→`0x04`, 500→`0x02`, 1000→`0x01`, 2000→`0x10`, 4000→`0x20`, 8000→`0x40` |
| `dpiStageCount` | `0x02` | 2 | `int` | min 1, max 6 |
| `dpiActiveStage` | `0x04` | 2 | `int` | min 0, max 5 |
| `lodMm` | `0x0A` | 2 | `enum` | options: 1→`1`, 2→`2`. readOnlyOptions: 0.7→`3` |
| `dpiStages.<i>.dpi`, i = 0..5 | `0x0C + 4i` | 4 | `dpi` | 50-26000, multiple of 50 |
| `dpiStages.<i>.color`, i = 0..5 | `0x2C + 4i` | 4 | `color` | `#rrggbb`, lowercase hex |
| `debounceMs` | `0xA9` | 2 | `int` | min 0, max 20 |
| `motionSync` | `0xAB` | 2 | `bool` | false→`0`, true→`1` |
| `sleepSeconds` | `0xAD` | 2 | `enum` | 10→1, 30→3, 60→6, 300→30, 600→60, 900→90, 1200→120, 1500→150, 1800→180, 2100→210, 2400→240 |
| `angleSnapping` | `0xAF` | 2 | `bool` | false→`0`, true→`1` |
| `rippleControl` | `0xB1` | 2 | `bool` | false→`0`, true→`1` |
| `peakPerformance` | `0xB5` | 2 | `bool` | false→`0`, true→`1` |
| `peakPerformanceTime` | `0xB7` | 2 | `enum` | `"30 s"`→3, `"1 min"`→6, `"2 min"`→30, `"5 min"`→60, `"10 min"`→90, `"15 min"`→120 |
| `sensorMode` | `0xB9` | 2 | `enum` | options: `"LP"`→0, `"HP"`→1. readOnlyOptions: `"Corded"`→2 |

Field order in `FIELDS`: as listed, with all six `dpiStages.<i>.dpi` entries (i ascending) followed by all six `dpiStages.<i>.color` entries.

**Encoding rules:**
- **2-byte field:** `[raw, (0x55 - raw) & 0xFF]`.
- **4-byte field:** `[a, b, c, (0x55 - a - b - c) & 0xFF]`.
- **DPI:** `v = dpi/50 - 1`, `hi = (v >> 8) & 3`, bytes `[v & 0xFF, v & 0xFF, (hi << 2) | (hi << 6)]`.
- **Colour:** `[R, G, B]` parsed from `#rrggbb`. Accept upper case on input; decode to lower case.
- **`encodeField` throws `Error`:**
  - unknown key
  - enum value not in `options` (readOnlyOptions are **not** encodable)
  - int out of range or not an integer
  - non-boolean for bool
  - DPI out of range or not a multiple of 50
  - malformed colour

**Decoding rules:**
- `decodeDpi(bytes)` → `vx = b0 | (((b2 >> 2) & 3) << 8)`, `vy = b1 | (((b2 >> 6) & 3) << 8)`, return `{ x: (vx + 1) * 50, y: (vy + 1) * 50 }`.
- `decodeField(key, bytes)`:
  - Bad check byte (sum of all field bytes mod 256 ≠ `0x55`) → `{ error: 'bad-check', raw }`.
  - Enum raw found in neither `options` nor `readOnlyOptions` → `{ error: 'unknown-value', raw }`.
  - Bool raw other than 0/1 → `unknown-value`.
  - Int raw outside min..max → `unknown-value`.
  - DPI value is a number when x === y, otherwise `{ x, y }`.
  - `raw` is the field's bytes as a plain number array.
- `decodeSettings(flash)` takes a `Uint8Array` of at least `SETTINGS_SIZE` bytes and returns:
  - `settings`: nested object matching spec 4.7 `settings` (keys: `reportRateHz`, `dpiStageCount`, `dpiActiveStage`, `dpiStages` (array of 6 `{ dpi, color }`), `lodMm`, `debounceMs`, `motionSync`, `sleepSeconds`, `angleSnapping`, `rippleControl`, `peakPerformance`, `peakPerformanceTime`, `sensorMode`). A field with an error has value `null`.
  - `errors`: `[{ key, addr, reason, raw }]`, where `reason` is `'bad-check'` or `'unknown-value'`.
- `getSetting(settings, 'dpiStages.2.color')` reads the nested path.
- `diffSettings(a, b)` compares with deep equality for `{ x, y }` values.

**Packet rules:**
- `buildPayload` returns 16 bytes: `[cmd, 0x00, addr >> 8, addr & 0xFF, len, data…(zero-padded to 10), checksum([REPORT_ID, …first 15 bytes])]`.
- It throws `Error` when any of these hold:
  - `cmd` is not a `CMD` value
  - `READ` with `len` < 1 or > 10, or `addr + len > 0x200`
  - `BATTERY`/`VERSION` with non-zero `addr`/`len` or any data
  - `WRITE` whose (`addr`, `len`) is not exactly (`addr`, `size`) of a `FIELDS` entry, or `data.length !== len`, or `data` not summing to `0x55` mod 256
- `parseReply(reportId, payload)` accepts a `Uint8Array` or `DataView` of 16 bytes. It returns `null` unless `reportId === 0x08`, the length is 16, and `(0x08 + sum(payload)) & 0xFF === 0x55`. Otherwise it returns `{ cmd: p[0], addr: (p[2] << 8) | p[3], len: p[4], data: Uint8Array(10) of p[5..14] }`.

**Battery/version:**
- `decodeBattery(data)` → `{ percent: data[0], charging: data[1] === 1, millivolts: (data[2] << 8) | data[3] }`.
- `decodeVersion(data)` → `` `${data[0].toString(16)}.${data[1].toString(16).padStart(2, '0')}` ``.

**Backup (spec 4.7):**
- `toBackup` returns `{ format: 'hypernova-settings', version: 1, exportedAt: now.toISOString(), firmware, settings }`.
  - `settings` copies all keys of the nested settings object.
  - `sensorMode` is omitted when `connection === 'wired'`.
  - It throws if any setting is `null` (refuse to back up corrupt/unknown values).
- `parseBackup(input, { connection })` accepts a JSON string or an object.
  - **Throws** `Error` with a human-readable message if:
    - `format` ≠ `'hypernova-settings'` or `version` ≠ 1
    - any key other than `sensorMode` is missing
    - `dpiStages` is not an array of 6 `{ dpi, color }`
    - any value fails `encodeField`
  - **Skips** (reported in `skipped`, not written) values not allowed on this connection:
    - `reportRateHz: 8000` when `connection === 'wireless'` (reason `'8000 Hz is only available over the cable'`)
    - `sensorMode` when `connection === 'wired'` (reason `'Sensor mode is fixed (Corded) over the cable'`)
    - `sensorMode: 'Corded'` on any connection
  - Unknown extra keys are ignored.
  - Returns `{ settings, skipped }`, where `settings` holds only the accepted keys, nested like `decodeSettings`.

**Tests (`test/protocol.test.js`, read the fixture via `new URL('../snapshots/flash-baseline-2026-10-07.bin', import.meta.url)`):**

1. `checksum` reproduces byte 16 of every captured packet below. `buildPayload` reproduces each captured TX payload (bytes 1-16):
   ```
   TX 08 08 00 00 00 0A 00 00 00 00 00 00 00 00 00 00 3B   read 0x00 len 10
   TX 08 07 00 00 AF 02 01 54 00 00 00 00 00 00 00 00 40   write angleSnapping on
   TX 08 07 00 00 0C 04 1F 1F 00 17 00 00 00 00 00 00 E1   write stage 0 dpi 1600
   TX 08 07 00 00 2C 04 00 FF 00 56 00 00 00 00 00 00 C1   write stage 0 colour green
   TX 08 04 00 00 00 00 00 00 00 00 00 00 00 00 00 00 49   battery
   TX 08 12 00 00 00 00 00 00 00 00 00 00 00 00 00 00 3B   version
   ```
2. `parseReply` accepts each captured RX (bytes 1-16, reportId 8) and returns null when any single byte is altered or reportId ≠ 8:
   ```
   RX 08 08 00 00 00 0A 01 54 01 54 00 55 00 55 00 55 92
   RX 08 07 00 00 AF 02 01 54 00 00 00 00 00 00 00 00 40
   RX 08 04 00 00 00 02 28 00 0E E0 00 00 00 00 00 00 31   → decodeBattery: { percent: 40, charging: false, millivolts: 3808 }
   RX 08 04 00 00 00 02 5F 01 10 01 00 00 00 00 00 00 D6   → decodeBattery: { percent: 95, charging: true, millivolts: 4097 }
   RX 08 12 00 00 00 02 02 17 00 00 00 00 00 00 00 00 20   → decodeVersion: "2.17"
   ```
3. `decodeSettings(baseline)` returns `errors: []` and exactly:
   ```json
   { "reportRateHz": 1000, "dpiStageCount": 1, "dpiActiveStage": 0,
     "dpiStages": [ { "dpi": 800, "color": "#ff0000" }, { "dpi": 2400, "color": "#00ff00" },
                    { "dpi": 3200, "color": "#0000ff" }, { "dpi": 4800, "color": "#ffff00" },
                    { "dpi": 8000, "color": "#00ffff" }, { "dpi": 26000, "color": "#ff00ff" } ],
     "lodMm": 1, "debounceMs": 2, "motionSync": true, "sleepSeconds": 300,
     "angleSnapping": false, "rippleControl": false, "peakPerformance": false,
     "peakPerformanceTime": "1 min", "sensorMode": "LP" }
   ```
4. Round trip: for every `FIELDS` entry and every allowed value (enum: all options; int: all values; bool: both; DPI: 50, 800, 12800, 12850, 25600, 26000; colour: `#000000`, `#ff8800`), `decodeField(key, encodeField(key, v)).value` equals `v`, and the bytes sum to `0x55` mod 256.
5. DPI codec: 800 → `0F 0F 00`, 1600 → `1F 1F 00`, 26000 → `07 07 88`. `decodeDpi([0x07, 0x07, 0x88])` → `{ x: 26000, y: 26000 }`. A field with x ≠ y decodes to `{ x, y }`.
6. Rejections (each throws):
   - `buildPayload(0x0D)`, `buildPayload(0x09)`, `buildPayload(0x05)`
   - `buildPayload(CMD.WRITE, 0x60, 4, [1,1,0,0x53])` (button map is preserved)
   - `buildPayload(CMD.WRITE, 0xAF, 4, …)` (wrong size)
   - a WRITE with a bad data check byte
   - `encodeField('reportRateHz', 3000)`, `encodeField('lodMm', 0.7)`, `encodeField('sensorMode', 'Corded')`
   - `encodeField('dpiStages.0.dpi', 825)`, `encodeField('dpiStages.0.dpi', 26050)`
   - `encodeField('debounceMs', 21)`, `encodeField('nope', 1)`
7. `decodeField` reports `bad-check` for `[0x01, 0x55]` and `unknown-value` for reportRate raw `0x03` (`[0x03, 0x52]`).
8. Backup:
   - `toBackup` → `parseBackup` round-trips the baseline settings (connection `'wireless'`).
   - Wired backup omits `sensorMode`.
   - `parseBackup` skips 8000 Hz on wireless and `sensorMode` on wired, with the reasons above.
   - It throws on wrong `format`, wrong `version`, missing `debounceMs`, and `dpiStages` of length 5.
   - `toBackup` throws when a setting is `null`.

**Commits:** e.g. `feat(protocol): add packet, field codec and backup logic` and `test(protocol): cover codecs against captured packets and baseline` (tests may be committed together with code).

---

### Task 3: `public/device.js` (WebHID transport) and `test/device.test.js`

**Goal:** A `Hypernova` class wrapping one `HIDDevice`: serialized commands with retries, verified writes, connection-dependent validation, and disconnect handling.

**Consumes from `protocol.js` (Task 2):** `REPORT_ID`, `CMD`, `SETTINGS_SIZE`, `FIELDS`, `buildPayload`, `parseReply`, `encodeField`, `decodeField`, `decodeSettings`, `decodeBattery`, `decodeVersion`.

**Exports (exact):**

```js
export const FILTERS = [
  { vendorId: 0x3554, productId: 0xF5FA, usagePage: 0xFF02 },  // wired
  { vendorId: 0x3554, productId: 0xF5FB, usagePage: 0xFF02 },  // 4K dongle
];
export class DeviceError extends Error {
  // constructor(code, message, extra = {}) — code: 'timeout' | 'verify' | 'disconnected' | 'invalid'
  // verify errors carry `actual` (decoded value read back from the device)
}
export class Hypernova extends EventTarget {
  constructor(hidDevice, { hid = globalThis.navigator?.hid, timeoutMs = 600, attempts = 4, gapMs = 8 } = {})
  static async request(hid = globalThis.navigator?.hid)    // requestDevice({ filters: FILTERS }); null if none chosen; returns opened instance
  static async reconnect(hid = globalThis.navigator?.hid)  // getDevices() → first matching device, preferring productId 0xF5FA; null if none; returns opened instance
  get connection()        // 'wired' (productId 0xF5FA) | 'wireless' (0xF5FB)
  get settings()          // last decoded settings object (from readSettings / writes), or null
  async open()            // opens the HIDDevice if not opened; attaches the single inputreport listener
  async readSettings()    // READs 0x00..0xBF in 10-byte chunks (last chunk 2 bytes) → decodeSettings result; caches settings
  async writeSetting(key, value)  // → decoded value read back from the device
  async readBattery()     // → decodeBattery(...)
  async readVersion()     // → decodeVersion(...)
  async close()
}
```

A device "matches" when `vendorId === 0x3554`, `productId` is `0xF5FA` or `0xF5FB`, and `collections.some(c => c.usagePage === 0xFF02)`.

**Command execution rules:**
- Commands run strictly one at a time (internal promise queue).
- Each starts at least `gapMs` after the previous command finished.
- One persistent `inputreport` listener feeds replies to the currently waiting command. **Never** create a per-attempt reader that can outlive its attempt; protocol spec GUD-002 describes the failure this avoids.
- **Attempt loop:**
  - `sendReport(REPORT_ID, buildPayload(...))`, then wait up to `timeoutMs` for a reply where `parseReply` is non-null and `reply.cmd === cmd && reply.addr === addr`. Ignore any other input report.
  - Up to `attempts` attempts in total.
  - When attempt 2 times out, dispatch `new Event('waiting')` once for that command.
  - After the last attempt, reject with `DeviceError('timeout', …)`.
- `close()`, or a `disconnect` event on `hid` whose `event.device` is this device:
  - rejects the in-flight command and every queued command with `DeviceError('disconnected', …)`
  - dispatches `new Event('disconnect')`
  - later calls reject immediately

**`writeSetting(key, value)` rules, in order:**
1. **Validation:** throw `DeviceError('invalid', …)` **without sending anything** if any of these hold:
   - `key === 'reportRateHz' && value === 8000 && connection === 'wireless'`
   - `key === 'sensorMode' && connection === 'wired'`
   - `key === 'dpiActiveStage'` and `value >= settings.dpiStageCount` (cached)
   - no cached settings (`readSettings` never ran)
   - `encodeField` throws (wrap its message)
2. **Stage-count ordering (spec SAF-007):** if `key === 'dpiStageCount'` and cached `dpiActiveStage >= value`, first `await this.writeSetting('dpiActiveStage', value - 1)`.
3. **Write and verify:**
   - Send `CMD.WRITE` at the field's `addr`/`size` with the encoded bytes.
   - Then send `CMD.READ` of the same `addr`/`size` and compare the bytes.
   - If they match, update the cached settings with the decoded value and return it.
   - On mismatch, repeat write + verify once more.
   - If it still mismatches, update the cache with the decoded read-back value and throw `DeviceError('verify', …, { actual })`.

**Tests (`test/device.test.js`).**

Build an in-memory fake in the test file (no extra helper files):
- A `FakeHid` (`EventTarget` with `requestDevice`, `getDevices`).
- A `FakeDevice` (`EventTarget` with `vendorId`, `productId`, `collections`, `opened`, `open()`, `close()`, `sendReport(reportId, data)`), simulating the mouse over a 512-byte flash loaded from the baseline fixture:
  - READ replies with flash bytes.
  - WRITE stores and echoes.
  - BATTERY replies `[0x28, 0x00, 0x0E, 0xE0]`.
  - VERSION replies `[0x02, 0x17]`.
  - Replies are built with the same packet rules (checksum included) and dispatched asynchronously as an `inputreport` event carrying `reportId` and a 16-byte `DataView` in `data`.
  - Options: `dropFirst: n` (ignore the first n sendReports), `dropAll`, `ignoreWrites` (echo but do not store).
- Use `timeoutMs: 20, gapMs: 0` in tests.

Required cases:
1. `readSettings()` equals `decodeSettings(baseline)` and sends 20 READ commands covering `0x00..0xBF`.
2. `dropFirst: 2` → `readVersion()` resolves `"2.17"`, and exactly one `waiting` event fired.
3. `dropAll` → `readBattery()` rejects with `code === 'timeout'` after exactly 4 `sendReport` calls.
4. `writeSetting('angleSnapping', true)`:
   - the first payload sent equals bytes 1-16 of `08 07 00 00 AF 02 01 54 00 00 00 00 00 00 00 00 40`
   - it is followed by a READ of `0xAF` len 2
   - it resolves `true`
   - fake flash `0xAF` is `0x01`
5. `ignoreWrites` → `writeSetting('motionSync', false)` rejects `code === 'verify'` with `actual === true` after 2 writes.
6. **Stage-count ordering:** fake flash with count 4, active 3 (patch fixture bytes `0x02`/`0x04` with valid check bytes) → after `readSettings()`, `writeSetting('dpiStageCount', 2)` writes `0x04` (value 1) before `0x02` (value 2).
7. **Connection rules:**
   - wireless (`0xF5FB`) + `reportRateHz` 8000 → `invalid` with zero `sendReport` calls
   - wired (`0xF5FA`) + `sensorMode` `'HP'` → `invalid`
   - wired + `reportRateHz` 8000 succeeds
8. **Disconnect:** a command in flight, then `hid.dispatchEvent` of a `disconnect` event with `device` set → the command rejects `code === 'disconnected'` and a `disconnect` event fires on the instance.
9. `reconnect()` with both PIDs granted returns the wired one. With none it returns `null`.

**Commits:** e.g. `feat(device): add WebHID transport with retries and verified writes`, `test(device): cover transport against simulated mouse`.

---

### Task 4: User interface (`public/index.html`, `public/style.css`, `public/app.js`)

**Goal:** The single page that lets a user connect, see, and change every in-scope setting, back up, and restore. Implements spec REQ-001 to REQ-016 on the UI side.

**Consumes:**
- `device.js`: `Hypernova`, `DeviceError`.
- `protocol.js`: `FIELDS`, `STAGES`, `diffSettings`, `getSetting`, `toBackup`, `parseBackup`.

`app.js` must not build packets or reference flash addresses (G3).

**Page structure (`index.html`):**
- `<html lang="en">`, `<meta charset="utf-8">`, viewport meta, `<title>Hypernova Web Driver</title>`.
- `<link rel="stylesheet" href="style.css">` and `<script type="module" src="app.js"></script>`.
- No inline scripts, styles, `style=` attributes, or `on*=` handlers (G6).
- **Header:** app name, a Connect button, connection label ("Wired" / "Wireless (4K dongle)"), firmware version, battery, and a status line (`role="status"`, `aria-live="polite"`).
- **Unsupported notice** (hidden by default): shown when `!('hid' in navigator)` (text: "This app needs a Chromium-based desktop browser such as Chrome, Edge, Opera, Brave or Arc.") or `!isSecureContext` (text: "This page must be opened over HTTPS."). When shown, all device controls are hidden (REQ-011).
- **Sections:**
  - **DPI:** stage count select 1-6, plus one row per stage (6 rows; rows ≥ count are hidden). Each row has:
    - an active-stage radio
    - a DPI number input (`min=50 max=26000 step=50`)
    - a colour input
  - **Performance:** report rate select. Options from `FIELDS`. 8000 only when `connection === 'wired'`.
  - **Sensor:**
    - LOD select (1 mm, 2 mm)
    - sensor mode select (LP, HP; when wired, a single disabled option "Corded")
    - motion sync, angle snapping and ripple control checkboxes
    - peak performance checkbox plus its time select
  - **Buttons:** debounce select 0-20 ms, with a visible warning text "Very low debounce can cause double clicks." when the value ≤ 3.
  - **Power:** mouse sleep time select (labels 10 s, 30 s, 1 min, 5 min, 10 min, 15 min, 20 min, 25 min, 30 min, 35 min, 40 min).
  - **Backup:**
    - "Export settings" button: downloads `hypernova-settings-YYYY-MM-DD.json` via `Blob` + temporary `<a download>`.
    - "Import settings" file input (`accept="application/json"`) plus a confirmation panel listing differing settings and skipped keys with "Apply" and "Cancel" buttons.
- **Footer:** "Unofficial project. Not affiliated with Cosmic Byte." and a link to `https://github.com/ohmygodashish/hypernova`.
- Every control has a visible `<label>`. Everything is keyboard operable.

**Behaviour (`app.js`):**
1. **On load:**
   - If unsupported, show the notice and stop.
   - Otherwise try `Hypernova.reconnect()` (REQ-002).
   - The Connect button calls `Hypernova.request()` (REQ-001).
   - Listen for `navigator.hid` `connect` events and try `reconnect()` when not connected.
2. **After connecting:**
   - `readSettings()`, `readVersion()`, `readBattery()`, then render (REQ-003, REQ-004).
   - Status shows "Connected".
   - Each entry in `errors` shows a warning line naming the setting (SAF-008). Its control shows "Unknown (0xNN)" (raw first byte) or "Invalid" via a selected disabled placeholder option, or an empty number input (REQ-014).
3. **Changing a control** (`change` event) calls `device.writeSetting(key, value)`.
   - While pending, that control is disabled and the status shows "Saving…".
   - On success, the control shows the returned value.
   - On error, the control is re-rendered from `device.settings` and the status shows the error message.
   - If DPI x ≠ y, the row shows "X / Y" next to the input, and the input holds x.
   - Changing the stage count re-renders the rows.
4. **Battery:**
   - When `charging`, show "Charging" (no percent) (REQ-015). Otherwise show `NN%`.
   - Poll `readBattery()` every 60 s while connected and `document.visibilityState === 'visible'` (REQ-007).
5. **Visibility:** on `visibilitychange` to visible while connected, re-read settings and battery (REQ-008).
6. **Device events:**
   - `waiting` → status "Waiting for the mouse… move it to wake it."
   - `disconnect` → status "Disconnected", all controls disabled, battery/version cleared.
7. **Backup:**
   - **Export:** `toBackup(settings, { firmware, connection, now: new Date() })` (REQ-009). If it throws, show its message.
   - **Import:**
     - Read the file, then `parseBackup(text, { connection })`. On throw, show the message and write nothing (AC-011).
     - Otherwise list `diffSettings(current, merged)` (merged = current settings overlaid with parsed settings) using human labels, plus skipped keys with reasons.
     - "Apply" writes each differing key **sequentially in FIELDS order** via `writeSetting`, then re-reads settings and reports the result (REQ-010).
8. **Labels:** human labels for every key live in one `LABELS` map in `app.js` (e.g. `reportRateHz` → "Report rate", `dpiStages.2.color` → "Stage 3 colour").
9. **Edge cases (spec section 9):**
    - **Active stage outside the stage count:** when `dpiActiveStage >= dpiStageCount` after a read, show the warning "The active DPI stage is outside the stage count." and a "Use stage 1" button that writes `dpiActiveStage` = 0.
    - **Valid value not offered on this connection** (report rate 8000 Hz read over the dongle): show it as a selected, disabled option "8000 Hz (cable only)". Write nothing until the user picks an offered option.
    - **Open failure:** if `Hypernova.request()`/`reconnect()` throws while opening the device (e.g. Linux without the udev rule), show the status "Could not open the mouse. On Linux, install the udev rule (see README)." with a link to `https://github.com/ohmygodashish/hypernova#linux`.
10. **Styling (`style.css`):**
   - light and dark themes via `prefers-color-scheme` with CSS custom properties
   - readable at 360 px width without horizontal scrolling
   - visible focus outlines
   - no external fonts or images

**Verify:**
- `node --check public/app.js` passes.
- `npm test` still passes.
- Manually review that no inline style/script or `on*=` attribute exists: `grep -nE 'style=|<style|<script>|onclick|onchange' public/index.html` returns nothing.

**Commits:** e.g. `feat(ui): add settings page with live device binding`, `feat(ui): add settings backup and restore`.

---

### Task 5: PWA (`public/manifest.webmanifest`, `public/sw.js`, `public/icons/*`, `scripts/make-icons.mjs`)

**Goal:** Installable app, offline app shell, original icon.

**Files:**
1. **`public/manifest.webmanifest`:**
   - `name` "Hypernova Web Driver", `short_name` "Hypernova", `start_url` "/", `scope` "/", `display` "standalone".
   - `background_color` and `theme_color` equal to the page's dark background colour from `style.css`.
   - `icons`: `icons/icon-192.png` (192×192, `purpose: "any"`), `icons/icon-512.png` (512×512, `purpose: "any"`), `icons/icon.svg` (`sizes: "any"`, `type: "image/svg+xml"`).
2. **`public/icons/icon.svg`:** an original, simple geometric mark. Suggested: a four-point star ("nova") centred on a dark rounded square. No text, no vendor marks.
3. **`scripts/make-icons.mjs`:**
   - Uses only Node built-ins (`node:zlib` for deflate, `zlib.crc32` or a small CRC32).
   - Procedurally draws the same design as `icon.svg` and writes `public/icons/icon-192.png` and `public/icons/icon-512.png` (8-bit RGBA PNG).
   - Add `"icons": "node scripts/make-icons.mjs"` to `package.json` scripts.
   - Commit the generated PNGs.
4. **`public/sw.js`:**
   - Cache name `hypernova-v1`.
   - **`install`:** `cache.addAll` of `['/', '/style.css', '/app.js', '/device.js', '/protocol.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png']`. **Do not list `/index.html`:** Workers static assets redirects it to `/`, and caching a redirected response breaks navigations. Then `skipWaiting()`.
   - **`activate`:** delete every cache whose name ≠ `hypernova-v1`, then `clients.claim()`.
   - **`fetch`:** handle only same-origin `GET`.
     - Network-first: on success, put a clone in the cache and return the response.
     - On network failure, return `caches.match(request)`, falling back to `caches.match('/')` for `request.mode === 'navigate'`.
5. **`public/index.html`:** add `<link rel="manifest" href="manifest.webmanifest">`, `<meta name="theme-color" content="…">` (same colour as the manifest), and `<link rel="icon" href="icons/icon.svg" type="image/svg+xml">`.
6. **`public/app.js`:** register the service worker (`navigator.serviceWorker?.register('sw.js')`) after load. Registration failure is logged with `console.warn`, never thrown.

**Verify:**
- `node --check public/sw.js`, `node --check scripts/make-icons.mjs`.
- `npm run icons` produces valid PNGs. Check the PNG signature bytes and IHDR width/height in a quick Node one-liner and include its output in the report.
- `npm test` passes.

**Commits:** e.g. `feat(pwa): add manifest, service worker and generated icons`.

---

### Task 6: `README.md`

**Goal:** Usage and maintenance documentation.

**Sections (in this order):**
1. Title and one-paragraph description. State that it is unofficial and not affiliated with Cosmic Byte.
2. **Use it:** open the deployed URL (placeholder `https://hypernova.<your-subdomain>.workers.dev`), click Connect, choose the mouse. Close the official Cosmic Byte app first (it may overwrite changes).
3. **Browser support:** Chromium desktop browsers (Chrome, Edge, Opera, Brave, Arc). Firefox and Safari lack WebHID.
4. **Linux:** the udev rule, verbatim from spec section 9, plus `sudo udevadm control --reload-rules && sudo udevadm trigger`, then replug the mouse.
5. **What it can change:** a short list of settings, and what is intentionally not supported (button remapping, macros, lighting, firmware updates).
6. **Development:** `npm install`, `npm test`, `npm run dev` (opens `http://localhost:8787`), `npm run icons`.
7. **Deployment:** Cloudflare Workers Builds connected to this GitHub repo: production branch `main`, build command `npm test`, deploy command `npx wrangler deploy`.
8. **Documentation:** links to both specs in `docs/`.
9. **License:** MIT (see `LICENSE`).

**Commits:** `docs: add README`.
