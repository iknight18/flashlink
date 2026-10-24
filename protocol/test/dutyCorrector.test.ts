import { describe, expect, it } from 'vitest';
import { DutyCorrector } from '../src/signal/dutyCorrector';
import { encodeFrame } from '../src/framing/frame';
import { manchesterEncode, type TimedLevels } from '../src/modulation/manchester/encode';
import type { Edge } from '../src/signal/edgeDetector';

/** Ideal edges of a signal, with every off→on edge delayed by `onDelayMs`. */
function edgesOf(sig: TimedLevels, onDelayMs: number, t0 = 1000): Edge[] {
  const edges: Edge[] = [];
  let level = 0;
  sig.levels.forEach((l, i) => {
    if (l !== level) edges.push({ t: t0 + i * sig.halfBitMs + (l === 1 ? onDelayMs : 0), level: l });
    level = l;
  });
  return edges;
}

describe('DutyCorrector', () => {
  it('reports no skew until it has seen enough pulses', () => {
    const c = new DutyCorrector();
    c.push({ t: 0, level: 1 });
    c.push({ t: 100, level: 0 });
    expect(c.skewMs).toBe(0);
  });

  it('measures a slow torch turn-on from the on/off balance', () => {
    const c = new DutyCorrector();
    for (const e of edgesOf(manchesterEncode(encodeFrame('Meet at the north gate'), 200), 33)) c.push(e);
    expect(c.skewMs).toBeGreaterThan(28);
    expect(c.skewMs).toBeLessThan(38);
  });

  it('moves off→on edges earlier by the measured skew and leaves on→off edges alone', () => {
    const c = new DutyCorrector();
    const edges = edgesOf(manchesterEncode(encodeFrame('Meet at the north gate'), 200), 33);
    const out = edges.map((e) => c.push(e));
    const last = out.length - 1;
    const rise = out[last].level === 1 ? last : last - 1;
    const fall = rise === last ? last - 1 : last;
    expect(edges[rise].t - out[rise].t).toBeCloseTo(c.skewMs, 5);
    expect(out[fall].t).toBe(edges[fall].t);
  });

  it('ignores long idle gaps between messages', () => {
    const c = new DutyCorrector();
    const sig = manchesterEncode(encodeFrame('hello'), 200);
    for (const e of edgesOf(sig, 0)) c.push(e);
    // Torch off for 5 s, then a new message.
    for (const e of edgesOf(sig, 0, 60_000)) c.push(e);
    expect(Math.abs(c.skewMs)).toBeLessThan(6);
  });
});
