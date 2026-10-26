import { runMultiSchedule, type Coding, type MultiTimedLevels } from '@flashlink/protocol';
import { icon } from '../ui/icons';
import { emitterIcon } from './icons';
import {
  BULBS,
  calibrationTransmission,
  DEFAULT_SLOT_MS,
  formatDuration,
  nextMsgId,
  planMessage,
  SLOT_MS,
  type Plan,
BRIGHTNESS, DEFAULT_BRIGHTNESS, } from './logic';
import { HUD_BAND_PX, layoutTiles, SendStage } from './stage';
import { bindStepper } from './stepper';

const STORAGE_KEY = 'flashlink.emitter.v1';
const CALIBRATE_MS = 10_000;

interface Settings {
  text: string;
  bulbs: number;
  coding: Coding;
  slotMs: number;
  repeat: boolean;
  brightness: number;
}

const settings: Settings = {
  text: 'Meet at the north gate, 21:40',
  bulbs: 4,
  coding: 'pulse',
  slotMs: DEFAULT_SLOT_MS,
  repeat: true,
  brightness: DEFAULT_BRIGHTNESS,
  ...load(),
};

function load(): Partial<Settings> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const s = JSON.parse(raw) as Partial<Settings>;
    const out: Partial<Settings> = {};
    if (typeof s.text === 'string') out.text = s.text;
    if (Number.isInteger(s.bulbs) && s.bulbs! >= BULBS.min && s.bulbs! <= BULBS.max) out.bulbs = s.bulbs;
    if (s.coding === 'pulse' || s.coding === 'manchester') out.coding = s.coding;
    if (Number.isInteger(s.slotMs) && s.slotMs! >= SLOT_MS.min && s.slotMs! <= SLOT_MS.max) out.slotMs = s.slotMs;
    if (typeof s.repeat === 'boolean') out.repeat = s.repeat;
    if (Number.isInteger(s.brightness) && s.brightness! >= BRIGHTNESS.min && s.brightness! <= BRIGHTNESS.max)
      out.brightness = s.brightness;
    return out;
  } catch {
    return {};
  }
}

function save(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private mode or blocked storage: settings just don't persist.
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  message: $<HTMLTextAreaElement>('message'),
  counter: $('counter'),
  eta: $('eta'),
  error: $('message-error'),
  coding: $('coding'),
  slotHint: $('slot-hint'),
  repeat: $<HTMLButtonElement>('repeat'),
  send: $<HTMLButtonElement>('send'),
  calibrate: $<HTMLButtonElement>('calibrate'),
  statusTitle: $('status-title'),
  statusText: $('status-text'),
  preview: $('preview'),
  previewCaption: $('preview-caption'),
};

$('brand-mark').innerHTML = emitterIcon('squaresFour', 18);
$('to-receiver').insertAdjacentHTML('beforeend', emitterIcon('arrowUpRight', 14));
ui.send.innerHTML = `${icon('play', 16)}<span>Send</span>`;
ui.calibrate.innerHTML = `${icon('crosshair', 16)}<span>Calibrate</span>`;

const stage = new SendStage($('stage'));
let msgId = Math.floor(Math.random() * 16);
let plan: Plan;
let sending: AbortController | null = null;

// ---------- Controls ----------

ui.message.value = settings.text;
ui.message.addEventListener('input', () => {
  settings.text = ui.message.value;
  update();
});

const bulbs = bindStepper($('bulbs'), BULBS, () => settings.bulbs, (v) => {
  settings.bulbs = v;
  update();
});
const slot = bindStepper($('slot'), SLOT_MS, () => settings.slotMs, (v) => {
  settings.slotMs = v;
  update();
});
const brightness = bindStepper($('brightness'), BRIGHTNESS, () => settings.brightness, (v) => {
  settings.brightness = v;
  update();
});

for (const b of ui.coding.querySelectorAll<HTMLButtonElement>('[data-value]')) {
  b.addEventListener('click', () => {
    settings.coding = b.dataset.value as Coding;
    update();
  });
}
ui.coding.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  settings.coding = settings.coding === 'pulse' ? 'manchester' : 'pulse';
  update();
  ui.coding.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
});

ui.repeat.addEventListener('click', () => {
  settings.repeat = !settings.repeat;
  update();
});

ui.send.addEventListener('click', () => {
  if (!plan.ok || sending) return; // check before burning a message id
  msgId = nextMsgId(msgId);
  // Rebuild with the new msgId; repeats inside this Send reuse it.
  const p = planMessage(settings.text, { lanes: settings.bulbs, coding: settings.coding, slotMs: settings.slotMs, msgId });
  if (!p.ok) return;
  void play('send', p.signal, settings.repeat);
});

ui.calibrate.addEventListener('click', () => {
  if (sending) return;
  void play('calibrate', calibrationTransmission(settings.bulbs, settings.slotMs, settings.coding, CALIBRATE_MS), false);
});

