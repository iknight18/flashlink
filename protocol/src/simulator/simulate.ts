import type { Level, TimedLevels } from '../modulation/manchester/encode';
import type { MultiTimedLevels } from '../signal/transmission';

export interface SimOptions {
  fps: number;
  /** Uniform ± jitter applied to each transmitted edge. Keep < halfBit/2. */
  jitterMs?: number;
  /** Uniform ± noise added to every sample level. */
  noise?: number;
  /** Probability that a camera frame is dropped. */
  dropRate?: number;
  seed?: number;
  leadInMs?: number;
  tailMs?: number;
  low?: number;
  high?: number;
  /**
   * Camera exposure per frame. 0 samples the light at an instant; longer exposures
   * average it over [t − exposureMs, t], so frames straddling an edge read in between.
   */
  exposureMs?: number;
  /** Extra delay on off→on transitions, modelling a torch that switches on slower than off. */
  onDelayMs?: number;
}

export interface Sample {
  t: number;
  level: number;
}

/** Deterministic PRNG so tests are reproducible. */
export function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One light as transmitted: jittered segment start times, read back at increasing times. */
class Light {
  private readonly starts: number[];
  private readonly end: number;
  private seg = -1;

  constructor(
    private readonly levels: Level[],
    slotMs: number,
    lead: number,
    jitter: number,
    onDelay: number,
    rand: () => number,
  ) {
    this.starts = levels.map(
      (l, i) =>
        lead + i * slotMs + (i === 0 ? 0 : (rand() * 2 - 1) * jitter) +
        (l === 1 && levels[i - 1] !== 1 ? onDelay : 0),
    );
    this.end = lead + levels.length * slotMs;
  }

  /** Advances to time `t` (call with increasing t). */
  advance(t: number): void {
    while (this.seg + 1 < this.starts.length && this.starts[this.seg + 1] <= t) this.seg++;
  }

  /** Light reaching the sensor at the current time `t`, 0–1, averaged over the exposure. */
  lit(t: number, exposure: number): number {
    const isOn = (seg: number, u: number) => seg >= 0 && u < this.end && this.levels[seg] === 1;
    if (exposure <= 0) return isOn(this.seg, t) ? 1 : 0;
    // Average the light over the exposure window in 0.5 ms steps.
    const steps = Math.max(1, Math.round(exposure * 2));
    let s = this.seg;
    let sum = 0;
    for (let k = 0; k < steps; k++) {
      const u = t - (k * exposure) / steps;
      while (s >= 0 && this.starts[s] > u) s--;
      sum += isOn(s, u) ? 1 : 0;
    }
    return sum / steps;
  }
}

/** Renders transmitted levels as a sensor would sample them. */
export function simulate(signal: TimedLevels, o: SimOptions): Sample[] {
  const rand = mulberry32(o.seed ?? 1);
  const noise = o.noise ?? 0;
  const drop = o.dropRate ?? 0;
  const lead = o.leadInMs ?? 1000;
  const tail = o.tailMs ?? 1000;
  const low = o.low ?? 0.1;
  const high = o.high ?? 0.9;
  const exposure = o.exposureMs ?? 0;

  const light = new Light(signal.levels, signal.halfBitMs, lead, o.jitterMs ?? 0, o.onDelayMs ?? 0, rand);
  const end = lead + signal.levels.length * signal.halfBitMs;
  const frame = 1000 / o.fps;

  const out: Sample[] = [];
  for (let t = rand() * frame; t <= end + tail; t += frame) {
    light.advance(t);
    if (rand() < drop) continue;
    out.push({ t, level: low + (high - low) * light.lit(t, exposure) + (rand() * 2 - 1) * noise });
  }
  return out;
}

export interface LaneSample {
  t: number;
  /** One level per lane. */
  levels: number[];
}

/**
 * Renders several lights seen by one camera: frame times and dropped frames are shared,
 * while edge jitter, noise and the turn-on delay are independent per lane.
 * `onDelayMsPerLane` overrides `onDelayMs` for each lane it covers.
 */
export function simulateLanes(
  signal: MultiTimedLevels,
  o: SimOptions & { onDelayMsPerLane?: number[] },
): LaneSample[] {
  const seed = o.seed ?? 1;
  const camera = mulberry32(seed);
  const noise = o.noise ?? 0;
  const drop = o.dropRate ?? 0;
  const lead = o.leadInMs ?? 1000;
  const tail = o.tailMs ?? 1000;
  const low = o.low ?? 0.1;
  const high = o.high ?? 0.9;
  const exposure = o.exposureMs ?? 0;

  const lanes = signal.lanes.map((levels, k) => {
    const rand = mulberry32(seed * 1_000_003 + 7919 * (k + 1));
    const onDelay = o.onDelayMsPerLane?.[k] ?? o.onDelayMs ?? 0;
    return { light: new Light(levels, signal.slotMs, lead, o.jitterMs ?? 0, onDelay, rand), rand };
  });
  const end = lead + (signal.lanes[0]?.length ?? 0) * signal.slotMs;
  const frame = 1000 / o.fps;

  const out: LaneSample[] = [];
  for (let t = camera() * frame; t <= end + tail; t += frame) {
    for (const l of lanes) l.light.advance(t);
    if (camera() < drop) continue;
    out.push({
      t,
      levels: lanes.map((l) => low + (high - low) * l.light.lit(t, exposure) + (l.rand() * 2 - 1) * noise),
    });
  }
  return out;
}
