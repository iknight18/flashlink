import type { TimedLevels } from '../modulation/manchester/encode';

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

/** Renders transmitted levels as a sensor would sample them. */
export function simulate(signal: TimedLevels, o: SimOptions): Sample[] {
  const rand = mulberry32(o.seed ?? 1);
  const jitter = o.jitterMs ?? 0;
  const noise = o.noise ?? 0;
  const drop = o.dropRate ?? 0;
  const lead = o.leadInMs ?? 1000;
  const tail = o.tailMs ?? 1000;
  const low = o.low ?? 0.1;
  const high = o.high ?? 0.9;
  const exposure = o.exposureMs ?? 0;

  const onDelay = o.onDelayMs ?? 0;
  const starts = signal.levels.map(
    (l, i) =>
      lead + i * signal.halfBitMs + (i === 0 ? 0 : (rand() * 2 - 1) * jitter) +
      (l === 1 && signal.levels[i - 1] !== 1 ? onDelay : 0),
  );
  const end = lead + signal.levels.length * signal.halfBitMs;
  const frame = 1000 / o.fps;

  const isOn = (seg: number, t: number) => seg >= 0 && t < end && signal.levels[seg] === 1;

  const out: Sample[] = [];
  let seg = -1;
  for (let t = rand() * frame; t <= end + tail; t += frame) {
    while (seg + 1 < starts.length && starts[seg + 1] <= t) seg++;
    if (rand() < drop) continue;
    let lit = isOn(seg, t) ? 1 : 0;
    if (exposure > 0) {
      // Average the light over the exposure window in 0.5 ms steps.
      const steps = Math.max(1, Math.round(exposure * 2));
      let s = seg;
      let sum = 0;
      for (let k = 0; k < steps; k++) {
        const u = t - (k * exposure) / steps;
        while (s >= 0 && starts[s] > u) s--;
        sum += isOn(s, u) ? 1 : 0;
      }
      lit = sum / steps;
    }
    out.push({ t, level: low + (high - low) * lit + (rand() * 2 - 1) * noise });
  }
  return out;
}
