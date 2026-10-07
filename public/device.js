// WebHID transport for the Cosmic Byte Hypernova: wraps one HIDDevice, runs one command at a time.
// The only module that sends reports. Flash addresses come from FIELDS (protocol.js).

import {
  REPORT_ID, CMD, SETTINGS_SIZE, FIELDS,
  buildPayload, parseReply, encodeField, decodeField, decodeSettings, decodeBattery, decodeVersion,
} from './protocol.js';

export const FILTERS = [
  { vendorId: 0x3554, productId: 0xF5FA, usagePage: 0xFF02 }, // wired
  { vendorId: 0x3554, productId: 0xF5FB, usagePage: 0xFF02 }, // 4K dongle
];

const WIRED_PID = FILTERS[0].productId;
const READ_CHUNK = 10; // data bytes per READ packet

const matches = (device) => FILTERS.some(({ vendorId, productId, usagePage }) => (
  device.vendorId === vendorId && device.productId === productId
  && device.collections.some((collection) => collection.usagePage === usagePage)
));

export class DeviceError extends Error {
  // code: 'timeout' | 'verify' | 'disconnected' | 'invalid'. Verify errors carry `actual`.
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'DeviceError';
    this.code = code;
    Object.assign(this, extra);
  }
}

export class Hypernova extends EventTarget {
  #hid;
  #timeoutMs;
  #attempts;
  #gapMs;
  #queue = Promise.resolve(); // end of the queue of public operations
  #waiter = null; // what the running command waits on: a reply, or the gap before it
  #lastEnd = -Infinity; // performance.now() when the previous command finished
  #closed = false;
  #flash = null; // settings region as last read or written
  #settings = null; // decodeSettings(#flash).settings

  constructor(hidDevice, { hid = globalThis.navigator?.hid, timeoutMs = 600, attempts = 4, gapMs = 8 } = {}) {
    super();
    this.device = hidDevice;
    this.#hid = hid;
    this.#timeoutMs = timeoutMs;
    this.#attempts = attempts;
    this.#gapMs = gapMs;
  }

  static async request(hid = globalThis.navigator?.hid) {
    const [device] = await hid.requestDevice({ filters: FILTERS });
    return device ? Hypernova.#adopt(device, hid) : null;
  }

  static async reconnect(hid = globalThis.navigator?.hid) {
    const found = (await hid.getDevices()).filter(matches);
    const device = found.find((d) => d.productId === WIRED_PID) ?? found[0];
    return device ? Hypernova.#adopt(device, hid) : null;
  }

