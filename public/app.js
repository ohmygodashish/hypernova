// The page: binds the controls to the mouse. All device access goes through Hypernova (device.js);
// packets and flash addresses stay in device.js and protocol.js.

import { Hypernova } from './device.js';
import { FIELDS, STAGES, diffSettings, getSetting, toBackup, parseBackup } from './protocol.js';

const POLL_MS = 60_000;
const WAITING = 'Waiting for the mouse… move it to wake it.';
const OPEN_FAILED = 'Could not open the mouse. On Linux, install the udev rule (see README).';
const CONNECTION = { wired: 'Wired', wireless: 'Wireless (4K dongle)' };
const UNITS = { reportRateHz: ' Hz', lodMm: ' mm', debounceMs: ' ms' };

const LABELS = {
  reportRateHz: 'Report rate',
  dpiStageCount: 'Number of stages',
  dpiActiveStage: 'Active stage',
  lodMm: 'Lift-off distance',
  debounceMs: 'Debounce time',
  motionSync: 'Motion sync',
  sleepSeconds: 'Mouse sleep time',
  angleSnapping: 'Angle snapping',
  rippleControl: 'Ripple control',
  peakPerformance: 'Peak performance',
  peakPerformanceTime: 'Peak performance time',
  sensorMode: 'Sensor mode',
};
for (let i = 0; i < STAGES; i++) {
  LABELS[`dpiStages.${i}.dpi`] = `Stage ${i + 1} DPI`;
  LABELS[`dpiStages.${i}.color`] = `Stage ${i + 1} colour`;
}

const $ = (id) => document.getElementById(id);
const fieldOf = (key) => FIELDS.find((field) => field.key === key);
const li = (textContent) => Object.assign(document.createElement('li'), { textContent });

// ---- Page state ----

let device = null; // the connected Hypernova, or null
let firmware = '';
let errors = []; // unreadable fields from the last readSettings
let connecting = false;
let pollTimer = null;
let plan = null; // an import waiting for confirmation: { keys, parsed }
const pending = new Set(); // controls with a write in flight

// ---- Controls ----

const controls = $('controls');
const statusText = $('status-text');

// Six stage rows from the template; rows past the stage count are hidden by render().
for (let i = 0; i < STAGES; i++) {
  const row = $('stage-template').content.firstElementChild.cloneNode(true);
  row.querySelector('.stage-name span').textContent = `Stage ${i + 1}`;
  row.querySelector('[type=radio]').value = i;
  for (const [selector, prop] of [['[type=number]', 'dpi'], ['[type=color]', 'color']]) {
    const input = row.querySelector(selector);
    input.dataset.key = `dpiStages.${i}.${prop}`;
    input.setAttribute('aria-label', LABELS[input.dataset.key]); // the visible "DPI" / "Colour" is the same in every row
  }
  $('stages').append(row);
}
const rows = [...$('stages').querySelectorAll('.stage')];
const radios = [...document.querySelectorAll('[type=radio]')]; // all write dpiActiveStage
const byKey = {};
for (const el of document.querySelectorAll('[data-key]')) {
  if (el.type !== 'radio') byKey[el.dataset.key] = el;
}

function setStatus(text, help = false) {
  statusText.textContent = text;
  $('linux-help').hidden = !help;
}

// ---- Display ----

function optionLabel(key, human) {
  if (key === 'sleepSeconds') return human < 60 ? `${human} s` : `${human / 60} min`;
  if (key === 'dpiActiveStage') return `Stage ${human + 1}`;
  return `${human}${UNITS[key] ?? ''}`;
}

function show(key, value) {
  if (value === null || value === undefined) return 'Invalid';
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'object') return `${value.x} / ${value.y}`;
  return optionLabel(key, value);
}

// What a field that failed to decode shows: "Invalid", or "Unknown (0xNN)" with the first raw byte.
function unreadable(key) {
  const error = errors.find((e) => e.key === key);
  if (error?.reason !== 'unknown-value') return 'Invalid';
  return `Unknown (0x${error.raw[0].toString(16).toUpperCase().padStart(2, '0')})`;
}

// value: undefined before the first read, null when the mouse's value could not be decoded.
function renderSelect(select, field, value) {
  const wired = device?.connection === 'wired';
  let pairs = field.options ?? Array.from({ length: field.max - field.min + 1 }, (_, i) => [field.min + i]);
  if (field.key === 'reportRateHz' && !wired) pairs = pairs.filter(([hz]) => hz !== 8000);
  const corded = field.key === 'sensorMode' && wired; // fixed over the cable
  if (corded) {
    pairs = field.readOnlyOptions;
    value = 'Corded';
  }
  select.disabled = corded;

  const items = pairs.map(([human]) => new Option(optionLabel(field.key, human), human));
  const offered = pairs.some(([human]) => human === value);
  if (value !== undefined && !offered) {
    // Selected but not choosable: unreadable, or valid but not offered on this connection.
    const note = field.options?.some(([human]) => human === value) ? 'cable only' : 'read-only';
    const text = value === null ? unreadable(field.key) : `${optionLabel(field.key, value)} (${note})`;
    const placeholder = new Option(text, '');
    placeholder.disabled = true;
    items.unshift(placeholder);
  }
  select.replaceChildren(...items);
  select.value = offered ? String(value) : '';
}

