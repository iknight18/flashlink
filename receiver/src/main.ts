import { Receiver, type ReceiverEvent } from '@flashlink/protocol';
import { channels } from './channels/registry';
import type { Region, Sensor } from './channels/types';
import { Diagnostics } from './diagnostics';
import { Graph } from './ui/graph';
import { Histogram } from './ui/histogram';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const select = $<HTMLSelectElement>('channel');
const startBtn = $<HTMLButtonElement>('start');
const video = $<HTMLVideoElement>('video');
const aim = $<HTMLDivElement>('aim');
const stateEl = $<HTMLSpanElement>('state');
const progressEl = $<HTMLSpanElement>('progress');
const messageEl = $<HTMLPreElement>('message');
const errorEl = $<HTMLParagraphElement>('error');

const graph = new Graph($<HTMLCanvasElement>('graph'));
const histogram = new Histogram($<HTMLPreElement>('histogram'));

for (const c of channels) select.add(new Option(c.label, c.id));

let sensor: Sensor | null = null;

function setState(state: string): void {
  stateEl.textContent = state;
  stateEl.className = `badge ${state}`;
}

function showError(text: string | null): void {
  errorEl.hidden = text === null;
  errorEl.textContent = text ?? '';
}

/** The aim box shows where the sensor is reading from; it follows the tracked light. */
function showRegion(r: Region): void {
  aim.style.left = `${r.x * 100}%`;
  aim.style.top = `${r.y * 100}%`;
  aim.style.width = `${r.w * 100}%`;
  aim.style.height = `${r.h * 100}%`;
}

function handle(e: ReceiverEvent): void {
  switch (e.type) {
    case 'state':
      setState(e.state);
      // Don't let the tracker move the region in the middle of a frame.
      sensor?.hold?.(e.state === 'LOCKED' || e.state === 'READING');
      if (e.state === 'LOCKED') progressEl.textContent = '';
      break;
    case 'interval':
      histogram.push(e.ms);
      break;
    case 'progress':
      progressEl.textContent = `receiving ${e.received}/${e.length} bytes`;
      break;
    case 'message':
      messageEl.textContent = e.text;
      progressEl.textContent = '';
      break;
    case 'error':
      progressEl.textContent = '';
      if (e.reason === 'crc') messageEl.textContent = `${e.bestGuess}\n(corrupted, ask the sender to resend)`;
      else messageEl.textContent = '(signal lost, keep the light in view and steady)';
      break;
  }
}

async function start(): Promise<void> {
  showError(null);
  const def = channels.find((c) => c.id === select.value)!;
  const rx = new Receiver();
  const diag = new Diagnostics();
  sensor = def.create({
    video,
    onRegion: (r) => {
      showRegion(r);
      diag.setRegion(r);
    },
  });
  startBtn.disabled = true;
  try {
    await sensor.start((t, level) => {
      graph.push(t, level, rx.threshold);
      diag.sample(t, level, rx.threshold);
      for (const e of rx.push(t, level)) {
        handle(e);
        diag.event(e);
      }
    });
    setState('HUNTING');
    startBtn.textContent = 'Stop';
  } catch (err) {
    sensor?.stop();
    sensor = null;
    if (!window.isSecureContext) showError('Camera needs HTTPS. Open the https:// URL that Vite printed.');
    else if (err instanceof DOMException && err.name === 'NotAllowedError')
      showError('Camera permission denied. Allow camera access for this site in your browser settings.');
    else showError(`Could not start the sensor: ${(err as Error).message}`);
  } finally {
    startBtn.disabled = false;
  }
}

function stop(): void {
  sensor?.stop();
  sensor = null;
  setState('IDLE');
  startBtn.textContent = 'Start';
}

startBtn.addEventListener('click', () => (sensor ? stop() : void start()));