  static async #adopt(device, hid) {
    const mouse = new Hypernova(device, { hid });
    await mouse.open();
    return mouse;
  }

  get connection() {
    return this.device.productId === WIRED_PID ? 'wired' : 'wireless';
  }

  get settings() {
    return this.#settings;
  }

  async open() {
    this.#alive();
    if (!this.device.opened) await this.device.open();
    // Adding the same listener twice is a no-op, so open() is safe to repeat.
    this.device.addEventListener('inputreport', this.#onReport);
    this.#hid?.addEventListener('disconnect', this.#onDisconnect);
  }

  async close() {
    this.#teardown();
    if (this.device.opened) await this.device.close();
  }

  async readSettings() {
    return this.#exclusive(async () => {
      const flash = new Uint8Array(SETTINGS_SIZE);
      for (let addr = 0; addr < SETTINGS_SIZE; addr += READ_CHUNK) {
        const len = Math.min(READ_CHUNK, SETTINGS_SIZE - addr);
        const reply = await this.#command(CMD.READ, addr, len);
        flash.set(reply.data.subarray(0, len), addr);
      }
      const result = decodeSettings(flash);
      this.#flash = flash;
      this.#settings = result.settings;
      return result;
    });
  }

  async writeSetting(key, value) {
    return this.#exclusive(() => this.#write(key, value));
  }

  async readBattery() {
    return this.#exclusive(async () => decodeBattery((await this.#command(CMD.BATTERY)).data));
  }

  async readVersion() {
    return this.#exclusive(async () => decodeVersion((await this.#command(CMD.VERSION)).data));
  }

  // The body of writeSetting, without the lock so SAF-007's pre-write can call it from inside the lock.
  // Validation reads the cache here, at run time, so it sees the effect of every operation queued before it.
  async #write(key, value) {
    const bytes = this.#validate(key, value);
    // SAF-007: the active stage must stay inside the stage count.
    if (key === 'dpiStageCount' && this.#settings.dpiActiveStage >= value) {
      await this.#write('dpiActiveStage', value - 1);
    }

    const { addr, size } = FIELDS.find((field) => field.key === key);
    let readBack;
    let verified = false;
    for (let write = 0; write < 2 && !verified; write++) { // SAF-006: one repeat
      await this.#command(CMD.WRITE, addr, size, bytes);
      readBack = (await this.#command(CMD.READ, addr, size)).data.slice(0, size);
      verified = readBack.every((byte, i) => byte === bytes[i]);
    }
    this.#flash.set(readBack, addr);
    this.#settings = decodeSettings(this.#flash).settings;

    const { value: actual = null } = decodeField(key, readBack);
    if (!verified) {
      throw new DeviceError('verify', `${key} did not stick: the mouse reports ${JSON.stringify(actual)}`, { actual });
    }
    return actual;
  }

  // Runs one public operation (any number of commands) with nothing else interleaved, in call order.
  // A failed operation never blocks the ones behind it. After close or unplug, waiting operations
  // fail on their turn, which comes right after the running one is released.
  #exclusive(operation) {
    const run = this.#queue.then(() => {
      this.#alive();
      return operation();
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  // Throws DeviceError('invalid') for anything the mouse should not be sent; returns the bytes to write.
  #validate(key, value) {
    const invalid = (message) => new DeviceError('invalid', message);
    if (key === 'reportRateHz' && value === 8000 && this.connection === 'wireless') {
      throw invalid('8000 Hz is only available over the cable');
    }
    if (key === 'sensorMode' && this.connection === 'wired') {
      throw invalid('Sensor mode is fixed over the cable');
    }
    if (!this.#settings) throw invalid('Read the settings before changing them');
    if (key === 'dpiActiveStage' && value >= this.#settings.dpiStageCount) {
      throw invalid(`Stage ${value + 1} is beyond the ${this.#settings.dpiStageCount} stages in use`);
    }
    try {
      return encodeField(key, value);
    } catch (error) {
      throw invalid(error.message);
    }
  }

  #alive() {
    if (this.#closed) throw new DeviceError('disconnected', 'The mouse is disconnected');
  }

  // Sends one command and resolves with its parsed reply. Only called from inside #exclusive, so never concurrently.
  async #command(cmd, addr = 0, len = 0, data = []) {
    this.#alive();
    const payload = buildPayload(cmd, addr, len, data);
    try {
      // ponytail: the gap is measured from the end of the previous command; a retry is already a full timeout later.
      const gap = this.#lastEnd + this.#gapMs - performance.now();
      if (gap > 0) await this.#expect(gap, () => false).done;

      let sendError = null;
      for (let attempt = 1; attempt <= this.#attempts; attempt++) {
        this.#alive();
        // Listen before sending: the reply can arrive before sendReport resolves.
        const waiter = this.#expect(this.#timeoutMs, (reply) => reply.cmd === cmd && reply.addr === addr);
        sendError = null;
        try {
          await this.device.sendReport(REPORT_ID, payload);
        } catch (error) {
          // A failed send is a failed attempt, handled exactly like a timeout: wait out the rest of the
          // window (giving a transient failure time to clear) before the next attempt.
          sendError = error;
        }
        const reply = await waiter.done;
        this.#alive();
        if (reply) return reply;
        if (attempt === 2) this.dispatchEvent(new Event('waiting'));
      }
      if (sendError) {
        throw new DeviceError(
          'timeout',
          `Could not send to the mouse after ${this.#attempts} attempts: ${sendError.message}`,
          { cause: sendError },
        );
      }
      throw new DeviceError('timeout', `No reply from the mouse after ${this.#attempts} attempts`);
    } finally {
      this.#lastEnd = performance.now();
    }
  }

  // Waits up to `ms` for a reply `accept` approves. done resolves with the reply, or null on timeout or teardown.
  #expect(ms, accept) {
    const waiter = { accept };
    waiter.done = new Promise((resolve) => {
      const timer = setTimeout(() => waiter.finish(null), ms);
      waiter.finish = (reply) => {
        clearTimeout(timer);
        if (this.#waiter === waiter) this.#waiter = null;
        resolve(reply);
      };
    });
    this.#waiter = waiter;
    return waiter;
  }

  // The single input report listener for the lifetime of the connection (protocol spec GUD-002).
  #onReport = (event) => {
    const reply = parseReply(event.reportId, event.data);
    if (reply && this.#waiter?.accept(reply)) this.#waiter.finish(reply);
  };

  #onDisconnect = (event) => {
    if (event.device === this.device) this.#teardown();
  };

  // Shared by close() and unplugging. Queued commands fail on their turn, which comes right after this.
  #teardown() {
    if (this.#closed) return;
    this.#closed = true;
    this.#waiter?.finish(null);
    this.device.removeEventListener('inputreport', this.#onReport);
    this.#hid?.removeEventListener('disconnect', this.#onDisconnect);
    this.dispatchEvent(new Event('disconnect'));
  }
}
