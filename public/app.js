// The page: binds the controls to the mouse. All device access goes through Hypernova (device.js);
// packets and flash addresses stay in device.js and protocol.js.

import { Hypernova } from './device.js';
import { FIELDS, STAGES, diffSettings, getSetting, toBackup, parseBackup } from './protocol.js';

const POLL_MS = 60_000;
const WAITING = 'Waiting for the mouse. Move it to wake it.';
const OPEN_FAILED = 'Could not open the mouse. On Linux, install the udev rule first.';
const CONNECTION = { wired: 'Wired', wireless: 'Wireless · 4K dongle' };
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

// Six stage tiles from the template; tiles past the stage count are hidden by render().
for (let i = 0; i < STAGES; i++) {
  const tile = $('stage-template').content.firstElementChild.cloneNode(true);
  tile.style.viewTransitionName = `stage-${i + 1}`; // CSSOM, so CSP allows it
  tile.style.viewTransitionClass = 'stage';
  tile.querySelector('.stage-name span').textContent = `Stage ${i + 1}`;
  tile.querySelector('[type=radio]').value = i;
  tile.querySelector('.pick input').ariaLabel = `Make stage ${i + 1} active`;
  for (const [selector, prop] of [['[type=number]', 'dpi'], ['[type=color]', 'color']]) {
    const input = tile.querySelector(selector);
    input.dataset.key = `dpiStages.${i}.${prop}`;
    input.ariaLabel = LABELS[input.dataset.key];
  }
  $('stages').append(tile);
}
const tiles = [...$('stages').children];
const radios = [...$('stages').querySelectorAll('[type=radio]')]; // all write dpiActiveStage
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

// ---- The island: status and messages share one strip that springs between sizes ----

const SPRING = 'linear(0,0.019,0.068,0.137,0.219,0.307,0.397,0.485,0.568,0.644,0.714,0.775,0.828,0.873,0.911,0.942,0.967,0.986,1.001,1.012,1.02,1.025,1.027,1.028,1.028,1.027,1.025,1.023,1.02,1.018,1.015,1.013,1.011,1.009,1.007,1.005,1.004,1.003,1.002,1.001,1)';
const strip = $('strip');
const statusLayer = $('strip-status');
const msgLayer = $('strip-msg');
let morphAnim = null;
let morphing = false;
let hideTimer = 0;
let holding = false; // the pointer is over the strip
let autoHide = false; // the message showing goes back to the status by itself

// Runs update() and springs the strip from its old size to its new one. Nested calls join the outer one.
function morph(update) {
  if (morphing) return update();
  const from = strip.getBoundingClientRect();
  morphAnim?.cancel();
  morphing = true;
  try {
    update();
  } finally {
    morphing = false;
  }
  const to = strip.getBoundingClientRect();
  const same = Math.abs(to.width - from.width) < 1 && Math.abs(to.height - from.height) < 1;
  if (same || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  morphAnim = strip.animate([{ width: `${from.width}px`, height: `${from.height}px` }, { width: `${to.width}px`, height: `${to.height}px` }], { duration: 650, easing: SPRING });
}

// Shows one layer and takes the other out of the tab order and the accessibility tree.
function showLayer(message) {
  statusLayer.classList.toggle('off', message);
  statusLayer.inert = message;
  msgLayer.classList.toggle('off', !message);
  msgLayer.inert = !message;
}

// state: 'idle', 'connecting' or 'ready'. Disconnect is offered only while ready.
function stripStatus(state) {
  morph(() => {
    for (const name of ['idle', 'connecting', 'ready']) $(`st-${name}`).hidden = name !== state;
    $('disconnect').hidden = state !== 'ready';
  });
}

const part = (name) => $('strip-parts').content.querySelector(`[data-part="${name}"]`).cloneNode(true);

function hideMessage() {
  clearTimeout(hideTimer);
  autoHide = false;
  morph(() => {
    strip.dataset.kind = 'status';
    showLayer(false);
  });
}

// Messages return to the status after 2.2 s, but wait while the pointer is over the strip or the tab is hidden.
function hideLater() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => (document.hidden || holding ? hideLater() : hideMessage()), 2200);
}

