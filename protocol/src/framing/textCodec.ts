/**
 * 6-bit text codec. Common characters take one 6-bit code; an upper-case letter is
 * SHIFT + its lower-case code; anything else is sent as its UTF-8 bytes, each one
 * ESCAPE + 8 raw bits. The stream is prefix-decodable, so a partly received payload
 * can be shown as it arrives.
 */

const END = 0;
const SHIFT = 1;
const ESCAPE = 2;
const FIRST_CHAR = 3;

/** 61 characters for codes 3–63. */
const ALPHABET = ' abcdefghijklmnopqrstuvwxyz0123456789\n.,!?\'":;-()/@&#%+=*_$<>';

const CODE_OF = new Map<string, number>([...ALPHABET].map((c, i) => [c, FIRST_CHAR + i]));

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true });

class BitWriter {
  private bytes: number[] = [];
  private acc = 0;
  private n = 0;

  write(value: number, bits: number): void {
    for (let i = bits - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((value >> i) & 1);
      if (++this.n === 8) {
        this.bytes.push(this.acc);
        this.acc = 0;
        this.n = 0;
      }
    }
  }

  /** Pads the last byte with END bits (zeros). */
  finish(): Uint8Array {
    if (this.n > 0) this.write(END, 8 - this.n);
    return new Uint8Array(this.bytes);
  }
}

/** Packs text into the 6-bit stream, END-padded to a whole byte. */
export function packText(text: string): Uint8Array {
  const w = new BitWriter();
  for (const ch of text) {
    const code = CODE_OF.get(ch);
    if (code !== undefined) {
      w.write(code, 6);
      continue;
    }
    const lower = ch.toLowerCase();
    if (ch >= 'A' && ch <= 'Z') {
      w.write(SHIFT, 6);
      w.write(CODE_OF.get(lower)!, 6);
      continue;
    }
    for (const byte of encoder.encode(ch)) {
      w.write(ESCAPE, 6);
      w.write(byte, 8);
    }
  }
  return w.finish();
}

/** Number of UTF-8 bytes in a sequence starting with `lead`, or 0 if it can't start one. */
function utf8SequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xc2 && lead < 0xe0) return 2;
  if (lead >= 0xe0 && lead < 0xf0) return 3;
  if (lead >= 0xf0 && lead < 0xf5) return 4;
  return 0;
}

/**
 * Unpacks a 6-bit stream. With `partial`, decodes only what is complete (a trailing
 * SHIFT, escape or incomplete UTF-8 sequence is left out) and never throws; otherwise
 * a malformed or truncated stream throws.
 */
export function unpackText(bytes: Uint8Array, partial = false): string {
  const total = bytes.length * 8;
  let pos = 0;
  const read = (bits: number): number => {
    let v = 0;
    for (let i = 0; i < bits; i++, pos++) v = (v << 1) | ((bytes[pos >> 3] >> (7 - (pos & 7))) & 1);
    return v;
  };
  const fail = (why: string): string => {
    if (partial) return out;
    throw new Error(`Malformed packed text: ${why}`);
  };

  let out = '';
  let pending: number[] = []; // escaped UTF-8 bytes of the character being built
  while (total - pos >= 6) {
    const code = read(6);
    if (code === END) break;
    if (pending.length > 0 && code !== ESCAPE) return fail('incomplete UTF-8 sequence');
    if (code === SHIFT) {
      if (total - pos < 6) return fail('SHIFT at end');
      const next = read(6);
      const ch = ALPHABET[next - FIRST_CHAR];
      if (next < FIRST_CHAR || !(ch >= 'a' && ch <= 'z')) return fail('SHIFT before a non-letter');
      out += ch.toUpperCase();
    } else if (code === ESCAPE) {
      if (total - pos < 8) return fail('ESCAPE at end');
      pending.push(read(8));
      const need = utf8SequenceLength(pending[0]);
      if (need === 0) return fail('invalid UTF-8 lead byte');
      if (pending.length < need) continue;
      try {
        out += strictDecoder.decode(new Uint8Array(pending));
      } catch {
        return fail('invalid UTF-8 sequence');
      }
      pending = [];
    } else {
      out += ALPHABET[code - FIRST_CHAR];
    }
  }
  if (pending.length > 0) return fail('incomplete UTF-8 sequence');
  return out;
}

/** Length of the longest prefix of `bytes` that ends on a whole UTF-8 character. */
export function completeUtf8Length(bytes: Uint8Array): number {
  for (let back = 1; back <= Math.min(4, bytes.length); back++) {
    const b = bytes[bytes.length - back];
    if ((b & 0xc0) === 0x80) continue; // continuation byte: keep looking for the lead byte
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    return need > back ? bytes.length - back : bytes.length;
  }
  return bytes.length;
}

/** Encodes a payload with whichever of the 6-bit codec and plain UTF-8 is smaller. */
export function encodePayload(text: string): { bytes: Uint8Array; compressed: boolean } {
  const plain = encoder.encode(text);
  const packed = packText(text);
  return packed.length < plain.length ? { bytes: packed, compressed: true } : { bytes: plain, compressed: false };
}

/**
 * Decodes a payload made by `encodePayload`. With `partial`, decodes as much of a
 * prefix as forms whole characters and never throws.
 */
export function decodePayload(bytes: Uint8Array, compressed: boolean, partial = false): string {
  if (compressed) return unpackText(bytes, partial);
  if (!partial) return strictDecoder.decode(bytes);
  try {
    return strictDecoder.decode(bytes.subarray(0, completeUtf8Length(bytes)));
  } catch {
    return '';
  }
}
