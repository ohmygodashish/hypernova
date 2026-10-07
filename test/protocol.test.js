import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  REPORT_ID, CMD, SETTINGS_SIZE, STAGES, FIELDS,
  checksum, buildPayload, parseReply, encodeField, decodeField, decodeSettings,
  getSetting, diffSettings, encodeDpi, decodeDpi, decodeBattery, decodeVersion,
  toBackup, parseBackup,
} from '../public/protocol.js';

const baseline = new Uint8Array(readFileSync(new URL('../snapshots/flash-baseline-2026-10-07.bin', import.meta.url)));
const hexBytes = (hex) => hex.trim().split(/\s+/).map((h) => parseInt(h, 16));
const sum = (bytes) => bytes.reduce((a, b) => a + b, 0);

// Captured packets (spec section 9): full line incl. leading report id, plus the buildPayload arguments.
const TX = [
  ['read 0x00 len 10', '08 08 00 00 00 0A 00 00 00 00 00 00 00 00 00 00 3B', [CMD.READ, 0x00, 10]],
  ['write angleSnapping on', '08 07 00 00 AF 02 01 54 00 00 00 00 00 00 00 00 40', [CMD.WRITE, 0xAF, 2, [0x01, 0x54]]],
  ['write stage 0 dpi 1600', '08 07 00 00 0C 04 1F 1F 00 17 00 00 00 00 00 00 E1', [CMD.WRITE, 0x0C, 4, [0x1F, 0x1F, 0x00, 0x17]]],
  ['write stage 0 colour green', '08 07 00 00 2C 04 00 FF 00 56 00 00 00 00 00 00 C1', [CMD.WRITE, 0x2C, 4, [0x00, 0xFF, 0x00, 0x56]]],
  ['battery', '08 04 00 00 00 00 00 00 00 00 00 00 00 00 00 00 49', [CMD.BATTERY]],
  ['version', '08 12 00 00 00 00 00 00 00 00 00 00 00 00 00 00 3B', [CMD.VERSION]],
];
const RX = {
  read: '08 08 00 00 00 0A 01 54 01 54 00 55 00 55 00 55 92',
  write: '08 07 00 00 AF 02 01 54 00 00 00 00 00 00 00 00 40',
  battery40: '08 04 00 00 00 02 28 00 0E E0 00 00 00 00 00 00 31',
  battery95: '08 04 00 00 00 02 5F 01 10 01 00 00 00 00 00 00 D6',
  version: '08 12 00 00 00 02 02 17 00 00 00 00 00 00 00 00 20',
};

test('FIELDS table: frozen, ordered, no overlaps, inside the settings region', () => {
  assert.ok(Object.isFrozen(FIELDS) && FIELDS.every((f) => Object.isFrozen(f)));
  assert.deepEqual(FIELDS.map((f) => f.key), [
    'reportRateHz', 'dpiStageCount', 'dpiActiveStage', 'lodMm',
    ...Array.from({ length: STAGES }, (_, i) => `dpiStages.${i}.dpi`),
    ...Array.from({ length: STAGES }, (_, i) => `dpiStages.${i}.color`),
    'debounceMs', 'motionSync', 'sleepSeconds', 'angleSnapping', 'rippleControl',
    'peakPerformance', 'peakPerformanceTime', 'sensorMode',
  ]);
  const covered = new Set();
  for (const f of FIELDS) {
    for (let a = f.addr; a < f.addr + f.size; a++) {
      assert.ok(a < SETTINGS_SIZE && !covered.has(a), `${f.key} overlaps or leaves the settings region`);
      covered.add(a);
    }
  }
  assert.ok(Object.isFrozen(CMD) && REPORT_ID === 0x08);
});

test('checksum and buildPayload reproduce every captured TX packet', () => {
  for (const [name, line, args] of TX) {
    const full = hexBytes(line);
    assert.equal(full[0], REPORT_ID, name);
    assert.equal(checksum(full.slice(0, 16)), full[16], `${name}: checksum`);
    assert.deepEqual([...buildPayload(...args)], full.slice(1), `${name}: payload`);
  }
});

