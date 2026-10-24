import { describe, expect, it } from 'vitest';
import { decodePayload, encodePayload, packText, unpackText } from '../src/framing/textCodec';
import { mulberry32 } from '../src/simulator/simulate';

const utf8 = (s: string) => new TextEncoder().encode(s);

const printableAscii = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('');

const samples = [
  '',
  'Meet at the north gate, 21:40',
  'MiXeD CaSe',
  'héllo 👋 世界',
  printableAscii,
  'line one\nline two\r\n\tindented\n',
];

describe('packText / unpackText', () => {
  it.each(samples)('round-trips %j', (text) => {
    expect(unpackText(packText(text))).toBe(text);
  });

  it('round-trips random Unicode', () => {
    const rand = mulberry32(42);
    for (let n = 0; n < 200; n++) {
      const cps = Array.from({ length: Math.floor(rand() * 20) }, () => {
        const r = rand();
        if (r < 0.6) return 32 + Math.floor(rand() * 95);
        if (r < 0.8) return 0xa0 + Math.floor(rand() * 0x700);
        if (r < 0.9) return 0x4e00 + Math.floor(rand() * 0x5000);
        return 0x1f300 + Math.floor(rand() * 0x300);
      });
      const text = String.fromCodePoint(...cps);
      expect(unpackText(packText(text))).toBe(text);
    }
  });

  it('shrinks an English sentence by at least 20% compared to UTF-8', () => {
    const text = 'Meet me at the north gate at 21:40, and bring the blue umbrella.';
    expect(packText(text).length).toBeLessThanOrEqual(utf8(text).length * 0.8);
  });

  it('decodes any byte prefix to a prefix of the text, never a broken character', () => {
    for (const text of samples) {
      const packed = packText(text);
      for (let n = 0; n <= packed.length; n++) {
        const got = unpackText(packed.slice(0, n), true);
        expect(text.startsWith(got), `${JSON.stringify(text)} prefix ${n}: ${JSON.stringify(got)}`).toBe(true);
        expect(got).not.toMatch(/[\uD800-\uDBFF]$/); // no lone high surrogate
        expect(got).not.toContain('�');
      }
      expect(unpackText(packed, true)).toBe(text);
    }
  });

  it('throws on a truncated stream unless partial', () => {
    const packed = packText('héllo');
    expect(() => unpackText(packed.slice(0, 2))).toThrow();
    expect(() => unpackText(packed.slice(0, 2), true)).not.toThrow();
  });
});

describe('encodePayload / decodePayload', () => {
  it.each(samples)('round-trips %j and never exceeds UTF-8', (text) => {
    const { bytes, compressed } = encodePayload(text);
    expect(bytes.length).toBeLessThanOrEqual(utf8(text).length);
    expect(decodePayload(bytes, compressed)).toBe(text);
  });

  it('compresses plain English', () => {
    expect(encodePayload('Meet at the north gate, 21:40').compressed).toBe(true);
  });

  it('keeps UTF-8 when packing would be larger', () => {
    expect(encodePayload('世界世界').compressed).toBe(false);
  });

  it('partially decodes an uncompressed prefix without breaking characters', () => {
    const text = 'héllo 👋 世界';
    const bytes = utf8(text);
    for (let n = 0; n <= bytes.length; n++) {
      const got = decodePayload(bytes.slice(0, n), false, true);
      expect(text.startsWith(got)).toBe(true);
      expect(got).not.toContain('�');
    }
  });
});
