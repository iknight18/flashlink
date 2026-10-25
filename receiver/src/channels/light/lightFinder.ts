export interface LightFinderOptions {
  /** Release time constant of the per-pixel running max/min (ms): how long a swing is remembered. Default 2000. */
  tauMs?: number;
  /** Attack time constant of the running max/min (ms), so a single noisy frame barely widens the swing. Default 30. */
  attackMs?: number;
  /** A pixel is part of a light if its swing is at least this share of the frame's 99th-percentile swing... Default 0.5. */
  relThreshold?: number;
  /** ...and at least this absolute swing, so noise and slow drifts find nothing. Default 0.15. */
  absFloor?: number;
  /**
   * Neighbouring pixels belong to the same light only if their luma correlates at least
   * this much over the last ~`tauMs`: two tiles blinking different lanes don't, even
   * where a shaking hand smears their swing maps into each other. Default 0.8.
   */
  minCorrelation?: number;
  /**
   * Only pixels that actually blink count: at least `minTransitions` crossings of their
   * own midpoint (with hysteresis) within the last `blinkWindowMs`. A steady lamp, a light
   * switched on once, an edge that moved once — none of these blink. Defaults 4 and 2000.
   */
  minTransitions?: number;
  blinkWindowMs?: number;
  /** Regions smaller than this many grid cells are ignored. Default 3. */
  minArea?: number;
  /** Lights are re-segmented this often (ms); in between each keeps a fixed pixel mask. Default 250. */
  resegmentMs?: number;
  /** A region overlapping no light takes the id of the nearest one within this many grid cells. Default 8. */
  matchRadius?: number;
  /**
   * A light no longer found keeps its id and mask this long (ms), so the emitter's pause
   * between repeats (8 slots ≈ 0.8 s) doesn't drop it. Default 1500.
   */
  holdMs?: number;
  /** At most this many sources, the ones blinking most first. Default 9 (the emitter's maximum). */
  maxSources?: number;
}

export interface LightSource {
  id: number;
  /** Mean brightness of the light's mask above the frame's baseline (median). */
  level: number;
  /** Centroid, normalized 0–1 across the grid. */
  cx: number;
  cy: number;
}

interface Region {
  pixels: Int32Array;
  /** Swing-weighted centroid in grid cells. */
  x: number;
  y: number;
  /** Summed swing: how much this region blinks. */
  swing: number;
}

interface Track extends Region {
  id: number;
  /** Time of the first re-segmentation that no longer found it, or null while it is found. */
  missingSince: number | null;
  /** Re-segmentations that found it; one seen only once isn't held when it goes missing. */
  hits: number;
  /** Its latest levels, oldest first (at most HISTORY). */
  history: number[];
}

const HIST_BINS = 1024;
/**
 * Hysteresis of a pixel's midpoint crossings: this share of its swing either side, but
 * at least CROSS_MIN × absFloor, so noise on a pixel that doesn't swing never counts.
 */
const CROSS_BAND = 0.15;
const CROSS_MIN = 0.4;
const SWING_PERCENTILE = 0.99;
/** Regions longer than this many times their width are edges swept by camera shake, not tiles. */
const MAX_ASPECT = 4;
/** ...as are regions filling less than this share of their bounding box (an outline, an L)... */
const MIN_FILL = 0.3;
/** ...and slivers thinner than this on average (area / longest side, in cells): a 2×2 torch is 2. */
const MIN_THICKNESS = 1.5;
/**
 * A region must swing at least this share of the strongest region's total swing: the
 * emitter's tiles are all the same size, while specks of an edge swept by shake or of
 * exposure settling are tiny next to them.
 */
const MIN_SHARE = 0.15;
/** Levels kept per light (~4 s at 60 fps) to tell whether two lights blink alike. */
const HISTORY = 240;
/** Two lights whose levels correlate at least this much are the same light, seen in parts. */
const SAME_LIGHT = 0.9;

