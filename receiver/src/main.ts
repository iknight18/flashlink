import { type MultiEvent, MultiReceiver, type ReceiverState } from '@flashlink/protocol';
import { channels } from './channels/registry';
import type { Sensor, SensorSource } from './channels/types';
import { Diagnostics, reportPageErrors, type SignalStats, Recorder } from './diagnostics';
import { Feed, type FeedRow } from './feed';
import { bestState, EdgeIntervals, liveLanes, type OverallState } from './sources';
import { Graph } from './ui/graph';
import { Histogram } from './ui/histogram';
import { icon } from './ui/icons';
import { Markers } from './ui/markers';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const select = $<HTMLSelectElement>('channel');
const startBtn = $<HTMLButtonElement>('start');
const recordBtn = $<HTMLButtonElement>('record');
const recorder = new Recorder();
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
const markers = new Markers($<HTMLDivElement>('markers'), video);
/** Lane each source last carried (from its latest frame header), for its marker. */
const laneOf = new Map<number, number>();

for (const c of channels) select.add(new Option(c.label, c.id));
// Nothing to choose with one channel; it would only crowd the top bar on a phone.
$('channel-field').hidden = channels.length < 2;

/** Keeps the phone's screen on while receiving (best effort; iOS 16.4+). */
let wakeLock: { release(): Promise<void> } | null = null;
async function keepAwake(on: boolean): Promise<void> {
  try {
    if (on && !wakeLock) wakeLock = (await navigator.wakeLock?.request('screen')) ?? null;
    else if (!on && wakeLock) {
      const lock = wakeLock;
      wakeLock = null;
      await lock.release();
    }
  } catch {
    wakeLock = null; // not supported, or refused (e.g. low battery)
  }
}

type UiState = OverallState | 'DONE' | 'IDLE';

const COPY: Record<UiState, { pill: string; title: string; text: string }> = {
  IDLE: { pill: 'Idle', title: 'Ready when you are', text: 'Press Start to open the camera.' },
  HUNTING: { pill: 'Searching', title: 'Looking for the lights', text: 'Point the camera at the sender. Every blinking light gets a numbered ring.' },
  LOCKED: { pill: 'Locked', title: 'Locked on', text: 'Lights found. Waiting for the start of a message.' },
  READING: { pill: 'Receiving', title: 'Receiving', text: 'The message streams into the list below.' },
  DONE: { pill: 'Received', title: 'Message received', text: 'Listening for the next one.' },
};

/** How long a lost or garbled attempt stays visible before it fades out. */
const NOTICE_MS = 4000;
/** How long "Message received" shows before the pill follows the lights again. */
const DONE_MS = 2500;

let sensor: Sensor | null = null;
let notice = 0;
let uiState: UiState = 'IDLE';
/** Latest decoder state of every tracked source (from MultiReceiver `sources` events). */
let sourceStates = new Map<number, ReceiverState>();
let doneUntil = 0;
let doneTimer = 0;

// ---------- Status ----------

function setStartButton(running: boolean): void {
  startBtn.innerHTML = running ? `${icon('stop', 16)}Stop` : `${icon('play', 16)}Start`;
  startBtn.toggleAttribute('data-running', running);
}

function setState(state: UiState): void {
  if (state === uiState) return;
  uiState = state;
  const copy = COPY[state];
  clearTimeout(notice);
  pill.dataset.state = state;
  pillText.textContent = copy.pill;
  statusTitle.textContent = copy.title;
  statusText.textContent = copy.text;
  progress.hidden = state !== 'READING';
  if (state !== 'READING') progressFill.style.transform = 'scaleX(0)';
}

const anyReading = () => [...sourceStates.values()].includes('READING');

/** Pill and title follow the best light, except right after a message. */
function refreshState(): void {
  const best = bestState(sourceStates.values());
  setState(best !== 'READING' && performance.now() < doneUntil ? 'DONE' : best);
}

