import { type Bit, bytesToBits } from './bits';
import { crc8 } from './crc8';

export const PREAMBLE_BITS = 16;
export const SYNC_BYTE = 0xd5;
export const MAX_PAYLOAD = 255;

/** Bits of preamble tail the decoder must see right before the sync byte. */
const SYNC_TAIL_BITS = 4;
/**
 * Lock pattern: the last SYNC_TAIL_BITS preamble bits (1010) then the sync byte, i.e. 0xAD5.
 * The bare sync byte alone false-locks whenever a 1 precedes the preamble (1 + 1010101 = 0xD5).
 * Kept short because the demodulator only delivers the preamble bits left after clock lock.
 */
const SYNC_WINDOW_BITS = SYNC_TAIL_BITS + 8;
const SYNC_MASK = (1 << SYNC_WINDOW_BITS) - 1;
const SYNC_PATTERN = (0b1010 << 8) | SYNC_BYTE;

const encoder = new TextEncoder();

export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/** [preamble 1010…][sync][length][payload][crc8(length+payload)] as bits. */
export function encodeFrame(text: string): Bit[] {
  const payload = encoder.encode(text);
  if (payload.length > MAX_PAYLOAD) {
    throw new RangeError(`Payload is ${payload.length} bytes; max is ${MAX_PAYLOAD}`);
  }
  const body = new Uint8Array([payload.length, ...payload]);
  const preamble = Array.from({ length: PREAMBLE_BITS }, (_, i): Bit => (i % 2 === 0 ? 1 : 0));
  return [...preamble, ...bytesToBits(new Uint8Array([SYNC_BYTE, ...body, crc8(body)]))];
}

export type FrameEvent =
  | { type: 'header'; length: number }
  | { type: 'progress'; received: number; length: number }
  | { type: 'done'; text: string }
  | { type: 'error'; reason: 'crc'; bestGuess: string };

/** Consumes demodulated bits one at a time; hunts for preamble tail + sync byte, then reads one frame. */
export class FrameDecoder {
  private stage: 'sync' | 'length' | 'payload' | 'crc' = 'sync';
  private window = 0;
  private seen = 0;
  private byte = 0;
  private nbits = 0;
  private length = 0;
  private payload: number[] = [];

  get reading(): boolean {
    return this.stage !== 'sync';
  }

  push(bit: Bit): FrameEvent | null {
    if (this.stage === 'sync') {
      this.window = ((this.window << 1) | bit) & SYNC_MASK;
      this.seen++;
      if (this.seen >= SYNC_WINDOW_BITS && this.window === SYNC_PATTERN) this.stage = 'length';
      return null;
    }

    this.byte = (this.byte << 1) | bit;
    if (++this.nbits < 8) return null;
    const value = this.byte;
    this.byte = 0;
    this.nbits = 0;

    switch (this.stage) {
      case 'length':
        this.length = value;
        this.payload = [];
        this.stage = value === 0 ? 'crc' : 'payload';
        return { type: 'header', length: value };
      case 'payload':
        this.payload.push(value);
        if (this.payload.length === this.length) this.stage = 'crc';
        return { type: 'progress', received: this.payload.length, length: this.length };
      case 'crc': {
        const body = new Uint8Array([this.length, ...this.payload]);
        const text = new TextDecoder().decode(new Uint8Array(this.payload));
        const ok = crc8(body) === value;
        this.reset();
        return ok ? { type: 'done', text } : { type: 'error', reason: 'crc', bestGuess: text };
      }
    }
    return null;
  }

  reset(): void {
    this.stage = 'sync';
    this.window = 0;
    this.seen = 0;
    this.byte = 0;
    this.nbits = 0;
    this.length = 0;
    this.payload = [];
  }
}
