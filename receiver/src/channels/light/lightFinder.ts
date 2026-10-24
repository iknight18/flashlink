export interface LightFinderOptions {
  /** Time constant of the per-pixel mean/variance averages (ms). Default 1000. */
  tauMs?: number;
  /** A pixel is active above this share of the frame's highest variance. Default 0.1. */
  relThreshold?: number;
  /** ...and above this absolute variance, so camera noise alone finds nothing. Default 2e-4 (σ 0.014). */
  noiseFloor?: number;
  /** Ids are matched to the nearest previous centroid within this many grid cells. Default 8. */
  matchRadius?: number;
  /** A light no longer detected keeps its id and position this long (ms). Default 500. */
  holdMs?: number;
  /** At most this many sources, the most active first. Default 12. */
  maxSources?: number;
}

export interface LightSource {
  id: number;
  /** Brightness of the light above the frame's baseline (median). */
  level: number;
  /** Centroid, normalized 0–1 across the grid. */
  cx: number;
  cy: number;
}

interface Track {
  id: number;
  /** Centroid in grid cells. */
  x: number;
  y: number;
  /** Pixels of the light's last detected blob, where its level is read. */
  pixels: Int32Array;
  lastSeen: number;
}

interface Blob {
  x: number;
  y: number;
  pixels: Int32Array;
  /** Summed variance: how much this blob blinks. */
  activity: number;
}

/** Share of a blob's pixels, the brightest, averaged as its level. */
const TOP_SHARE = 0.3;
/** ...but at most this many, so a blob widened by halo or motion isn't diluted. */
const TOP_MAX = 32;
const MEDIAN_BINS = 1024;
/** Frame-to-frame change a blob needs to become a new light (the camera edge detector's minimum contrast). */
const NEW_LIGHT_STEP = 0.04;

/**
 * Finds the blinking lights in a stream of luma frames, statelessly enough that it can't
 * get lost: every frame, the pixels that vary over time (variance EMA) are grouped into
 * 4-connected blobs; each blob is a light. Ids carry over to the nearest blob of the
 * previous frame, and a light that briefly drops out keeps its id and position (its
 * level is read there) for `holdMs`, so a decoder isn't reset by a flicker of detection.
 *
 * A steady lamp doesn't vary, so it's ignored. A level is the brightest pixels of the
 * blob minus the frame median, so a room getting brighter or darker cancels out.
 */
export class LightFinder {
  private readonly n: number;
  private readonly mean: Float32Array;
  private readonly variance: Float32Array;
  private readonly prev: Float32Array;
  private readonly label: Int32Array;
  private readonly queue: Int32Array;
  private readonly hist = new Uint32Array(MEDIAN_BINS);
  private readonly tauMs: number;
  private readonly relThreshold: number;
  private readonly noiseFloor: number;
  private readonly matchRadius: number;
  private readonly holdMs: number;
  private readonly maxSources: number;
  private lastT: number | null = null;
  private tracks: Track[] = [];

  constructor(
    private readonly width: number,
    private readonly height: number,
    opts: LightFinderOptions = {},
  ) {
    this.n = width * height;
    this.mean = new Float32Array(this.n);
    this.variance = new Float32Array(this.n);
    this.prev = new Float32Array(this.n);
    this.label = new Int32Array(this.n);
    this.queue = new Int32Array(this.n);
    this.tauMs = opts.tauMs ?? 1000;
    this.relThreshold = opts.relThreshold ?? 0.1;
    this.noiseFloor = opts.noiseFloor ?? 2e-4;
    this.matchRadius = opts.matchRadius ?? 8;
    this.holdMs = opts.holdMs ?? 500;
    this.maxSources = opts.maxSources ?? 12;
  }

  push(t: number, luma: Float32Array): LightSource[] {
    if (luma.length !== this.n) throw new Error(`expected ${this.n} pixels, got ${luma.length}`);
    if (this.lastT === null) {
      this.mean.set(luma);
      this.prev.set(luma);
      this.lastT = t;
      return [];
    }
    const dt = Math.max(1, t - this.lastT);
    this.lastT = t;
    const maxVar = this.updateVariance(luma, 1 - Math.exp(-dt / this.tauMs));
    const threshold = Math.max(this.noiseFloor, this.relThreshold * maxVar);
    const blobs = this.findBlobs(threshold);
    this.match(t, blobs, luma);
    this.prev.set(luma);
    const median = this.median(luma);
    return this.tracks
      .map((tr) => ({
        id: tr.id,
        level: Math.max(0, topMean(luma, tr.pixels) - median),
        cx: (tr.x + 0.5) / this.width,
        cy: (tr.y + 0.5) / this.height,
      }))
      .sort((a, b) => a.id - b.id);
  }