test('parseReply accepts captured RX packets and rejects any altered byte or wrong report id', () => {
  for (const [name, line] of Object.entries(RX)) {
    const [id, ...payload] = hexBytes(line);
    assert.equal(checksum([id, ...payload.slice(0, 15)]), payload[15], `${name}: checksum`);
    const reply = parseReply(id, Uint8Array.from(payload));
    assert.deepEqual(
      { cmd: reply.cmd, addr: reply.addr, len: reply.len, data: [...reply.data] },
      { cmd: payload[0], addr: (payload[2] << 8) | payload[3], len: payload[4], data: payload.slice(5, 15) },
      name,
    );
    assert.equal(reply.data.length, 10);
    const view = new DataView(Uint8Array.from(payload).buffer);
    assert.deepEqual(parseReply(id, view), reply, `${name}: DataView`);
    for (let i = 0; i < 16; i++) {
      const bad = Uint8Array.from(payload);
      bad[i] = (bad[i] + 1) & 0xFF;
      assert.equal(parseReply(id, bad), null, `${name}: byte ${i} altered`);
    }
    assert.equal(parseReply(0x09, Uint8Array.from(payload)), null, `${name}: wrong report id`);
    assert.equal(parseReply(id, Uint8Array.from(payload.slice(0, 15))), null, `${name}: short`);
    assert.equal(parseReply(id, Uint8Array.from([...payload, 0])), null, `${name}: long, same sum`);
  }
});

test('decodeBattery and decodeVersion decode captured replies', () => {
  const data = (name) => parseReply(8, Uint8Array.from(hexBytes(RX[name]).slice(1))).data;
  assert.deepEqual(decodeBattery(data('battery40')), { percent: 40, charging: false, millivolts: 3808 });
  assert.deepEqual(decodeBattery(data('battery95')), { percent: 95, charging: true, millivolts: 4097 });
  assert.equal(decodeVersion(data('version')), '2.17');
  assert.equal(decodeVersion([0x02, 0x07]), '2.07');
});

test('decodeSettings reads the baseline snapshot exactly', () => {
  const { settings, errors } = decodeSettings(baseline);
  assert.deepEqual(errors, []);
  assert.deepEqual(settings, {
    reportRateHz: 1000, dpiStageCount: 1, dpiActiveStage: 0,
    dpiStages: [
      { dpi: 800, color: '#ff0000' }, { dpi: 2400, color: '#00ff00' },
      { dpi: 3200, color: '#0000ff' }, { dpi: 4800, color: '#ffff00' },
      { dpi: 8000, color: '#00ffff' }, { dpi: 26000, color: '#ff00ff' },
    ],
    lodMm: 1, debounceMs: 2, motionSync: true, sleepSeconds: 300,
    angleSnapping: false, rippleControl: false, peakPerformance: false,
    peakPerformanceTime: '1 min', sensorMode: 'LP',
  });
});

test('decodeSettings nulls a bad field and reports it', () => {
  const flash = Uint8Array.from(baseline);
  flash[0x00] = 0x03; flash[0x01] = 0x52;  // report rate raw 3: valid check, unknown value
  flash[0x2F] ^= 0xFF;                      // stage 0 colour: broken check byte
  const { settings, errors } = decodeSettings(flash);
  assert.equal(settings.reportRateHz, null);
  assert.equal(settings.dpiStages[0].color, null);
  assert.equal(settings.dpiStages[0].dpi, 800);
  assert.deepEqual(errors, [
    { key: 'reportRateHz', addr: 0x00, reason: 'unknown-value', raw: [0x03, 0x52] },
    { key: 'dpiStages.0.color', addr: 0x2C, reason: 'bad-check', raw: [0xFF, 0x00, 0x00, 0x56 ^ 0xFF] },
  ]);
  assert.throws(() => decodeSettings(baseline.subarray(0, SETTINGS_SIZE - 1)));
});

