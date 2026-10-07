// Pure protocol logic for the Cosmic Byte Hypernova: packets, field codecs, backup files.
// No DOM, no WebHID, no timers. Runs unchanged in browsers and Node.
// Flash addresses and sizes live only in FIELDS (spec 4.4).

export const REPORT_ID = 0x08;
export const CMD = Object.freeze({ BATTERY: 0x04, WRITE: 0x07, READ: 0x08, VERSION: 0x12 });
export const SETTINGS_SIZE = 0xC0; // bytes read on connect: flash 0x00..0xBF
export const STAGES = 6; // DPI stages exposed by the app

const FLASH_SIZE = 0x200;
const MAX_READ = 10; // data bytes per packet
const DPI_MIN = 50;
const DPI_STEP = 50;
const DPI_MAX = 26000;
const CHECK_TOTAL = 0x55; // every field and packet sums to this, mod 256

// enum options: frozen [human value, raw byte] pairs, in display order.
const opts = (...pairs) => Object.freeze(pairs.map((pair) => Object.freeze(pair)));
const boolField = (key, addr) => ({ key, addr, size: 2, kind: 'bool' });
const stageFields = (prop, base, kind, extra) => Array.from({ length: STAGES }, (_, i) => (
  { key: `dpiStages.${i}.${prop}`, addr: base + 4 * i, size: 4, kind, ...extra }
));

export const FIELDS = Object.freeze([
  {
    key: 'reportRateHz', addr: 0x00, size: 2, kind: 'enum',
    options: opts([125, 0x08], [250, 0x04], [500, 0x02], [1000, 0x01], [2000, 0x10], [4000, 0x20], [8000, 0x40]),
  },
  { key: 'dpiStageCount', addr: 0x02, size: 2, kind: 'int', min: 1, max: STAGES },
  { key: 'dpiActiveStage', addr: 0x04, size: 2, kind: 'int', min: 0, max: STAGES - 1 },
  { key: 'lodMm', addr: 0x0A, size: 2, kind: 'enum', options: opts([1, 1], [2, 2]), readOnlyOptions: opts([0.7, 3]) },
  ...stageFields('dpi', 0x0C, 'dpi', { min: DPI_MIN, max: DPI_MAX }),
  ...stageFields('color', 0x2C, 'color'),
  { key: 'debounceMs', addr: 0xA9, size: 2, kind: 'int', min: 0, max: 20 },
  boolField('motionSync', 0xAB),
  {
    key: 'sleepSeconds', addr: 0xAD, size: 2, kind: 'enum',
    options: opts([10, 1], [30, 3], [60, 6], [300, 30], [600, 60], [900, 90], [1200, 120], [1500, 150], [1800, 180], [2100, 210], [2400, 240]),
  },
  boolField('angleSnapping', 0xAF),
  boolField('rippleControl', 0xB1),
  boolField('peakPerformance', 0xB5),
  {
    key: 'peakPerformanceTime', addr: 0xB7, size: 2, kind: 'enum',
    options: opts(['30 s', 3], ['1 min', 6], ['2 min', 30], ['5 min', 60], ['10 min', 90], ['15 min', 120]),
  },
  {
    key: 'sensorMode', addr: 0xB9, size: 2, kind: 'enum',
    options: opts(['LP', 0], ['HP', 1]), readOnlyOptions: opts(['Corded', 2]),
  },
].map((field) => Object.freeze(field)));

const FIELD_BY_KEY = new Map(FIELDS.map((field) => [field.key, field]));

function fieldFor(key) {
  const field = FIELD_BY_KEY.get(key);
  if (!field) throw new Error(`Unknown setting: ${key}`);
  return field;
}

const sum = (bytes) => bytes.reduce((total, byte) => total + byte, 0);
const isByte = (n) => Number.isInteger(n) && n >= 0 && n <= 0xFF;

export function checksum(bytes) {
  return (CHECK_TOTAL - sum(bytes)) & 0xFF;
}

// ---- Packets ----

