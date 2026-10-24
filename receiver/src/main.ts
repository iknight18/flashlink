import { Receiver, type ReceiverEvent, type ReceiverState } from '@flashlink/protocol';
import { channels } from './channels/registry';
import type { Region, Sensor } from './channels/types';
import { Diagnostics, type SignalStats } from './diagnostics';
import { Graph } from './ui/graph';
import { Histogram } from './ui/histogram';
import { icon } from './ui/icons';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const select = $<HTMLSelectElement>('channel');
const startBtn = $<HTMLButtonElement>('start');
const viewport = $<HTMLDivElement>('viewport');
const video = $<HTMLVideoElement>('video');
const aim = $<HTMLDivElement>('aim');
const pill = $<HTMLSpanElement>('pill');
const pillText = $<HTMLSpanElement>('pill-text');
const statusTitle = $<HTMLParagraphElement>('status-title');
const statusText = $<HTMLParagraphElement>('status-text');
const progress = $<HTMLDivElement>('progress');
const progressFill = $<HTMLSpanElement>('progress-fill');
const messageEl = $<HTMLPreElement>('message');
const errorEl = $<HTMLParagraphElement>('error');
const historyEl = $<HTMLOListElement>('history');
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
  READING: { pill: 'Receiving', title: 'Receiving', text: 'Hold steady until the message completes.' },
  DONE: { pill: 'Received', title: 'Message received', text: 'Checksum passed. Ready for the next one.' },
  ERROR: { pill: 'Lost', title: 'Signal lost', text: 'Ask the sender to resend and keep both phones steady.' },
};

let sensor: Sensor | null = null;
let region: Region | null = null;
/** Last text that passed its checksum; a later failed repeat must not replace it. */
let verified: string | null = null;

function setStartButton(running: boolean): void {
  startBtn.innerHTML = running ? `${icon('stop', 16)}Stop` : `${icon('play', 16)}Start`;
  startBtn.toggleAttribute('data-running', running);
}

function setState(state: UiState): void {
  const copy = COPY[state];
  pill.dataset.state = state;
  pillText.textContent = copy.pill;
  statusTitle.textContent = copy.title;
  statusText.textContent = copy.text;
  progress.hidden = state !== 'READING';
  if (state !== 'READING') progressFill.style.transform = 'scaleX(0)';
  viewport.toggleAttribute('data-tracking', state === 'HUNTING');
}

function showError(text: string | null): void {
  errorEl.hidden = text === null;
  errorEl.innerHTML = text === null ? '' : `${icon('warningCircle', 16)}<span></span>`;
  if (text !== null) errorEl.querySelector('span')!.textContent = text;
}

/** Moves the aim box over the region the sensor reads, using transforms only. */
function placeAim(): void {
  if (!region || !video.clientWidth) return;
  const w = video.clientWidth;
  const h = video.clientHeight;
  aim.hidden = false;
  aim.style.width = `${region.w * w}px`;
  aim.style.height = `${region.h * h}px`;
  aim.style.transform = `translate(${region.x * w}px, ${region.y * h}px)`;
}
new ResizeObserver(placeAim).observe(video);

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

function addHistory(text: string): void {
  // A looping emitter sends the same message over and over: count repeats on one row.
  const first = historyEl.firstElementChild as HTMLLIElement | null;
  if (first?.dataset.text === text) {
    const count = Number(first.dataset.count) + 1;
    first.dataset.count = String(count);
    first.querySelector('time')!.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    first.querySelector('.count')!.textContent = `×${count}`;
    return;
  }
  const li = document.createElement('li');
  li.dataset.text = text;
  li.dataset.count = '1';
  const time = document.createElement('time');
  const now = new Date();
  time.dateTime = now.toISOString();
  time.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const span = document.createElement('span');
  span.textContent = text;
  const count = document.createElement('b');
  count.className = 'count';
  li.append(time, span, count);
  historyEl.prepend(li);
  while (historyEl.children.length > 20) historyEl.lastElementChild!.remove();
}

function showMessage(text: string, kind: 'streaming' | 'verified' | 'corrupted'): void {
  messageEl.textContent = text;
  messageEl.toggleAttribute('data-streaming', kind === 'streaming');
  messageEl.toggleAttribute('data-corrupted', kind === 'corrupted');
}

function handle(e: ReceiverEvent): void {
  switch (e.type) {
    case 'state':
      setState(e.state);
      // Don't let the tracker move the region in the middle of a frame.
      sensor?.hold?.(e.state === 'LOCKED' || e.state === 'READING');
      break;
    case 'interval':
      histogram.push(e.ms);
      break;
    case 'progress':
      statusText.textContent = `${e.received} of ${e.length} bytes`;
      progressFill.style.transform = `scaleX(${e.length ? e.received / e.length : 1})`;
      // A repeat of the verified message stays put; a different message streams in.
      if (verified === null || !verified.startsWith(e.text)) showMessage(e.text, 'streaming');
      break;
    case 'message':
      verified = e.text;
      showMessage(e.text, 'verified');
      addHistory(e.text);
      break;
    case 'error':
      if (verified !== null) {
        // Keep the verified copy; the emitter is likely looping and will send it again.
        showMessage(verified, 'verified');
        statusText.textContent = 'A repeat was garbled. The message shown was verified earlier.';
      } else if (e.reason === 'crc') {
        showMessage(e.bestGuess, 'corrupted');
        statusText.textContent = 'Checksum failed, so this is a best guess. If the sender is repeating, the next pass will fix it.';
      } else {
        messageEl.removeAttribute('data-streaming');
      }
      break;
  }
}

async function start(): Promise<void> {
  showError(null);
  const def = channels.find((c) => c.id === select.value)!;
  const rx = new Receiver();
  const diag = new Diagnostics(showStats);
  sensor = def.create({
    video,
    onRegion: (r) => {
      region = r;
      placeAim();
      diag.setRegion(r);
    },
  });
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
    else showError(`Could not start the camera: ${(err as Error).message}`);
  } finally {
    startBtn.disabled = false;
  }
}

function stop(): void {
  fpsHint.hidden = true;
  sensor?.stop();
  sensor = null;
  region = null;
  verified = null;
  aim.hidden = true;
  viewport.dataset.camera = 'off';
  graph.clear();
  setState('IDLE');
  setStartButton(false);
}

setState('IDLE');
setStartButton(false);
startBtn.addEventListener('click', () => (sensor ? stop() : void start()));
