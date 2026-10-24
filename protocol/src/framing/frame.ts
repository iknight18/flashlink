import { type Bit, bytesToBits } from './bits';
import { crc8 } from './crc8';
import { encodePayload } from './textCodec';

/**
 * Frame v2 sync word. Its minimum Hamming distance to every overlap with either
 * modulator's preamble (Manchester demodulates to 1010…, pulse-length to 0000…) is 7,
 * so a few bit errors in the preamble tail can't fake a lock. Starts with 01 so the
 * first pulse-length run after the preamble is 2 slots long.
 */
export const SYNC_WORD = 0x6cc7;
export const SYNC_BITS = 16;
/** Largest chunk one lane frame can carry (the length field is one byte). */
export const MAX_CHUNK = 255;
/** Header field ranges: msgId 0–15, lane 0–14, lanes 1–15. */
export const MAX_MSG_ID = 15;
export const MAX_LANES = 15;

const SYNC_MASK = (1 << SYNC_BITS) - 1;
const FLAG_COMPRESSED = 0x1;

/** Identifies one lane's chunk of a message. */
export interface LaneHeader {
  /** Message id 0–15; a new message gets a new id, repeats reuse it. */
  msgId: number;
  /** Lane index 0–14: this frame carries chunk `lane` of the message. */
  lane: number;
  /** Number of lanes the message is split across, 1–15. */
  lanes: number;
  /** Payload is in the 6-bit text codec rather than UTF-8. */
  compressed: boolean;
}

function validHeader(h: LaneHeader): boolean {
  const int = Number.isInteger;
  return int(h.msgId) && int(h.lane) && int(h.lanes) &&
    h.msgId >= 0 && h.msgId <= MAX_MSG_ID &&
    h.lanes >= 1 && h.lanes <= MAX_LANES &&
    h.lane >= 0 && h.lane < h.lanes;
}

function headerBytes(h: LaneHeader): [number, number] {
  return [(h.msgId << 4) | h.lane, (h.lanes << 4) | (h.compressed ? FLAG_COMPRESSED : 0)];
}

/** Parses the two header bytes; null if they can't come from `encodeLaneFrame`. */
function parseHeader(b0: number, b1: number): LaneHeader | null {
  const flags = b1 & 0x0f;
  if (flags & ~FLAG_COMPRESSED) return null; // reserved flags must be 0
  const h = { msgId: b0 >> 4, lane: b0 & 0x0f, lanes: b1 >> 4, compressed: (flags & FLAG_COMPRESSED) !== 0 };
  return validHeader(h) ? h : null;
}

/**
 * [sync 16][msgId:4|lane:4][lanes:4|flags:4][length 8][chunk][crc8(header+length+chunk)] as bits.
 * No preamble: each modulator adds its own.
 */
export function encodeLaneFrame(h: LaneHeader, chunk: Uint8Array): Bit[] {
  if (!validHeader(h)) throw new RangeError(`Invalid lane header ${JSON.stringify(h)}`);
  if (chunk.length > MAX_CHUNK) throw new RangeError(`Chunk is ${chunk.length} bytes; max is ${MAX_CHUNK}`);
  const body = new Uint8Array([...headerBytes(h), chunk.length, ...chunk]);
  return bytesToBits(new Uint8Array([SYNC_WORD >> 8, SYNC_WORD & 0xff, ...body, crc8(body)]));
}

/** A whole message as one lane (lane 0 of 1), in whichever payload encoding is smaller. */
export function encodeFrame(text: string, msgId = 0): Bit[] {
  const { bytes, compressed } = encodePayload(text);
  return encodeLaneFrame({ msgId, lane: 0, lanes: 1, compressed }, bytes);
}

export type FrameEvent =
  | { type: 'header'; header: LaneHeader; length: number }
  /** `bytes` is the chunk received so far, not yet checked by the CRC. */
  | { type: 'progress'; header: LaneHeader; bytes: Uint8Array; length: number }
  | { type: 'done'; header: LaneHeader; bytes: Uint8Array }
  /** Checksum mismatch, or a header no encoder could produce. */
  | { type: 'error'; reason: 'crc' };

/** Consumes demodulated bits one at a time; hunts for the sync word, then reads one frame. */
export class FrameDecoder {
  private stage: 'sync' | 'header' | 'chunk' | 'crc' = 'sync';
  private window = 0;
  private seen = 0;
  private byte = 0;
  private nbits = 0;
  /** Header bytes and length as they arrive. */
  private head: number[] = [];
  private header: LaneHeader | null = null;
  private length = 0;
  private chunk: number[] = [];

  get reading(): boolean {
    return this.stage !== 'sync';
  }

  push(bit: Bit): FrameEvent | null {
    if (this.stage === 'sync') {
      this.window = ((this.window << 1) | bit) & SYNC_MASK;
      this.seen++;
      if (this.seen >= SYNC_BITS && this.window === SYNC_WORD) this.stage = 'header';
      return null;
    }

    this.byte = (this.byte << 1) | bit;
    if (++this.nbits < 8) return null;
    const value = this.byte;
    this.byte = 0;
    this.nbits = 0;

    switch (this.stage) {
      case 'header': {
        this.head.push(value);
        if (this.head.length < 3) return null;
        const header = parseHeader(this.head[0], this.head[1]);
        if (!header) {
          this.reset();
          return { type: 'error', reason: 'crc' };
        }
        this.header = header;
        this.length = value;
        this.stage = value === 0 ? 'crc' : 'chunk';
        return { type: 'header', header, length: value };
      }
      case 'chunk':
        this.chunk.push(value);
        if (this.chunk.length === this.length) this.stage = 'crc';
        return { type: 'progress', header: this.header!, bytes: new Uint8Array(this.chunk), length: this.length };
      case 'crc': {
        const ok = crc8(new Uint8Array([...this.head, ...this.chunk])) === value;
        const done = { type: 'done' as const, header: this.header!, bytes: new Uint8Array(this.chunk) };
        this.reset();
        return ok ? done : { type: 'error', reason: 'crc' };
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
    this.head = [];
    this.header = null;
    this.length = 0;
    this.chunk = [];
  }
}
