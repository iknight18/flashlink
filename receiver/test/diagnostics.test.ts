import { describe, expect, it, vi } from 'vitest';
import { Diagnostics, type SignalStats } from '../src/diagnostics';

describe('Diagnostics', () => {
  it('summarises each second per source, with the strongest source picked out', () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response())));
    const stats: SignalStats[] = [];
    const d = new Diagnostics((s) => stats.push(s));
    const info = (id: number) =>
      id === 1 ? { state: 'READING' as const, threshold: 0.4, skew: 12 } : { state: 'LOCKED' as const, threshold: 0.1, skew: 0 };
    for (let t = 0; t <= 1000; t += 50) {
      const on = (t / 50) % 2 === 0;
      d.sample(t, [{ id: 1, level: on ? 0.8 : 0.1 }, { id: 2, level: on ? 0.2 : 0.15 }], info);
      d.interval(50);
    }
    expect(stats).toHaveLength(1);
    const s = stats[0];
    expect(s.lights).toBe(2);
    expect(s.fps).toBe(21); // 21 frames counted over the 1000 ms window
    expect(s.sources).toEqual([
      { id: 1, level: [0.1, 0.8], contrast: 0.7, state: 'READING', threshold: 0.4, skew: 12 },
      { id: 2, level: [0.15, 0.2], contrast: 0.05, state: 'LOCKED', threshold: 0.1, skew: 0 },
    ]);
    expect(s.strongest).toBe(1);
    expect(s.contrast).toBe(0.7);
    expect(s.threshold).toBe(0.4);
    expect(s.state).toBe('READING');
    expect(s.edges).toMatchObject({ median: 50 });
    vi.unstubAllGlobals();
  });

  it('reports no lights and no strongest source when nothing blinks', () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response())));
    const stats: SignalStats[] = [];
    const d = new Diagnostics((s) => stats.push(s));
    for (let t = 0; t <= 1000; t += 100) d.sample(t, [], () => undefined);
    expect(stats[0]).toMatchObject({ lights: 0, sources: [], strongest: null, contrast: 0, state: 'HUNTING' });
    vi.unstubAllGlobals();
  });
});