/**
 * Finds the blinking lights in a stream of luma frames.
 *
 * Per pixel, on luma minus the frame median (so the room getting brighter or darker
 * cancels out), it keeps:
 *  - a swing: running max − min (fast attack, slow ~2 s release). A tile swings by its
 *    full on/off contrast; a steady lamp doesn't swing.
 *  - blinks: the times of its last few crossings of its own midpoint, with hysteresis. A
 *    pixel blinks if it crossed `minTransitions` times within `blinkWindowMs`, so a light
 *    switched on once, or an edge that moved once, never counts.
 *  - correlations with its neighbours (EMA over ~2 s): two tiles carrying different
 *    lanes don't correlate, even where a shaking hand smears their swings together.
 *
 * Regions grow from blinking pixels into neighbouring pixels that swing at least half as
 * much as the strongest (99th percentile) and correlate with them, bridging 1-cell gaps
 * so a noisy, soft-edged tile stays one region. Long thin regions, outlines and slivers
 * (steady edges swept back and forth by shake) are dropped, as are regions swinging far
 * less than the strongest one: the emitter's tiles are all the same size.
 *
 * Regions are re-segmented only every `resegmentMs`; in between each light keeps a fixed
 * pixel mask, and its level is the mean luma over that mask minus the frame median, so
 * the level is a clean square wave rather than a pixel set changing every frame. New
 * regions take the id of the light whose mask they overlap most (else the nearest); a
 * light that is no longer found keeps its id and mask for `holdMs` (unless it was only
 * ever seen once: a speck that came and went). Lights far from all others are picked up
 * on any frame, as soon as they blink; two lights a region spans are kept apart unless
 * their levels correlate (fragments of one light); and pieces beside a light, under half
 * its size (a moving light's leading edge or trail), don't become lights of their own.
 */
export class LightFinder {
  private readonly n: number;
  private readonly hi: Float32Array;
  private readonly lo: Float32Array;
  private readonly swing: Float32Array;
  /** Per pixel: EMA mean, variance, this frame's deviation from the mean. */
  private readonly mean: Float32Array;
  private readonly variance: Float32Array;
  private readonly dev: Float32Array;
  /** EMA covariance of each pixel with the one 1 and 2 cells to the right, and 1 and 2 cells below. */
  private readonly cov: Float32Array[];
  private readonly offsets: number[];
  /** Per pixel: above its midpoint, and the times of its last `minTransitions` crossings (ring). */
  private readonly high: Uint8Array;
  private readonly crossings: Float64Array;
  private readonly crossAt: Uint8Array;
  private readonly label: Int32Array;
  private readonly queue: Int32Array;
  private readonly hist = new Uint32Array(HIST_BINS);
  private readonly tauMs: number;
  private readonly attackMs: number;
  private readonly relThreshold: number;
  private readonly absFloor: number;
  private readonly minCorrelation: number;
  private readonly minTransitions: number;
  private readonly blinkWindowMs: number;
  private readonly minArea: number;
  private readonly resegmentMs: number;
  private readonly matchRadius: number;
  private readonly holdMs: number;
  private readonly maxSources: number;
  private lastT: number | null = null;
  private lastSegment = -Infinity;
  private tracks: Track[] = [];

  constructor(
    private readonly width: number,
    private readonly height: number,
    opts: LightFinderOptions = {},
  ) {
    this.n = width * height;
    this.hi = new Float32Array(this.n);
    this.lo = new Float32Array(this.n);
    this.swing = new Float32Array(this.n);
    this.mean = new Float32Array(this.n);
    this.variance = new Float32Array(this.n);
    this.dev = new Float32Array(this.n);
    this.offsets = [1, 2, width, 2 * width];
    this.cov = this.offsets.map(() => new Float32Array(this.n));
    this.label = new Int32Array(this.n);
    this.queue = new Int32Array(this.n);
    this.tauMs = opts.tauMs ?? 2000;
    this.attackMs = opts.attackMs ?? 30;
    this.relThreshold = opts.relThreshold ?? 0.5;
    this.absFloor = opts.absFloor ?? 0.15;
    this.minCorrelation = opts.minCorrelation ?? 0.8;
    this.minTransitions = Math.max(1, Math.min(255, opts.minTransitions ?? 4));
    this.blinkWindowMs = opts.blinkWindowMs ?? 2000;
    this.high = new Uint8Array(this.n);
    this.crossings = new Float64Array(this.n * this.minTransitions).fill(-Infinity);
    this.crossAt = new Uint8Array(this.n);
    this.minArea = opts.minArea ?? 3;
    this.resegmentMs = opts.resegmentMs ?? 250;
    this.matchRadius = opts.matchRadius ?? 8;
    this.holdMs = opts.holdMs ?? 1500;
    this.maxSources = opts.maxSources ?? 9;
  }

