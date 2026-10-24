import type { Bit } from '../../framing/bits';

export type Level = 0 | 1;

/** A sequence of output levels, each held for `halfBitMs`. Channel-agnostic. */
export interface TimedLevels {
  halfBitMs: number;
  levels: Level[];
}

/** IEEE 802.3 convention: 1 = high→low, 0 = low→high (transition at mid-bit). */
export function manchesterEncode(bits: Bit[], bitMs: number): TimedLevels {
  const levels: Level[] = [];
  for (const bit of bits) levels.push(...(bit === 1 ? ([1, 0] as const) : ([0, 1] as const)));
  return { halfBitMs: bitMs / 2, levels };
}

/**
 * Appends `bits` bit periods of darkness. Between repeats this gives the receiver a
 * silence longer than its 3-bit timeout, so each pass starts from a clean lock.
 */
export function withIdleGap(signal: TimedLevels, bits: number): TimedLevels {
  return { halfBitMs: signal.halfBitMs, levels: [...signal.levels, ...new Array<Level>(bits * 2).fill(0)] };
}

/** Steady 1010… pattern used to measure a channel's real timing jitter. */
export function calibrationSignal(bitMs: number, durationMs: number): TimedLevels {
  const count = Math.floor(durationMs / bitMs);
  return manchesterEncode(Array.from({ length: count }, (_, i): Bit => (i % 2 === 0 ? 1 : 0)), bitMs);
}
