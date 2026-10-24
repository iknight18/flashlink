import type { ReceiverEvent } from '@flashlink/protocol';
import type { Region } from './channels/types';

const ENDPOINT = '/__flashlink/log';

function post(entry: object): void {
  if (!import.meta.env.DEV) return;
  fetch(ENDPOINT, { method: 'POST', body: JSON.stringify(entry), keepalive: true }).catch(() => {});
}

const round = (v: number, digits = 3) => Number(v.toFixed(digits));

/** One second of signal health, shown in the UI and logged in dev. */
export interface SignalStats {
  state: string;
  fps: number;
  level: [number, number];
  contrast: number;
  threshold: number | null;
  edges: { n: number; min?: number; median?: number; max?: number };
  region: [number, number] | null;
}

/**
 * Summarises the signal once per second for the UI. In dev it also sends each summary
 * and every notable receiver event to the Vite server, which prints it and appends it
 * to receiver/logs/.
 */
export class Diagnostics {
  private frames = 0;
  private min = Infinity;
  private max = -Infinity;
  private threshold: number | null = null;
  private intervals: number[] = [];
  private state = 'IDLE';
  private region: Region | null = null;
  private windowStart: number | null = null;

  constructor(private readonly onStats?: (stats: SignalStats) => void) {
    post({ kind: 'session', userAgent: navigator.userAgent });
  }

  /** Logs what the sensor hardware reports after starting. */
  sensor(info: Record<string, unknown>): void {
    post({ kind: 'sensor', ...info });
  }

  sample(t: number, level: number, threshold: number | null): void {
    this.windowStart ??= t;
    this.frames++;
    this.min = Math.min(this.min, level);
    this.max = Math.max(this.max, level);
    this.threshold = threshold;
    if (t - this.windowStart >= 1000) this.flush(t);
  }

  event(e: ReceiverEvent): void {
    if (e.type === 'interval') {
      this.intervals.push(e.ms);
      return;
    }
    if (e.type === 'state') this.state = e.state;
    if (e.type === 'progress' && e.received !== 0) return; // header only
    post({ kind: 'event', ...e });
  }

  setRegion(region: Region): void {
    this.region = region;
    post({ kind: 'region', ...Object.fromEntries(Object.entries(region).map(([k, v]) => [k, round(v)])) });
  }

  private flush(t: number): void {
    const elapsed = t - this.windowStart!;
    const sorted = [...this.intervals].sort((a, b) => a - b);
    const stats: SignalStats = {
      state: this.state,
      fps: round((this.frames * 1000) / elapsed, 1),
      level: [round(this.min), round(this.max)],
      contrast: round(this.max - this.min),
      threshold: this.threshold === null ? null : round(this.threshold),
      edges: sorted.length
        ? { n: sorted.length, min: Math.round(sorted[0]), median: Math.round(sorted[sorted.length >> 1]), max: Math.round(sorted[sorted.length - 1]) }
        : { n: 0 },
      region: this.region && [round(this.region.x + this.region.w / 2, 2), round(this.region.y + this.region.h / 2, 2)],
    };
    this.onStats?.(stats);
    post({ kind: 'stats', ...stats });
    this.windowStart = t;
    this.frames = 0;
    this.min = Infinity;
    this.max = -Infinity;
    this.intervals = [];
  }
}
