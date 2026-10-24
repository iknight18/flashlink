import type { Region } from '../types';

export interface BlinkTrackerOptions {
  /** Time constant of each pixel's running mean and variance. */
  tauMs?: number;
  /** Per-pixel variance (luma²) treated as sensor noise rather than blinking. */
  noiseFloor?: number;
  /** Smallest half-size of the displayed region, in grid cells. */
  minHalfSize?: number;
}

const WHOLE_FRAME: Region = { x: 0, y: 0, w: 1, h: 1 };

/**
 * Reads the blinking light from anywhere in a low-resolution luma grid. Each pixel
 * keeps a running variance; the level is the variance-weighted mean of the whole
 * frame, so steady lights and dark background count for almost nothing and the
 * torch is followed wherever it moves. `region` only reports where the blinking
 * is, for display; nothing is read from a fixed box.
 */
export class BlinkTracker {
  private mean: Float32Array;
  private variance: Float32Array;
  private lastT: number | null = null;
  private current: Region = WHOLE_FRAME;
  private readonly tauMs: number;
  private readonly noiseFloor: number;
  private readonly minHalfSize: number;

  constructor(
    readonly width: number,
    readonly height: number,
    opts: BlinkTrackerOptions = {},
  ) {
    this.mean = new Float32Array(width * height);
    this.variance = new Float32Array(width * height);
    this.tauMs = opts.tauMs ?? 120; // short, so cells the light has left stop counting quickly
    this.noiseFloor = opts.noiseFloor ?? 0.0025; // ≈ ±0.05 luma
    this.minHalfSize = opts.minHalfSize ?? 1.5;
  }

  /** Where the blinking is (normalized), or the whole frame before anything has blinked. */
  get region(): Region {
    return this.current;
  }

  /** Feeds one frame of luma values (0–1, row-major) and returns the light's level. */
  push(t: number, luma: ArrayLike<number>): number {
    const dt = this.lastT === null ? null : t - this.lastT;
    this.lastT = t;
    const a = dt === null ? 1 : 1 - Math.exp(-Math.max(0, dt) / this.tauMs);

    let plain = 0;
    let wsum = 0;
    let sum = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let syy = 0;
    for (let i = 0; i < luma.length; i++) {
      const v = luma[i];
      plain += v;
      if (dt === null) {
        this.mean[i] = v;
        continue;
      }
      const d = v - this.mean[i];
      this.mean[i] += a * d;
      this.variance[i] += a * (d * d - this.variance[i]);
      const w = this.variance[i] - this.noiseFloor;
      if (w <= 0) continue;
      const x = (i % this.width) + 0.5;
      const y = Math.floor(i / this.width) + 0.5;
      wsum += w;
      sum += w * v;
      sx += w * x;
      sy += w * y;
      sxx += w * x * x;
      syy += w * y * y;
    }

    if (wsum <= 0) return plain / luma.length; // nothing blinking yet: plain average

    const cx = sx / wsum;
    const cy = sy / wsum;
    const hx = Math.max(this.minHalfSize, 2 * Math.sqrt(Math.max(0, sxx / wsum - cx * cx)));
    const hy = Math.max(this.minHalfSize, 2 * Math.sqrt(Math.max(0, syy / wsum - cy * cy)));
    const x0 = Math.max(0, cx - hx);
    const y0 = Math.max(0, cy - hy);
    const x1 = Math.min(this.width, cx + hx);
    const y1 = Math.min(this.height, cy + hy);
    this.current = { x: x0 / this.width, y: y0 / this.height, w: (x1 - x0) / this.width, h: (y1 - y0) / this.height };
    return sum / wsum;
  }
}
