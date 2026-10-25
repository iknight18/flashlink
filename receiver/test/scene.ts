/**
 * Synthetic camera frames for LightFinder tests: rectangles painted with exact sub-cell
 * coverage (so a scene can be shifted by fractions of a cell, like a shaking hand),
 * optional soft edges (blur and bloom, as a camera sees a bright tile) and sensor noise.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Luma inside the rectangle; later rectangles are painted over earlier ones. */
  value: number;
}

export interface SceneOptions {
  /** Luma where no rectangle is painted. Default 0.05. */
  bg?: number;
  /** Uniform ± noise added to every cell. */
  noise?: number;
  rand?: () => number;
  /** Blur the edges (≈ 2-cell ramp) and add a faint bloom around bright areas. */
  soft?: boolean;
  /** Whole-scene translation in cells (camera shake). */
  dx?: number;
  dy?: number;
  /** Exposure gain applied to the whole picture (auto-exposure settling). Default 1. */
  gain?: number;
}

const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

export function paintScene(w: number, h: number, rects: Rect[], o: SceneOptions = {}): Float32Array {
  const dx = o.dx ?? 0;
  const dy = o.dy ?? 0;
  let f: Float32Array = new Float32Array(w * h).fill(o.bg ?? 0.05);
  for (const r of rects) {
    const x0 = r.x + dx;
    const y0 = r.y + dy;
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(h, Math.ceil(y0 + r.h)); y++) {
      const cy = overlap(y, y + 1, y0, y0 + r.h);
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, Math.ceil(x0 + r.w)); x++) {
        const c = cy * overlap(x, x + 1, x0, x0 + r.w);
        f[y * w + x] += (r.value - f[y * w + x]) * c;
      }
    }
  }
  if (o.soft) {
    const sharp = f;
    f = boxBlur(boxBlur(sharp, w, h, 1), w, h, 1);
    const bloom = boxBlur(sharp, w, h, 3);
    for (let i = 0; i < f.length; i++) f[i] += 0.15 * bloom[i];
  }
  const gain = o.gain ?? 1;
  const noise = o.noise ?? 0;
  const rand = o.rand ?? Math.random;
  for (let i = 0; i < f.length; i++) f[i] = Math.min(1, Math.max(0, f[i] * gain + (noise ? (rand() * 2 - 1) * noise : 0)));
  return f;
}

/** Separable box blur of the given radius, clamped at the borders. */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += src[y * w + Math.min(w - 1, Math.max(0, x + k))];
      tmp[y * w + x] = s / (2 * r + 1);
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let k = -r; k <= r; k++) s += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x];
      out[y * w + x] = s / (2 * r + 1);
    }
  return out;
}

/** Hand shake: up to ±`amp` cells, ~`hz` Hz, slightly different on each axis so it never repeats exactly. */
export function shake(t: number, amp = 1, hz = 3): { dx: number; dy: number } {
  const s = t / 1000;
  return {
    dx: amp * Math.sin(2 * Math.PI * hz * s + 0.3),
    dy: amp * Math.sin(2 * Math.PI * hz * 0.83 * s + 1.7),
  };
}

/** Auto-exposure settling after the camera opens: 1.6× too bright at first, right after 0.8 s. */
export function exposureRamp(t: number): number {
  return 1 + 0.6 * Math.max(0, 1 - t / 800);
}

/**
 * A laptop seen across a desk: a lit room (0.2), a mid-grey bezel (0.4) and the emitter
 * page's black screen (0.05) — every boundary is a strong steady edge that a shaking
 * camera turns into variance.
 */
export function laptop(w: number, h: number): Rect[] {
  const m = 6;
  const border = 4;
  return [
    { x: m, y: m, w: w - 2 * m, h: h - 2 * m, value: 0.4 },
    { x: m + border, y: m + border, w: w - 2 * (m + border), h: h - 2 * (m + border), value: 0.05 },
  ];
}