export function buildPayload(cmd, addr = 0, len = 0, data = []) {
  if (!Object.values(CMD).includes(cmd)) throw new Error(`Command ${cmd} is not allowed`);
  if (!Number.isInteger(addr) || !Number.isInteger(len) || addr < 0 || len < 0) {
    throw new Error('Address and length must be non-negative integers');
  }
  if (!data.every(isByte)) throw new Error('Data must be bytes');

  if (cmd === CMD.READ) {
    if (len < 1 || len > MAX_READ || addr + len > FLASH_SIZE || data.length) {
      throw new Error(`Cannot read ${len} bytes at address ${addr}`);
    }
  } else if (cmd === CMD.WRITE) {
    if (!FIELDS.some((field) => field.addr === addr && field.size === len)) {
      throw new Error(`No writable setting at address ${addr} with size ${len}`);
    }
    // ponytail: checks shape and check byte only; value validity is encodeField's job
    // (device.js always builds WRITE data with it).
    if (data.length !== len || (sum(data) & 0xFF) !== CHECK_TOTAL) {
      throw new Error(`Write data for address ${addr} is not ${len} bytes with a valid check byte`);
    }
  } else if (addr || len || data.length) {
    throw new Error(`Command ${cmd} takes no address, length or data`);
  }

  const payload = new Uint8Array(16);
  payload.set([cmd, 0x00, addr >> 8, addr & 0xFF, len]);
  payload.set(data, 5);
  payload[15] = checksum([REPORT_ID, ...payload.subarray(0, 15)]);
  return payload;
}

export function parseReply(reportId, payload) {
  const p = payload instanceof DataView
    ? new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
    : payload;
  if (reportId !== REPORT_ID || p.length !== 16 || ((REPORT_ID + sum(p)) & 0xFF) !== CHECK_TOTAL) return null;
  return { cmd: p[0], addr: (p[2] << 8) | p[3], len: p[4], data: p.slice(5, 15) };
}

export function decodeBattery(data) {
  return { percent: data[0], charging: data[1] === 1, millivolts: (data[2] << 8) | data[3] };
}

export function decodeVersion(data) {
  return `${data[0].toString(16)}.${data[1].toString(16).padStart(2, '0')}`;
}

// ---- DPI codec (spec 4.5) ----

export function encodeDpi(dpi) {
  if (!Number.isInteger(dpi) || dpi < DPI_MIN || dpi > DPI_MAX || dpi % DPI_STEP !== 0) {
    throw new Error(`${dpi} is not a multiple of ${DPI_STEP} from ${DPI_MIN} to ${DPI_MAX}`);
  }
  const v = dpi / DPI_STEP - 1;
  const hi = (v >> 8) & 3;
  return [v & 0xFF, v & 0xFF, (hi << 2) | (hi << 6)];
}

export function decodeDpi(bytes) {
  const [b0, b1, b2] = bytes;
  const vx = b0 | (((b2 >> 2) & 3) << 8);
  const vy = b1 | (((b2 >> 6) & 3) << 8);
  return { x: (vx + 1) * DPI_STEP, y: (vy + 1) * DPI_STEP };
}

// ---- Field codecs ----

function encodeValue(field, value) {
  const no = (what) => new Error(`${value} is not ${what}`);
  switch (field.kind) {
    case 'enum': {
      const option = field.options.find(([human]) => human === value);
      if (!option) throw no(`one of ${field.options.map(([human]) => human).join(', ')}`);
      return [option[1]];
    }
    case 'int':
      if (!Number.isInteger(value) || value < field.min || value > field.max) {
        throw no(`a whole number from ${field.min} to ${field.max}`);
      }
      return [value];
    case 'bool':
      if (typeof value !== 'boolean') throw no('true or false');
      return [value ? 1 : 0];
    case 'dpi':
      return encodeDpi(value);
    case 'color':
      if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) throw no('a #rrggbb colour');
      return [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
    default:
      throw new Error(`Unknown field kind: ${field.kind}`);
  }
}

export function encodeField(key, value) {
  const raw = encodeValue(fieldFor(key), value);
  return Uint8Array.from([...raw, checksum(raw)]);
}

export function decodeField(key, bytes) {
  const field = fieldFor(key);
  const raw = Array.from(bytes);
  if ((sum(raw) & 0xFF) !== CHECK_TOTAL) return { error: 'bad-check', raw };
  const unknown = { error: 'unknown-value', raw };
  const [first] = raw;
  switch (field.kind) {
    case 'enum': {
      const option = [...field.options, ...(field.readOnlyOptions ?? [])].find(([, code]) => code === first);
      return option ? { value: option[0] } : unknown;
    }
    case 'int':
      return first >= field.min && first <= field.max ? { value: first } : unknown;
    case 'bool':
      return first <= 1 ? { value: first === 1 } : unknown;
    case 'dpi': {
      const { x, y } = decodeDpi(raw);
      return { value: x === y ? x : { x, y } };
    }
    case 'color':
      return { value: `#${raw.slice(0, 3).map((b) => b.toString(16).padStart(2, '0')).join('')}` };
    default:
      throw new Error(`Unknown field kind: ${field.kind}`);
  }
}