test('round trip: every field, every allowed value, check byte sums to 0x55', () => {
  const samples = { dpi: [50, 800, 12800, 12850, 25600, 26000], color: ['#000000', '#ff8800'], bool: [false, true] };
  for (const f of FIELDS) {
    const values = f.kind === 'enum' ? f.options.map(([v]) => v)
      : f.kind === 'int' ? Array.from({ length: f.max - f.min + 1 }, (_, i) => f.min + i)
      : samples[f.kind];
    assert.ok(values.length > 0, `${f.key}: no sample values`);
    for (const v of values) {
      const bytes = encodeField(f.key, v);
      assert.equal(bytes.length, f.size, `${f.key}=${v}: size`);
      assert.equal(sum(bytes) & 0xFF, 0x55, `${f.key}=${v}: check byte`);
      assert.deepEqual(decodeField(f.key, bytes), { value: v }, `${f.key}=${v}`);
    }
  }
  assert.deepEqual([...encodeField('dpiStages.0.color', '#FF8800')], [0xFF, 0x88, 0x00, checksum([0xFF, 0x88, 0x00])]);
  assert.deepEqual(decodeField('dpiStages.0.color', encodeField('dpiStages.0.color', '#FF8800')), { value: '#ff8800' });
});

test('DPI codec matches captured values', () => {
  assert.deepEqual(encodeDpi(800), [0x0F, 0x0F, 0x00]);
  assert.deepEqual(encodeDpi(1600), [0x1F, 0x1F, 0x00]);
  assert.deepEqual(encodeDpi(26000), [0x07, 0x07, 0x88]);
  assert.deepEqual([...encodeField('dpiStages.0.dpi', 800)], [0x0F, 0x0F, 0x00, 0x37]);
  assert.deepEqual([...encodeField('dpiStages.0.dpi', 26000)], [0x07, 0x07, 0x88, 0xBF]);
  assert.deepEqual(decodeDpi([0x07, 0x07, 0x88]), { x: 26000, y: 26000 });
  const mixed = [0x0F, 0x1F, 0x00];
  assert.deepEqual(decodeField('dpiStages.0.dpi', [...mixed, checksum(mixed)]), { value: { x: 800, y: 1600 } });
});

test('invalid packets and values are rejected', () => {
  for (const cmd of [0x0D, 0x09, 0x05]) assert.throws(() => buildPayload(cmd), `cmd ${cmd}`);
  assert.throws(() => buildPayload(CMD.WRITE, 0x60, 4, [1, 1, 0, 0x53]), /address/i);  // button map is preserved
  assert.throws(() => buildPayload(CMD.WRITE, 0xAF, 4, [1, 0x54, 0, 0]));              // wrong size
  assert.throws(() => buildPayload(CMD.WRITE, 0xAF, 2, [0x01, 0x55]));                  // bad check byte
  assert.throws(() => buildPayload(CMD.WRITE, 0xAF, 2, [0x01]));                        // data shorter than len
  assert.throws(() => buildPayload(CMD.READ, 0, 0));
  assert.throws(() => buildPayload(CMD.READ, 0, 11));
  assert.throws(() => buildPayload(CMD.READ, 0x1FA, 10));
  assert.throws(() => buildPayload(CMD.BATTERY, 1, 0));
  assert.throws(() => buildPayload(CMD.VERSION, 0, 1));
  assert.throws(() => buildPayload(CMD.VERSION, 0, 0, [1]));
  assert.throws(() => encodeField('reportRateHz', 3000));
  assert.throws(() => encodeField('lodMm', 0.7));
  assert.throws(() => encodeField('sensorMode', 'Corded'));
  assert.throws(() => encodeField('dpiStages.0.dpi', 825));
  assert.throws(() => encodeField('dpiStages.0.dpi', 26050));
  assert.throws(() => encodeField('debounceMs', 21));
  assert.throws(() => encodeField('debounceMs', 1.5));
  assert.throws(() => encodeField('motionSync', 1));
  assert.throws(() => encodeField('dpiStages.0.color', '#12345'));
  assert.throws(() => encodeField('dpiStages.0.color', ['#123456']));
  assert.throws(() => encodeField('nope', 1), /unknown/i);
  assert.throws(() => encodeDpi(0));
});

