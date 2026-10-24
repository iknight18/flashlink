import { describe, expect, it } from 'vitest';
import { Receiver, type ReceiverEvent } from '../src/receiver';
import { encodeFrame } from '../src/framing/frame';
import { manchesterEncode, withIdleGap } from '../src/modulation/manchester/encode';
import { pulseEncode } from '../src/modulation/pulse/encode';
import { decodePayload } from '../src/framing/textCodec';
import { simulate, type SimOptions } from '../src/simulator/simulate';

function transmit(text: string, bitMs: number, sim: SimOptions): ReceiverEvent[] {
  const rx = new Receiver();
  const events: ReceiverEvent[] = [];
  for (const s of simulate(manchesterEncode(encodeFrame(text), bitMs), sim)) {
    events.push(...rx.push(s.t, s.level));
  }
  return events;
}

/** Same, with pulse-length modulation at `slotMs`. */
function transmitPulse(text: string, slotMs: number, sim: SimOptions): ReceiverEvent[] {
  const rx = new Receiver();
  return simulate(pulseEncode(encodeFrame(text), slotMs), sim).flatMap((s) => rx.push(s.t, s.level));
}

/** Single-lane chunks assembled to text (each single-lane chunk is a whole message). */
const messages = (evs: ReceiverEvent[]) =>
  evs.flatMap((e) => (e.type === 'chunk' ? [decodePayload(e.bytes, e.header.compressed)] : []));
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

describe('Receiver streaming', () => {
  it('streams the text decoded so far, never showing half of a multi-byte character', () => {
    const text = 'héllo 👋 world';
    const evs = transmit(text, 200, { fps: 30 });
    const partials = evs.flatMap((e) =>
      (e.type === 'progress' ? [decodePayload(e.bytes, e.header.compressed, true)] : []));
    expect(partials[0]).toBe('');
    expect(partials.at(-1)).toBe(text);
    for (let i = 1; i < partials.length; i++) expect(partials[i].startsWith(partials[i - 1])).toBe(true);
    expect(partials.some((p) => p.includes('�'))).toBe(false);
  });
});

describe('Receiver with a looping emitter', () => {
  it('joins halfway through one pass and decodes the next', () => {
    const text = 'Meet at the north gate, 21:40';
    const pass = withIdleGap(manchesterEncode(encodeFrame(text), 200), 4);
    const looped = { halfBitMs: pass.halfBitMs, levels: [...pass.levels, ...pass.levels, ...pass.levels] };
    const passMs = pass.levels.length * pass.halfBitMs;
    const rx = new Receiver();
    const evs = simulate(looped, { fps: 30, jitterMs: 8, noise: 0.03, seed: 4, leadInMs: 1000 })
      .filter((s) => s.t > 1000 + passMs * 0.5) // the receiver starts mid-way through pass 1
      .flatMap((s) => rx.push(s.t, s.level));
    const got = messages(evs);
    expect(got.length).toBeGreaterThanOrEqual(1);
    expect(got.every((m) => m === text)).toBe(true);
  });
});

describe('Receiver keeps listening', () => {
  it('goes straight back to searching after a lost frame and decodes the next one', () => {
    const cut = manchesterEncode(encodeFrame('this one gets cut off'), 200);
    cut.levels = cut.levels.slice(0, Math.floor(cut.levels.length * 0.5));
    const next = manchesterEncode(encodeFrame('but this one arrives'), 200);
    const signal = { halfBitMs: 100, levels: [...cut.levels, ...new Array(30).fill(0), ...next.levels] };
    const rx = new Receiver();
    const evs = simulate(signal, { fps: 30 }).flatMap((s) => rx.push(s.t, s.level));
    const lost = evs.findIndex((e) => e.type === 'error');
    expect(evs[lost]).toEqual({ type: 'error', reason: 'lost' });
    expect(evs[lost + 1]).toEqual({ type: 'state', state: 'HUNTING' });
    expect(messages(evs)).toEqual(['but this one arrives']);
  });

  it('goes straight back to searching after a checksum failure', () => {
    const bits = encodeFrame('Hello');
    const i = 16 + 16 + 8 + 7; // sync + header + length → last bit of the first payload byte
    bits[i] = bits[i] === 1 ? 0 : 1;
    const rx = new Receiver();
    const evs = simulate(manchesterEncode(bits, 200), { fps: 30 }).flatMap((s) => rx.push(s.t, s.level));
    const err = evs.findIndex((e) => e.type === 'error');
    expect(evs[err]).toMatchObject({ type: 'error', reason: 'crc' });
    expect(evs[err + 1]).toEqual({ type: 'state', state: 'HUNTING' });
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
    bits[32] = bits[32] === 1 ? 0 : 1; // sync 16 + header 16 → MSB of the length byte
    const rx = new Receiver();
    const evs = simulate(manchesterEncode(bits, 200), { fps: 30 }).flatMap((s) => rx.push(s.t, s.level));
    expect(evs).toContainEqual({ type: 'error', reason: 'lost' });
    expect(messages(evs)).toEqual([]);
  });
});