// nodes: the new content, or null to keep what the layer holds. kind: status, saving, saved, info, warn or error.
function present(kind, nodes, auto) {
  clearTimeout(hideTimer);
  const replacing = nodes && !msgLayer.classList.contains('off');
  morph(() => {
    strip.dataset.kind = kind;
    msgLayer.dataset.msg = kind;
    if (nodes) msgLayer.replaceChildren(...nodes);
    showLayer(true);
  });
  // One message replacing another: blur the new content in, like the layer cross-fade.
  if (replacing) msgLayer.animate([{ opacity: 0, filter: 'blur(4px)' }, { opacity: 1, filter: 'blur(0px)' }], { duration: 250, easing: 'cubic-bezier(0.23,1,0.32,1)' });
  autoHide = auto;
  if (auto) hideLater();
}

// icon: check, busy, idle, mouse, alert or error.
function say(kind, icon, text, link = false) {
  const body = Object.assign(document.createElement('span'), { textContent: text });
  if (link) body.append(' ', Object.assign(document.createElement('a'), { href: 'https://github.com/ohmygodashish/hypernova#linux', textContent: 'Linux setup' }));
  const nodes = [part(icon), body];
  if (kind === 'error') {
    const close = part('x');
    close.addEventListener('click', hideMessage);
    nodes.push(close);
  }
  present(kind, nodes, kind !== 'error' && icon !== 'busy'); // errors and progress stay until replaced or dismissed
}
const fail = (text, link) => say('error', 'error', text, link);
const done = (text) => say('saved', 'check', text);

// phase: 'saving' (stays) or 'saved' (then back to the status). Saving to Saved swaps inside the same layer.
function showSave(phase) {
  const swapping = !msgLayer.classList.contains('off') && msgLayer.querySelector('.msg-swap');
  present(phase, swapping ? null : [part('save')], phase === 'saved');
}

strip.addEventListener('mouseenter', () => { holding = true; });
strip.addEventListener('mouseleave', () => {
  holding = false;
  if (autoHide) hideLater();
});

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

// What a select or a button group offers for a field. value: undefined before the first read, null when the
// mouse's value could not be decoded. blocked(pair): not choosable now (8000 Hz off the cable). odd: the value
// is shown but cannot be chosen (unreadable, read-only, or blocked): { human, text, note }.
function choicesFor(field, value) {
  const wired = device?.connection === 'wired';
  const corded = field.key === 'sensorMode' && wired; // fixed over the cable
  const pairs = corded ? field.readOnlyOptions : field.options ?? Array.from({ length: field.max - field.min + 1 }, (_, i) => [field.min + i]);
  if (corded) value = 'Corded';
  const blocked = ([human]) => field.key === 'reportRateHz' && human === 8000 && !wired;
  let odd = null;
  if (value !== undefined && !pairs.some((pair) => pair[0] === value && !blocked(pair))) {
    const note = field.options?.some(([human]) => human === value) ? 'cable only' : 'read-only';
    odd = value === null ? { human: null, text: unreadable(field.key), note: '' } : { human: value, text: optionLabel(field.key, value), note };
  }
  return { pairs, blocked, corded, value, odd };
}

function renderSelect(select, field, value) {
  const { pairs, blocked, corded, value: shown, odd } = choicesFor(field, value);
  select.disabled = corded;
  const items = pairs.filter((pair) => !blocked(pair)).map(([human]) => new Option(optionLabel(field.key, human), human));
  if (odd) {
    const placeholder = new Option(odd.note ? `${odd.text} (${odd.note})` : odd.text, '');
    placeholder.disabled = true;
    items.unshift(placeholder);
  }
  select.replaceChildren(...items);
  select.value = odd ? '' : String(shown ?? '');
}

// Button group text and accessible name per option (the select shows optionLabel).
const SEG_NAMES = { LP: 'Low power', HP: 'High performance' };
const segText = (key, human) => (key === 'lodMm' ? optionLabel(key, human) : String(human));

