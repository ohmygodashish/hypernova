import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  REPORT_ID, CMD, SETTINGS_SIZE, FIELDS, checksum, decodeSettings,
} from '../public/protocol.js';
import { FILTERS, DeviceError, Hypernova } from '../public/device.js';

const baseline = new Uint8Array(readFileSync(new URL('../snapshots/flash-baseline-2026-10-07.bin', import.meta.url)));
const WIRED = 0xF5FA;
const DONGLE = 0xF5FB;
const hexBytes = (hex) => hex.trim().split(/\s+/).map((h) => parseInt(h, 16));
const addrOf = (key) => FIELDS.find((field) => field.key === key).addr;
const settle = () => new Promise((resolve) => setImmediate(resolve));

// ---- In-memory mouse: a 512-byte flash behind the same packet rules as the real one ----

class FakeDevice extends EventTarget {
  vendorId = 0x3554;
  collections = [{ usagePage: 0xFF02 }];
  opened = false;
  sent = []; // every payload passed to sendReport

  constructor(productId, { flash = baseline, dropFirst = 0, dropAll = false, ignoreWrites = false, noise = false } = {}) {
    super();
    this.productId = productId;
    this.flash = Uint8Array.from(flash);
    Object.assign(this, { dropFirst, dropAll, ignoreWrites, noise });
  }

  async open() { this.opened = true; }

  async close() { this.opened = false; }

  async sendReport(reportId, data) {
    assert.equal(reportId, REPORT_ID);
    this.sent.push(Uint8Array.from(data));
    if (this.dropAll || this.sent.length <= this.dropFirst) return;
    const [cmd, , hi, lo, len] = data;
    const addr = (hi << 8) | lo;
    if (this.noise) {
      this.#emit(CMD.BATTERY, 0, 2, [0x28, 0x00, 0x0E, 0xE0]); // valid, but not the reply we want
      this.#emit(cmd, addr, 2, [0x09, 0x09], true); // right command, corrupted
    }
    switch (cmd) {
      case CMD.READ:
        return this.#emit(cmd, addr, len, this.flash.subarray(addr, addr + len));
      case CMD.WRITE:
        if (!this.ignoreWrites) this.flash.set(data.subarray(5, 5 + len), addr);
        return this.#emit(cmd, addr, len, data.subarray(5, 5 + len));
      case CMD.BATTERY:
        return this.#emit(cmd, 0, 2, [0x28, 0x00, 0x0E, 0xE0]);
      case CMD.VERSION:
        return this.#emit(cmd, 0, 2, [0x02, 0x17]);
      default:
        throw new Error(`Fake mouse got command ${cmd}`);
    }
  }

  #emit(cmd, addr, len, body, corrupt = false) {
    const payload = new Uint8Array(16);
    payload.set([cmd, 0, addr >> 8, addr & 0xFF, len, ...body]);
    payload[15] = (checksum([REPORT_ID, ...payload.subarray(0, 15)]) + (corrupt ? 1 : 0)) & 0xFF;
    queueMicrotask(() => this.dispatchEvent(
      Object.assign(new Event('inputreport'), { reportId: REPORT_ID, data: new DataView(payload.buffer) }),
    ));
  }
}

class FakeHid extends EventTarget {
  constructor(devices) {
    super();
    this.devices = devices;
  }

  async requestDevice(options) {
    this.requested = options;
    return [...this.devices];
  }

  async getDevices() { return [...this.devices]; }
}

async function connect({ pid = WIRED, ...options } = {}) {
  const fake = new FakeDevice(pid, options);
  const hid = new FakeHid([fake]);
  const hn = new Hypernova(fake, { hid, timeoutMs: 20, gapMs: 0 });
  await hn.open();
  return { fake, hid, hn };
}

// Awaits a rejection, checks it is a DeviceError with this code, and returns it.
async function errorOf(promise, code) {
  const error = await promise.then(() => assert.fail('expected a rejection'), (e) => e);
  assert.ok(error instanceof DeviceError, `expected a DeviceError, got ${error}`);
  assert.equal(error.code, code, error.message);
  return error;
}

