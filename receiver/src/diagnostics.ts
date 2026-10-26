import type { MultiEvent, ReceiverState } from '@flashlink/protocol';
import { bestState } from './sources';

const ENDPOINT = '/__flashlink/log';

function post(entry: object): void {
  if (!import.meta.env.DEV) return;
  fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(entry), keepalive: true }).catch(() => {});
}

/** Sends uncaught page errors to the log, so device-only failures can be read on the laptop. */
export function reportPageErrors(): void {
  window.addEventListener('error', (e) => post({ kind: 'page-error', message: e.message, stack: e.error?.stack }));
  window.addEventListener('unhandledrejection', (e) => post({ kind: 'page-error', message: String(e.reason), stack: e.reason?.stack }));
}

const round = (v: number, digits = 3) => Number(v.toFixed(digits));

/** What the decoder of one source reports (see MultiReceiver.receiver). */
export interface SourceInfo {
  state: ReceiverState;
  threshold: number | null;
  skew: number;
}

/** One second of one light. */
export interface SourceStats {
  id: number;
  level: [number, number];
  contrast: number;
  state: ReceiverState | 'GONE';
  threshold: number | null;
  /** Measured transmitter turn-on delay being corrected (ms). */
  skew: number;
}

/** One second of signal health, shown in the UI and logged in dev. */
export interface SignalStats {
  /** Best state over all lights (READING > LOCKED > HUNTING). */
  state: string;
  fps: number;
  /** Lights seen in the last frame. */
  lights: number;
  sources: SourceStats[];
  /** Id of the source with the highest contrast this second, if any. */
  strongest: number | null;
  /** Contrast, threshold and skew of the strongest source. */
  contrast: number;
  threshold: number | null;
  skew: number;
  /** Edge intervals of all sources. */
  edges: { n: number; min?: number; median?: number; max?: number };
}

interface Window {
  min: number;
  max: number;
  info?: SourceInfo;
}

/**
 * Summarises the signal once per second for the UI. In dev it also sends each summary
 * and every notable receiver event to the Vite server, which prints it and appends it
 * to receiver/logs/.
 */
export class Diagnostics {
  private frames = 0;
  private lights = 0;
  private sources = new Map<number, Window>();
  private intervals: number[] = [];
  private windowStart: number | null = null;

  constructor(private readonly onStats?: (stats: SignalStats) => void) {
    post({ kind: 'session', userAgent: navigator.userAgent });
  }

  /** Logs what the sensor hardware reports after starting. */
  sensor(info: Record<string, unknown>): void {
    post({ kind: 'sensor', ...info });
  }

  /** One frame: every source's level, and its decoder's state for the summary. */
  sample(t: number, sources: { id: number; level: number }[], info: (id: number) => SourceInfo | undefined): void {
    this.windowStart ??= t;
    this.frames++;
    this.lights = sources.length;
    for (const { id, level } of sources) {
      let w = this.sources.get(id);
      if (!w) this.sources.set(id, (w = { min: Infinity, max: -Infinity }));
      w.min = Math.min(w.min, level);
      w.max = Math.max(w.max, level);
      w.info = info(id);
    }
    if (t - this.windowStart >= 1000) this.flush(t);
  }

  interval(ms: number): void {
    this.intervals.push(ms);
  }

  event(e: MultiEvent): void {
    post({ kind: 'event', ...e });
  }

  private flush(t: number): void {
    const elapsed = t - this.windowStart!;
    const sorted = [...this.intervals].sort((a, b) => a - b);
    const sources: SourceStats[] = [...this.sources.entries()]
      .sort(([a], [b]) => a - b)
      .map(([id, w]) => ({
        id,
        level: [round(w.min), round(w.max)],
        contrast: round(w.max - w.min),
        state: w.info?.state ?? 'GONE',
        threshold: w.info?.threshold == null ? null : round(w.info.threshold),
        skew: round(w.info?.skew ?? 0, 1),
      }));
    const strongest = sources.reduce<SourceStats | null>((b, s) => (!b || s.contrast > b.contrast ? s : b), null);
    const stats: SignalStats = {
      state: bestState(sources.flatMap((s) => (s.state === 'GONE' ? [] : [s.state]))),
      fps: round((this.frames * 1000) / elapsed, 1),
      lights: this.lights,
      sources,
      strongest: strongest?.id ?? null,
      contrast: strongest?.contrast ?? 0,
      threshold: strongest?.threshold ?? null,
      skew: strongest?.skew ?? 0,
      edges: sorted.length
        ? { n: sorted.length, min: Math.round(sorted[0]), median: Math.round(sorted[sorted.length >> 1]), max: Math.round(sorted[sorted.length - 1]) }
        : { n: 0 },
    };
    this.onStats?.(stats);
    post({ kind: 'stats', ...stats });
    this.windowStart = t;
    this.frames = 0;
    this.sources = new Map();
    this.intervals = [];
  }
}

/**
 * Records every frame's per-light levels for a few seconds and sends them to the log
 * in one entry, so a device test can be replayed through the decoders offline.
 */
export class Recorder {
  private frames: [number, [number, number][]][] = [];
  private until = 0;
  private onDone: (() => void) | null = null;

  get active(): boolean {
    return this.until > 0;
  }

  start(durationMs: number, onDone: () => void): void {
    this.frames = [];
    this.until = -durationMs; // armed: the first frame fixes the end time
    this.onDone = onDone;
  }

  push(t: number, sources: { id: number; level: number }[]): void {
    if (this.until === 0) return;
    if (this.until < 0) this.until = t - this.until;
    this.frames.push([Math.round(t * 10) / 10, sources.map((s) => [s.id, Math.round(s.level * 1000) / 1000])]);
    if (t >= this.until) this.finish();
  }

  private finish(): void {
    // Not via post(): keepalive requests are capped at 64 KB and a recording can be larger.
    if (import.meta.env.DEV)
      fetch(ENDPOINT, { method: 'POST', body: JSON.stringify({ kind: 'recording', frames: this.frames }) }).catch(() => {});
    this.frames = [];
    this.until = 0;
    this.onDone?.();
  }
}
