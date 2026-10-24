import { describe, expect, it } from 'vitest';
import { buildTransmission } from '@flashlink/protocol';
import {
  calibrationTransmission,
  clampStep,
  formatDuration,
  gridLayout,
  gridShape,
  GAP_RATIO,
  nextMsgId,
  planMessage,
  signalDurationMs,
} from '../src/emitter/logic';

describe('gridShape', () => {
  it('follows the near-square rules for 1–9 bulbs', () => {
    const shapes = [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => gridShape(n));
    expect(shapes).toEqual([
      { cols: 1, rows: 1 },
      { cols: 2, rows: 1 },
      { cols: 3, rows: 1 },
      { cols: 2, rows: 2 },
      { cols: 3, rows: 2 },
      { cols: 3, rows: 2 },
      { cols: 3, rows: 3 },
      { cols: 3, rows: 3 },
      { cols: 3, rows: 3 },
    ]);
  });

  it('rejects counts outside 1–9', () => {
    expect(() => gridShape(0)).toThrow(RangeError);
    expect(() => gridShape(10)).toThrow(RangeError);
  });
});

describe('gridLayout', () => {
  const boxes: [number, number][] = [
    [1440, 900],
    [375, 812],
    [1920, 1080],
    [800, 800],
  ];

  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    for (const [w, h] of boxes) {
      it(`${n} tiles fit ${w}x${h} with gaps of at least 15% and no overlap`, () => {
        const l = gridLayout(n, w, h);
        expect(l.tiles).toHaveLength(n);
        expect(l.gap).toBeGreaterThanOrEqual(0.15 * l.size - 1e-9);
        for (const t of l.tiles) {
          expect(t.x).toBeGreaterThanOrEqual(-1e-9);
          expect(t.y).toBeGreaterThanOrEqual(-1e-9);
          expect(t.x + l.size).toBeLessThanOrEqual(w + 1e-9);
          expect(t.y + l.size).toBeLessThanOrEqual(h + 1e-9);
        }
        for (let i = 0; i < n; i++)
          for (let j = i + 1; j < n; j++) {
            const a = l.tiles[i];
            const b = l.tiles[j];
            const dx = Math.abs(a.x - b.x);
            const dy = Math.abs(a.y - b.y);
            // Separated by at least one gap on some axis.
            expect(Math.max(dx, dy)).toBeGreaterThanOrEqual(l.size + l.gap - 1e-9);
          }
      });
    }
  }

  it('makes tiles as large as possible: one dimension is fully used', () => {
    const l = gridLayout(4, 1440, 900); // 2×2, height-bound
    const usedH = 2 * l.size + 3 * l.gap;
    expect(usedH).toBeCloseTo(900, 6);
    expect(l.gap / l.size).toBeCloseTo(GAP_RATIO, 9);
  });

  it('centres the grid and a partial last row', () => {
    const l = gridLayout(5, 1500, 1000);
    const xs = l.tiles.map((t) => t.x + l.size / 2);
    const left = Math.min(...l.tiles.map((t) => t.x));
    const right = Math.max(...l.tiles.map((t) => t.x + l.size));
    expect(left).toBeCloseTo(1500 - right, 6);
    // Last row has 2 tiles, centred around the middle.
    expect((xs[3] + xs[4]) / 2).toBeCloseTo(750, 6);
    expect(l.tiles[3].y).toBeGreaterThan(l.tiles[0].y);
  });

  it('keeps lanes in reading order', () => {
    const l = gridLayout(9, 900, 900);
    for (let i = 1; i < 9; i++) {
      const a = l.tiles[i - 1];
      const b = l.tiles[i];
      expect(b.y > a.y || (b.y === a.y && b.x > a.x)).toBe(true);
    }
  });

  it('returns zero-sized tiles for an empty box instead of negative sizes', () => {
    const l = gridLayout(3, 0, 0);
    expect(l.size).toBe(0);
  });
});

describe('nextMsgId', () => {
  it('counts 0–15 and wraps', () => {
    expect(nextMsgId(0)).toBe(1);
    expect(nextMsgId(14)).toBe(15);
    expect(nextMsgId(15)).toBe(0);
  });
});

