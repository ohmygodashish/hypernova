---
title: Cosmic Byte Hypernova - HID configuration protocol (complete reference)
version: 1.0
date_created: 2026-10-07
last_updated: 2026-10-07
owner: ohmygodashish
tags: [data, protocol, hid, reverse-engineering, hardware]
---

# Introduction

This document is the complete technical reference for how host software configures the Cosmic Byte Hypernova gaming mouse over USB HID. It was reverse-engineered from the vendor's Windows configuration program (v1.0.1.1) and verified against a real device. It covers device identification, transport, packet format, every known command, the full settings memory (flash) map, value encodings, vendor-application behaviour, and the vendor-program internals used to derive them.

The web driver's behaviour is specified separately in [spec-architecture-hypernova-web-driver.md](spec-architecture-hypernova-web-driver.md), which uses a safe subset of this protocol.

## 1. Purpose & Scope

**Purpose.** Be the single source of truth for the Hypernova configuration protocol, so any client (the web driver, scripts, future tools) can be implemented and checked without repeating the reverse engineering.

**Scope.**

- Included: USB identifiers, HID collections, packet format and checksums, transport timing and reliability rules, the complete command catalogue with safety classes, the complete known flash map (including unknown and preserved regions), all value encodings, vendor UI rules, vendor program internals, captured packets, and a reference flash dump.
- Excluded: firmware contents, firmware update procedure, Bluetooth-mode configuration (not investigated), and keyboard/macro encodings beyond what is listed (not decoded).

**Audience.** Developers and AI agents writing or reviewing software that talks to the mouse.

**Verification status.** Every fact carries one of these markers:

| Marker | Meaning |
|---|---|
| **LIVE** | Observed on the real device on 2026-10-07 (mouse firmware v2.17, receiver v2.15) |
| **STATIC** | Derived from the vendor program's code or data files, not yet observed on the device |
| **INFERRED** | Deduced from patterns; neither directly observed nor read from code |

## 2. Definitions

| Term | Definition |
|---|---|
| HID | Human Interface Device, the USB device class used by mice and keyboards. |
| Collection | A logical group in a HID report descriptor. On Windows each top-level collection appears as a separate device path (`...&COLnn`). |
| Usage page | HID value classifying a collection. `0xFF00`-`0xFFFF` are vendor-defined. |
| Report ID | First byte of a HID report. The configuration protocol uses `0x08`. |
| Output / input report | Host-to-device / device-to-host HID report. |
| Feature report | Bidirectional HID report sent via control transfer (`HidD_SetFeature`). |
| Packet | One 17-byte configuration report (report ID + 16 bytes). |
| Packet checksum | Byte 16 of a packet, making all 17 bytes sum to `0x55` modulo 256. |
| Flash | The mouse's non-volatile settings memory, byte-addressed from `0x0000`. |
| Field | One setting in flash: value byte(s) followed by one check byte. |
| Check byte | Last byte of a field, making all bytes of the field sum to `0x55` modulo 256. |
| Dongle / receiver | USB wireless receiver. The "4K dongle" supports 4000 Hz. |
| DPI stage | One of the stored DPI presets cycled by the mouse's DPI button. |
| LOD | Lift-off distance. |
| CID / MID | Customer ID / Model ID: identifiers the vendor tool reads and writes for pairing and branding. |
| Struct offset | Byte offset inside the vendor program's in-memory settings structure (`FlashDataMap`). Used only in section 4.8. |
| Compx | The platform vendor whose SDK (`HIDUsb.dll`, functions prefixed `CS_`) the vendor program uses. |

## 3. Requirements, Constraints & Guidelines

Rules every client must follow.

### Protocol rules

- **PRO-001**: Send configuration commands only to the collection with usage page `0xFF02`, usage `0x02` (section 4.1).
- **PRO-002**: Every packet is exactly 17 bytes with report ID `0x08` and a valid packet checksum (section 4.2). Packets with a wrong checksum are not answered (INFERRED).
- **PRO-003**: Send at most one command at a time, and wait at least 8 ms between commands. The vendor program enforces 8 ms (STATIC).
- **PRO-004**: Match a reply to its request by command byte and address bytes. Ignore other input reports.
- **PRO-005**: Treat a missing reply after 600 ms as a dropped command and resend it, up to 4 attempts in total. Over the dongle, an idle mouse silently drops commands, including writes (LIVE).
- **PRO-006**: Every value written to flash must carry its check byte (section 4.4).
- **PRO-007**: Read flash in chunks of at most 10 bytes.

### Safety rules