function segOption(key, human, text, { name, title, checked, disabled, odd }) {
  const input = Object.assign(document.createElement('input'), { type: 'radio', name: key, value: human ?? '', checked, disabled });
  if (name) input.setAttribute('aria-label', name);
  const label = Object.assign(document.createElement('label'), { className: odd ? 'odd' : '', title: title ?? '' });
  label.append(input, Object.assign(document.createElement('span'), { textContent: text }));
  return label;
}

function renderSegments(fieldset, field, value) {
  const { pairs, blocked, corded, value: shown, odd } = choicesFor(field, value);
  const key = field.key;
  fieldset.disabled = corded;
  const items = pairs.map((pair) => {
    const [human] = pair;
    const cableOnly = blocked(pair);
    return segOption(key, human, segText(key, human), {
      name: cableOnly ? `${human} Hz, cable only` : key === 'reportRateHz' ? `${human} Hz` : SEG_NAMES[human],
      title: cableOnly ? 'Cable only' : '',
      checked: human === shown,
      disabled: cableOnly,
      odd: cableOnly && odd?.human === human,
    });
  });
  // A value that is not one of the options gets an extra first one.
  if (odd && !pairs.some(([human]) => human === odd.human)) {
    items.unshift(segOption(key, null, odd.text, { checked: true, disabled: true, odd: true }));
  }
  // Rebuild only when the options change, so the thumb keeps sliding and focus stays put. outerHTML leaves out `checked`.
  const shape = items.map((label) => label.outerHTML).join('');
  if (fieldset.shape !== shape) {
    fieldset.shape = shape;
    fieldset.style.setProperty('--n', items.length);
    fieldset.replaceChildren(Object.assign(document.createElement('span'), { className: 'seg-thumb', ariaHidden: 'true' }), ...items);
  } else {
    fieldset.querySelectorAll('input').forEach((input, i) => { input.checked = items[i].firstElementChild.checked; });
  }
}

function renderControl(el, field, value) {
  if (el.tagName === 'SELECT') {
    renderSelect(el, field, value);
  } else if (el.tagName === 'FIELDSET') {
    renderSegments(el, field, value);
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

let morphCount = false; // the stage count was just clicked with a pointer: the next render morphs the tiles

// Draws every control from device.settings. Controls with a write in flight keep what they show.
function render() {
  const settings = device?.settings;
  const wired = device?.connection === 'wired';
  const count = settings?.dpiStageCount ?? STAGES;
  const layout = () => {
    $('stages').dataset.count = count;
    tiles.forEach((tile, i) => { tile.hidden = i >= count; });
  };
  // Only a pointer click morphs; keyboard, reduced motion, and counts that arrive by restore or refresh just switch.
  if (morphCount && document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches && $('stages').dataset.count !== String(count)) {
    document.startViewTransition(layout);
  } else {
    layout();
  }
  morphCount = false;
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
  const outside = Number.isInteger(active) && Number.isInteger(total) && active >= total;
  $('active-warning').hidden = !outside;
  if (outside) $('active-text').textContent = `The mouse's active stage is stage ${active + 1}, but only ${total} stage${total === 1 ? ' is' : 's are'} in use.`;
  // The active stage's colour tints the card; neutral when it is unknown or outside the count.
  const accent = Number.isInteger(active) && active < count ? getSetting(settings, `dpiStages.${active}.color`) : null;
  if (accent) document.documentElement.style.setProperty('--accent', accent);
  else document.documentElement.style.removeProperty('--accent');
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
  $('disconnect').disabled = false;
  morph(() => {
    stripStatus('idle');
    if (message) say('info', 'idle', message);
    else hideMessage();
  });
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
        detach();
        await old.close().catch((error) => console.warn('Could not close the previous mouse:', error)); // not fatal
        await next.open();
      }
    } catch (error) {
      console.error(error);
      fail(OPEN_FAILED, true);
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
  dev.addEventListener('waiting', () => { if (dev === device) say('warn', 'mouse', WAITING); });
  // The mouse has no USB serial number, so Chrome forgets the permission on unplug: a replug needs a Connect click.
  dev.addEventListener('disconnect', () => { if (dev === device) detach('Disconnected. Plug the mouse back in, then click Connect.'); });
  stripStatus('connecting');
  showView('loading');
  try {
    ({ errors } = await dev.readSettings());
    firmware = await dev.readVersion();
    $('battery').textContent = batteryText(await dev.readBattery());
  } catch (error) {
    if (dev !== device) return; // unplugged while reading
    // ponytail: no retry button; after a failed first read the page is back to "not connected" and Connect tries again.
    morph(() => {
      detach();
      fail(error.message);
    });
    await dev.close();
    return;
  }
  if (dev !== device) return;
  $('connection').textContent = CONNECTION[dev.connection];
  $('firmware').textContent = firmware;
  controls.disabled = false;
  render();
  showView('settings');
  morph(() => {
    stripStatus('ready');
    hideMessage(); // a stale error or waiting hint from this attempt
  });
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
  } catch (error) {
    if (dev === device) fail(error.message);
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
  return Number(el.value); // number input, numeric select, stage count radio
}

// Writes one setting. el is the control, or a button group's fieldset. It is disabled while the write is pending,
// then redrawn from what the mouse reports.
async function save(el, key, value) {
  const dev = device;
  const hadFocus = el.contains(document.activeElement);
  pending.add(el);
  el.disabled = true;
  showSave('saving');
  let message = null;
  try {
    await dev.writeSetting(key, value);
  } catch (error) {
    message = explain(key, error);
  }
  pending.delete(el);
  el.disabled = false;
  if (dev !== device) return;
  render();
  if (message) fail(message);
  else if (!pending.size) showSave('saved'); // not "Saved" while another write is still going
  if (hadFocus) (el.querySelector('input:checked') ?? el).focus(); // disabling dropped the focus; render() rebuilt a group's radios
}

controls.addEventListener('change', (event) => {
  const el = event.target;
  const group = el.closest('.seg') ?? el; // a radio of a button group saves through its fieldset
  const key = group.dataset.key;
  if (key === 'dpiStageCount') morphCount = !el.matches(':focus-visible'); // the write disables the group, so ask now
  if (key && device) save(group, key, readControl(el, fieldOf(key)));
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
    done('Settings exported');
  } catch (error) {
    fail(error.message);
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
  } catch (error) {
    fail(`Import failed: ${error.message}`); // nothing was written
  }
});