function showError(text: string | null): void {
  errorEl.hidden = text === null;
  errorEl.innerHTML = text === null ? '' : `${icon('warningCircle', 16)}<span></span>`;
  if (text !== null) errorEl.querySelector('span')!.textContent = text;
}

/** Below this, a 100 ms slot spans fewer than ~2.5 frames and can't be decoded. */
const MIN_FPS_FOR_100 = 25;

/** Source whose level the graph shows: the highest contrast over the last second. */
let strongestId: number | null = null;

function showStats(s: SignalStats): void {
  strongestId = s.strongest;
  $('stat-fps').textContent = s.fps.toFixed(1);
  fpsHint.hidden = s.fps >= MIN_FPS_FOR_100;
  fpsHint.textContent = `The camera is only delivering ${Math.round(s.fps)} fps. That's enough for 200 ms slots, but 100 ms needs about 30 fps. Add light to the room or raise the slot length on the sender.`;
  $('stat-lights').textContent = String(s.lights);
  $('stat-contrast').textContent = s.contrast.toFixed(2);
  $('stat-median').textContent = s.edges.median === undefined ? '–' : `${s.edges.median} ms`;
  $('stat-spread').textContent = s.edges.n > 1 ? `${s.edges.max! - s.edges.min!} ms` : '–';
  $('stat-skew').textContent = s.strongest === null ? '–' : `${Math.round(s.skew)} ms`;
}

// ---------- Feed ----------

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const rowEls = new Map<number, HTMLLIElement>();

function renderRow(row: FeedRow, removed: boolean): void {
  let li = rowEls.get(row.id);
  if (removed) {
    li?.remove();
    rowEls.delete(row.id);
    updateFeedMeta();
    return;
  }
  if (!li) {
    li = document.createElement('li');
    const time = document.createElement('time');
    const span = document.createElement('span');
    span.className = 'text';
    const count = document.createElement('b');
    count.className = 'count';
    li.append(time, span, count);
    feedEl.append(li);
    rowEls.set(row.id, li);
  }
  li.querySelector('time')!.textContent = clock(row.at);
  li.querySelector('.text')!.textContent = row.text;
  li.querySelector('.count')!.textContent =
    row.status === 'failed' ? (row.reason ?? '') : row.count > 1 ? `×${row.count}` : '';
  li.toggleAttribute('data-live', row.status === 'live');
  li.toggleAttribute('data-verified', row.status === 'verified');
  li.toggleAttribute('data-failed', row.status === 'failed');
  li.toggleAttribute('data-repeating', row.repeating);
  if (row.status === 'failed' && !li.dataset.fading) {
    li.dataset.fading = '';
    setTimeout(() => feed.remove(row.id), NOTICE_MS);
  }
  if (row.status === 'live') li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  updateFeedMeta();
}

const feed = new Feed(renderRow);

function updateFeedMeta(): void {
  const n = feed.verifiedCount;
  feedEmpty.hidden = feed.rows.length > 0;
  feedCount.textContent = n ? String(n) : '';
}

/** Says the attempt failed and that the receiver keeps searching. */
function showFailed(): void {
  statusTitle.textContent = 'Signal lost, searching again';
  statusText.textContent = 'If the sender is repeating, the next pass will come through.';
  clearTimeout(notice);
  notice = window.setTimeout(() => {
    statusTitle.textContent = COPY[uiState].title;
    statusText.textContent = COPY[uiState].text;
  }, NOTICE_MS);
}

