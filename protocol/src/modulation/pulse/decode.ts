import type { Bit } from '../../framing/bits';
import type { Edge } from '../../signal/edgeDetector';
import type { DemodState } from '../manchester/decode';
import { PULSE_MAX_RUN, PULSE_PREAMBLE_RUNS } from './encode';

export interface PulseDecoderOptions {
  /** Consistent 1-slot runs needed to lock. */
  lockCount?: number;
  /** Max distance of a preamble edge from the fitted slot grid, as a fraction of the slot. */
  tolerance?: number;
}

/** Fraction of a run's timing error applied to the edge reference. */
const PHASE_GAIN = 0.3;
/** Fraction of a run's per-slot timing error applied to the slot estimate. */
const PERIOD_GAIN = 0.05;
/** Largest turn-on skew accepted at lock, as a fraction of the slot (45 ms torches at 100 ms slots). */
const MAX_SKEW = 0.6;
/** Slots without an edge before lock is lost (longest run is 4). */
const TIMEOUT_SLOTS = PULSE_MAX_RUN + 1;

/**
 * Fits edges at slot indices 0, 1, 2… to a common grid: t = a + k·slot, with every
 * rising edge late by `skew`. Least squares with a shared slope and one intercept per
 * edge polarity. Returns the grid position `ref` of the last edge (skew-corrected) and
 * the largest distance of any edge from the grid.
 */
function fitGrid(edges: Edge[]): { slot: number; skew: number; ref: number; maxResidual: number } {
  const groups = [0, 1].map((level) => {
    const pts = edges.map((e, k) => ({ k, t: e.t, level: e.level })).filter((p) => p.level === level);
    const kMean = pts.reduce((s, p) => s + p.k, 0) / pts.length;
    const tMean = pts.reduce((s, p) => s + p.t, 0) / pts.length;
    return { pts, kMean, tMean };
  });
  let num = 0;
  let den = 0;
  for (const g of groups) {
    for (const p of g.pts) {
      num += (p.k - g.kMean) * (p.t - g.tMean);
      den += (p.k - g.kMean) ** 2;
    }
  }
  const slot = num / den;
  const [fall, rise] = groups.map((g) => g.tMean - slot * g.kMean);
  const maxResidual = Math.max(...edges.map((e, k) => Math.abs(e.t - (e.level === 1 ? rise : fall) - k * slot)));
  return { slot, skew: rise - fall, ref: fall + (edges.length - 1) * slot, maxResidual };
}

/**
 * Decodes pulse-length modulation from edge times. Locks on the 1-slot preamble runs,
 * where it measures the slot length and the turn-on skew (rising edges late relative to
 * falling ones), and holds that skew for the rest of the frame. Each later run is
 * classified as round(corrected length / slot) slots, timed from a phase-locked estimate
 * of the previous edge so one badly sampled edge doesn't shift the next decision too.
 * A run outside 0.5–4.5 slots drops back to hunting.
 *
 * Measured through the Receiver (seeds 1–1000, 100 ms slots, 30 fps): 95.5% decoded with
 * ±8 ms jitter, noise 0.03 and 1% frame drops; 97.5% / 98.6% / 97.5% with a 25 / 33 / 45 ms
 * turn-on delay. Failures are CRC rejections, lost lock or no lock; none delivered wrong text.
 *
 * Expects raw edges: the skew is measured here because pulse-length code is not on half
 * the time, so the receiver's duty-cycle correction doesn't apply to it.
 */
export class PulseDecoder {
  state: DemodState = 'HUNTING';
  /** Current slot length estimate (ms); 0 while hunting. */
  bitMs = 0;
  /** Turn-on delay measured in the preamble (ms), held for the frame; 0 while hunting. */
  skewMs = 0;

  private lastEdge: Edge | null = null;
  /** Hunting: the most recent edges. Locked, still in the preamble: its edges so far. */
  private edges: Edge[] = [];
  private inPreamble = false;
  /** Estimated time of the previous edge on the slot grid (skew-corrected). */
  private ref = 0;
  private readonly lockCount: number;
  private readonly tolerance: number;

  constructor(opts: PulseDecoderOptions = {}) {
    this.lockCount = opts.lockCount ?? 8;
    this.tolerance = opts.tolerance ?? 0.3;
  }

  pushEdge(edge: Edge): Bit[] {
    this.lastEdge = edge;
    return this.state === 'HUNTING' ? this.hunt(edge) : this.decode(edge);
  }

  /** Call on every sample without an edge; returns true if lock was just lost. */
  checkTimeout(now: number): boolean {
    if (this.state !== 'LOCKED' || !this.lastEdge) return false;
    if (now - this.lastEdge.t <= TIMEOUT_SLOTS * this.bitMs) return false;
    this.reset();
    this.lastEdge = null;
    return true;
  }

  reset(): void {
    this.state = 'HUNTING';
    this.bitMs = 0;
    this.skewMs = 0;
    this.edges = [];
    this.inPreamble = false;
    this.ref = 0;
  }

  private hunt(edge: Edge): Bit[] {
    this.edges.push(edge);
    if (this.edges.length > this.lockCount + 1) this.edges.shift();
    if (this.edges.length < this.lockCount + 1) return [];
    // Single runs are too coarse to check at low frame rates (a 1-slot run spans ~3
    // frames), so the edges are checked against the fitted grid instead.
    const { slot, skew, ref, maxResidual } = fitGrid(this.edges);
    if (!(slot > 0) || Math.abs(skew) > MAX_SKEW * slot || maxResidual > this.tolerance * slot) return [];
    this.state = 'LOCKED';
    this.bitMs = slot;
    this.skewMs = skew;
    this.ref = ref;
    this.inPreamble = true;
    return [];
  }

  private decode(edge: Edge): Bit[] {
    const elapsed = this.correctedT(edge, this.skewMs) - this.ref;
    const x = elapsed / this.bitMs;
    if (x < 0.5 || x >= PULSE_MAX_RUN + 0.5) {
      this.reset();
      this.edges = [edge];
      return [];
    }
    const n = Math.round(x);
    if (this.inPreamble && n === 1 && this.edges.length <= PULSE_PREAMBLE_RUNS) {
      // Still in the preamble: refine slot and skew from all of it.
      this.edges.push(edge);
      const fit = fitGrid(this.edges);
      this.bitMs = fit.slot;
      this.skewMs = fit.skew;
      this.ref = fit.ref;
      return [0, 0];
    }
    this.inPreamble = false;
    this.edges = [];
    const err = elapsed - n * this.bitMs;
    this.ref += n * this.bitMs + PHASE_GAIN * err;
    this.bitMs += (PERIOD_GAIN * err) / n;
    const value = n - 1;
    return [((value >> 1) & 1) as Bit, (value & 1) as Bit];
  }

  private correctedT(edge: Edge, skew: number): number {
    return edge.level === 1 ? edge.t - skew : edge.t;
  }
}
