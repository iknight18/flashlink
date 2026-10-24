import { describe, expect, it } from 'vitest';
import { runSchedule, type Clock } from '../src/signal/scheduler';
import type { Level } from '../src/modulation/manchester/encode';

/** Every sleep overshoots by 7 ms, like a busy JS thread. */
class LateClock implements Clock {
  t = 0;
  now = () => this.t;
  sleep = async (ms: number) => {
    this.t += ms + 7;
  };
}

describe('runSchedule', () => {
  it('sets each level at its absolute target time without accumulating drift', async () => {
    const clock = new LateClock();
    const calls: { t: number; level: Level }[] = [];
    const levels: Level[] = [1, 0, 0, 1, 1, 0, 1, 0, 0, 1];
    await runSchedule({ halfBitMs: 50, levels }, (level) => calls.push({ t: clock.t, level }), { clock });

    expect(calls.slice(0, levels.length).map((c) => c.level)).toEqual(levels);
    calls.slice(0, levels.length).forEach((c, i) => {
      expect(Math.abs(c.t - i * 50)).toBeLessThanOrEqual(7);
    });
    expect(calls.at(-1)).toMatchObject({ level: 0 }); // always ends dark
    expect(calls.at(-1)!.t).toBeGreaterThanOrEqual(levels.length * 50);
  });

  it('reports progress and stops on abort, leaving the output off', async () => {
    const clock = new LateClock();
    const ctrl = new AbortController();
    const set: Level[] = [];
    const progress: number[] = [];
    await runSchedule({ halfBitMs: 50, levels: [1, 1, 1, 1, 1, 1] }, (l) => set.push(l), {
      clock,
      abort: ctrl.signal,
      onProgress: (done) => {
        progress.push(done);
        if (done === 2) ctrl.abort();
      },
    });
    expect(progress).toEqual([1, 2]);
    expect(set).toEqual([1, 1, 0]);
  });
});