function renderControl(el, field, value) {
  if (el.tagName === 'SELECT') {
    renderSelect(el, field, value);
  } else if (field.kind === 'bool') {
    el.checked = value === true;
    el.indeterminate = value === null;
  } else if (field.kind === 'color') {
    // ponytail: a colour that could not be read shows black, and picking black again fires no change event.
    el.value = value ?? '#000000';
  } else {
    // DPI: the input holds x; "X / Y" is shown beside it when the mouse has different values.
    const mixed = typeof value === 'object' && value !== null;
    el.value = (mixed ? value.x : value) ?? '';
    el.closest('.stage').querySelector('.xy').textContent = mixed ? `${value.x} / ${value.y}` : '';
  }
}

// Draws every control from device.settings. Controls with a write in flight keep what they show.
function render() {
  const settings = device?.settings;
  const wired = device?.connection === 'wired';
  const count = settings?.dpiStageCount ?? STAGES;
  rows.forEach((row, i) => { row.hidden = i >= count; });
  for (const [key, el] of Object.entries(byKey)) {
    if (!pending.has(el)) renderControl(el, fieldOf(key), getSetting(settings, key));
  }
  for (const radio of radios) {
    if (!pending.has(radio)) radio.checked = Number(radio.value) === settings?.dpiActiveStage;
  }

  const stuck = errors.filter(({ key }) => getSetting(settings, key) === null && !(wired && key === 'sensorMode'));
  $('warnings').replaceChildren(...stuck.map(({ key }) => (
    li(`${LABELS[key]}: ${unreadable(key)}. Choose a new value to repair it.`)
  )));
  const { dpiActiveStage: active, dpiStageCount: total } = settings ?? {};
  $('active-warning').hidden = !(Number.isInteger(active) && Number.isInteger(total) && active >= total);
  $('debounce-warning').hidden = !(Number.isInteger(settings?.debounceMs) && settings.debounceMs <= 3);
}

const batteryText = ({ percent, charging }) => (charging ? 'Charging' : `${percent}%`);

// ---- Connecting ----

// Forgets the mouse and locks the page.
function detach(message) {
  device = null;
  clearInterval(pollTimer);
  controls.disabled = true;
  plan = null;
  $('import-panel').hidden = true;
  $('connection').textContent = $('firmware').textContent = $('battery').textContent = '–';
  setStatus(message);
}

// open: Hypernova.request or Hypernova.reconnect.
async function connect(open) {
  if (connecting) return; // a chooser or a read is already under way
  connecting = true;
  try {
    let next;
    try {
      next = await open();
      if (next && device) {
        // Picking another device (or the same one again): let go of the old instance first, then reopen.
        const old = device;
        detach('Connecting…');
        await old.close();
        await next.open();
      }
    } catch (error) {
      console.error(error);
      setStatus(OPEN_FAILED, true);
      return;
    }
    if (next) await start(next);
  } finally {
    connecting = false;
  }
}

async function start(dev) {
  device = dev;
  dev.addEventListener('waiting', () => { if (dev === device) setStatus(WAITING); });
  dev.addEventListener('disconnect', () => { if (dev === device) detach('Disconnected'); });
  setStatus('Connecting…');
  try {
    ({ errors } = await dev.readSettings());
    firmware = await dev.readVersion();
    $('battery').textContent = batteryText(await dev.readBattery());
  } catch (error) {
    if (dev !== device) return; // unplugged while reading
    // ponytail: no retry button; after a failed first read the page is back to "not connected" and Connect tries again.
    detach(error.message);
    await dev.close();
    return;
  }
  if (dev !== device) return;
  $('connection').textContent = CONNECTION[dev.connection];
  $('firmware').textContent = firmware;
  controls.disabled = false;
  render();
  setStatus('Connected');
  pollTimer = setInterval(() => {
    if (document.visibilityState === 'visible') pollBattery(dev);
  }, POLL_MS);
}

async function pollBattery(dev) {
  try {
    const battery = await dev.readBattery();
    if (dev === device) $('battery').textContent = batteryText(battery);
  } catch {
    // ponytail: a failed background read is silent; the next action the user takes reports the problem.
  }
  if (dev === device && statusText.textContent === WAITING) setStatus('Connected');
}

// Re-reads everything: the mouse's own DPI button can change the active stage while the page is hidden.
async function refresh(dev) {
  try {
    const read = await dev.readSettings();
    const battery = await dev.readBattery();
    if (dev !== device) return;
    errors = read.errors;
    $('battery').textContent = batteryText(battery);
    render();
    setStatus('Connected');
  } catch (error) {
    if (dev === device) setStatus(error.message);
  }
}

