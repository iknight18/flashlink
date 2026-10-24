import type { Bit } from '../../framing/bits';
import type { Edge } from '../../signal/edgeDetector';

export type DemodState = 'HUNTING' | 'LOCKED';

export interface ManchesterDecoderOptions {
  /** Consistent intervals needed to lock (preamble edges are all one bit apart). */
  lockCount?: number;
  /** Max relative deviation from the median for an interval to count as consistent. */
  tolerance?: number;
}

/** Fraction of a mid-edge timing error applied to the phase reference. */
const PHASE_GAIN = 0.3;
/** Fraction of a mid-edge timing error applied to the bit period estimate. */
const PERIOD_GAIN = 0.05;

/** A mid-bit edge going high→low is a 1, low→high is a 0. */
const bitFromEdge = (e: Edge): Bit => (e.level === 0 ? 1 : 0);

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Decodes Manchester from the time between edges rather than fixed sample points,
 * which tolerates low frame rates, dropped frames and transmitter jitter.
 */
export class ManchesterDecoder {
  state: DemodState = 'HUNTING';
  /** Current bit period estimate (ms); 0 while hunting. */
  bitMs = 0;

  private lastEdge: Edge | null = null;
  private intervals: number[] = [];
  /** Filtered estimate of the last mid-bit edge's time; every bit is timed from here. */
  private midT = 0;
  /** A boundary edge has already been seen since the last mid-bit edge. */
  private sawBoundary = false;
  private readonly lockCount: number;
  private readonly tolerance: number;

  constructor(opts: ManchesterDecoderOptions = {}) {
    this.lockCount = opts.lockCount ?? 8;
    this.tolerance = opts.tolerance ?? 0.3;
  }

  pushEdge(edge: Edge): Bit[] {
    const prev = this.lastEdge;
    this.lastEdge = edge;
    if (!prev) return [];
    return this.state === 'HUNTING' ? this.hunt(edge.t - prev.t, edge) : this.decode(edge);
  }

  /** Call on every sample without an edge; returns true if lock was just lost. */
  checkTimeout(now: number): boolean {
    if (this.state !== 'LOCKED' || !this.lastEdge) return false;
    if (now - this.lastEdge.t <= 3 * this.bitMs) return false;
    this.reset();
    this.lastEdge = null;
    return true;
  }

  reset(): void {
    this.state = 'HUNTING';
    this.bitMs = 0;
    this.intervals = [];
    this.midT = 0;
    this.sawBoundary = false;
  }

  private hunt(dt: number, edge: Edge): Bit[] {
    this.intervals.push(dt);
    if (this.intervals.length > this.lockCount) this.intervals.shift();
    if (this.intervals.length < this.lockCount) return [];
    const m = median(this.intervals);
    if (!this.intervals.every((x) => Math.abs(x - m) <= this.tolerance * m)) return [];
    this.state = 'LOCKED';
    this.bitMs = m;
    this.intervals = [];
    this.midT = edge.t;
    this.sawBoundary = false;
    return [bitFromEdge(edge)];
  }

  /**
   * Classifies each edge by time since the last mid-bit edge: boundary (< ¾T) or mid (¾T–1½T).
   * The mid-edge reference is a phase-locked estimate rather than the raw edge time, so one
   * late or early sample (frame quantization, a dropped frame) doesn't shift the next decision.
   */
  private decode(edge: Edge): Bit[] {
    const elapsed = edge.t - this.midT;
    const ratio = elapsed / this.bitMs;
    // Two boundary edges can't be adjacent, so after one the mid edge may arrive as early as ½T.
    const midFrom = this.sawBoundary ? 0.5 : 0.75;
    if (ratio < midFrom) {
      // boundary edge between two equal bits: carries no data
      if (!this.sawBoundary) {
        this.sawBoundary = true;
        return [];
      }
    } else if (ratio < 1.5) {
      // mid-bit edge, expected one period after the last one
      const err = elapsed - this.bitMs;
      this.midT += this.bitMs + PHASE_GAIN * err;
      this.bitMs += PERIOD_GAIN * err;
      this.sawBoundary = false;
      return [bitFromEdge(edge)];
    }
    this.reset();
    return [];
  }
}