// ---------- Sending ----------

async function play(kind: 'send' | 'calibrate', signal: MultiTimedLevels, loop: boolean): Promise<void> {
  if (sending) return;
  const abort = new AbortController();
  sending = abort;
  stage.onExit = () => {
    abort.abort();
    // The schedule notices within one slot; until then Send stays visibly blocked.
    ui.send.disabled = ui.calibrate.disabled = true;
    setStatus('Stopping…', '');
  };
  stage.open(signal.lanes.length, settings.brightness / 100); // synchronous: still inside the click gesture
  const label = kind === 'send' ? `msg ${msgId}` : 'calibrate';
  let pass = 0;
  let failure: unknown = null;
  try {
    do {
      pass++;
      let shown = -1;
      await runMultiSchedule(signal, stage.setLevels, {
        abort: abort.signal,
        onProgress: (done, total) => {
          // Coarse 5% steps keep the corner text from flickering in the camera's view.
          const pct = Math.floor((done / total) * 20) * 5;
          if (pct === shown) return;
          shown = pct;
          stage.progress(`${label} · ${loop ? `pass ${pass} · ` : ''}${pct}%`);
        },
      });
    } while (loop && !abort.signal.aborted);
  } catch (err) {
    failure = err;
  } finally {
    stage.close();
    sending = null;
    ui.calibrate.disabled = false;
    update();
    const stopped = abort.signal.aborted;
    if (failure !== null) setStatus('Send failed', failure instanceof Error ? failure.message : String(failure));
    else if (kind === 'calibrate') setStatus(stopped ? 'Calibration stopped' : 'Calibration done', 'Send your message when the receiver shows a tight timing peak.');
    else
      setStatus(
        stopped ? `Stopped during pass ${pass}` : 'Sent',
        `Message ${msgId} on ${signal.lanes.length === 1 ? '1 bulb' : `${signal.lanes.length} bulbs`}. Send again for a new message id.`,
      );
  }
}

function setStatus(title: string, text: string): void {
  ui.statusTitle.textContent = title;
  ui.statusText.textContent = text;
}

// ---------- Render ----------

function update(): void {
  plan = planMessage(settings.text, { lanes: settings.bulbs, coding: settings.coding, slotMs: settings.slotMs, msgId });
  const chars = [...settings.text].length;
  ui.counter.textContent = `${chars} ${chars === 1 ? 'char' : 'chars'} · ${plan.bytes}/${plan.capacity} bytes${plan.compressed ? ' · 6-bit' : ''}`;
  ui.counter.dataset.over = String(plan.bytes > plan.capacity);
  ui.eta.textContent = plan.ok ? `${formatDuration(plan.etaMs)} per pass` : '';
  const showError = !plan.ok && settings.text.length > 0;
  ui.error.hidden = !showError;
  if (!plan.ok && showError) ui.error.innerHTML = `${icon('warningCircle', 16)}<span>${escapeHtml(plan.error)}</span>`;
  ui.message.setAttribute('aria-invalid', String(showError));
  ui.send.disabled = !plan.ok;

  for (const b of ui.coding.querySelectorAll<HTMLButtonElement>('[data-value]')) {
    const on = b.dataset.value === settings.coding;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  ui.slotHint.textContent =
    settings.coding === 'manchester'
      ? `1 bit = 2 slots = ${2 * settings.slotMs} ms`
      : `2 bits per run of 1–4 slots`;
  ui.repeat.setAttribute('aria-checked', String(settings.repeat));
  bulbs.render();
  slot.render();
  brightness.render();
  renderPreview();
  save();
}

let previewTiles: HTMLElement[] = [];

function renderPreview(): void {
  const n = settings.bulbs;
  if (previewTiles.length !== n) {
    previewTiles = Array.from({ length: n }, (_, i) => {
      const t = document.createElement('div');
      t.className = 'em-preview-tile';
      t.innerHTML = `<span>${i + 1}</span>`;
      return t;
    });
    ui.preview.replaceChildren(...previewTiles);
  }
  const l = { 1: '1', 2: '2 × 1', 3: '3 × 1', 4: '2 × 2', 5: '3 × 2', 6: '3 × 2' } as Record<number, string>;
  ui.previewCaption.textContent = `${n === 1 ? '1 bulb' : `${n} bulbs`} · ${l[n] ?? '3 × 3'}`;
  layoutPreview();
}

function layoutPreview(): void {
  const h = ui.preview.clientHeight;
  // Same proportions as the stage, which keeps a band free at the bottom for Stop.
  layoutTiles(ui.preview, previewTiles, ui.preview.clientWidth, h - (h * HUD_BAND_PX) / (screen.height || 900));
}

// The preview has the shape of this screen, as the fullscreen stage will.
ui.preview.style.aspectRatio = `${screen.width || 16} / ${screen.height || 10}`;
new ResizeObserver(layoutPreview).observe(ui.preview);

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

update();