// ---- Tests ----

test('readSettings equals decodeSettings(baseline) and reads 0x00..0xBF in 20 READ commands', async () => {
  const { fake, hn } = await connect();
  assert.equal(hn.settings, null);
  const result = await hn.readSettings();
  assert.deepEqual(result, decodeSettings(baseline));
  assert.deepEqual(hn.settings, result.settings);
  assert.equal(fake.sent.length, 20);
  const covered = fake.sent.flatMap((p) => {
    assert.equal(p[0], CMD.READ);
    const addr = (p[2] << 8) | p[3];
    return Array.from({ length: p[4] }, (_, i) => addr + i);
  });
  assert.deepEqual(covered, Array.from({ length: SETTINGS_SIZE }, (_, i) => i));
});

test('a dropped command is resent and a single waiting event fires after the 2nd attempt', async () => {
  const { fake, hn } = await connect({ dropFirst: 2 });
  let waiting = 0;
  hn.addEventListener('waiting', () => { waiting += 1; });
  assert.equal(await hn.readVersion(), '2.17');
  assert.equal(waiting, 1);
  assert.equal(fake.sent.length, 3);
});

test('dropAll: readBattery times out after exactly 4 sends and the queue keeps working', async () => {
  const { fake, hn } = await connect({ dropAll: true });
  let waiting = 0;
  hn.addEventListener('waiting', () => { waiting += 1; });
  await errorOf(hn.readBattery(), 'timeout');
  assert.equal(fake.sent.length, 4);
  assert.equal(waiting, 1);
  fake.dropAll = false;
  assert.equal(await hn.readVersion(), '2.17');
  assert.deepEqual(await hn.readBattery(), { percent: 40, charging: false, millivolts: 3808 });
});

test('replies for another command or with a bad checksum are ignored', async () => {
  const { fake, hn } = await connect({ noise: true });
  assert.equal(await hn.readVersion(), '2.17');
  assert.equal(fake.sent.length, 1);
});

test('writeSetting sends the captured packet, verifies with a READ, and returns the read-back value', async () => {
  const { fake, hn } = await connect();
  await hn.readSettings();
  fake.sent.length = 0;
  assert.equal(await hn.writeSetting('angleSnapping', true), true);
  assert.deepEqual([...fake.sent[0]], hexBytes('08 07 00 00 AF 02 01 54 00 00 00 00 00 00 00 00 40').slice(1));
  assert.deepEqual([...fake.sent[1].subarray(0, 5)], [CMD.READ, 0x00, 0x00, addrOf('angleSnapping'), 2]);
  assert.equal(fake.sent.length, 2);
  assert.equal(fake.flash[addrOf('angleSnapping')], 0x01);
  assert.equal(hn.settings.angleSnapping, true);
});

test('a write the mouse ignores is retried once, then fails with the actual value', async () => {
  const { fake, hn } = await connect({ ignoreWrites: true });
  await hn.readSettings();
  fake.sent.length = 0;
  const error = await errorOf(hn.writeSetting('motionSync', false), 'verify');
  assert.equal(error.actual, true);
  assert.equal(fake.sent.filter((p) => p[0] === CMD.WRITE).length, 2);
  assert.equal(fake.sent.filter((p) => p[0] === CMD.READ).length, 2);
  assert.equal(hn.settings.motionSync, true);
});

test('reducing the stage count writes the active stage first (SAF-007)', async () => {
  const flash = Uint8Array.from(baseline);
  const [count, active] = [addrOf('dpiStageCount'), addrOf('dpiActiveStage')];
  flash.set([0x04, 0x51], count); // 4 stages
  flash.set([0x03, 0x52], active); // stage index 3 active
  const { fake, hn } = await connect({ flash });
  await hn.readSettings();
  assert.equal(hn.settings.dpiStageCount, 4);
  assert.equal(hn.settings.dpiActiveStage, 3);
  fake.sent.length = 0;
  assert.equal(await hn.writeSetting('dpiStageCount', 2), 2);
  const writes = fake.sent.filter((p) => p[0] === CMD.WRITE).map((p) => [p[3], p[5]]);
  assert.deepEqual(writes, [[active, 1], [count, 2]]);
  assert.equal(hn.settings.dpiActiveStage, 1);
  assert.equal(hn.settings.dpiStageCount, 2);
});