  push(t: number, luma: Float32Array): LightSource[] {
    if (luma.length !== this.n) throw new Error(`expected ${this.n} pixels, got ${luma.length}`);
    const median = this.median(luma);
    if (this.lastT === null) {
      for (let i = 0; i < this.n; i++) this.hi[i] = this.lo[i] = this.mean[i] = luma[i] - median;
      this.lastT = t;
      return [];
    }
    const dt = Math.max(1, t - this.lastT);
    this.lastT = t;
    this.update(t, luma, median, 1 - Math.exp(-dt / this.attackMs), 1 - Math.exp(-dt / this.tauMs));

    if (this.tracks.length === 0 || t - this.lastSegment >= this.resegmentMs) {
      this.lastSegment = t;
      this.match(t, this.segment(t));
    } else {
      // Between re-segmentations masks stay fixed, but a new light is picked up as soon as it blinks.
      this.addNew(this.segment(t));
    }
    this.tracks = this.tracks.filter(
      (tr) => tr.missingSince === null || (tr.hits > 1 && t - tr.missingSince < this.holdMs),
    );

    return this.tracks
      .map((tr) => {
        const level = Math.max(0, maskMean(luma, tr.pixels) - median);
        tr.history.push(level);
        if (tr.history.length > HISTORY) tr.history.shift();
        return { id: tr.id, level, cx: (tr.x + 0.5) / this.width, cy: (tr.y + 0.5) / this.height };
      })
      .sort((a, b) => a.id - b.id);
  }

  /**
   * Per pixel, on luma − median: running max/min (quick to follow a new extreme, slow to
   * forget it), EMA mean and variance; then the EMA covariance with each neighbour in `offsets`.
   */
  private update(t: number, luma: Float32Array, median: number, attack: number, release: number): void {
    const { hi, lo, mean, variance, dev, high, crossings, crossAt, minTransitions: k, n } = this;
    const minBand = CROSS_MIN * this.absFloor;
    for (let i = 0; i < n; i++) {
      const v = luma[i] - median;
      hi[i] += (v - hi[i]) * (v > hi[i] ? attack : release);
      lo[i] += (v - lo[i]) * (v < lo[i] ? attack : release);
      const mid = (hi[i] + lo[i]) / 2;
      const band = Math.max(CROSS_BAND * (hi[i] - lo[i]), minBand);
      if (high[i] ? v < mid - band : v > mid + band) {
        high[i] ^= 1;
        crossings[i * k + crossAt[i]] = t;
        crossAt[i] = (crossAt[i] + 1) % k;
      }
      const d = v - mean[i];
      dev[i] = d;
      mean[i] += release * d;
      variance[i] = (1 - release) * (variance[i] + release * d * d);
    }
    this.offsets.forEach((off, k) => {
      const c = this.cov[k];
      for (let i = 0; i + off < n; i++) c[i] = (1 - release) * (c[i] + release * dev[i] * dev[i + off]);
    });
  }

  /** Whether pixel `i` crossed its midpoint `minTransitions` times within the blink window. */
  private blinking(i: number, t: number): boolean {
    // The ring's next slot holds its oldest crossing.
    return this.crossings[i * this.minTransitions + this.crossAt[i]] >= t - this.blinkWindowMs;
  }

  /** Whether neighbours `i` and `i + offsets[k]` blink together. */
  private linked(i: number, k: number): boolean {
    const j = i + this.offsets[k];
    const vv = this.variance[i] * this.variance[j];
    return vv > 0 && this.cov[k][i] >= this.minCorrelation * Math.sqrt(vv);
  }