test('decodeField reports bad-check and unknown-value, and accepts read-only values', () => {
  assert.deepEqual(decodeField('reportRateHz', [0x01, 0x55]), { error: 'bad-check', raw: [0x01, 0x55] });
  assert.deepEqual(decodeField('reportRateHz', [0x03, 0x52]), { error: 'unknown-value', raw: [0x03, 0x52] });
  assert.deepEqual(decodeField('motionSync', [0x02, 0x53]), { error: 'unknown-value', raw: [0x02, 0x53] });
  assert.deepEqual(decodeField('debounceMs', [21, 0x55 - 21]), { error: 'unknown-value', raw: [21, 0x55 - 21] });
  assert.deepEqual(decodeField('lodMm', [3, 0x52]), { value: 0.7 });
  assert.deepEqual(decodeField('sensorMode', [2, 0x53]), { value: 'Corded' });
  assert.throws(() => decodeField('nope', [0, 0x55]));
});

test('getSetting and diffSettings', () => {
  const { settings } = decodeSettings(baseline);
  assert.equal(getSetting(settings, 'dpiStages.2.color'), '#0000ff');
  assert.equal(getSetting(settings, 'lodMm'), 1);
  assert.equal(getSetting(settings, 'dpiStages.9.dpi'), undefined);
  assert.deepEqual(diffSettings(settings, structuredClone(settings)), []);
  const other = structuredClone(settings);
  other.dpiStages[2].color = '#123456';
  other.lodMm = 2;
  other.sensorMode = 'HP';
  assert.deepEqual(diffSettings(settings, other), ['lodMm', 'dpiStages.2.color', 'sensorMode']);
  const mixedA = structuredClone(settings);
  const mixedB = structuredClone(settings);
  mixedA.dpiStages[0].dpi = { x: 800, y: 1600 };
  mixedB.dpiStages[0].dpi = { x: 800, y: 1600 };
  assert.deepEqual(diffSettings(mixedA, mixedB), []);
  mixedB.dpiStages[0].dpi = 800;
  assert.deepEqual(diffSettings(mixedA, mixedB), ['dpiStages.0.dpi']);
});

test('backup: export then import round-trips the baseline', () => {
  const { settings } = decodeSettings(baseline);
  const now = new Date('2026-10-07T12:00:00.000Z');
  const backup = toBackup(settings, { firmware: '2.17', connection: 'wireless', now });
  assert.deepEqual(
    { format: backup.format, version: backup.version, exportedAt: backup.exportedAt, firmware: backup.firmware },
    { format: 'hypernova-settings', version: 1, exportedAt: '2026-10-07T12:00:00.000Z', firmware: '2.17' },
  );
  assert.deepEqual(backup.settings, settings);
  assert.notEqual(backup.settings, settings);
  const fromObject = parseBackup(backup, { connection: 'wireless' });
  assert.deepEqual(fromObject, { settings, skipped: [] });
  assert.deepEqual(parseBackup(JSON.stringify(backup), { connection: 'wireless' }), fromObject);
});

test('backup: wired export omits sensorMode and wired import skips it', () => {
  const { settings } = decodeSettings(baseline);
  const wired = toBackup(settings, { firmware: '2.17', connection: 'wired', now: new Date() });
  assert.ok(!('sensorMode' in wired.settings));
  assert.equal(settings.sensorMode, 'LP');
  const noSensor = parseBackup(wired, { connection: 'wired' });
  assert.deepEqual(noSensor.skipped, []);
  assert.ok(!('sensorMode' in noSensor.settings));
  const withSensor = toBackup(settings, { firmware: '2.17', connection: 'wireless', now: new Date() });
  assert.deepEqual(parseBackup(withSensor, { connection: 'wired' }).skipped, [
    { key: 'sensorMode', reason: 'Sensor mode is fixed (Corded) over the cable' },
  ]);
});