  /** Exponentially weighted mean and variance per pixel; returns the highest variance. */
  private updateVariance(luma: Float32Array, a: number): number {
    const { mean, variance } = this;
    let max = 0;
    for (let i = 0; i < this.n; i++) {
      const d = luma[i] - mean[i];
      mean[i] += a * d;
      const v = (1 - a) * (variance[i] + a * d * d);
      variance[i] = v;
      if (v > max) max = v;
    }
    return max;
  }

  /** 4-connected blobs of pixels above the threshold, the most active first. */
  private findBlobs(threshold: number): Blob[] {
    const { width: w, height: h, variance, label, queue } = this;
    label.fill(0);
    const blobs: Blob[] = [];
    let next = 0;
    for (let start = 0; start < this.n; start++) {
      if (label[start] !== 0 || variance[start] < threshold) continue;
      next++;
      let head = 0;
      let tail = 0;
      queue[tail++] = start;
      label[start] = next;
      let sx = 0;
      let sy = 0;
      let activity = 0;
      while (head < tail) {
        const i = queue[head++];
        const x = i % w;
        const y = (i - x) / w;
        // Weighted by variance, so the centroid sits on the light rather than on the
        // fading trail a moving light leaves in the activity map.
        sx += x * variance[i];
        sy += y * variance[i];
        activity += variance[i];
        const visit = (j: number) => {
          if (label[j] === 0 && variance[j] >= threshold) {
            label[j] = next;
            queue[tail++] = j;
          }
        };
        if (x > 0) visit(i - 1);
        if (x < w - 1) visit(i + 1);
        if (y > 0) visit(i - w);
        if (y < h - 1) visit(i + w);
      }
      blobs.push({ x: sx / activity, y: sy / activity, pixels: queue.slice(0, tail), activity });
    }
    return blobs.sort((a, b) => b.activity - a.activity).slice(0, this.maxSources);
  }

  /** Greedy nearest-centroid matching of blobs to tracks; unmatched tracks are held, then dropped. */
  private match(t: number, blobs: Blob[], luma: Float32Array): void {
    const r2 = this.matchRadius * this.matchRadius;
    const pairs: { d: number; tr: Track; b: Blob }[] = [];
    for (const tr of this.tracks)
      for (const b of blobs) {
        const d = (tr.x - b.x) ** 2 + (tr.y - b.y) ** 2;
        if (d <= r2) pairs.push({ d, tr, b });
      }
    pairs.sort((p, q) => p.d - q.d);
    const usedTracks = new Set<Track>();
    const usedBlobs = new Set<Blob>();
    for (const { tr, b } of pairs) {
      if (usedTracks.has(tr) || usedBlobs.has(b)) continue;
      usedTracks.add(tr);
      usedBlobs.add(b);
      Object.assign(tr, { x: b.x, y: b.y, pixels: b.pixels, lastSeen: t });
    }
    this.tracks = this.tracks.filter((tr) => usedTracks.has(tr) || t - tr.lastSeen <= this.holdMs);
    for (const b of blobs) {
      if (usedBlobs.has(b) || this.tracks.length >= this.maxSources || !this.toggled(b, luma)) continue;
      this.tracks.push({ id: this.freeId(), x: b.x, y: b.y, pixels: b.pixels, lastSeen: t });
    }
  }

  /**
   * Whether the blob changed brightness since the last frame. Only such a blob becomes a
   * new light: a light shows up when it switches, while a leftover of the fading trail of
   * a moving light (which no longer switches) never does.
   */
  private toggled(b: Blob, luma: Float32Array): boolean {
    for (const i of b.pixels) if (Math.abs(luma[i] - this.prev[i]) >= NEW_LIGHT_STEP) return true;
    return false;
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
    for (let i = 0; i < this.n; i++) hist[Math.min(MEDIAN_BINS - 1, Math.max(0, Math.floor(luma[i] * MEDIAN_BINS)))]++;
    let seen = 0;
    for (let b = 0; b < MEDIAN_BINS; b++) {
      seen += hist[b];
      if (seen * 2 > this.n) return (b + 0.5) / MEDIAN_BINS;
    }
    return 1;
  }
}

/** Mean of the brightest pixels of `pixels` (see TOP_SHARE, TOP_MAX). */
function topMean(luma: Float32Array, pixels: Int32Array): number {
  const values = Float32Array.from(pixels, (i) => luma[i]).sort();
  const k = Math.max(1, Math.min(TOP_MAX, Math.ceil(values.length * TOP_SHARE)));
  let sum = 0;
  for (let i = values.length - k; i < values.length; i++) sum += values[i];
  return sum / k;
}
