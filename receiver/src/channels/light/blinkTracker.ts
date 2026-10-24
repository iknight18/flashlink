import type { Region } from '../types';

export interface BlinkTrackerOptions {
  /** Time constant of the per-pixel mean/variance averages. */
  tauMs?: number;
  /** ROI radius in grid cells around the tracked centre. */
  radius?: number;
  /** Minimum per-pixel variance (luma²) that counts as blinking. */
  minVariance?: number;
  /** A new spot must beat the current one by this factor to take over. */
  switchRatio?: number;
}

/**
 * Finds the blinking light in a low-resolution luma grid by tracking each pixel's
 * temporal variance, and reports the light's level as a variance-weighted mean
 * of its neighbourhood, so static background (lamps, windows, diffuse glow
 * around the torch) contributes little.
 */
export class BlinkTracker {
  private mean: Float32Array;
  private variance: Float32Array;
  private lastT: number | null = null;
  private cx: number;
  private cy: number;
  private held = false;
  private readonly tauMs: number;
  private readonly radius: number;
  private readonly minVariance: number;
  private readonly switchRatio: number;

  constructor(
    readonly width: number,
    readonly height: number,
    opts: BlinkTrackerOptions = {},
  ) {
    this.mean = new Float32Array(width * height);
    this.variance = new Float32Array(width * height);
    this.cx = width >> 1;
    this.cy = height >> 1;
    this.tauMs = opts.tauMs ?? 700;
    this.radius = opts.radius ?? 2;
    this.minVariance = opts.minVariance ?? 0.0025; // ≈ ±0.05 luma swing
    this.switchRatio = opts.switchRatio ?? 1.5;
  }

  /** While held, the tracked position doesn't move (e.g. while a frame is being read). */
  hold(held: boolean): void {
    this.held = held;
  }

  get region(): Region {
    const r = this.radius;
    const x0 = Math.max(0, this.cx - r);
    const y0 = Math.max(0, this.cy - r);
    const x1 = Math.min(this.width, this.cx + r + 1);
    const y1 = Math.min(this.height, this.cy + r + 1);
    return { x: x0 / this.width, y: y0 / this.height, w: (x1 - x0) / this.width, h: (y1 - y0) / this.height };
  }

  /** Feeds one frame of luma values (0–1, row-major) and returns the light's level. */
  push(t: number, luma: ArrayLike<number>): number {
    const dt = this.lastT === null ? null : t - this.lastT;
    this.lastT = t;
    if (dt === null) {
      for (let i = 0; i < luma.length; i++) this.mean[i] = luma[i];
    } else {
      const a = 1 - Math.exp(-Math.max(0, dt) / this.tauMs);
      let best = 0;
      let bestI = -1;
      for (let i = 0; i < luma.length; i++) {
        const d = luma[i] - this.mean[i];
        this.mean[i] += a * d;
        this.variance[i] += a * (d * d - this.variance[i]);
        if (this.variance[i] > best) {
          best = this.variance[i];
          bestI = i;
        }
      }
      if (!this.held && bestI >= 0 && best >= this.minVariance) {
        const current = this.variance[this.cy * this.width + this.cx];
        if (best > current * this.switchRatio) {
          this.cx = bestI % this.width;
          this.cy = Math.floor(bestI / this.width);
        }
      }
    }
    return this.level(luma);
  }

  private level(luma: ArrayLike<number>): number {
    const r = this.radius;
    let sum = 0;
    let wsum = 0;
    let plain = 0;
    let n = 0;
    for (let y = Math.max(0, this.cy - r); y <= Math.min(this.height - 1, this.cy + r); y++) {
      for (let x = Math.max(0, this.cx - r); x <= Math.min(this.width - 1, this.cx + r); x++) {
        const i = y * this.width + x;
        const w = this.variance[i];
        sum += w * luma[i];
        wsum += w;
        plain += luma[i];
        n++;
      }
    }
    // Until something blinks, fall back to a plain average of the region.
    return wsum >= this.minVariance ? sum / wsum : plain / n;
  }
}