// ---- Changing settings ----

function explain(key, error) {
  if (error.code === 'verify') return `${LABELS[key]} did not stick. The mouse reports ${show(key, error.actual)}.`;
  return `${LABELS[key]}: ${error.message}`;
}

function readControl(el, field) {
  if (el.type === 'checkbox') return el.checked;
  if (el.type === 'color') return el.value;
  if (field.options) return field.options.find(([human]) => String(human) === el.value)?.[0];
  return Number(el.value); // number input, numeric select, radio
}

// Writes one setting. The control is disabled while the write is pending, then redrawn from what the mouse reports.
async function save(el, key, value) {
  const dev = device;
  const hadFocus = document.activeElement === el;
  pending.add(el);
  el.disabled = true;
  setStatus('Saving…');
  let message = 'Saved';
  try {
    await dev.writeSetting(key, value);
  } catch (error) {
    message = explain(key, error);
  }
  pending.delete(el);
  el.disabled = false;
  if (dev !== device) return;
  render();
  if (message !== 'Saved' || !pending.size) setStatus(message); // not "Saved" while another write is still going
  if (hadFocus) el.focus(); // disabling dropped the focus
}

controls.addEventListener('change', (event) => {
  const el = event.target;
  const key = el.dataset.key;
  if (key && device) save(el, key, readControl(el, fieldOf(key)));
});

$('use-stage-1').addEventListener('click', (event) => save(event.currentTarget, 'dpiActiveStage', 0));

// ---- Backup ----

function download(name, text) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href));
}

$('export').addEventListener('click', () => {
  try {
    const now = new Date();
    const backup = toBackup(device.settings, { firmware, connection: device.connection, now });
    // The en-CA locale formats a date as YYYY-MM-DD in local time.
    download(`hypernova-settings-${now.toLocaleDateString('en-CA')}.json`, JSON.stringify(backup, null, 2));
    setStatus('Settings exported');
  } catch (error) {
    setStatus(error.message);
  }
});

$('import-file').addEventListener('change', async (event) => {
  const [file] = event.target.files;
  event.target.value = ''; // so the same file can be chosen again
  if (!file || !device) return;
  const dev = device;
  try {
    const { settings: parsed, skipped } = parseBackup(await file.text(), { connection: dev.connection });
    const current = dev.settings;
    const keys = diffSettings(current, { ...current, ...parsed }); // parsed holds only accepted keys
    if (dev !== device) return;
    plan = { keys, parsed };
    $('import-changes').replaceChildren(...(keys.length
      ? keys.map((key) => li(`${LABELS[key]}: ${show(key, getSetting(current, key))} → ${show(key, getSetting(parsed, key))}`))
      : [li('No differences from the current settings.')]));
    $('import-skipped').replaceChildren(...skipped.map(({ key, reason }) => li(`${LABELS[key]}: ${reason}`)));
    $('import-skipped-box').hidden = !skipped.length;
    $('import-apply').disabled = !keys.length;
    $('import-panel').hidden = false;
    setStatus('Review the changes, then apply or cancel.');
  } catch (error) {
    setStatus(`Import failed: ${error.message}`); // nothing was written
  }
});

$('import-cancel').addEventListener('click', () => {
  plan = null;
  $('import-panel').hidden = true;
  setStatus('Import cancelled');
});

$('import-apply').addEventListener('click', async () => {
  const dev = device;
  const { keys, parsed } = plan;
  plan = null;
  $('import-panel').hidden = true;
  controls.disabled = true;
  let problem = null;
  for (const [i, key] of keys.entries()) { // FIELDS order, so the stage count lands before the active stage
    setStatus(`Restoring ${i + 1} of ${keys.length}: ${LABELS[key]}…`);
    try {
      await dev.writeSetting(key, getSetting(parsed, key));
    } catch (error) {
      problem = `Restore stopped. ${explain(key, error)}`;
      break;
    }
  }
  try {
    ({ errors } = await dev.readSettings());
  } catch (error) {
    problem ??= error.message;
  }
  if (dev !== device) return;
  controls.disabled = false;
  render();
  setStatus(problem ?? `Restored ${keys.length} setting${keys.length === 1 ? '' : 's'}.`);
});

// ---- Start ----

if (!isSecureContext || !('hid' in navigator)) {
  $('unsupported').textContent = isSecureContext
    ? 'This app needs a Chromium-based desktop browser such as Chrome, Edge, Opera, Brave or Arc.'
    : 'This page must be opened over HTTPS.';
  $('unsupported').hidden = false;
  $('device-bar').hidden = true;
  $('main').hidden = true;
} else {
  render(); // fills the selects before the first connection
  $('connect').addEventListener('click', () => connect(() => Hypernova.request()));
  navigator.hid.addEventListener('connect', () => {
    if (!device) connect(() => Hypernova.reconnect());
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && device) refresh(device);
  });
  connect(() => Hypernova.reconnect());
}