- **SAF-001**: Never send commands of class **X** (section 4.3). They change USB identity, enter bootloader/factory modes, or re-pair the wireless link, and can leave the device unusable without the vendor tool.
- **SAF-002**: Do not send class **D** commands (factory reset) unless the user explicitly asks and a settings backup exists.
- **SAF-003**: Write only to fields whose address, size, and encoding are listed in section 4.4 as writable. Do not write unknown or preserved regions.
- **SAF-004**: Verify each write by reading the same range back.
- **SAF-005**: Identify devices by vendor ID **and** product ID. Vendor ID `0x3554` is shared by other mice built on the same platform with different flash layouts.

### Constraints

- **CON-001**: In WebHID, `sendReport(reportId, data)` takes the report ID separately and `data` is bytes 1-16. The packet checksum still includes the report ID.
- **CON-002**: The vendor program may hold the device open at the same time as another client. Each Windows handle receives its own copy of input reports, so both work, but their writes can overwrite each other.
- **CON-003**: Command `0x03` (online status) answers `01` even while the mouse is dropping commands, so it is not a usable "awake" check (LIVE).

### Guidelines

- **GUD-001**: Keep a backup of the settings region (`0x00`-`0xBF`) before writing.
- **GUD-002**: If an implementation abandons a pending asynchronous read on timeout, that read will later consume the next reply and desynchronise all following commands (LIVE, Win32 overlapped I/O). Keep one pending read across commands, or use an event listener (WebHID `inputreport`).

## 4. Interfaces & Data Contracts

### 4.1 Device identification

| Property | Value | Status |
|---|---|---|
| Vendor ID | `0x3554` | LIVE |
| Product ID, cable | `0xF5FA` | LIVE |
| Product ID, 4K dongle | `0xF5FB` | LIVE |
| Product ID, 1K dongle | none configured in the vendor program (`Wireless_PID` empty) | STATIC |
| Sensor | PixArt PAW3395 | STATIC |
| Mouse MCU | Nordic nRF52833 | STATIC |
| Dongle MCU | CX52650N (1K), WCH CH32V305 (4K) | STATIC |
| Mouse firmware | v2.17 | LIVE |
| Receiver firmware | v2.15 (shown by vendor app; command unknown, see OQ-007) | LIVE (vendor UI) |
| Physical buttons | 6 | STATIC |
| Wireless modes | 2.4 GHz dongle, Bluetooth | product listing |

HID layout. Identical for `0xF5FA` and `0xF5FB` (LIVE, Windows `HidP_GetCaps`):

| Interface / collection | Usage page | Usage | In / Out / Feature bytes | Purpose |
|---|---|---|---|---|
| MI_00 | `0x0001` | `0x06` | 9 / 2 / 0 | Keyboard (macro/key output) |
| MI_01 COL01 | `0xFF05` | `0x00` | 8 / 0 / 0 | Vendor, unknown |
| MI_01 COL02 | `0xFF03` | `0x00` | 8 / 0 / 0 | Vendor, unknown |
| MI_01 COL03 | `0x000C` | `0x01` | 3 / 0 / 0 | Consumer control (media keys) |
| MI_01 COL04 | `0x0001` | `0x80` | 2 / 0 / 0 | System control |
| **MI_01 COL05** | **`0xFF02`** | **`0x02`** | **17 / 17 / 0** | **Configuration protocol (this document)** |
| MI_01 COL06 | `0xFF04` | `0x02` | 0 / 0 / 8 | Vendor feature report, likely firmware update (INFERRED) |
| MI_01 COL07 | `0xFF06` | `0x02` | 49 / 49 / 0 | Vendor bulk, likely firmware update (INFERRED) |
| MI_01 COL08 | `0x0001` | `0x02` | 8 / 0 / 0 | Mouse (dongle only) |
| MI_02 | `0x0001` | `0x02` | 8 / 0 / 0 | Mouse |

The vendor `Config.ini` agrees: `InterfaceId=1`, `DeviceId=5`.

### 4.2 Packet format

| Byte | Field | Notes |
|---|---|---|
| 0 | Report ID | always `0x08` |
| 1 | Command | section 4.3 |
| 2 | Reserved | `0x00` in requests. Reply to `0x03` puts the online status here |
| 3 | Address high | flash commands. `0x00` otherwise |
| 4 | Address low | |
| 5 | Length | data length, 0-10 |
| 6-15 | Data | zero-padded |
| 16 | Packet checksum | `(0x55 - sum(bytes 0..15)) & 0xFF` |

- Requests are output reports. Replies are input reports with the same layout and checksum rule (LIVE).
- A reply echoes command, address, and length. A write reply is an exact echo of the request (LIVE).
- Battery reply anomaly: length byte `0x02` but 4 meaningful data bytes (LIVE).

