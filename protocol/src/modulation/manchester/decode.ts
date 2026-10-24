import type { Bit } from '../../framing/bits';
import type { Edge } from '../../signal/edgeDetector';

export type DemodState = 'HUNTING' | 'LOCKED';

export interface ManchesterDecoderOptions {
  /** Consistent intervals needed to lock (preamble edges are all one bit apart). */
  lockCount?: number;
  /** Max relative deviation from the median for an interval to count as consistent. */
  tolerance?: number;
}

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
  private phase: 'mid' | 'boundary' = 'mid';
  private pendingShort = 0;
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
    const dt = edge.t - prev.t;
    return this.state === 'HUNTING' ? this.hunt(dt, edge) : this.decode(dt, edge);
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
    this.phase = 'mid';
    this.pendingShort = 0;
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
    this.phase = 'mid';
    return [bitFromEdge(edge)];
  }

  private decode(dt: number, edge: Edge): Bit[] {
    const ratio = dt / this.bitMs;
    if (ratio < 0.75) {
      // short: half a bit
      if (this.phase === 'mid') {
        this.phase = 'boundary';
        this.pendingShort = dt;
        return [];
      }
      this.adapt(this.pendingShort + dt);
      this.phase = 'mid';
      return [bitFromEdge(edge)];
    }
    if (ratio < 1.5 && this.phase === 'mid') {
      // long: a full bit, mid-edge to mid-edge
      this.adapt(dt);
      return [bitFromEdge(edge)];
    }
    this.reset();
    return [];
  }

  private adapt(period: number): void {
    this.bitMs = 0.8 * this.bitMs + 0.2 * period;
  }
}