describe('Receiver events (v2)', () => {
  it('reports chunks with their lane header and coding', () => {
    const evs = transmit('Hello', 200, { fps: 30 });
    const chunk = evs.find((e) => e.type === 'chunk');
    expect(chunk).toMatchObject({ type: 'chunk', coding: 'manchester', header: { msgId: 0, lane: 0, lanes: 1 } });
    expect(transmitPulse('Hello', 100, { fps: 30 }).find((e) => e.type === 'chunk'))
      .toMatchObject({ type: 'chunk', coding: 'pulse' });
  });

  it('reports progress with the header, bytes so far and the length', () => {
    const evs = transmitPulse('Hello there', 100, { fps: 30 });
    const progress = evs.flatMap((e) => (e.type === 'progress' ? [e] : []));
    expect(progress[0]).toMatchObject({ received: 0, bytes: new Uint8Array() });
    expect(progress.map((p) => p.received)).toEqual(progress.map((_, i) => i));
    expect(progress.every((p) => p.bytes.length === p.received && p.length === progress.at(-1)!.received)).toBe(true);
  });
});

describe('Receiver with pulse-length coding', () => {
  it('decodes an ideal 30 fps signal at 100 ms slots', () => {
    const evs = transmitPulse('Hello', 100, { fps: 30 });
    expect(messages(evs)).toEqual(['Hello']);
    expect(states(evs)).toEqual(['LOCKED', 'READING', 'DONE']);
  });

  it('decodes ≥93% of seeds 1..300 at 100 ms slots, 30 fps with jitter, noise and dropped frames', () => {
    const text = 'Hello, FlashLink! 👋';
    const failed: number[] = [];
    const wrong: string[] = [];
    for (let seed = 1; seed <= 300; seed++) {
      const got = messages(transmitPulse(text, 100, { fps: 30, jitterMs: 8, noise: 0.03, dropRate: 0.01, seed }));
      wrong.push(...got.filter((m) => m !== text).map((m) => `seed ${seed}: ${JSON.stringify(m)}`));
      if (got[0] !== text) failed.push(seed);
    }
    expect(wrong, 'wrong texts emitted').toEqual([]);
    expect((300 - failed.length) / 300, `failed seeds: ${failed.join(', ')}`).toBeGreaterThanOrEqual(0.93);
  });

  it.each([25, 33, 45])('decodes ≥90% at 100 ms slots and 30 fps with a %i ms turn-on delay', (onDelayMs) => {
    const text = 'Meet at the north gate, 21:40';
    const failed: number[] = [];
    for (let seed = 1; seed <= 200; seed++) {
      const got = messages(transmitPulse(text, 100, {
        fps: 30, jitterMs: 8, noise: 0.02, seed, onDelayMs, low: 0.04, high: 0.8,
      }));
      expect(got.every((m) => m === text)).toBe(true);
      if (!got.includes(text)) failed.push(seed);
    }
    expect(200 - failed.length, `failed seeds: ${failed.join(',')}`).toBeGreaterThanOrEqual(180);
  });

  it('decodes a Manchester frame followed by a pulse-length frame', () => {
    const a = manchesterEncode(encodeFrame('manchester first'), 200);
    const b = pulseEncode(encodeFrame('then pulses'), 100);
    const idle = new Array<0>(10).fill(0);
    const sig = { halfBitMs: 100, levels: [...a.levels, ...idle, ...b.levels] };
    const rx = new Receiver();
    const evs = simulate(sig, { fps: 30, jitterMs: 8, noise: 0.03, seed: 2 }).flatMap((s) => rx.push(s.t, s.level));
    expect(messages(evs)).toEqual(['manchester first', 'then pulses']);
    expect(evs.flatMap((e) => (e.type === 'chunk' ? [e.coding] : []))).toEqual(['manchester', 'pulse']);
  });

  it('decodes a pulse-length frame followed by a Manchester frame', () => {
    const a = pulseEncode(encodeFrame('pulses first'), 100);
    const b = manchesterEncode(encodeFrame('then manchester'), 200);
    const idle = new Array<0>(10).fill(0);
    const sig = { halfBitMs: 100, levels: [...a.levels, ...idle, ...b.levels] };
    const rx = new Receiver();
    const evs = simulate(sig, { fps: 30, jitterMs: 8, noise: 0.03, seed: 2 }).flatMap((s) => rx.push(s.t, s.level));
    expect(messages(evs)).toEqual(['pulses first', 'then manchester']);
  });

  it('reports lost signal when the light stops mid-frame', () => {
    const sig = pulseEncode(encodeFrame('this gets cut off'), 100);
    sig.levels = sig.levels.slice(0, Math.floor(sig.levels.length * 0.6));
    const rx = new Receiver();
    const evs = simulate(sig, { fps: 30 }).flatMap((s) => rx.push(s.t, s.level));
    expect(evs).toContainEqual({ type: 'error', reason: 'lost' });
    expect(messages(evs)).toEqual([]);
  });
});
