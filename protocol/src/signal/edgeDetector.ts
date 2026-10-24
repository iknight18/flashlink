import type { Level } from '../modulation/manchester/encode';

export interface Edge {
  /** Interpolated time the signal crossed the threshold. */
  t: number;
  /** Level after the edge. */
  level: Level;
}

export interface EdgeDetectorOptions {
  /** Rolling window for min/max tracking. */
  windowMs?: number;
  /** Below this max−min range there is no signal, only noise. */
  minContrast?: number;
  /** Hysteresis band as a fraction of the range, either side of the midpoint. */
  hysteresis?: number;
}

export class EdgeDetector {
  private samples: { t: number; v: number }[] = [];
  private prev: { t: number; v: number } | null = null;
  private level: Level = 0;
  private mid: number | null = null;
  private readonly windowMs: number;
  private readonly minContrast: number;
  private readonly hysteresis: number;

  constructor(opts: EdgeDetectorOptions = {}) {
    this.windowMs = opts.windowMs ?? 2000;
    this.minContrast = opts.minContrast ?? 0.15;
    this.hysteresis = opts.hysteresis ?? 0.2;
  }

  get threshold(): number | null {
    return this.mid;
  }

  push(t: number, v: number): Edge | null {
    const prev = this.prev;
    this.prev = { t, v };
    this.samples.push({ t, v });
    while (this.samples[0].t < t - this.windowMs) this.samples.shift();

    let min = Infinity;
    let max = -Infinity;
    for (const s of this.samples) {
      if (s.v < min) min = s.v;
      if (s.v > max) max = s.v;
    }
    const range = max - min;
    if (range < this.minContrast) {
      this.mid = null;
      return null;
    }

    const mid = (min + max) / 2;
    const band = range * this.hysteresis;
    this.mid = mid;

    let next = this.level;
    if (this.level === 0 && v > mid + band) next = 1;
    else if (this.level === 1 && v < mid - band) next = 0;
    if (next === this.level) return null;
    this.level = next;

    let edgeT = t;
    if (prev && prev.v !== v) {
      const frac = Math.min(1, Math.max(0, (mid - prev.v) / (v - prev.v)));
      edgeT = prev.t + frac * (t - prev.t);
    }
    return { t: edgeT, level: next };
  }
}
