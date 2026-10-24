import { describe, expect, it } from 'vitest';
import {
  encodeFrame, encodeLaneFrame, FrameDecoder, MAX_CHUNK, SYNC_BITS, SYNC_WORD,
  type FrameEvent, type LaneHeader,
} from '../src/framing/frame';
import { bytesToBits, type Bit } from '../src/framing/bits';
import { decodePayload, encodePayload } from '../src/framing/textCodec';
import { mulberry32 } from '../src/simulator/simulate';

function decodeAll(bits: Bit[]): FrameEvent[] {
  const dec = new FrameDecoder();
  return bits.map((b) => dec.push(b)).filter((e): e is FrameEvent => e !== null);
}

/** Text of the last `done` event. */
function doneText(events: FrameEvent[]): string | undefined {
  const done = events.filter((e) => e.type === 'done').at(-1);
  return done && done.type === 'done' ? decodePayload(done.bytes, done.header.compressed) : undefined;
}

const header: LaneHeader = { msgId: 9, lane: 2, lanes: 5, compressed: true };

describe('encodeLaneFrame', () => {
  it('starts with the 16-bit sync word, no preamble', () => {
    const bits = encodeLaneFrame(header, new Uint8Array([1, 2]));
    expect(bits.slice(0, SYNC_BITS)).toEqual(bytesToBits(new Uint8Array([SYNC_WORD >> 8, SYNC_WORD & 0xff])));
  });
  it('packs msgId|lane, lanes|flags and length after the sync word', () => {
    const bits = encodeLaneFrame(header, new Uint8Array([1, 2]));
    expect(bits.slice(16, 40)).toEqual(bytesToBits(new Uint8Array([0x92, 0x51, 2])));
  });
  it('has sync + header + length + chunk + crc', () => {
    expect(encodeLaneFrame(header, new Uint8Array(7))).toHaveLength(16 + 8 * (2 + 1 + 7 + 1));
  });
  it('rejects chunks over MAX_CHUNK bytes and out-of-range header fields', () => {
    expect(() => encodeLaneFrame(header, new Uint8Array(MAX_CHUNK + 1))).toThrow(RangeError);
    expect(() => encodeLaneFrame({ ...header, msgId: 16 }, new Uint8Array())).toThrow(RangeError);
    expect(() => encodeLaneFrame({ ...header, lanes: 0, lane: 0 }, new Uint8Array())).toThrow(RangeError);
    expect(() => encodeLaneFrame({ ...header, lanes: 16 }, new Uint8Array())).toThrow(RangeError);
    expect(() => encodeLaneFrame({ ...header, lane: 5 }, new Uint8Array())).toThrow(RangeError);
  });
});

describe('encodeFrame (single lane)', () => {
  it('is lane 0 of 1 with the given msgId and the smaller payload encoding', () => {
    const text = 'Meet at the north gate, 21:40';
    const { bytes, compressed } = encodePayload(text);
    expect(encodeFrame(text, 3)).toEqual(encodeLaneFrame({ msgId: 3, lane: 0, lanes: 1, compressed }, bytes));
  });
  it('defaults msgId to 0', () => {
    const done = decodeAll(encodeFrame('hi')).at(-1);
    expect(done).toMatchObject({ type: 'done', header: { msgId: 0, lane: 0, lanes: 1 } });
  });
  it('rejects payloads over MAX_CHUNK bytes', () => {
    expect(() => encodeFrame('世'.repeat(100))).toThrow(RangeError);
  });
});