### 4.3 Command catalogue

Safety classes: **R** = read-only. **W** = writes reversible settings. **D** = destructive to settings (factory reset). **X** = never send (identity, bootloader, pairing).

| Cmd | Vendor function | Class | Request (addr / len / data) | Reply data | Status |
|---|---|---|---|---|---|
| `0x01` | `GetDeviceInfo`, `ReadEncryption` | R | unknown | unknown | STATIC |
| `0x02` | `SetPCDriverStatus` | W | flag byte (meaning unknown) | unknown | STATIC |
| `0x03` | `ReadOnLine` | R | 0 / 1 / none | byte 2 = `0x01` (see CON-003) | LIVE |
| `0x04` | `ReadBatteryLevel` | R | 0 / 0 / none | `[percent, charging, mV_hi, mV_lo]` | LIVE |
| `0x05` | `EnterDonglePair` (`OnlyCid`, `WithCidMid`) | X | - | - | STATIC |
| `0x06` | `ReadDonglePairStatus` | R | unknown | unknown | STATIC |
| `0x07` | Write flash (`ProtocolDataUpdate` path) | W | addr / n / field bytes | exact echo | LIVE |
| `0x08` | Read flash (`ReadFalshData`) | R | addr / 1-10 / none | `len` bytes of flash | LIVE |
| `0x09` | `SetClearSetting` (factory reset; also used by `BufferToLedBar`) | D | unknown | unknown | STATIC |
| `0x0B` | `SetVidPid` | X | - | - | STATIC |
| `0x0C` | `SetDeviceDescriptorString` | X | - | - | STATIC |
| `0x0D` | `EnterUsbUpdateMode` (bootloader) | X | - | - | STATIC |
| `0x0E` | `ReadConfig` (onboard profile index) | R | unknown | unknown | STATIC |
| `0x0F` | `SetCurrentConfig` (select onboard profile) | W | unknown | unknown | STATIC |
| `0x11` | `EnterMTKMode` (factory/test mode) | X | - | - | STATIC |
| `0x12` | `ReadVersion` | R | 0 / 0 / none | `[major, minor]` | LIVE |
| `0x14` | `Set4KDongleRGB` | W | unknown | unknown | STATIC |
| `0x15` | `Get4KDongleRGBValue` | R | unknown | unknown | STATIC |
| `0x16` | `SetLongRangeMode` | W | unknown | unknown | STATIC |
| `0x17` | `GetLongRangeMode` | R | unknown | unknown | STATIC |
| `0x18` | `SetDongleRGBBarMode` | W | unknown | unknown | STATIC |
| `0x19` | `GetDongleRGBBarMode` | R | unknown | unknown | STATIC |
| `0x1A` | `SetDongleIDToMouse` (pairing) | X | - | - | STATIC |
| `0xB3` | `GetSlaveVersion` | R | unknown | unknown | STATIC |
| `0xF0` | `WriteCidMid` | X | - | - | STATIC |
| `0xF1` | `ReadCidMid` | R | unknown | unknown | STATIC |

Battery reply decoding (LIVE):

| Byte (data index) | Meaning | Dongle, on battery | Cable, charging |
|---|---|---|---|
| 0 | Percent | `0x28` = 40 | `0x5F` = 95. Inflated by charging voltage; vendor app showed 42-43 % |
| 1 | Charging flag | `0x00` | `0x01` |
| 2-3 | Battery voltage, mV, big-endian | `0x0EE0` = 3808 | `0x1001` = 4097 |

While charging, the percent byte is not a usable state-of-charge value. The vendor `BatteryParam` table maps voltage to percent in 5 % steps (0 %…100 %): `3050, 3170, 3230, 3300, 3600, 3660, 3720, 3760, 3800, 3840, 3880, 3920, 3940, 3960, 3980, 4000, 4020, 4040, 4060, 4080, 4110` mV.

Version reply: `[0x02, 0x17]` → "2.17". Each byte is printed as two hex digits.

### 4.4 Flash map

Field check bytes: 2-byte field `[v, (0x55 - v) & 0xFF]`. 4-byte field `[a, b, c, (0x55 - a - b - c) & 0xFF]`. 7-byte field `[a..f, (0x55 - sum) & 0xFF]`.

"Baseline" = value in `snapshots/flash-baseline-2026-10-07.bin`. "W" = writable by clients (SAF-003). "P" = preserve (do not write).

