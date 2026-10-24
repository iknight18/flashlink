import { describe, expect, it } from 'vitest';
import { PULSE_PREAMBLE_RUNS, pulseEncode } from '../src/modulation/pulse/encode';
import { PulseDecoder } from '../src/modulation/pulse/decode';
import type { TimedLevels } from '../src/modulation/manchester/encode';
import { encodeFrame } from '../src/framing/frame';
import type { Bit } from '../src/framing/bits';
import type { Edge } from '../src/signal/edgeDetector';

/** Run lengths (in slots) of a level sequence, with each run's level. */
function runs(levels: number[]): { level: number; slots: number }[] {
  const out: { level: number; slots: number }[] = [];
  for (const l of levels) {
    if (out.length && out.at(-1)!.level === l) out.at(-1)!.slots++;
    else out.push({ level: l, slots: 1 });
  }
  return out;
}

/** Ideal edges of a signal starting from dark, every off→on edge delayed by `onDelayMs`. */
function edgesOf(sig: TimedLevels, onDelayMs = 0, t0 = 1000): Edge[] {
  const edges: Edge[] = [];
  let level = 0;
  sig.levels.forEach((l, i) => {
    if (l !== level) edges.push({ t: t0 + i * sig.halfBitMs + (l === 1 ? onDelayMs : 0), level: l });
    level = l;
  });
  if (level === 1) edges.push({ t: t0 + sig.levels.length * sig.halfBitMs, level: 0 });
  return edges;
}

function decode(dec: PulseDecoder, edges: Edge[]): Bit[] {
  return edges.flatMap((e) => dec.pushEdge(e));
}

/** The decoded bits are some preamble zeros, the frame, then at most one terminator run. */
function expectFrameInside(out: Bit[], bits: Bit[]): void {
  const k = out.length - bits.length - (out.length - bits.length) % 2;
  const starts = [k, k - 2].filter((s) => s >= 0);
  const ok = starts.some((s) =>
    out.slice(0, s).every((b) => b === 0) &&
    out.slice(s, s + bits.length).join('') === bits.join('') &&
    out.slice(s + bits.length).every((b) => b === 0));
  expect(ok, `decoded ${out.join('')}`).toBe(true);
}

describe('pulseEncode', () => {
  it('starts with 16 alternating 1-slot runs, on first', () => {
    const sig = pulseEncode([], 100);
    expect(sig.halfBitMs).toBe(100);
    expect(sig.levels.slice(0, PULSE_PREAMBLE_RUNS)).toEqual([1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0]);
  });

  it('carries 2 bits per run as 1 + value slots, alternating level', () => {
    const sig = pulseEncode([0, 0, 0, 1, 1, 0, 1, 1], 100);
    const data = runs(sig.levels.slice(PULSE_PREAMBLE_RUNS));
    expect(data.slice(0, 4)).toEqual([
      { level: 1, slots: 1 }, { level: 0, slots: 2 }, { level: 1, slots: 3 }, { level: 0, slots: 4 },
    ]);
  });

  it('ends an off data run with a 1-slot on terminator, then dark', () => {
    const data = pulseEncode([0, 0, 0, 1], 100).levels.slice(PULSE_PREAMBLE_RUNS);
    expect(data).toEqual([1, 0, 0, 1, 0]);
  });

  it('ends an on data run with a dark terminator', () => {
    const data = pulseEncode([1, 1], 100).levels.slice(PULSE_PREAMBLE_RUNS);
    expect(data).toEqual([1, 1, 1, 1, 0]);
  });

  it('pads an odd bit count with a 0 bit', () => {
    const data = pulseEncode([1], 100).levels.slice(PULSE_PREAMBLE_RUNS);
    expect(data).toEqual([1, 1, 1, 0]); // 10 → 3 slots
  });
});

describe('PulseDecoder', () => {
  it('locks on the preamble and recovers the frame bits from ideal edges', () => {
    const bits = encodeFrame('Hi there!');
    const dec = new PulseDecoder();
    const out = decode(dec, edgesOf(pulseEncode(bits, 100)));
    expect(dec.bitMs).toBeCloseTo(100, 5);
    expectFrameInside(out, bits);
  });

  it.each([1, 2, 3])('decodes an odd-length tail padded to %i bits', (n) => {
    const bits = [...encodeFrame('x'), ...new Array<Bit>(n).fill(1)];
    const out = decode(new PulseDecoder(), edgesOf(pulseEncode(bits, 100)));
    expectFrameInside(out, n % 2 ? [...bits, 0] : bits);
  });

  it('measures and corrects a 33 ms turn-on delay', () => {
    const bits = encodeFrame('Meet at the north gate, 21:40');
    const dec = new PulseDecoder();
    const edges = edgesOf(pulseEncode(bits, 100), 33);
    const out = decode(dec, edges);
    expect(dec.skewMs).toBeCloseTo(33, 5);
    expectFrameInside(out, bits);
  });

  it('holds the preamble skew during data', () => {
    const dec = new PulseDecoder();
    const edges = edgesOf(pulseEncode(encodeFrame('hold it'), 100), 25);
    decode(dec, edges.slice(0, 17));
    const skew = dec.skewMs;
    decode(dec, edges.slice(17, -2));
    expect(dec.state).toBe('LOCKED');
    expect(dec.skewMs).toBe(skew);
  });

  it('needs 8 consistent runs to lock', () => {
    const dec = new PulseDecoder();
    const edges = edgesOf(pulseEncode([], 100));
    decode(dec, edges.slice(0, 8));
    expect(dec.state).toBe('HUNTING');
    dec.pushEdge(edges[8]);
    expect(dec.state).toBe('LOCKED');
  });

  it('resets on an impossible run', () => {
    const dec = new PulseDecoder();
    const edges = edgesOf(pulseEncode(encodeFrame('x'), 100));
    decode(dec, edges.slice(0, 12));
    expect(dec.state).toBe('LOCKED');
    const last = edges[11];
    dec.pushEdge({ t: last.t + 500, level: last.level === 1 ? 0 : 1 });
    expect(dec.state).toBe('HUNTING');
  });

  it('resets on a run shorter than half a slot', () => {
    const dec = new PulseDecoder();
    const edges = edgesOf(pulseEncode(encodeFrame('x'), 100));
    decode(dec, edges.slice(0, 12));
    const last = edges[11];
    dec.pushEdge({ t: last.t + 40, level: last.level === 1 ? 0 : 1 });
    expect(dec.state).toBe('HUNTING');
  });

  it('times out after 5 slots without an edge', () => {
    const dec = new PulseDecoder();
    const edges = edgesOf(pulseEncode(encodeFrame('x'), 100));
    decode(dec, edges.slice(0, 12));
    const lastT = edges[11].t;
    expect(dec.checkTimeout(lastT + 450)).toBe(false);
    expect(dec.checkTimeout(lastT + 550)).toBe(true);
    expect(dec.state).toBe('HUNTING');
    expect(dec.checkTimeout(lastT + 900)).toBe(false);
  });

  it('decodes a second frame after reset', () => {
    const dec = new PulseDecoder();
    decode(dec, edgesOf(pulseEncode(encodeFrame('one'), 100)));
    dec.reset();
    const bits = encodeFrame('two');
    expectFrameInside(decode(dec, edgesOf(pulseEncode(bits, 100), 0, 60_000)), bits);
  });
});
