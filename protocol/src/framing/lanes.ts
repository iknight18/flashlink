import { MAX_CHUNK, MAX_LANES, type LaneHeader } from './frame';
import { decodePayload, encodePayload } from './textCodec';

/** One lane's share of a message, ready for `encodeLaneFrame`. */
export interface LaneChunk {
  header: LaneHeader;
  chunk: Uint8Array;
}

/**
 * Encodes `text` (6-bit codec or UTF-8, whichever is smaller) and splits the bytes into
 * `lanes` contiguous chunks whose sizes differ by at most one byte; the first chunks get
 * the extra bytes. Chunks may be empty when there are fewer bytes than lanes.
 */
export function splitMessage(text: string, lanes: number, msgId: number): LaneChunk[] {
  if (!Number.isInteger(lanes) || lanes < 1 || lanes > MAX_LANES) {
    throw new RangeError(`Lane count ${lanes} is outside 1–${MAX_LANES}`);
  }
  const { bytes, compressed } = encodePayload(text);
  const base = Math.floor(bytes.length / lanes);
  const extra = bytes.length % lanes;
  if (base + (extra > 0 ? 1 : 0) > MAX_CHUNK) {
    throw new RangeError(`Message is ${bytes.length} bytes; ${lanes} lane(s) carry at most ${lanes * MAX_CHUNK}`);
  }
  const out: LaneChunk[] = [];
  let at = 0;
  for (let lane = 0; lane < lanes; lane++) {
    const size = base + (lane < extra ? 1 : 0);
    out.push({ header: { msgId, lane, lanes, compressed }, chunk: bytes.slice(at, at + size) });
    at += size;
  }
  return out;
}

/** A lane frame still being received, as reported by the frame decoder's progress. */
export interface LivePartial {
  header: LaneHeader;
  bytes: Uint8Array;
}

const sameMessage = (a: LaneHeader, b: LaneHeader) =>
  a.msgId === b.msgId && a.lanes === b.lanes && a.compressed === b.compressed;

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Reassembles lane chunks by header, never by arrival order or light position.
 * Tracks one message at a time: a chunk with a different msgId (or lane count or
 * encoding) discards the partial state. Once a message completes its chunks are
 * cleared, so a repeat of the same message is assembled and reported again.
 */
export class MessageAssembler {
  private current: LaneHeader | null = null;
  private chunks = new Map<number, Uint8Array>();

  /**
   * Stores a CRC-checked chunk. Returns the full text with `complete` once every lane
   * of `header.msgId` has arrived, otherwise the text decodable so far (see `preview`).
   * A complete set that is not a valid payload is discarded and reported incomplete.
   */
  add(header: LaneHeader, bytes: Uint8Array): { text: string; complete: boolean } {
    if (!this.current || !sameMessage(this.current, header)) {
      this.current = header;
      this.chunks.clear();
    }
    this.chunks.set(header.lane, bytes);
    if (this.chunks.size < header.lanes) return { text: this.preview(header.msgId), complete: false };

    const full = concat(Array.from({ length: header.lanes }, (_, i) => this.chunks.get(i)!));
    this.chunks.clear();
    try {
      return { text: decodePayload(full, header.compressed), complete: true };
    } catch {
      return { text: '', complete: false };
    }
  }

  /** Lanes of `msgId` received since it last completed. */
  lanesDone(msgId: number): number {
    return this.current?.msgId === msgId ? this.chunks.size : 0;
  }

  /**
   * Text decodable from the contiguous chunks received so far (lane 0 onward), extended
   * by the live partial of the next missing lane if one is given. Unverified live bytes
   * are for display only.
   */
  preview(msgId: number, live: LivePartial[] = []): string {
    const known = this.current?.msgId === msgId ? this.current : null;
    const parts: Uint8Array[] = [];
    let next = 0;
    if (known) while (this.chunks.has(next)) parts.push(this.chunks.get(next++)!);
    const ref = known ?? live.find((l) => l.header.msgId === msgId && l.header.lane === 0)?.header;
    if (!ref) return '';
    const tail = live.find((l) => l.header.lane === next && sameMessage(l.header, ref));
    if (tail) parts.push(tail.bytes);
    return decodePayload(concat(parts), ref.compressed, true);
  }
}