| Addr | Size | Setting | Encoding | Baseline | W/P | Status |
|---|---|---|---|---|---|---|
| `0x00` | 2 | Report rate | `0x08`=125, `0x04`=250, `0x02`=500, `0x01`=1000, `0x10`=2000, `0x20`=4000, `0x40`=8000 Hz | `01` (1000 Hz) | W | LIVE read; values STATIC |
| `0x02` | 2 | DPI stage count | 1-6 | `01` | W | LIVE read |
| `0x04` | 2 | Active DPI stage | 0 to count-1 | `00` | W | LIVE read |
| `0x06` | 2 | "XSpindown" | unknown | `00` | P | STATIC name |
| `0x08` | 2 | "YSpindown" | unknown | `00` | P | STATIC name |
| `0x0A` | 2 | LOD | `1` = 1 mm, `2` = 2 mm, `3` = 0.7 mm (PAW3950 mice only; not offered for this mouse's PAW3395) | `01` | W (1, 2) | LIVE read; values STATIC |
| `0x0C + 4i`, i=0-7 | 4 | DPI of stage i | DPI codec (4.5) | 800, 2400, 3200, 4800, 8000, 26000, 26000, 26000 | W (i=0-5), P (i=6-7) | LIVE read + write |
| `0x2C + 4i`, i=0-7 | 4 | Indicator colour of stage i | `[R, G, B, chk]` | red, green, blue, yellow, cyan, magenta, magenta, magenta | W (i=0-5), P (i=6-7) | LIVE read + write |
| `0x4C` | 2 | DPI LED parameter (written together with effect) | unknown | `02` | P | STATIC |
| `0x4E` | 2 | DPI LED brightness | unknown scale | `80` | P | STATIC |
| `0x50` | 2 | DPI LED breathing speed | unknown scale | `03` | P | STATIC |
| `0x52` | 2 | DPI LED effect | UI labels OFF / Fixed light / Flicker; `0` = OFF observed | `00` | P | LIVE read (OFF) |
| `0x54`-`0x5F` | 12 | Unknown. Pattern `[R,G,B,chk]` + 4 two-byte fields, mirrors `0x4C`-`0x52` | - | `FF 00 FF 57 00 55 80 D5 03 52 00 55` | P | LIVE read |
| `0x60 + 4i`, i=0-15 | 4 | Button mapping of slot i | `[type, p1, p2, chk]` (4.6) | see 4.6 | P | LIVE read; partial decode |
| `0xA0` | 7 | Lighting | `[mode, R, G, B, speed, brightness, chk]` | `01 FF 00 FF 07 09 46` | P | STATIC layout |
| `0xA7` | 2 | Lighting flag (set by `SetLightMode`) | unknown | `00` | P | STATIC |
| `0xA9` | 2 | Debounce | ms, 0-20. Vendor app warns for values ≤ 3 | `02` | W | LIVE read; range from vendor UI |
| `0xAB` | 2 | Motion sync | `0` off, `1` on | `01` | W | LIVE read |
| `0xAD` | 2 | Mouse sleep time | units of 10 s. Vendor options: 1, 3, 6, 30, 60, 90, 120, 150, 180, 210, 240 (10 s, 30 s, 1, 5, 10, 15, 20, 25, 30, 35, 40 min) | `1E` (5 min) | W | LIVE read |
| `0xAF` | 2 | Angle snapping | `0` off, `1` on | `00` | W | LIVE read + write + felt on device |
| `0xB1` | 2 | Ripple control | `0` off, `1` on | `00` | W | LIVE read |
| `0xB3` | 2 | Move-off LED | `0`/`1` | `00` | P | STATIC |
| `0xB5` | 2 | Peak performance switch | `0` off, `1` on | `00` | W | LIVE (changed in vendor app, observed `01`) |
| `0xB7` | 2 | Peak performance time | vendor raw values 3, 6, 30, 60, 90, 120 shown as 30 s, 1, 2, 5, 10, 15 min (see 4.7 and OQ-001) | `06` (1 min) | W | LIVE read; mapping STATIC |
| `0xB9` | 2 | Sensor mode | `0` LP (low power), `1` HP (high performance). Vendor UI shows "Corded" when cable-connected; stored value unchanged (LIVE) | `00` | W (0, 1) | LIVE read |
| `0xBB` | 2 | Unknown | - | `0A` | P | LIVE read |
| `0xBD`-`0x1FF` | - | Erased (`FF`) | - | `FF…` | P | LIVE read |

### 4.5 DPI codec

`v = DPI / 50 - 1` (10 bits, DPI 50-26000 in steps of 50).

| Byte | Content |
|---|---|
| 0 | `vx & 0xFF` |
| 1 | `vy & 0xFF` |
| 2 | `((vx >> 8) & 3) << 2  \|  ((vy >> 8) & 3) << 6`. Bits 0-1 and 4-5 are `0` in all observed values |
| 3 | check byte |

| DPI | Bytes | Status |
|---|---|---|
| 800 | `0F 0F 00 37` | LIVE |
| 1600 | `1F 1F 00 17` | LIVE (written and read back) |
| 2400 | `2F 2F 00 F7` | LIVE |
| 8000 | `9F 9F 00 17` | LIVE |
| 26000 | `07 07 88 BF` | LIVE |

The vendor UI always writes X = Y. `Config.ini` `DPIRange=50,4000,50,4050,26000,50` describes the slider as two segments, 50-4000 and 4050-26000, both in steps of 50.

### 4.6 Button mapping (partial)

| Slot | Baseline | Meaning |
|---|---|---|
| 0 | `01 01 00` | Left click (type `01` = mouse button, p1 = HID button bitmask) |
| 1 | `01 02 00` | Right click |
| 2 | `01 04 00` | Middle click |
| 3 | `01 08 00` | Button 4 (side) |
| 4 | `01 10 00` | Button 5 (side) |
| 5 | `02 01 00` | DPI loop (type `02` = DPI function) |
| 6 | `02 02 00` | default, likely DPI+ |
| 7 | `02 03 00` | default, likely DPI- |
| 8 | `07 00 00` | default, type `07` unknown |
| 9 | `08 04 00` | default, type `08` unknown |
| 10 | `04 0A 03` | default, type `04` unknown |
| 11-15 | `00 00 00` | empty |

Keyboard, media, and macro types are not decoded. Starting points: `BufferToKeyFunMap`, `BufferToShortcutKey`, `MacroKeyToBuffer` in `HIDUsb.dll`. Collection MI_00 (keyboard) is presumably how key and macro output reaches the PC.

### 4.7 Vendor application behaviour

| Behaviour | Detail | Status |
|---|---|---|
| Report rate options | Cable: 125-8000 Hz. 4K dongle: 125-4000 Hz (8000 hidden) | LIVE (vendor UI) |
| LOD options | 1 mm, 2 mm. 0.7 mm only if the configured sensor is "3950" (`Insert7mm`/`Remove7mm`) | STATIC + LIVE (vendor UI) |
| LOD index mapping | 3 options: index 0 → `3`, 1 → `1`, 2 → `2`. 2 options: index → index + 1 | STATIC |
| Sensor mode | Dongle: LP / HP selectable. Cable: dropdown shows "Corded" and is disabled. Index 2 is never written | STATIC + LIVE (vendor UI) |
| DPI stages | Up to 6 (`DPIMaxGrade=6`). Defaults 1200, 2400, 3200, 4800, 8000, 26000 | STATIC |
| Default stage colours | red, green, blue, yellow, cyan, magenta (`DPIColor`) | STATIC |
| Debounce | 0-20 ms. Value = dropdown index. Warning dialog for ≤ 3 ms | STATIC + user observation |
| Sleep time | dropdown index → 1, 3, 6, 30, 60, 90, 120, 150, 180, 210, 240 | STATIC |
| Peak performance time | dropdown labels 30 s, 1, 2, 5, 10, 15 min → raw 3, 6, 30, 60, 90, 120. From the third option on the labels disagree with the 10-second unit used by sleep time (OQ-001) | STATIC + LIVE (vendor UI) |
| Battery display | Shows its own percentage (42-43 %) while charging, not the device's inflated percent byte | LIVE |
| Write strategy | Diffs old and new settings and writes only changed fields, one `0x07` per field | STATIC |
| Command pacing | ≥ 8 ms between commands, 17-byte `WriteFile` | STATIC |
| Write gating | Each `FunctionSet::Set*` first checks the device is online (`UsbFinderC_GetDeviceOnLine`) | STATIC |

### 4.8 Vendor program internals (provenance)

Install directory: `C:\Program Files\Cosmic Byte Hypernova Gaming Mouse\Sys64` (32-bit build in `Sys32`). Qt 5.9.3, MSVC.

| File | Contents used |
|---|---|
| `HIDUsb.dll` | Compx SDK: packet building (`UsbServer_*`), checksum function, write diffing (`CS_ProtocolDataCompareUpdate`), transport (`UsbReaderWriterServer`), firmware upgrade (`CS_UsbUpgrade_*`, uses `HidD_SetFeature`) |
| `functionset.obj` | `FunctionSet::Set*` setters → settings struct offsets (names of every field) |
| `sensor*.obj`, `debouncetime.obj`, `stopclosetime.obj` | UI handlers → value encodings and option lists |
| `driver_sensor.h` | DPI tables for other sensors (3335, 3325, 3104, 3212, 8920, 3311, 4090) and feature support per sensor. Not used by the PAW3395 |
| `CosmicByteHypernovaGamingMouse.pdb` | Full debug symbols (not parsed; `.obj` relocations were sufficient) |
| `usersetting\Config.ini` | Device config, base64-encoded values (below) |
| `Language\0-English.xml` | UI strings and option labels |

`Config.ini` decoded: `VID=3554`, `USB_PID=F5FA`, `Wireless4_PID=F5FB`, `CID=71`, `MID=01`, `Sensor=3395`, `MM=NRF52833`, `DM=CX52650N`, `D4M=CH32V305`, `InterfaceId=1`, `DeviceId=5`, `DPIMaxGrade=6`, `KeyNumber=6`.

Settings struct (`FlashDataMap`) → flash mapping, from `CS_ProtocolDataCompareUpdate` and `FunctionSet`:

| Struct offset | Setter | Flash addr |
|---|---|---|
| `+0x00` | `SetReportRate` | `0x00` |
| `+0x01` | `SetMaxDPI` | `0x02` |
| `+0x02` | `SetCurrentDPI` | `0x04` |
| `+0x03` | `SetXSpindown` | `0x06` |
| `+0x04` | `SetYSpindown` | `0x08` |
| `+0x05` | `SetSilenceHeight` (LOD) | `0x0A` |
| `+0x06` | `SetDebounceTime` | `0xA9` |
| `+0x07` | `SetMotionSync` | `0xAB` |
| `+0x08` | `SetLightOffTime` (mouse sleep time) | `0xAD` |
| `+0x09` | `SetAngleSnapping` | `0xAF` |
| `+0x0A` | `SetRipple` | `0xB1` |
| `+0x0B` | `SetMoveOffLed` | `0xB3` |
| `+0x0C` | `SetSensorSleepSwitch` (peak performance) | `0xB5` |
| `+0x0D` | `SetSensorSleepTime` (peak performance time) | `0xB7` |
| `+0x0E` | `SetSensorMode` | `0xB9` |
| `+0x0F + 6i` | `SetExChangeDpi` (DPI, 3 bytes) | `0x0C + 4i` |
| `+0x12 + 6i` | `SetExChangeDpi` (colour, 3 bytes) | `0x2C + 4i` |
| `+0x3F` | `SetDPIEffect` | `0x4C` |
| `+0x40` | `SetDPIBrightness` | `0x4E` |
| `+0x41` | `SetDPIBreathSpeed` | `0x50` |
| `+0x42` | `SetDPIEffect` | `0x52` |
| `+0x43`-`+0x48` | `SetLightMode`, `SetLightColor`, `SetLightSpeed`, `SetLightBrightness` | `0xA0` (7-byte block) |
| `+0x49` | `SetLightMode` (flag) | `0xA7` |

## 5. Acceptance Criteria

Conformance checks for any client implementation of this protocol.

- **AC-001**: Given any request built by the client, When its 17 bytes are summed, Then the sum modulo 256 is `0x55`.
- **AC-002**: Given each captured packet in section 9, When the client computes its checksum, Then it equals the captured byte 16.
- **AC-003**: Given `snapshots/flash-baseline-2026-10-07.bin`, When the client decodes `0x00`-`0xBF`, Then every field in section 4.4 has a valid check byte and decodes to the "Baseline" column.
- **AC-004**: Given a request for a class X command or a write outside the writable fields, When the client is asked to send it, Then it refuses without sending.
- **AC-005**: Given an idle mouse on the dongle, When the first command is dropped, Then the client resends it and completes (PRO-005).
- **AC-006**: Given a write, When it completes, Then reading the same range back returns the written bytes (SAF-004).

## 6. Test Automation Strategy

- **Test levels**: Unit tests of codecs and packet building against the fixtures below. Manual live tests against the device for anything marked STATIC before relying on it.
- **Frameworks**: Any. The web driver uses Node's built-in `node:test`.
- **Test data**:
  - `snapshots/flash-baseline-2026-10-07.bin`: 512-byte flash dump (`0x000`-`0x1FF`), read over the 4K dongle on 2026-10-07 before any write. Contents in section 9.
  - Captured packets in section 9.
- **Live test procedure** (used for every LIVE write in this document):
  1. Read `0x00`-`0xBF` and save it.
  2. Write one field.
  3. Read the field back and compare.
  4. Restore the original value.
  5. Read `0x00`-`0xBF` again and diff against step 1. The diff must be empty.
- **CI/CD**: Unit tests run in the web driver's deploy pipeline (see the architecture spec).
- **Coverage**: Every row of 4.4 marked W has encode/decode tests.

## 7. Rationale & Context

**Method.** The vendor program ships its build intermediates: debug symbols, `.obj` files with relocations, Qt moc sources, and a header. Disassembling `HIDUsb.dll` exports gave the packet format, checksum, command IDs, and the field-by-field write function. The `.obj` relocations named every settings field (`FunctionSet::Set*`) and every UI handler, which gave the value encodings. Live reads then confirmed the map against the vendor UI, and selected writes confirmed the write path. No USB traffic capture was needed.

**Check bytes.** Each field carries its own `0x55`-sum check byte, separate from the packet checksum. The firmware presumably validates fields on load, so writing a value without its check byte would likely be rejected or treated as corrupt.

**Live verification log (2026-10-07).**

| Time order | Transport | Action | Result |
|---|---|---|---|
| 1 | 4K dongle | Read `0x000`-`0x1FF` | Matched vendor UI. Saved as baseline |
| 2 | 4K dongle | Write `0xAF` = 1 (angle snapping) | First attempt dropped (idle mouse). Retry succeeded. Effect felt by user. Only `0xAF`/`0xB0` changed |
| 3 | Vendor app | User turned angle snapping off, enabled peak performance | Re-read identical to baseline except `0xB5` = 1 |
| 4 | 4K dongle | Read battery, version | 40 %, 3808 mV, not charging. v2.17 |
| 5 | Cable | Read `0x00`-`0xBF`, battery | Same layout. Charging flag `01`, percent byte 95 |
| 6 | Cable | Write stage 0 DPI 1600 → read back → restore 800 | Verified |
| 7 | Cable | Write stage 0 colour green → read back → restore red | Verified. Final diff empty |

### 7.1 Open questions

- **OQ-001**: Actual firmware duration for peak performance raw values 30, 60, 90, 120. The vendor labels (2, 5, 10, 15 min) disagree with the 10-second unit implied by raw 3 = 30 s and 6 = 1 min. Clients should use the vendor's raw values and labels so both tools agree.
- **OQ-002**: Meaning of `0x06`/`0x08` ("XSpindown"/"YSpindown") and `0xBB`.
- **OQ-003**: The `0x54`-`0x5F` block (possibly a second lighting or DPI-LED profile).
- **OQ-004**: DPI LED encodings (`0x4C`-`0x52`), lighting block (`0xA0`), and whether this mouse has any LED besides the DPI indicator.
- **OQ-005**: Button types `04`, `07`, `08`, keyboard/media encodings, and macro storage location.
- **OQ-006**: Onboard profiles (`0x0E`/`0x0F`, vendor UI "Config1"). Unknown whether other profiles live at other flash addresses. `0xC0`-`0x1FF` is erased.
- **OQ-007**: Which command returns the receiver firmware version (v2.15), possibly `0xB3`.
- **OQ-008**: Request/reply formats of `0x01`, `0x02`, `0x06`, `0x0E`, `0x15`, `0x17`, `0x19`, `0xF1`.
- **OQ-009**: Whether the configuration collection is reachable over Bluetooth.
- **OQ-010**: Bits 0-1 and 4-5 of DPI byte 2.

## 8. Dependencies & External Integrations

### External Systems

- **EXT-001**: Cosmic Byte Hypernova mouse, firmware v2.17. Receiver firmware v2.15.
- **EXT-002**: Vendor configuration program v1.0.1.1 (Windows): source of all STATIC facts.

### Third-Party Services

- None.

### Infrastructure Dependencies

- None.

### Data Dependencies

- **DAT-001**: `snapshots/flash-baseline-2026-10-07.bin`: reference flash dump.

### Technology Platform Dependencies

- **PLT-001**: Any host HID API that can send output reports and receive input reports on a specific collection: WebHID, Win32 `hid.dll` + `WriteFile`/`ReadFile`, hidapi, Linux hidraw.

### Compliance Dependencies

- **COM-001**: Information was obtained by analysing software and hardware the owner legitimately possesses, for interoperability. Do not redistribute vendor binaries or assets.

## 9. Examples & Edge Cases

Captured packets (LIVE, full 17 bytes):

```text
Read flash 0x00, 10 bytes (dongle)
TX 08 08 00 00 00 0A 00 00 00 00 00 00 00 00 00 00 3B
RX 08 08 00 00 00 0A 01 54 01 54 00 55 00 55 00 55 92

Online status
TX 08 03 00 00 00 01 00 00 00 00 00 00 00 00 00 00 49
RX 08 03 01 00 00 01 00 00 00 00 00 00 00 00 00 00 48

Write angle snapping on (2-byte field)
TX 08 07 00 00 AF 02 01 54 00 00 00 00 00 00 00 00 40
RX 08 07 00 00 AF 02 01 54 00 00 00 00 00 00 00 00 40

Write stage 0 DPI = 1600 (4-byte field), then read back
TX 08 07 00 00 0C 04 1F 1F 00 17 00 00 00 00 00 00 E1
RX 08 07 00 00 0C 04 1F 1F 00 17 00 00 00 00 00 00 E1
TX 08 08 00 00 0C 04 00 00 00 00 00 00 00 00 00 00 35
RX 08 08 00 00 0C 04 1F 1F 00 17 00 00 00 00 00 00 E0

Write stage 0 colour = green
TX 08 07 00 00 2C 04 00 FF 00 56 00 00 00 00 00 00 C1
RX 08 07 00 00 2C 04 00 FF 00 56 00 00 00 00 00 00 C1

Battery (dongle, on battery): 40 %, not charging, 3808 mV
TX 08 04 00 00 00 00 00 00 00 00 00 00 00 00 00 00 49
RX 08 04 00 00 00 02 28 00 0E E0 00 00 00 00 00 00 31

Battery (cable, charging): percent byte 95 (inflated), charging, 4097 mV
RX 08 04 00 00 00 02 5F 01 10 01 00 00 00 00 00 00 D6

Version: 2.17
TX 08 12 00 00 00 00 00 00 00 00 00 00 00 00 00 00 3B
RX 08 12 00 00 00 02 02 17 00 00 00 00 00 00 00 00 20
```

Baseline flash `0x00`-`0xBF` (`snapshots/flash-baseline-2026-10-07.bin`. `0xC0`-`0x1FF` are all `FF`):

```text
0000: 01 54 01 54 00 55 00 55 00 55 01 54 0F 0F 00 37
0010: 2F 2F 00 F7 3F 3F 00 D7 5F 5F 00 97 9F 9F 00 17
0020: 07 07 88 BF 07 07 88 BF 07 07 88 BF FF 00 00 56
0030: 00 FF 00 56 00 00 FF 56 FF FF 00 57 00 FF FF 57
0040: FF 00 FF 57 FF 00 FF 57 FF 00 FF 57 02 53 80 D5
0050: 03 52 00 55 FF 00 FF 57 00 55 80 D5 03 52 00 55
0060: 01 01 00 53 01 02 00 52 01 04 00 50 01 08 00 4C
0070: 01 10 00 44 02 01 00 52 02 02 00 51 02 03 00 50
0080: 07 00 00 4E 08 04 00 49 04 0A 03 44 00 00 00 55
0090: 00 00 00 55 00 00 00 55 00 00 00 55 00 00 00 55
00A0: 01 FF 00 FF 07 09 46 00 55 02 53 01 54 1E 37 00
00B0: 55 00 55 00 55 00 55 06 4F 00 55 0A 4B FF FF FF
```

Checksum and codec examples:

```js
const sum = (a) => a.reduce((s, b) => s + b, 0);
const packetChecksum = (first16) => (0x55 - sum(first16)) & 0xFF;
const field = (values) => [...values, (0x55 - sum(values)) & 0xFF];

field([0x01]);                 // [0x01, 0x54]   angle snapping on
field([0x0F, 0x0F, 0x00]);     // [0x0F, 0x0F, 0x00, 0x37]   800 DPI
field([0xFF, 0x00, 0x00]);     // [0xFF, 0x00, 0x00, 0x56]   red
```

Edge cases:

| Case | Behaviour |
|---|---|
| Mouse idle on dongle | Commands dropped silently, including writes. Resend (PRO-005) |
| `0x03` while mouse is dropping commands | Still answers `01` (CON-003) |
| Abandoned async read on timeout | Swallows the next reply. All later commands appear to time out (GUD-002) |
| Charging | Battery percent byte inflated. Use the charging flag |
| Cable and dongle | Same flash, same protocol, same collection layout. Settings are shared |
| Vendor app open concurrently | Both receive replies. Writes can overwrite each other |
| Field check byte invalid | Treat the value as corrupt. Writing a valid value repairs it |

## 10. Validation Criteria

This document is valid while:

1. Every LIVE fact can be reproduced on a Hypernova with firmware v2.17 using the procedure in section 6.
2. The captured packets in section 9 pass the checksum rule.
3. The baseline dump decodes per section 4.4 with all check bytes valid.
4. Any new finding updates the relevant table, its status marker, and the open questions.

## 11. Related Specifications / Further Reading

- [spec-architecture-hypernova-web-driver.md](spec-architecture-hypernova-web-driver.md): web driver that implements a safe subset of this protocol.
- [WebHID API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/WebHID_API)
- [USB HID specification (USB-IF)](https://www.usb.org/hid)