describe('FrameDecoder', () => {
  it.each(['Hello', 'héllo 👋', '', 'Meet at the north gate, 21:40'])('round-trips %j', (text) => {
    expect(doneText(decodeAll(encodeFrame(text)))).toBe(text);
  });

  it('decodes every header field and the raw chunk', () => {
    const chunk = new Uint8Array([0, 255, 17, 42]);
    for (const h of [header, { msgId: 0, lane: 0, lanes: 1, compressed: false }, { msgId: 15, lane: 14, lanes: 15, compressed: false }]) {
      expect(decodeAll(encodeLaneFrame(h, chunk)).at(-1)).toEqual({ type: 'done', header: h, bytes: chunk });
    }
  });

  it('reports the header, then per-byte progress with the bytes so far', () => {
    const events = decodeAll(encodeLaneFrame(header, new Uint8Array([7, 8])));
    expect(events).toEqual([
      { type: 'header', header, length: 2 },
      { type: 'progress', header, bytes: new Uint8Array([7]), length: 2 },
      { type: 'progress', header, bytes: new Uint8Array([7, 8]), length: 2 },
      { type: 'done', header, bytes: new Uint8Array([7, 8]) },
    ]);
  });

  it('handles a zero-length chunk', () => {
    expect(decodeAll(encodeLaneFrame(header, new Uint8Array()))).toEqual([
      { type: 'header', header, length: 0 },
      { type: 'done', header, bytes: new Uint8Array() },
    ]);
  });

  it('flags a corrupted bit anywhere after the sync word as a CRC error', () => {
    const clean = encodeLaneFrame(header, new Uint8Array([1, 2, 3]));
    for (let i = SYNC_BITS; i < clean.length; i++) {
      const bits = [...clean];
      bits[i] = bits[i] === 1 ? 0 : 1;
      const last = decodeAll(bits).at(-1);
      // A flipped length can leave the decoder waiting for more bytes; it must never pass.
      expect(last?.type, `bit ${i}`).not.toBe('done');
      if (i >= SYNC_BITS + 24) expect(last, `bit ${i}`).toEqual({ type: 'error', reason: 'crc' });
    }
  });

  it('ignores garbage before the sync word', () => {
    const garbage: Bit[] = [0, 0, 1, 1, 0, 0, 1, 1, 0, 1, 1, 0, 1, 1, 0, 0, 1, 1, 0];
    expect(doneText(decodeAll([...garbage, ...encodeFrame('ok')]))).toBe('ok');
  });

  it('syncs after either modulator preamble', () => {
    const alt = Array.from({ length: 16 }, (_, i): Bit => (i % 2 === 0 ? 1 : 0));
    const zeros = new Array<Bit>(16).fill(0);
    expect(doneText(decodeAll([...alt, ...encodeFrame('ok')]))).toBe('ok');
    expect(doneText(decodeAll([...zeros, ...encodeFrame('ok')]))).toBe('ok');
  });

  it('decodes two frames in a row', () => {
    const events = decodeAll([...encodeFrame('one', 1), ...encodeFrame('two', 2)]);
    const done = events.filter((e) => e.type === 'done');
    expect(done.map((e) => e.type === 'done' && e.header.msgId)).toEqual([1, 2]);
    expect(done.map((e) => e.type === 'done' && decodePayload(e.bytes, e.header.compressed))).toEqual(['one', 'two']);
  });

  it('false-syncs at most once in a random 1000-bit stream', () => {
    let total = 0;
    for (let seed = 1; seed <= 50; seed++) {
      const rand = mulberry32(seed);
      const bits = Array.from({ length: 1000 }, (): Bit => (rand() < 0.5 ? 0 : 1));
      const headers = decodeAll(bits).filter((e) => e.type === 'header').length;
      expect(headers, `seed ${seed}`).toBeLessThanOrEqual(1);
      total += headers;
    }
    expect(total).toBeLessThanOrEqual(5);
  });

  it('exposes whether a frame is being read', () => {
    const dec = new FrameDecoder();
    const bits = encodeFrame('ok');
    bits.slice(0, SYNC_BITS - 1).forEach((b) => dec.push(b));
    expect(dec.reading).toBe(false);
    dec.push(bits[SYNC_BITS - 1]);
    expect(dec.reading).toBe(true);
    dec.reset();
    expect(dec.reading).toBe(false);
  });
});
