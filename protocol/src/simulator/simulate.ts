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

  const starts = signal.levels.map(
    (_, i) => lead + i * signal.halfBitMs + (i === 0 ? 0 : (rand() * 2 - 1) * jitter),
  );
  const end = lead + signal.levels.length * signal.halfBitMs;
  const frame = 1000 / o.fps;

  const out: Sample[] = [];
  let seg = -1;
  for (let t = rand() * frame; t <= end + tail; t += frame) {
    while (seg + 1 < starts.length && starts[seg + 1] <= t) seg++;
    if (rand() < drop) continue;
    const on = seg >= 0 && t < end && signal.levels[seg] === 1;
    out.push({ t, level: (on ? high : low) + (rand() * 2 - 1) * noise });
  }
  return out;
}