describe('clampStep', () => {
  it('steps by 10 within 50–1000', () => {
    const r = { min: 50, max: 1000, step: 10 };
    expect(clampStep(100, 1, r)).toBe(110);
    expect(clampStep(100, -1, r)).toBe(90);
    expect(clampStep(50, -1, r)).toBe(50);
    expect(clampStep(1000, 1, r)).toBe(1000);
    expect(clampStep(103, 1, r)).toBe(110); // snaps to the grid
  });
  it('steps bulbs by 1 within 1–9', () => {
    const r = { min: 1, max: 9, step: 1 };
    expect(clampStep(9, 1, r)).toBe(9);
    expect(clampStep(1, -1, r)).toBe(1);
    expect(clampStep(4, 1, r)).toBe(5);
  });
});

describe('planMessage', () => {
  it('reports bytes, capacity and the real signal length as ETA', () => {
    const p = planMessage('Meet at the north gate', { lanes: 3, coding: 'pulse', slotMs: 100, msgId: 2 });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const ref = buildTransmission('Meet at the north gate', { lanes: 3, coding: 'pulse', slotMs: 100, msgId: 2 });
    expect(p.signal.lanes).toHaveLength(3);
    expect(p.etaMs).toBe(ref.lanes[0].length * 100);
    expect(p.capacity).toBe(3 * 255);
    expect(p.bytes).toBeLessThan(new TextEncoder().encode('Meet at the north gate').length);
    expect(p.compressed).toBe(true);
  });

  it('Manchester uses 2 slots per bit, so it takes longer at the same slot', () => {
    const pulse = planMessage('hello world', { lanes: 1, coding: 'pulse', slotMs: 100, msgId: 0 });
    const man = planMessage('hello world', { lanes: 1, coding: 'manchester', slotMs: 100, msgId: 0 });
    expect(pulse.ok && man.ok).toBe(true);
    if (pulse.ok && man.ok) expect(man.etaMs).toBeGreaterThan(pulse.etaMs);
  });

  it('gives an inline error for empty text', () => {
    const p = planMessage('   ', { lanes: 1, coding: 'pulse', slotMs: 100, msgId: 0 });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error).toMatch(/type/i);
  });

  it('turns the splitMessage RangeError into an inline error', () => {
    const long = '世'.repeat(200); // 600 UTF-8 bytes, cannot be 6-bit packed
    const p = planMessage(long, { lanes: 1, coding: 'pulse', slotMs: 100, msgId: 0 });
    expect(p.ok).toBe(false);
    if (!p.ok) {
      expect(p.error).toMatch(/600 bytes/);
      expect(p.bytes).toBe(600);
      expect(p.capacity).toBe(255);
    }
    expect(planMessage(long, { lanes: 3, coding: 'pulse', slotMs: 100, msgId: 0 }).ok).toBe(true);
  });
});

describe('signalDurationMs and formatDuration', () => {
  it('ETA is lanes[0].length × slotMs', () => {
    expect(signalDurationMs({ slotMs: 50, lanes: [[1, 0, 1], [0, 0, 1]] })).toBe(150);
  });
  it('formats seconds and minutes', () => {
    expect(formatDuration(4321)).toBe('4.3 s');
    expect(formatDuration(59_940)).toBe('59.9 s');
    expect(formatDuration(75_000)).toBe('1 min 15 s');
  });
});

describe('calibrationTransmission', () => {
  it('blinks every lane in step for about 10 s and ends dark', () => {
    const s = calibrationTransmission(4, 100, 'pulse', 10_000);
    expect(s.lanes).toHaveLength(4);
    expect(signalDurationMs(s)).toBeGreaterThanOrEqual(10_000);
    expect(signalDurationMs(s)).toBeLessThanOrEqual(10_400);
    for (const lane of s.lanes) expect(lane).toEqual(s.lanes[0]);
    expect(s.lanes[0].at(-1)).toBe(0);
    // Pulse: 1-slot alternation like the preamble.
    expect(s.lanes[0].slice(0, 4)).toEqual([1, 0, 1, 0]);
  });
  it('Manchester calibration toggles once per bit (2 slots)', () => {
    const s = calibrationTransmission(1, 100, 'manchester', 10_000);
    const lane = s.lanes[0];
    let edges = 0;
    for (let i = 1; i < lane.length; i++) if (lane[i] !== lane[i - 1]) edges++;
    // Roughly one edge per 200 ms bit.
    expect(edges).toBeGreaterThan(40);
    expect(edges).toBeLessThan(60);
  });
});
