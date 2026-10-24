import { encodeLaneFrame } from '../framing/frame';
import { splitMessage } from '../framing/lanes';
import { type Level, manchesterEncode } from '../modulation/manchester/encode';
import { pulseEncode } from '../modulation/pulse/encode';
import type { Coding } from '../receiver';

/** Levels for several lights driven from one clock; every lane has the same length. */
export interface MultiTimedLevels {
  slotMs: number;
  lanes: Level[][];
}

export interface TransmissionOptions {
  /** Lights to split the message across, 1–15. */
  lanes: number;
  coding: Coding;
  /** Pulse-length slot; with Manchester a bit is 2 slots. */
  slotMs: number;
  /** 0–15; use a new id per message and the same one for its repeats. */
  msgId: number;
  /** Darkness appended to every lane, longer than both decoders' timeouts. Default 8. */
  gapSlots?: number;
}

/**
 * One pass of a message over `lanes` lights: the text is encoded once (6-bit codec or
 * UTF-8), split into one chunk per lane, and each lane frame is modulated with the
 * chosen coding. Lanes are padded with darkness to the longest, then `gapSlots` of
 * darkness follow so a looping emitter gives the receiver a clean restart.
 */
export function buildTransmission(text: string, o: TransmissionOptions): MultiTimedLevels {
  const lanes = splitMessage(text, o.lanes, o.msgId).map(({ header, chunk }) => {
    const bits = encodeLaneFrame(header, chunk);
    return o.coding === 'pulse' ? pulseEncode(bits, o.slotMs).levels : manchesterEncode(bits, 2 * o.slotMs).levels;
  });
  const length = Math.max(...lanes.map((l) => l.length)) + (o.gapSlots ?? 8);
  return {
    slotMs: o.slotMs,
    lanes: lanes.map((l) => [...l, ...new Array<Level>(length - l.length).fill(0)]),
  };
}