$('import-cancel').addEventListener('click', () => {
  plan = null;
  $('import-panel').hidden = true;
});

// Writes the keys, re-reads the mouse and returns the message to show: [kind, icon, text]. Never throws.
async function restore(dev, keys, parsed) {
  let problem = null;
  for (const [i, key] of keys.entries()) { // FIELDS order, so the stage count lands before the active stage
    say('info', 'busy', `Restoring ${i + 1} of ${keys.length}: ${LABELS[key]}…`);
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
  if (problem) return ['error', 'error', problem];
  const differ = changesFor(dev.settings, parsed).filter((key) => keys.includes(key));
  if (differ.length) {
    const [restored, left] = [keys.length - differ.length, differ.length];
    return ['error', 'error', `Restored ${restored} setting${restored === 1 ? '' : 's'}, but ${left} still ${left === 1 ? 'differs' : 'differ'}: ${differ.map((key) => LABELS[key]).join(', ')}.`];
  }
  return ['saved', 'check', `Restored ${keys.length} setting${keys.length === 1 ? '' : 's'}`];
}

$('import-apply').addEventListener('click', async () => {
  const dev = device;
  const { keys, parsed, skipped } = plan;
  plan = null;
  $('import-panel').hidden = true;
  controls.disabled = true;
  $('disconnect').disabled = true; // not while the restore writes
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
      message = ['warn', 'alert', 'The mouse changed since you opened the file. Review the changes and restore again.'];
    }
  } catch (error) {
    message = ['error', 'error', error.message];
  }
  if (dev !== device) return;
  controls.disabled = false;
  $('disconnect').disabled = false;
  render();
  say(...message);
});

$('disconnect').addEventListener('click', async () => {
  const dev = device;
  detach(); // before close(), so the disconnect event finds no matching device and shows no unplug message
  await dev.close().catch((error) => console.warn('Could not close the mouse:', error));
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
  strip.hidden = true;
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
