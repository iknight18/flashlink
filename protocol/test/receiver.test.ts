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

  it.each([1, 2, 3, 4, 5])('decodes with jitter, noise and dropped frames (seed %i)', (seed) => {
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
  const sweep = (bitMs: number, sim: Omit<SimOptions, 'seed'>) => {
    const failed: number[] = [];
    for (let seed = 1; seed <= 100; seed++) {
      if (messages(transmit(text, bitMs, { ...sim, seed }))[0] !== text) failed.push(seed);
    }
    return failed;
  };

  it('decodes every seed at 200 ms/bit, 30 fps with jitter, noise and dropped frames', () => {
    const failed = sweep(200, { fps: 30, jitterMs: 8, noise: 0.05, dropRate: 0.01 });
    expect(100 - failed.length, `failed seeds: ${failed.join(', ')}`).toBe(100);
  });

  it('decodes every seed at 100 ms/bit, 60 fps with jitter, noise and dropped frames', () => {
    const failed = sweep(100, { fps: 60, jitterMs: 4, noise: 0.03, dropRate: 0.01 });
    expect(100 - failed.length, `failed seeds: ${failed.join(', ')}`).toBe(100);
  });
});