  /** Regions of blinking pixels that swing enough, compact ones only, the ones swinging most first. */
  private segment(t: number): Region[] {
    const { width: w, height: h, swing, label, queue, hist } = this;
    hist.fill(0);
    for (let i = 0; i < this.n; i++) {
      const s = Math.max(0, this.hi[i] - this.lo[i]);
      swing[i] = s;
      hist[Math.min(HIST_BINS - 1, Math.floor(s * HIST_BINS))]++;
    }
    let seen = 0;
    let p99 = 0;
    for (let b = 0; b < HIST_BINS; b++) {
      seen += hist[b];
      if (seen >= this.n * SWING_PERCENTILE) {
        p99 = (b + 1) / HIST_BINS;
        break;
      }
    }
    const threshold = Math.max(this.absFloor, this.relThreshold * p99);

    label.fill(0);
    const regions: Region[] = [];
    let next = 0;
    for (let start = 0; start < this.n; start++) {
      // A region grows from a pixel that blinked repeatedly into the swinging pixels that
      // blink along with it: those a moving light only just reached haven't blinked
      // `minTransitions` times yet, but a light switched on once, or an edge that moved
      // once, has no such seed at all.
      if (label[start] !== 0 || swing[start] < threshold || !this.blinking(start, t)) continue;
      next++;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      label[start] = next;
      let sx = 0;
      let sy = 0;
      let total = 0;
      let x0 = w;
      let x1 = 0;
      let y0 = h;
      let y1 = 0;
      while (head < tail) {
        const i = queue[head++];
        const x = i % w;
        const y = (i - x) / w;
        sx += x * swing[i];
        sy += y * swing[i];
        total += swing[i];
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
        // Neighbours 1 and 2 cells away along each axis, so fragments separated by a 1-cell
        // gap are one region — if they blink together.
        const visit = (j: number, from: number, k: number) => {
          if (label[j] === 0 && swing[j] >= threshold && this.linked(from, k)) {
            label[j] = next;
            queue[tail++] = j;
          }
        };
        for (let k = 0; k < 2; k++) {
          const d = k + 1;
          if (x + d < w) visit(i + d, i, k);
          if (x - d >= 0) visit(i - d, i - d, k);
          if (y + d < h) visit(i + d * w, i, k + 2);
          if (y - d >= 0) visit(i - d * w, i - d * w, k + 2);
        }
      }
      const bw = x1 - x0 + 1;
      const bh = y1 - y0 + 1;
      if (tail < this.minArea) continue;
      const long = Math.max(bw, bh);
      if (long > MAX_ASPECT * Math.min(bw, bh) || tail < MIN_FILL * bw * bh || tail < MIN_THICKNESS * long) continue;
      regions.push({ pixels: queue.slice(0, tail), x: sx / total, y: sy / total, swing: total });
    }
    regions.sort((a, b) => b.swing - a.swing);
    const minSwing = MIN_SHARE * (regions[0]?.swing ?? 0);
    return regions.filter((r) => r.swing >= minSwing).slice(0, this.maxSources);
  }