// ---- Settings object (nested, spec 4.7) ----

export function getSetting(settings, key) {
  return key.split('.').reduce((node, part) => node?.[part], settings);
}

function setSetting(settings, key, value) {
  const path = key.split('.');
  const last = path.pop();
  let node = settings;
  path.forEach((part, i) => {
    node = node[part] ??= /^\d+$/.test(path[i + 1] ?? last) ? [] : {};
  });
  node[last] = value;
}

export function decodeSettings(flash) {
  if (flash.length < SETTINGS_SIZE) throw new Error(`Need ${SETTINGS_SIZE} bytes of settings, got ${flash.length}`);
  const settings = {};
  const errors = [];
  for (const { key, addr, size } of FIELDS) {
    const result = decodeField(key, flash.subarray(addr, addr + size));
    if (result.error) errors.push({ key, addr, reason: result.error, raw: result.raw });
    setSetting(settings, key, result.error ? null : result.value);
  }
  return { settings, errors };
}

export function diffSettings(a, b) {
  // ponytail: JSON compare, relies on the fixed { x, y } key order decodeField produces.
  const same = (key) => JSON.stringify(getSetting(a, key)) === JSON.stringify(getSetting(b, key));
  return FIELDS.map((field) => field.key).filter((key) => !same(key));
}

// ---- Backup file (spec 4.7) ----

const BACKUP_FORMAT = 'hypernova-settings';

export function toBackup(settings, { firmware, connection, now }) {
  const wired = connection === 'wired'; // sensorMode is not exported over the cable, so its value is irrelevant
  const unreadable = FIELDS.map((field) => field.key)
    .filter((key) => !(wired && key === 'sensorMode') && getSetting(settings, key) == null);
  if (unreadable.length) throw new Error(`Cannot back up unreadable settings: ${unreadable.join(', ')}`);
  // parseBackup only accepts a single DPI number per stage, so a decoded { x, y } would not import back.
  const mixed = settings.dpiStages.findIndex(({ dpi }) => typeof dpi !== 'number');
  if (mixed !== -1) throw new Error(`Stage ${mixed + 1} has different X and Y DPI. Set it in the app before exporting.`);
  const copy = structuredClone(settings);
  if (wired) delete copy.sensorMode;
  const backup = { format: BACKUP_FORMAT, version: 1, exportedAt: now.toISOString(), firmware, settings: copy };
  // Every exported file must import: run it through the import rules (e.g. read-only LOD 0.7, DPI above 26000).
  try {
    parseBackup(backup, { connection });
  } catch (error) {
    throw new Error(`Cannot back up: ${error.message}`);
  }
  return backup;
}

function skipReason(key, value, connection) {
  if (key === 'reportRateHz' && value === 8000 && connection === 'wireless') return '8000 Hz is only available over the cable';
  if (key === 'sensorMode' && connection === 'wired') return 'Sensor mode is fixed (Corded) over the cable';
  if (key === 'sensorMode' && value === 'Corded') return 'Corded is not a sensor mode that can be set';
  return null;
}

export function parseBackup(input, { connection }) {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch {
      throw new Error('The file is not valid JSON');
    }
  }
  if (data?.format !== BACKUP_FORMAT) throw new Error('This is not a Hypernova settings backup');
  if (data.version !== 1) throw new Error(`Unsupported backup version: ${data.version}`);
  const source = data.settings;
  if (source === null || typeof source !== 'object') throw new Error('The backup has no settings');
  if (!Array.isArray(source.dpiStages) || source.dpiStages.length !== STAGES) {
    throw new Error(`dpiStages must list ${STAGES} stages, each with dpi and color`);
  }

  const settings = {};
  const skipped = [];
  for (const { key, kind } of FIELDS) {
    const value = getSetting(source, key);
    if (value === undefined) {
      if (key === 'sensorMode') continue;
      throw new Error(`The backup is missing ${key}`);
    }
    const reason = skipReason(key, value, connection);
    if (reason) {
      skipped.push({ key, reason });
      continue;
    }
    try {
      encodeField(key, value);
    } catch (error) {
      throw new Error(`The backup has an invalid value for ${key}: ${error.message}`);
    }
    setSetting(settings, key, kind === 'color' ? value.toLowerCase() : value);
  }
  // Both are always present here: a missing key threw above, and neither is ever skipped.
  if (settings.dpiActiveStage >= settings.dpiStageCount) {
    throw new Error("The backup's active DPI stage is outside its stage count.");
  }
  return { settings, skipped };
}