test('backup: connection-specific values are skipped, not written', () => {
  const { settings } = decodeSettings(baseline);
  const fast = { ...structuredClone(settings), reportRateHz: 8000 };
  const backup = toBackup(fast, { firmware: '2.17', connection: 'wired', now: new Date() });
  const wireless = parseBackup(backup, { connection: 'wireless' });
  assert.deepEqual(wireless.skipped, [{ key: 'reportRateHz', reason: '8000 Hz is only available over the cable' }]);
  assert.ok(!('reportRateHz' in wireless.settings));
  assert.equal(parseBackup(backup, { connection: 'wired' }).settings.reportRateHz, 8000);
  const corded = { ...backup, settings: { ...settings, sensorMode: 'Corded' } };
  const parsed = parseBackup(corded, { connection: 'wireless' });
  assert.deepEqual(parsed.skipped.map((s) => s.key), ['sensorMode']);
  assert.ok(!('sensorMode' in parsed.settings));
});

test('backup: import normalises colours and ignores unknown keys', () => {
  const { settings } = decodeSettings(baseline);
  const backup = toBackup(settings, { firmware: '2.17', connection: 'wireless', now: new Date() });
  backup.settings.dpiStages[0].color = '#FF0000';
  backup.settings.extra = 1;
  backup.extra = 2;
  assert.deepEqual(parseBackup(backup, { connection: 'wireless' }).settings, settings);
});

test('backup: invalid files are rejected', () => {
  const { settings } = decodeSettings(baseline);
  const good = toBackup(settings, { firmware: '2.17', connection: 'wireless', now: new Date() });
  const parse = (mutate) => {
    const copy = structuredClone(good);
    mutate(copy);
    return () => parseBackup(copy, { connection: 'wireless' });
  };
  assert.throws(parse((b) => { b.format = 'other'; }), /backup/i);
  assert.throws(parse((b) => { b.version = 2; }), /version/i);
  assert.throws(parse((b) => { delete b.settings.debounceMs; }), /debounceMs/);
  assert.throws(parse((b) => { b.settings.dpiStages.pop(); }), /dpiStages/);
  assert.throws(parse((b) => { delete b.settings.dpiStages[3].color; }), /dpiStages\.3\.color/);
  assert.throws(parse((b) => { b.settings.reportRateHz = 3000; }), /reportRateHz/);
  assert.throws(parse((b) => { b.settings.dpiStages[1].dpi = 825; }), /dpiStages\.1\.dpi/);
  assert.throws(() => parseBackup('{ not json', { connection: 'wireless' }));
  assert.throws(() => parseBackup('null', { connection: 'wireless' }));
});

test('backup: toBackup refuses a stage with different X and Y DPI', () => {
  const { settings } = decodeSettings(baseline);
  const mixed = structuredClone(settings);
  mixed.dpiStages[2].dpi = { x: 800, y: 1600 };
  for (const connection of ['wired', 'wireless']) {
    assert.throws(
      () => toBackup(mixed, { firmware: '2.17', connection, now: new Date() }),
      { message: 'Stage 3 has different X and Y DPI. Set it in the app before exporting.' },
    );
  }
});

test('backup: wired export ignores a null sensorMode, wireless export does not', () => {
  const { settings } = decodeSettings(baseline);
  const unknownSensor = { ...settings, sensorMode: null };
  const wired = toBackup(unknownSensor, { firmware: '2.17', connection: 'wired', now: new Date() });
  assert.ok(!('sensorMode' in wired.settings));
  assert.deepEqual(parseBackup(wired, { connection: 'wired' }).skipped, []);
  assert.throws(
    () => toBackup(unknownSensor, { firmware: '2.17', connection: 'wireless', now: new Date() }),
    /sensorMode/,
  );
  assert.throws(
    () => toBackup({ ...unknownSensor, lodMm: null }, { firmware: '2.17', connection: 'wired', now: new Date() }),
    /lodMm/,
  );
});

test('backup: toBackup refuses unreadable settings', () => {
  const { settings } = decodeSettings(baseline);
  for (const key of ['lodMm', 'sensorMode']) {
    assert.throws(
      () => toBackup({ ...settings, [key]: null }, { firmware: '2.17', connection: 'wireless', now: new Date() }),
      new RegExp(key),
    );
  }
});
