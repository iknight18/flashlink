import type { Edge } from './edgeDetector';

export interface DutyCorrectorOptions {
  /** On- and off-pulses kept per side for the estimate. */
  keep?: number;
  /** Pulses needed per side before any correction is applied. */
  minPulses?: number;
  /**
   * Shrinks early estimates toward zero: the correction is scaled by n / (n + prior)
   * for n pulses per side, so a few noisy pulses can't swing it far.
   */
  prior?: number;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/**
 * Removes on/off asymmetry from edge timings. Torches typically switch on slower than
 * they switch off, which shortens every on-pulse and lengthens every off-pulse by the
 * same amount. Manchester code is on exactly half the time, so the mean on- and
 * off-pulse lengths should match; half their difference is the turn-on delay, and
 * every off→on edge is moved earlier by it.
 */
export class DutyCorrector {
  private on: number[] = [];
  private off: number[] = [];
  private last: Edge | null = null;
  private readonly keep: number;
  private readonly minPulses: number;
  private readonly prior: number;

  constructor(opts: DutyCorrectorOptions = {}) {
    this.keep = opts.keep ?? 16;
    this.minPulses = opts.minPulses ?? 2;
    this.prior = opts.prior ?? 2;
  }

  /** Estimated delay of off→on edges relative to on→off edges (ms). */
  get skewMs(): number {
    const n = Math.min(this.on.length, this.off.length);
    if (n < this.minPulses) return 0;
    return ((mean(this.off) - mean(this.on)) / 2) * (n / (n + this.prior));
  }

  push(edge: Edge): Edge {
    const prev = this.last;
    this.last = edge;
    if (prev) {
      const pulse = edge.t - prev.t;
      // Skip idle gaps and other outliers far longer than the recent pulses.
      const recent = [...this.on, ...this.off];
      const limit = recent.length >= 4 ? 4 * median(recent) : 2000;
      if (pulse <= limit) {
        const side = edge.level === 0 ? this.on : this.off; // a falling edge ends an on-pulse
        side.push(pulse);
        if (side.length > this.keep) side.shift();
      }
    }
    return edge.level === 1 ? { t: edge.t - this.skewMs, level: 1 } : edge;
  }
}
