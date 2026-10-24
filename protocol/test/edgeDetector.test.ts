import { describe, expect, it } from 'vitest';
import { EdgeDetector, type Edge } from '../src/signal/edgeDetector';

function run(det: EdgeDetector, samples: [number, number][]): Edge[] {
  return samples.map(([t, v]) => det.push(t, v)).filter((e): e is Edge => e !== null);
}

describe('EdgeDetector', () => {
  it('detects a rising then falling edge, interpolating the crossing time', () => {
    const samples: [number, number][] = [];
    for (let t = 0; t < 1000; t += 10) samples.push([t, t >= 500 && t < 800 ? 0.9 : 0.1]);
    const edges = run(new EdgeDetector(), samples);
    expect(edges).toHaveLength(2);
    expect(edges[0].level).toBe(1);
    expect(edges[0].t).toBeCloseTo(495, 5); // midway between 490 (0.1) and 500 (0.9)
    expect(edges[1].level).toBe(0);
    expect(edges[1].t).toBeCloseTo(795, 5);
  });

  it('ignores noise below the minimum contrast', () => {
    const samples: [number, number][] = [];
    for (let t = 0; t < 2000; t += 10) samples.push([t, 0.1 + (t % 30 === 0 ? 0.05 : -0.05)]);
    expect(run(new EdgeDetector(), samples)).toEqual([]);
  });

  it('exposes the current threshold once contrast is present', () => {
    const det = new EdgeDetector();
    det.push(0, 0.1);
    expect(det.threshold).toBeNull();
    det.push(10, 0.9);
    expect(det.threshold).toBeCloseTo(0.5, 5);
  });
});
