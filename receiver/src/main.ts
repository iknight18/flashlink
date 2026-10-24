import { Receiver, type ReceiverEvent } from '@flashlink/protocol';
import { channels } from './channels/registry';
import type { Sensor } from './channels/types';
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

function positionAim(): void {
  const side = 0.2 * Math.min(video.clientWidth, video.clientHeight);
  aim.style.width = aim.style.height = `${side}px`;
}
video.addEventListener('loadedmetadata', positionAim);
window.addEventListener('resize', positionAim);

function handle(e: ReceiverEvent): void {
  switch (e.type) {
    case 'state':
      setState(e.state);
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
      else messageEl.textContent = '(signal lost, keep the light inside the red box)';
      break;
  }
}

async function start(): Promise<void> {
  showError(null);
  const def = channels.find((c) => c.id === select.value)!;
  const rx = new Receiver();
  sensor = def.create({ video });
  startBtn.disabled = true;
  try {
    await sensor.start((t, level) => {
      graph.push(t, level, rx.threshold);
      rx.push(t, level).forEach(handle);
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