function handle(e: MultiEvent): void {
  switch (e.type) {
    case 'sources':
      sourceStates = new Map(e.sources.map((s) => [s.id, s.state]));
      for (const id of laneOf.keys()) if (!sourceStates.has(id)) laneOf.delete(id);
      refreshState();
      if (feed.sources(anyReading())) showFailed();
      break;
    case 'progress':
      feed.progress(e.msgId, e.text);
      if (uiState === 'READING') {
        statusText.textContent =
          e.lanes > 1 ? `${e.text.length} characters · ${e.lanesDone} of ${e.lanes} lights done` : `${e.text.length} characters`;
        progressFill.style.transform = `scaleX(${e.lanesDone / e.lanes})`;
      }
      break;
    case 'message':
      feed.message(e.msgId, e.text);
      doneUntil = performance.now() + DONE_MS;
      clearTimeout(doneTimer);
      doneTimer = window.setTimeout(refreshState, DONE_MS + 50);
      setState('DONE');
      break;
    case 'error':
      if (feed.error(e.reason, anyReading())) showFailed();
      break;
  }
}

// ---------- Receiver ----------

/** Graph source for this frame: the strongest of the last second, else the brightest now. */
function graphSource(sources: SensorSource[]): SensorSource | undefined {
  return sources.find((s) => s.id === strongestId) ?? sources.reduce<SensorSource | undefined>((b, s) => (!b || s.level > b.level ? s : b), undefined);
}

async function start(): Promise<void> {
  showError(null);
  const def = channels.find((c) => c.id === select.value)!;
  // Camera noise on the baseline-relative level is ~0.001 (device logs), so a small
  // minimum contrast is safe and keeps a faint or distant light decodable.
  const rx = new MultiReceiver({ edge: { minContrast: 0.04 } });
  const edges = new EdgeIntervals();
  const diag = new Diagnostics(showStats);
  const info = (id: number) => {
    const r = rx.receiver(id);
    return r && { state: r.state, threshold: r.threshold, skew: r.skewMs };
  };
  sensor = def.create({ video });
  startBtn.disabled = true;
  startBtn.textContent = 'Starting';
  viewport.dataset.camera = 'starting';
  try {
    await sensor.start((t, sources) => {
      recorder.push(t, sources);
      const events = rx.push(t, sources);
      for (const e of events) {
        handle(e);
        diag.event(e);
        if (e.type === 'sources') edges.retain(new Set(e.sources.map((s) => s.id)));
      }
      for (const s of sources) {
        for (const ms of edges.push(t, s.id, s.level, rx.receiver(s.id)?.threshold ?? null)) {
          histogram.push(ms);
          diag.interval(ms);
        }
      }
      for (const [id, lane] of liveLanes(rx)) laneOf.set(id, lane);
      markers.update(sources, sourceStates, laneOf);
      const g = graphSource(sources);
      if (g) graph.push(t, g.level, rx.receiver(g.id)?.threshold ?? null);
      diag.sample(t, sources, info);
    });
    viewport.dataset.camera = 'on';
    const hw = sensor.describe?.();
    if (hw) diag.sensor(hw);
    sourceStates = new Map();
    refreshState();
    setStartButton(true);
    recordBtn.hidden = false;
    void keepAwake(true);
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
  recordBtn.hidden = true;
  sensor?.stop();
  sensor = null;
  feed.reset();
  markers.clear();
  laneOf.clear();
  sourceStates = new Map();
  strongestId = null;
  doneUntil = 0;
  clearTimeout(doneTimer);
  viewport.dataset.camera = 'off';
  graph.clear();
  setState('IDLE');
  setStartButton(false);
  void keepAwake(false);
}

reportPageErrors();
pill.dataset.state = 'IDLE';
setStartButton(false);
startBtn.addEventListener('click', () => (sensor ? stop() : void start()));

// Raw per-frame light levels for offline replay of a device test (sent to the dev-server log).
recordBtn.addEventListener('click', () => {
  if (recorder.active) return;
  recordBtn.disabled = true;
  recordBtn.textContent = 'Recording…';
  recorder.start(10_000, () => {
    recordBtn.disabled = false;
    recordBtn.textContent = 'Recorded';
    setTimeout(() => (recordBtn.textContent = 'Record 10 s'), 2500);
  });
});

// Browsers keep the camera open in background tabs; release it so another tab or app can use it.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && sensor) stop();
});
window.addEventListener('pagehide', () => sensor?.stop());
