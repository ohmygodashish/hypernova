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
  dpiStageCount: 'Stages in use',
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
let replugged = false; // a mouse showed up while a connect attempt was under way
let pollTimer = null;
let plan = null; // an import waiting for confirmation: { keys, parsed, skipped }
const pending = new Set(); // controls with a write in flight

// ---- Controls ----

const controls = $('settings');
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

// Shows one of the four page views; main[data-view] sets the layout.
function showView(name) {
  for (const id of ['unsupported', 'empty', 'loading', 'settings']) $(id).hidden = id !== name;
  $('main').dataset.view = name;
}

// The sections and the note rise one after another (--i drives the delay in style.css).
document.querySelectorAll('#settings > section, .note').forEach((el, i) => el.style.setProperty('--i', i));

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

// Forgets the mouse and shows the connect card.
function detach(message) {
  device = null;
  showView('empty');
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
        await old.close().catch((error) => console.warn('Could not close the previous mouse:', error)); // not fatal
        await next.open();
      }
    } catch (error) {
      console.error(error);
      setStatus(OPEN_FAILED, true);
      showView('empty');
      return;
    }
    if (next) await start(next);
    else if (!device) showView('empty'); // cancelled, or no granted mouse
  } finally {
    connecting = false;
    // On Windows one plug-in fires a connect event per collection, so one may arrive mid-attempt.
    const again = replugged;
    replugged = false;
    if (again && !device) connect(() => Hypernova.reconnect());
  }
}

async function start(dev) {
  device = dev;
  dev.addEventListener('waiting', () => { if (dev === device) setStatus(WAITING); });
  // The mouse has no USB serial number, so Chrome forgets the permission on unplug: a replug needs a Connect click.
  dev.addEventListener('disconnect', () => { if (dev === device) detach('Disconnected. Plug the mouse back in, then click Connect.'); });
  setStatus('Connecting…');
  showView('loading');
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
  showView('settings');
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

// The settings an import would change, in FIELDS order. parsed holds only the keys it accepted.
const changesFor = (current, parsed) => diffSettings(current, { ...current, ...parsed });

// Opens the review panel for `plan`: what applying it would change in the mouse's current settings.
function showPlan(current) {
  const { keys, parsed, skipped } = plan;
  $('import-changes').replaceChildren(...(keys.length
    ? keys.map((key) => li(`${LABELS[key]}: ${show(key, getSetting(current, key))} → ${show(key, getSetting(parsed, key))}`))
    : [li('No differences from the current settings.')]));
  $('import-skipped').replaceChildren(...skipped.map(({ key, reason }) => li(`${LABELS[key]}: ${reason}`)));
  $('import-skipped-box').hidden = !skipped.length;
  $('import-apply').disabled = !keys.length;
  $('import-panel').hidden = false;
}

$('import-file').addEventListener('change', async (event) => {
  plan = null; // a new file replaces the pending one, even if it turns out to be unusable
  $('import-panel').hidden = true;
  const [file] = event.target.files;
  event.target.value = ''; // so the same file can be chosen again
  if (!file || !device) return;
  const dev = device;
  try {
    const { settings: parsed, skipped } = parseBackup(await file.text(), { connection: dev.connection });
    const current = dev.settings;
    if (dev !== device) return;
    plan = { keys: changesFor(current, parsed), parsed, skipped };
    showPlan(current);
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

// Writes the keys, re-reads the mouse and returns the status to show. Never throws.
async function restore(dev, keys, parsed) {
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
  if (problem) return problem;
  const differ = changesFor(dev.settings, parsed).filter((key) => keys.includes(key));
  if (differ.length) {
    const [done, left] = [keys.length - differ.length, differ.length];
    return `Restored ${done} setting${done === 1 ? '' : 's'}, but ${left} still ${left === 1 ? 'differs' : 'differ'}: ${differ.map((key) => LABELS[key]).join(', ')}.`;
  }
  return `Restored ${keys.length} setting${keys.length === 1 ? '' : 's'}.`;
}

$('import-apply').addEventListener('click', async () => {
  const dev = device;
  const { keys, parsed, skipped } = plan;
  plan = null;
  $('import-panel').hidden = true;
  controls.disabled = true;
  let message;
  try {
    // The mouse can change while the file is under review (its own DPI button), so check the preview against it now.
    ({ errors } = await dev.readSettings());
    if (dev !== device) return;
    const now = changesFor(dev.settings, parsed);
    if (now.join() === keys.join()) {
      message = await restore(dev, keys, parsed);
    } else {
      plan = { keys: now, parsed, skipped };
      showPlan(dev.settings);
      message = 'The mouse changed since you opened the file. Review the updated changes and apply again.';
    }
  } catch (error) {
    message = error.message;
  }
  if (dev !== device) return;
  controls.disabled = false;
  render();
  setStatus(message);
});

// ---- Start ----

if (!isSecureContext || !('hid' in navigator)) {
  if (!isSecureContext) {
    $('h-unsupported').textContent = 'Open this page over HTTPS';
    $('unsupported').querySelector('p').textContent = 'The browser only allows WebHID on secure pages.';
  }
  $('copy-link').hidden = !navigator.clipboard;
  $('copy-link').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
    } catch (error) {
      return console.warn('Could not copy the link:', error);
    }
    $('copy-label').textContent = 'Link copied';
    setTimeout(() => { $('copy-label').textContent = 'Copy page link'; }, 2000);
  });
  $('device-bar').hidden = true;
  showView('unsupported');
} else {
  render(); // fills the selects before the first connection
  $('connect').addEventListener('click', () => connect(() => Hypernova.request()));
  navigator.hid.addEventListener('connect', () => {
    if (device) return;
    if (connecting) replugged = true; // connect() runs one more reconnect when the attempt ends
    else connect(() => Hypernova.reconnect());
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && device) refresh(device);
  });
  connect(() => Hypernova.reconnect());
}

// Offline copy of the page. Registered after load so it never slows the first paint; a failure only costs the offline copy.
addEventListener('load', () => {
  navigator.serviceWorker?.register('sw.js').catch((error) => console.warn('Service worker not registered:', error));
});
