import type { Level, TimedLevels } from '../modulation/manchester/encode';

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  // Monotonic where available (browsers, Hermes); falls back to wall-clock time.
  now: () => globalThis.performance?.now() ?? Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

export interface ScheduleOptions {
  onProgress?: (done: number, total: number) => void;
  abort?: AbortSignal;
  clock?: Clock;
}

/**
 * Plays levels on any output. Targets absolute timestamps (start + i·halfBit)
 * so late timers don't accumulate drift. Always leaves the output at 0.
 */
export async function runSchedule(
  signal: TimedLevels,
  setLevel: (level: Level) => void,
  opts: ScheduleOptions = {},
): Promise<void> {
  const clock = opts.clock ?? realClock;
  const total = signal.levels.length;
  const start = clock.now();
  try {
    for (let i = 0; i < total; i++) {
      if (opts.abort?.aborted) return;
      const wait = start + i * signal.halfBitMs - clock.now();
      if (wait > 0) await clock.sleep(wait);
      if (opts.abort?.aborted) return;
      setLevel(signal.levels[i]);
      opts.onProgress?.(i + 1, total);
    }
    const tail = start + total * signal.halfBitMs - clock.now();
    if (tail > 0) await clock.sleep(tail);
  } finally {
    setLevel(0);
  }
}
