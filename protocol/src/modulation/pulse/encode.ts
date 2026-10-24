import type { Bit } from '../../framing/bits';
import type { Level, TimedLevels } from '../manchester/encode';

/** 1-slot runs (alternating, on first) sent before every frame to lock slot length and skew. */
export const PULSE_PREAMBLE_RUNS = 16;
/** Longest data run in slots (2 bits per run: 1 + value). */
export const PULSE_MAX_RUN = 4;

/**
 * Pulse-length modulation: every run of light or darkness carries 2 bits as its length,
 * 1–4 slots (1 + value, MSB first), and runs alternate level. After the preamble the
 * first data run is on. A 1-slot terminating run gives the last data run an end edge,
 * and the output always ends dark. An odd bit count is padded with a 0 bit.
 * `halfBitMs` of the result is the slot length.
 */
export function pulseEncode(bits: Bit[], slotMs: number): TimedLevels {
  const levels: Level[] = [];
  let level: Level = 1;
  const run = (slots: number) => {
    for (let i = 0; i < slots; i++) levels.push(level);
    level = level === 1 ? 0 : 1;
  };
  for (let i = 0; i < PULSE_PREAMBLE_RUNS; i++) run(1);
  const data = bits.length % 2 ? [...bits, 0] : bits;
  for (let i = 0; i < data.length; i += 2) run(1 + data[i] * 2 + data[i + 1]);
  run(1); // terminator
  if (levels.at(-1) === 1) levels.push(0);
  return { halfBitMs: slotMs, levels };
}
