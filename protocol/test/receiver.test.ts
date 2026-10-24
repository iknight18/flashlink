import { describe, expect, it } from 'vitest';
import { Receiver, type ReceiverEvent } from '../src/receiver';
import { encodeFrame } from '../src/framing/frame';
import { manchesterEncode } from '../src/modulation/manchester/encode';
import { simulate, type SimOptions } from '../src/simulator/simulate';

function transmit(text: string, bitMs: number, sim: SimOptions): ReceiverEvent[] {
  const rx = new Receiver();
  const events: ReceiverEvent[] = [];
  for (const s of simulate(manchesterEncode(encodeFrame(text), bitMs), sim)) {
    events.push(...rx.push(s.t, s.level));
  }
  return events;
}

const messages = (evs: ReceiverEvent[]) =>
  evs.flatMap((e) => (e.type === 'message' ? [e.text] : []));
const states = (evs: ReceiverEvent[]) =>
  evs.flatMap((e) => (e.type === 'state' ? [e.state] : []));

describe('Receiver end-to-end (simulated camera)', () => {
  it('decodes an ideal 30 fps signal at 200 ms/bit', () => {
    const evs = transmit('Hello', 200, { fps: 30 });
    expect(messages(evs)).toEqual(['Hello']);
    expect(states(evs)).toEqual(['LOCKED', 'READING', 'DONE']);
  });

  it.each([1, 2, 3, 4, 5])('decodes with jitter, noise and dropped frames (known-good seed %i, smoke test)', (seed) => {
    const evs = transmit('Hello, FlashLink! 👋', 200, {
      fps: 30, jitterMs: 8, noise: 0.05, dropRate: 0.01, seed,
    });
    expect(messages(evs)).toEqual(['Hello, FlashLink! 👋']);
  });

  it('decodes a long message at 100 ms/bit and 60 fps', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(2).trim();
    expect(messages(transmit(text, 100, { fps: 60, jitterMs: 4, noise: 0.03, seed: 7 }))).toEqual([text]);
  });

  it('decodes at 400 ms/bit with heavier jitter', () => {
    expect(messages(transmit('slow & steady', 400, { fps: 30, jitterMs: 20, noise: 0.05, seed: 3 })))
      .toEqual(['slow & steady']);
  });

  it('reports lost signal when the light stops mid-frame', () => {
    const sig = manchesterEncode(encodeFrame('this gets cut off'), 200);
    sig.levels = sig.levels.slice(0, Math.floor(sig.levels.length * 0.6));
    const rx = new Receiver();
    const evs = simulate(sig, { fps: 30 }).flatMap((s) => rx.push(s.t, s.level));
    expect(evs).toContainEqual({ type: 'error', reason: 'lost' });
    expect(messages(evs)).toEqual([]);
  });

  it('emits edge intervals for the calibration histogram', () => {
    const evs = transmit('x', 200, { fps: 30 });
    expect(evs.some((e) => e.type === 'interval')).toBe(true);
  });
});

describe('Receiver robustness sweeps', () => {
  const text = 'Hello, FlashLink! 👋';
  const SEEDS = 500;
  const sweep = (bitMs: number, sim: Omit<SimOptions, 'seed'>) => {
    const failed: number[] = [];
    const wrong: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const got = messages(transmit(text, bitMs, { ...sim, seed }));
      wrong.push(...got.filter((m) => m !== text).map((m) => `seed ${seed}: ${JSON.stringify(m)}`));
      if (got[0] !== text) failed.push(seed);
    }
    return { rate: (SEEDS - failed.length) / SEEDS, failed, wrong };
  };

  it('decodes ≥93% of seeds at 200 ms/bit, 30 fps with jitter, noise and dropped frames', () => {
    const { rate, failed, wrong } = sweep(200, { fps: 30, jitterMs: 8, noise: 0.05, dropRate: 0.01 });
    expect(wrong, 'wrong texts emitted').toEqual([]);
    expect(rate, `failed seeds: ${failed.join(', ')}`).toBeGreaterThanOrEqual(0.93);
  });

  it('decodes ≥94% of seeds at 100 ms/bit, 60 fps with jitter, noise and dropped frames', () => {
    const { rate, failed, wrong } = sweep(100, { fps: 60, jitterMs: 4, noise: 0.03, dropRate: 0.01 });
    expect(wrong, 'wrong texts emitted').toEqual([]);
    expect(rate, `failed seeds: ${failed.join(', ')}`).toBeGreaterThanOrEqual(0.94);
  });
});

describe('Receiver with a slow-switching torch (device test, 2026-10-24)', () => {
  // On the iPhone the torch turned on ~25-45 ms later than it turned off; at 200 ms/bit
  // that alone dropped decoding to ~50%. The receiver must calibrate it away.
  it.each([25, 33, 45])('decodes 200 ms/bit at 30 fps with a %i ms turn-on delay', (onDelayMs) => {
    const text = 'Meet at the north gate, 21:40';
    const failed: number[] = [];
    for (let seed = 1; seed <= 200; seed++) {
      const rx = new Receiver();
      const evs = simulate(manchesterEncode(encodeFrame(text), 200), {
        fps: 30, jitterMs: 10, noise: 0.02, seed, onDelayMs, low: 0.04, high: 0.8,
      }).flatMap((s) => rx.push(s.t, s.level));
      const got = messages(evs);
      expect(got.every((m) => m === text)).toBe(true);
      if (!got.includes(text)) failed.push(seed);
    }
    expect(200 - failed.length, `failed seeds: ${failed.join(',')}`).toBeGreaterThanOrEqual(190);
  });
});

describe('Receiver regressions', () => {
  it('decodes two consecutive frames through one receiver', () => {
    const a = manchesterEncode(encodeFrame('first'), 200);
    const b = manchesterEncode(encodeFrame('second'), 200);
    const idle = Array.from({ length: 10 }, () => 0 as const);
    const sig = { halfBitMs: a.halfBitMs, levels: [...a.levels, ...idle, ...b.levels] };
    const rx = new Receiver();
    const evs = simulate(sig, { fps: 30 }).flatMap((s) => rx.push(s.t, s.level));
    expect(messages(evs)).toEqual(['first', 'second']);
    expect(states(evs)).toEqual(['LOCKED', 'READING', 'DONE', 'LOCKED', 'READING', 'DONE']);
  });

  it('reports lost signal (not stuck) when the length byte MSB is corrupted', () => {
    const bits = encodeFrame('short');
    bits[24] = bits[24] === 1 ? 0 : 1; // preamble 16 + sync 8 → MSB of the length byte
    const rx = new Receiver();
    const evs = simulate(manchesterEncode(bits, 200), { fps: 30 }).flatMap((s) => rx.push(s.t, s.level));
    expect(evs).toContainEqual({ type: 'error', reason: 'lost' });
    expect(messages(evs)).toEqual([]);
  });
});
