import { describe, expect, it } from 'vitest';
import { ManchesterDecoder } from '../src/modulation/manchester/decode';
import { manchesterEncode, type TimedLevels } from '../src/modulation/manchester/encode';
import { encodeFrame } from '../src/framing/frame';
import type { Bit } from '../src/framing/bits';
import type { Edge } from '../src/signal/edgeDetector';

/** Ideal edges for a signal, starting from an idle-low line. */
function edgesOf(sig: TimedLevels, t0 = 1000): Edge[] {
  const edges: Edge[] = [];
  let level = 0;
  sig.levels.forEach((l, i) => {
    if (l !== level) edges.push({ t: t0 + i * sig.halfBitMs, level: l });
    level = l;
  });
  return edges;
}

describe('ManchesterDecoder', () => {
  it('locks on the preamble and decodes the remaining bits exactly', () => {
    const bits = encodeFrame('Hi!');
    const dec = new ManchesterDecoder();
    const out: Bit[] = [];
    for (const e of edgesOf(manchesterEncode(bits, 200))) out.push(...dec.pushEdge(e));
    expect(dec.state).toBe('LOCKED');
    expect(out.length).toBeGreaterThan(bits.length - 16);
    expect(out).toEqual(bits.slice(bits.length - out.length));
  });

  it('drops back to HUNTING on an impossible interval', () => {
    const dec = new ManchesterDecoder();
    const edges = edgesOf(manchesterEncode(encodeFrame('x'), 200));
    for (const e of edges.slice(0, 12)) dec.pushEdge(e);
    expect(dec.state).toBe('LOCKED');
    const last = edges[11];
    dec.pushEdge({ t: last.t + 1000, level: last.level === 1 ? 0 : 1 });
    expect(dec.state).toBe('HUNTING');
  });

  it('times out after 3 bit periods without an edge', () => {
    const dec = new ManchesterDecoder();
    const edges = edgesOf(manchesterEncode(encodeFrame('x'), 200));
    for (const e of edges.slice(0, 12)) dec.pushEdge(e);
    const lastT = edges[11].t;
    expect(dec.checkTimeout(lastT + 500)).toBe(false);
    expect(dec.checkTimeout(lastT + 700)).toBe(true);
    expect(dec.state).toBe('HUNTING');
  });
});
