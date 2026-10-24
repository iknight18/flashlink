import { Receiver, type ReceiverEvent, type ReceiverState } from '@flashlink/protocol';
import { channels } from './channels/registry';
import type { Sensor } from './channels/types';
import { Diagnostics, reportPageErrors, type SignalStats } from './diagnostics';
import { Graph } from './ui/graph';
import { Histogram } from './ui/histogram';
import { icon } from './ui/icons';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const select = $<HTMLSelectElement>('channel');
const startBtn = $<HTMLButtonElement>('start');
const viewport = $<HTMLDivElement>('viewport');
const video = $<HTMLVideoElement>('video');
const pill = $<HTMLSpanElement>('pill');
const pillText = $<HTMLSpanElement>('pill-text');
const statusTitle = $<HTMLParagraphElement>('status-title');
const statusText = $<HTMLParagraphElement>('status-text');
const progress = $<HTMLDivElement>('progress');
const progressFill = $<HTMLSpanElement>('progress-fill');
const errorEl = $<HTMLParagraphElement>('error');
const feedEl = $<HTMLOListElement>('feed');
const feedEmpty = $<HTMLParagraphElement>('feed-empty');
const feedCount = $<HTMLSpanElement>('feed-count');
const fpsHint = $<HTMLParagraphElement>('fps-hint');

$('brand-mark').innerHTML = icon('flashlight', 18);
$('empty-icon').innerHTML = icon('cameraSlash', 22);

const graph = new Graph($<HTMLCanvasElement>('graph'));
const histogram = new Histogram($<HTMLCanvasElement>('histogram'));

for (const c of channels) select.add(new Option(c.label, c.id));

type UiState = ReceiverState | 'IDLE';

const COPY: Record<UiState, { pill: string; title: string; text: string }> = {
  IDLE: { pill: 'Idle', title: 'Ready when you are', text: 'Press Start to open the camera.' },
  HUNTING: { pill: 'Searching', title: 'Looking for the light', text: 'Point the camera at the sender. Calibrate on the emitter helps it lock on.' },
  LOCKED: { pill: 'Locked', title: 'Locked on', text: 'Timing found. Waiting for the start of a message.' },
  READING: { pill: 'Receiving', title: 'Receiving', text: 'The message streams into the list below.' },
  DONE: { pill: 'Received', title: 'Message received', text: 'Listening for the next one.' },
};

/** How long a lost or garbled attempt stays visible before it fades out. */
const NOTICE_MS = 4000;

let sensor: Sensor | null = null;
/** The row streaming the message currently arriving, if any. */
let live: HTMLLIElement | null = null;
let notice = 0;

function setStartButton(running: boolean): void {
  startBtn.innerHTML = running ? `${icon('stop', 16)}Stop` : `${icon('play', 16)}Start`;
  startBtn.toggleAttribute('data-running', running);
}

function setState(state: UiState): void {
  const copy = COPY[state];
  clearTimeout(notice);
  pill.dataset.state = state;
  pillText.textContent = copy.pill;
  statusTitle.textContent = copy.title;
  statusText.textContent = copy.text;
  progress.hidden = state !== 'READING';
  if (state !== 'READING') progressFill.style.transform = 'scaleX(0)';
}

function showError(text: string | null): void {
  errorEl.hidden = text === null;
  errorEl.innerHTML = text === null ? '' : `${icon('warningCircle', 16)}<span></span>`;
  if (text !== null) errorEl.querySelector('span')!.textContent = text;
}

/** Below this, a 100 ms half-bit (200 ms bits) spans fewer than ~2.5 frames and can't be decoded. */
const MIN_FPS_FOR_200 = 25;

function showStats(s: SignalStats): void {
  $('stat-fps').textContent = s.fps.toFixed(1);
  fpsHint.hidden = s.fps >= MIN_FPS_FOR_200;
  fpsHint.textContent = `The camera is only delivering ${Math.round(s.fps)} fps. That's enough for 400 ms bits, but 200 ms needs about 30 fps. Add light to the room or use a phone as the receiver.`;
  $('stat-contrast').textContent = s.contrast.toFixed(2);
  $('stat-median').textContent = s.edges.median === undefined ? '–' : `${s.edges.median} ms`;
  $('stat-spread').textContent = s.edges.n > 1 ? `${s.edges.max! - s.edges.min!} ms` : '–';
}

const clock = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function makeRow(text: string): HTMLLIElement {
  const li = document.createElement('li');
  const time = document.createElement('time');
  time.textContent = clock();
  const span = document.createElement('span');
  span.className = 'text';
  span.textContent = text;
  const count = document.createElement('b');
  count.className = 'count';
  li.append(time, span, count);
  return li;
}

function updateFeedMeta(): void {
  const n = feedEl.querySelectorAll('li[data-verified]').length;
  feedEmpty.hidden = feedEl.children.length > 0;
  feedCount.textContent = n ? String(n) : '';
}

/** Last verified row, which a looping emitter keeps repeating. */
const lastVerified = () => [...feedEl.querySelectorAll<HTMLLIElement>('li[data-verified]')].at(-1) ?? null;