test('connection rules: 8000 Hz is cable only, sensor mode is dongle only', async () => {
  const dongle = await connect({ pid: DONGLE });
  assert.equal(dongle.hn.connection, 'wireless');
  await dongle.hn.readSettings();
  dongle.fake.sent.length = 0;
  await errorOf(dongle.hn.writeSetting('reportRateHz', 8000), 'invalid');
  assert.equal(dongle.fake.sent.length, 0);

  const cable = await connect();
  assert.equal(cable.hn.connection, 'wired');
  await cable.hn.readSettings();
  cable.fake.sent.length = 0;
  await errorOf(cable.hn.writeSetting('sensorMode', 'HP'), 'invalid');
  assert.equal(cable.fake.sent.length, 0);
  assert.equal(await cable.hn.writeSetting('reportRateHz', 8000), 8000);
});

test('invalid writes are rejected before anything is sent', async () => {
  const { fake, hn } = await connect({ pid: DONGLE });
  await errorOf(hn.writeSetting('angleSnapping', true), 'invalid'); // settings never read
  await hn.readSettings();
  fake.sent.length = 0;
  await errorOf(hn.writeSetting('dpiActiveStage', hn.settings.dpiStageCount), 'invalid'); // beyond the stage count
  await errorOf(hn.writeSetting('reportRateHz', 123), 'invalid'); // not an allowed value
  await errorOf(hn.writeSetting('nonsense', 1), 'invalid'); // unknown setting
  assert.equal(fake.sent.length, 0);
});

test('disconnect rejects the in-flight and queued commands and fires disconnect', async () => {
  const { fake, hid, hn } = await connect({ dropAll: true });
  let disconnects = 0;
  hn.addEventListener('disconnect', () => { disconnects += 1; });
  const inFlight = errorOf(hn.readBattery(), 'disconnected');
  const queued = errorOf(hn.readVersion(), 'disconnected');
  while (!fake.sent.length) await settle();

  hid.dispatchEvent(Object.assign(new Event('disconnect'), { device: new FakeDevice(WIRED) }));
  assert.equal(disconnects, 0, 'another device unplugged');

  hid.dispatchEvent(Object.assign(new Event('disconnect'), { device: fake }));
  await Promise.all([inFlight, queued]);
  assert.equal(disconnects, 1);
  assert.equal(fake.sent.length, 1, 'the queued command never reached the mouse');
  await errorOf(hn.readVersion(), 'disconnected');
});

test('close rejects the in-flight command and closes the device', async () => {
  const { fake, hn } = await connect({ dropAll: true });
  let disconnects = 0;
  hn.addEventListener('disconnect', () => { disconnects += 1; });
  const inFlight = errorOf(hn.readBattery(), 'disconnected');
  while (!fake.sent.length) await settle();
  await hn.close();
  await inFlight;
  assert.equal(fake.opened, false);
  assert.equal(disconnects, 1);
  await errorOf(hn.writeSetting('angleSnapping', true), 'disconnected');
});

test('reconnect prefers the cable, ignores other devices, and returns null with none', async () => {
  const wired = new FakeDevice(WIRED);
  const dongle = new FakeDevice(DONGLE);
  const other = new FakeDevice(0x1234);

  const both = await Hypernova.reconnect(new FakeHid([other, dongle, wired]));
  assert.equal(both.device, wired);
  assert.equal(wired.opened, true);
  assert.equal((await Hypernova.reconnect(new FakeHid([dongle]))).device, dongle);
  assert.equal(await Hypernova.reconnect(new FakeHid([other])), null);
  assert.equal(await Hypernova.reconnect(new FakeHid([])), null);

  const hid = new FakeHid([dongle]);
  assert.equal((await Hypernova.request(hid)).device, dongle);
  assert.deepEqual(hid.requested, { filters: FILTERS });
  assert.equal(await Hypernova.request(new FakeHid([])), null);
});
