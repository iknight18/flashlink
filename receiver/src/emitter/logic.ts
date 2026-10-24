/**
 * Pure helpers for the browser emitter: grid layout, message planning (bytes, ETA,
 * inline errors), msgId rotation and calibration. No DOM, so it is unit-tested.
 */
import {
  buildTransmission,
  calibrationSignal,
  encodePayload,
  MAX_CHUNK,
  type Coding,
  type Level,
  type MultiTimedLevels,
} from '@flashlink/protocol';

export const MAX_BULBS = 9;
/** Gap between tiles (and to the edge) as a fraction of the tile size; the spec asks ≥ 15%. */
export const GAP_RATIO = 0.2;

export interface Range {
  min: number;
  max: number;
  step: number;
}
export const BULBS: Range = { min: 1, max: MAX_BULBS, step: 1 };
export const SLOT_MS: Range = { min: 50, max: 1000, step: 10 };
export const DEFAULT_SLOT_MS = 100;

/** Near-square grid: 1, 2, 3 in a row, 4 = 2×2, 5–6 = 3×2, 7–9 = 3×3. */
export function gridShape(n: number): { cols: number; rows: number } {
  if (!Number.isInteger(n) || n < 1 || n > MAX_BULBS) throw new RangeError(`Bulb count ${n} is outside 1–${MAX_BULBS}`);
  if (n <= 3) return { cols: n, rows: 1 };
  if (n === 4) return { cols: 2, rows: 2 };
  if (n <= 6) return { cols: 3, rows: 2 };
  return { cols: 3, rows: 3 };
}

export interface GridLayout {
  cols: number;
  rows: number;
  /** Square tile edge, in the box's units. */
  size: number;
  gap: number;
  /** Top-left corner of each tile, lane order (reading order). */
  tiles: { x: number; y: number }[];
}

/**
 * Square tiles as large as fit in `width`×`height`, with a gap of `gapRatio`×size
 * between tiles and around the grid. The grid is centred; a partial last row is
 * centred too, so every tile stays far from its neighbours.
 */
export function gridLayout(n: number, width: number, height: number, gapRatio = GAP_RATIO): GridLayout {
  const { cols, rows } = gridShape(n);
  const w = Math.max(0, width);
  const h = Math.max(0, height);
  const size = Math.min(w / (cols + (cols + 1) * gapRatio), h / (rows + (rows + 1) * gapRatio));
  const gap = size * gapRatio;
  const pitch = size + gap;
  const gridH = rows * size + (rows - 1) * gap;
  const top = (h - gridH) / 2;
  const tiles: { x: number; y: number }[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const inRow = Math.min(cols, n - row * cols);
    const rowW = inRow * size + (inRow - 1) * gap;
    const left = (w - rowW) / 2;
    tiles.push({ x: left + (i % cols) * pitch, y: top + row * pitch });
  }
  return { cols, rows, size, gap, tiles };
}

/** msgIds are 4 bits: a new one per Send, the same one for its repeats. */
export function nextMsgId(prev: number): number {
  return (prev + 1) & 15;
}

/** Moves `value` by `dir` steps on the range's grid, clamped to [min, max]. */
export function clampStep(value: number, dir: number, r: Range): number {
  const next = dir > 0 ? Math.floor(value / r.step) * r.step + r.step : Math.ceil(value / r.step) * r.step - r.step;
  return Math.min(r.max, Math.max(r.min, next));
}

/** Length of one pass: every lane has the same number of slots. */
export function signalDurationMs(signal: MultiTimedLevels): number {
  return (signal.lanes[0]?.length ?? 0) * signal.slotMs;
}

export function formatDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${(Math.floor(s * 10) / 10).toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${Math.round(s - m * 60)} s`;
}

export interface PlanOptions {
  lanes: number;
  coding: Coding;
  slotMs: number;
  msgId: number;
}

interface PlanBase {
  /** Payload bytes after the 6-bit codec or UTF-8, whichever is smaller. */
  bytes: number;
  compressed: boolean;
  /** Bytes the chosen bulb count can carry. */
  capacity: number;
}
export type Plan =
  | (PlanBase & { ok: true; signal: MultiTimedLevels; etaMs: number })
  | (PlanBase & { ok: false; error: string });

/** Builds one pass of the message, or explains inline why it can't be sent. */
export function planMessage(text: string, o: PlanOptions): Plan {
  const { bytes, compressed } = encodePayload(text);
  const base: PlanBase = { bytes: bytes.length, compressed, capacity: o.lanes * MAX_CHUNK };
  if (text.trim() === '') return { ...base, ok: false, error: 'Type a message to send.' };
  try {
    const signal = buildTransmission(text, o);
    return { ...base, ok: true, signal, etaMs: signalDurationMs(signal) };
  } catch (e) {
    if (!(e instanceof RangeError)) throw e;
    const more = Math.ceil(bytes.length / MAX_CHUNK);
    const hint = more <= MAX_BULBS ? ` Use ${more} bulbs or shorten it.` : ' Shorten it.';
    return {
      ...base,
      ok: false,
      error: `Too long: ${bytes.length} bytes, ${o.lanes === 1 ? '1 bulb carries' : `${o.lanes} bulbs carry`} at most ${base.capacity}.${hint}`,
    };
  }
}

/**
 * Steady blinking on every tile so the receiver can lock on and plot its timing
 * histogram: 1-slot alternation (the pulse-length preamble rhythm) for pulse, and
 * the Manchester `calibrationSignal` (one edge per 2-slot bit) for Manchester.
 */
export function calibrationTransmission(lanes: number, slotMs: number, coding: Coding, durationMs = 10_000): MultiTimedLevels {
  let levels: Level[];
  if (coding === 'manchester') levels = [...calibrationSignal(2 * slotMs, durationMs).levels];
  else levels = Array.from({ length: Math.floor(durationMs / slotMs) }, (_, i): Level => (i % 2 === 0 ? 1 : 0));
  if (levels.at(-1) !== 0) levels.push(0);
  return { slotMs, lanes: Array.from({ length: lanes }, () => levels.slice()) };
}