  /**
   * Carries ids over: each region takes the light whose mask it overlaps most, then the
   * nearest remaining light within `matchRadius`. Lights not found are held; regions
   * left over become new lights.
   *
   * A region covering most of several lights that don't blink alike is two tiles whose
   * lanes happened to correlate for a while (a shaking hand smears neighbouring tiles
   * into each other, so only correlation tells them apart): they stay separate lights,
   * each on its previous mask.
   */
  private match(t: number, regions: Region[]): void {
    const owner = this.label;
    owner.fill(-1);
    regions.forEach((r, k) => {
      for (const i of r.pixels) owner[i] = k;
    });
    const pairs: { score: number; tr: Track; k: number }[] = [];
    const covers = regions.map((): Track[] => []);
    for (const tr of this.tracks) {
      const counts = new Map<number, number>();
      for (const i of tr.pixels) if (owner[i] >= 0) counts.set(owner[i], (counts.get(owner[i]) ?? 0) + 1);
      for (const [k, c] of counts) {
        pairs.push({ score: c, tr, k });
        if (c * 2 >= tr.pixels.length) covers[k].push(tr);
      }
    }
    const usedTracks = new Set<Track>();
    const usedRegions = new Set<number>();
    covers.forEach((trs, k) => {
      const distinct = trs.some((a, i) => trs.slice(i + 1).some((b) => correlation(a.history, b.history) < SAME_LIGHT));
      if (!distinct) return;
      usedRegions.add(k);
      for (const tr of trs) {
        usedTracks.add(tr);
        tr.missingSince = null;
        tr.hits++;
      }
    });
    pairs.sort((p, q) => q.score - p.score);
    const near: typeof pairs = [];
    const r2 = this.matchRadius * this.matchRadius;
    for (const tr of this.tracks)
      regions.forEach((r, k) => {
        const d = (tr.x - r.x) ** 2 + (tr.y - r.y) ** 2;
        if (d <= r2) near.push({ score: -d, tr, k });
      });
    near.sort((p, q) => q.score - p.score);

    for (const { tr, k } of [...pairs, ...near]) {
      if (usedTracks.has(tr) || usedRegions.has(k)) continue;
      usedTracks.add(tr);
      usedRegions.add(k);
      Object.assign(tr, regions[k], { missingSince: null, hits: tr.hits + 1 });
    }
    for (const tr of this.tracks) if (!usedTracks.has(tr)) tr.missingSince ??= t;
    // A leftover region beside a light and less than half its size is a piece of it (the
    // leading edge or trail of a moving light), not a new one: the emitter's tiles are all
    // the same size.
    const beside = this.nearMasks();
    regions.forEach((r, k) => {
      if (usedRegions.has(k) || this.tracks.length >= this.maxSources) return;
      if (r.pixels.some((i) => beside[i] > 2 * r.pixels.length)) return;
      this.tracks.push({ ...r, id: this.freeId(), missingSince: null, hits: 1, history: [] });
    });
  }

  /**
   * Regions more than 2 cells from every light's mask become new lights. Anything closer
   * (the leading edge of a moving light, say) waits for the next re-segmentation.
   */
  private addNew(regions: Region[]): void {
    const near = this.nearMasks();
    for (const r of regions) {
      if (this.tracks.length >= this.maxSources) return;
      if (r.pixels.some((i) => near[i] > 0)) continue;
      this.tracks.push({ ...r, id: this.freeId(), missingSince: null, hits: 1, history: [] });
    }
  }

  /** Per pixel, the size of the largest light mask within 2 cells of it (0 if none). */
  private nearMasks(): Int32Array {
    const { width: w, height: h } = this;
    const near = this.label;
    near.fill(0);
    for (const tr of this.tracks) {
      const size = tr.pixels.length;
      for (const i of tr.pixels) {
        const x = i % w;
        const y = (i - x) / w;
        for (let yy = Math.max(0, y - 2); yy <= Math.min(h - 1, y + 2); yy++)
          for (let xx = Math.max(0, x - 2); xx <= Math.min(w - 1, x + 2); xx++)
            if (near[yy * w + xx] < size) near[yy * w + xx] = size;
      }
    }
    return near;
  }

  /** The smallest id not in use, so markers read 1, 2, 3… */
  private freeId(): number {
    const used = new Set(this.tracks.map((tr) => tr.id));
    let id = 1;
    while (used.has(id)) id++;
    return id;
  }

  private median(luma: Float32Array): number {
    const { hist } = this;
    hist.fill(0);
    for (let i = 0; i < this.n; i++) hist[Math.min(HIST_BINS - 1, Math.max(0, Math.floor(luma[i] * HIST_BINS)))]++;
    let seen = 0;
    for (let b = 0; b < HIST_BINS; b++) {
      seen += hist[b];
      if (seen * 2 > this.n) return (b + 0.5) / HIST_BINS;
    }
    return 1;
  }
}

/**
 * Pearson correlation of the latest samples two lights share. Lights too young to tell
 * (under half a second at 60 fps) count as alike.
 */
function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 30) return 1;
  let sa = 0;
  let sb = 0;
  for (let i = 1; i <= n; i++) {
    sa += a[a.length - i];
    sb += b[b.length - i];
  }
  const ma = sa / n;
  const mb = sb / n;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 1; i <= n; i++) {
    const da = a[a.length - i] - ma;
    const db = b[b.length - i] - mb;
    ab += da * db;
    aa += da * da;
    bb += db * db;
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 1;
}

function maskMean(luma: Float32Array, pixels: Int32Array): number {
  let sum = 0;
  for (const i of pixels) sum += luma[i];
  return sum / pixels.length;
}