function streamText(text: string): void {
  const last = lastVerified();
  // A repeat of the last message only pulses its row; a new message streams into a live row.
  if (!live && last && last.dataset.text!.startsWith(text)) {
    last.toggleAttribute('data-repeating', true);
    return;
  }
  last?.removeAttribute('data-repeating');
  if (!live) {
    live = makeRow('');
    live.dataset.live = '';
    feedEl.append(live);
    updateFeedMeta();
  }
  live.querySelector('.text')!.textContent = text;
  live.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function addMessage(text: string): void {
  const last = lastVerified();
  last?.removeAttribute('data-repeating');
  if (!live && last?.dataset.text === text) {
    const count = Number(last.dataset.count) + 1;
    last.dataset.count = String(count);
    last.querySelector('time')!.textContent = clock();
    last.querySelector('.count')!.textContent = `×${count}`;
    return;
  }
  const row = live ?? makeRow(text);
  live = null;
  row.removeAttribute('data-live');
  row.dataset.verified = '';
  row.dataset.text = text;
  row.dataset.count = '1';
  row.querySelector('.text')!.textContent = text;
  if (!row.isConnected) feedEl.append(row);
  while (feedEl.children.length > 50) feedEl.firstElementChild!.remove();
  updateFeedMeta();
}

/** Marks the live attempt as failed, lets it fade out, and says the receiver keeps searching. */
function failAttempt(reason: string, bestGuess?: string): void {
  lastVerified()?.removeAttribute('data-repeating');
  if (live) {
    const row = live;
    live = null;
    row.removeAttribute('data-live');
    row.dataset.failed = '';
    if (bestGuess !== undefined) row.querySelector('.text')!.textContent = bestGuess;
    row.querySelector('.count')!.textContent = reason;
    setTimeout(() => {
      row.remove();
      updateFeedMeta();
    }, NOTICE_MS);
  }
  statusTitle.textContent = 'Signal lost, searching again';
  statusText.textContent = 'If the sender is repeating, the next pass will come through.';
  clearTimeout(notice);
  notice = window.setTimeout(() => {
    statusTitle.textContent = COPY.HUNTING.title;
    statusText.textContent = COPY.HUNTING.text;
  }, NOTICE_MS);
}

function handle(e: ReceiverEvent): void {
  switch (e.type) {
    case 'state':
      setState(e.state);
      break;
    case 'interval':
      histogram.push(e.ms);
      break;
    case 'progress':
      statusText.textContent = `${e.received} of ${e.length} bytes`;
      progressFill.style.transform = `scaleX(${e.length ? e.received / e.length : 1})`;
      streamText(e.text);
      break;
    case 'message':
      addMessage(e.text);
      break;
    case 'error':
      if (e.reason === 'crc') failAttempt('garbled', e.bestGuess);
      else failAttempt('lost');
      break;
  }
}

async function start(): Promise<void> {
  showError(null);
  const def = channels.find((c) => c.id === select.value)!;
  const rx = new Receiver();
  const diag = new Diagnostics(showStats);
  sensor = def.create({ video });
  startBtn.disabled = true;
  startBtn.textContent = 'Starting';
  viewport.dataset.camera = 'starting';
  try {
    await sensor.start((t, level) => {
      graph.push(t, level, rx.threshold);
      diag.sample(t, level, rx.threshold, rx.skewMs);
      for (const e of rx.push(t, level)) {
        handle(e);
        diag.event(e);
      }
    });
    viewport.dataset.camera = 'on';
    const info = sensor.describe?.();
    if (info) diag.sensor(info);
    setState('HUNTING');
    setStartButton(true);
  } catch (err) {
    sensor?.stop();
    sensor = null;
    viewport.dataset.camera = 'off';
    setStartButton(false);
    if (!window.isSecureContext) showError('The camera needs HTTPS. Open the https:// address Vite printed.');
    else if (err instanceof DOMException && err.name === 'NotAllowedError')
      showError('Camera permission was denied. Allow camera access for this site in your browser settings, then try again.');
    else if (err instanceof DOMException && err.name === 'NotReadableError')
      showError('The camera is busy. Another tab or app is using it, often an older FlashLink tab. Close it, then press Start again.');
    else showError(`Could not start the camera: ${(err as Error).message}`);
    diag.sensor({ failed: err instanceof DOMException ? err.name : 'Error', message: (err as Error).message });
  } finally {
    startBtn.disabled = false;
  }
}

function stop(): void {
  fpsHint.hidden = true;
  sensor?.stop();
  sensor = null;
  live?.remove();
  live = null;
  updateFeedMeta();
  viewport.dataset.camera = 'off';
  graph.clear();
  setState('IDLE');
  setStartButton(false);
}

reportPageErrors();
setState('IDLE');
setStartButton(false);
startBtn.addEventListener('click', () => (sensor ? stop() : void start()));

// Browsers keep the camera open in background tabs; release it so another tab or app can use it.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && sensor) stop();
});
window.addEventListener('pagehide', () => sensor?.stop());
