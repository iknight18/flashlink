import { describe, expect, it } from 'vitest';
import {
  encodeFrame, FrameDecoder, MAX_PAYLOAD, PREAMBLE_BITS, type FrameEvent,
} from '../src/framing/frame';
import type { Bit } from '../src/framing/bits';

function decodeAll(bits: Bit[]): FrameEvent[] {
  const dec = new FrameDecoder();
  return bits.map((b) => dec.push(b)).filter((e): e is FrameEvent => e !== null);
}

describe('encodeFrame', () => {
  it('starts with an alternating preamble then the sync byte', () => {
    const bits = encodeFrame('A');
    expect(bits.slice(0, PREAMBLE_BITS)).toEqual([1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0]);
    expect(bits.slice(PREAMBLE_BITS, PREAMBLE_BITS + 8)).toEqual([1, 1, 0, 1, 0, 1, 0, 1]);
  });
  it('has preamble + (sync + length + payload + crc) bytes', () => {
    expect(encodeFrame('Hi')).toHaveLength(PREAMBLE_BITS + 8 * (3 + 2));
  });
  it('rejects payloads over MAX_PAYLOAD bytes', () => {
    expect(() => encodeFrame('x'.repeat(MAX_PAYLOAD + 1))).toThrow(RangeError);
  });
});

describe('FrameDecoder', () => {
  it('round-trips ASCII', () => {
    expect(decodeAll(encodeFrame('Hello')).at(-1)).toEqual({ type: 'done', text: 'Hello' });
  });
  it('round-trips multi-byte UTF-8', () => {
    expect(decodeAll(encodeFrame('héllo 👋')).at(-1)).toEqual({ type: 'done', text: 'héllo 👋' });
  });
  it('round-trips an empty message', () => {
    expect(decodeAll(encodeFrame('')).at(-1)).toEqual({ type: 'done', text: '' });
  });
  it('reports header and per-byte progress', () => {
    const events = decodeAll(encodeFrame('ab'));
    expect(events.slice(0, 3)).toEqual([
      { type: 'header', length: 2 },
      { type: 'progress', received: 1, length: 2 },
      { type: 'progress', received: 2, length: 2 },
    ]);
  });
  it('ignores leading garbage before the sync byte', () => {
    const garbage: Bit[] = [0, 0, 1, 1, 0, 0, 1];
    expect(decodeAll([...garbage, ...encodeFrame('ok')]).at(-1)).toEqual({ type: 'done', text: 'ok' });
  });
  it('syncs when only the last 4 preamble bits arrive (demodulator locks mid-preamble)', () => {
    expect(decodeAll(encodeFrame('ok').slice(PREAMBLE_BITS - 4)).at(-1)).toEqual({ type: 'done', text: 'ok' });
  });
  it('flags a CRC mismatch with a best guess', () => {
    const bits = encodeFrame('Hello');
    const i = PREAMBLE_BITS + 16 + 7; // last bit of first payload byte
    bits[i] = bits[i] === 1 ? 0 : 1;
    const last = decodeAll(bits).at(-1);
    expect(last).toMatchObject({ type: 'error', reason: 'crc' });
    expect(last && 'bestGuess' in last && last.bestGuess).toBe('Iello');
  });
  it('can decode a second frame after the first', () => {
    const events = decodeAll([...encodeFrame('one'), ...encodeFrame('two')]);
    expect(events.filter((e) => e.type === 'done')).toEqual([
      { type: 'done', text: 'one' },
      { type: 'done', text: 'two' },
    ]);
  });
});
