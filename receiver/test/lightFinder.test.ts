import { describe, expect, it } from 'vitest';
import { buildTransmission, MultiReceiver, simulateLanes } from '@flashlink/protocol';
import { LightFinder } from '../src/channels/light/lightFinder';
import { exposureRamp, laptop, paintScene, type Rect, shake } from './scene';

const W = 96;
const H = 72;
const FRAME_MS = 1000 / 30;
const SLOT_MS = 100;
const FRAME60_MS = 1000 / 60;

/** Small seeded PRNG (mulberry32) so the synthetic scenes are reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Tile {
  x: number;
  y: number;
  size: number;
  /** Brightness when on; the tile is at the background level when off. */
  value?: number;
  /** On/off per 100 ms slot; `true` = always on (a steady lamp). */
  on: (slot: number) => boolean;
}

/** A random on/off pattern per slot that starts on, like a preamble. */
function blinking(seed: number): (slot: number) => boolean {
  const r = rng(seed);
  const bits = Array.from({ length: 2000 }, (_, i) => i === 0 || r() < 0.5);
  return (slot) => bits[slot % bits.length];
}

function render(t: number, tiles: Tile[], opts: { w?: number; h?: number; bg?: number; noise?: number; r?: () => number } = {}): Float32Array {
  const w = opts.w ?? W;
  const h = opts.h ?? H;
  const bg = opts.bg ?? 0.05;
  const f = new Float32Array(w * h);
  const noise = opts.noise ?? 0;
  const r = opts.r ?? Math.random;
  for (let i = 0; i < f.length; i++) f[i] = bg + (noise ? (r() * 2 - 1) * noise : 0);
  const slot = Math.floor(t / SLOT_MS);
  for (const tile of tiles) {
    if (!tile.on(slot)) continue;
    const x0 = Math.round(tile.x);
    const y0 = Math.round(tile.y);
    for (let y = y0; y < y0 + tile.size; y++)
      for (let x = x0; x < x0 + tile.size; x++) if (x >= 0 && y >= 0 && x < w && y < h) f[y * w + x] = tile.value ?? 0.9;
  }
  return f;
}

type Source = ReturnType<LightFinder['push']>[number];

/** Runs the finder over `ms` of frames and returns every frame's sources. */
function run(
  finder: LightFinder,
  ms: number,
  tiles: (t: number) => Tile[],
  opts: Parameters<typeof render>[2] = {},
): { t: number; sources: Source[] }[] {
  const out = [];
  for (let t = 0; t < ms; t += FRAME_MS) out.push({ t, sources: finder.push(t, render(t, tiles(t), opts)) });
  return out;
}

const ids = (s: Source[]) => s.map((x) => x.id).sort((a, b) => a - b);

describe('LightFinder', () => {
  it('separates 4 tiles blinking independently, with stable ids over 3 s', () => {
    const tiles: Tile[] = [
      { x: 10, y: 10, size: 8, on: blinking(1) },
      { x: 70, y: 10, size: 8, on: blinking(2) },
      { x: 10, y: 50, size: 8, on: blinking(3) },
      { x: 70, y: 50, size: 8, on: blinking(4) },
    ];
    const frames = run(new LightFinder(W, H), 4500, () => tiles, { noise: 0.01, r: rng(9) });
    const settled = frames.filter((f) => f.t >= 1500);
    const first = ids(settled[0].sources);
    expect(first).toHaveLength(4);
    for (const f of settled) expect(ids(f.sources)).toEqual(first);
    // Each id stays on its own tile.
    const byId = new Map(settled[0].sources.map((s) => [s.id, s]));
    for (const f of settled)
      for (const s of f.sources) {
        expect(Math.abs(s.cx - byId.get(s.id)!.cx)).toBeLessThan(0.02);
        expect(Math.abs(s.cy - byId.get(s.id)!.cy)).toBeLessThan(0.02);
      }
  });

  it('reports no source for a steady bright lamp, and only the blinking light next to one', () => {
    const lamp: Tile = { x: 40, y: 30, size: 10, on: () => true };
    const alone = run(new LightFinder(W, H), 3000, () => [lamp], { noise: 0.01, r: rng(3) });
    for (const f of alone) expect(f.sources).toEqual([]);

    const torch: Tile = { x: 5, y: 5, size: 4, on: blinking(5) };
    const both = run(new LightFinder(W, H), 3000, () => [lamp, torch], { noise: 0.01, r: rng(4) });
    for (const f of both.filter((f) => f.t >= 1500)) {
      expect(f.sources).toHaveLength(1);
      expect(f.sources[0].cx).toBeLessThan(0.15);
    }
  });

  it('reports nothing for camera noise alone', () => {
    const frames = run(new LightFinder(W, H), 3000, () => [], { noise: 0.015, r: rng(6) });
    for (const f of frames) expect(f.sources).toEqual([]);
  });

  it('keeps a 2×2 tile at 100 ms slots at a contrast of at least 0.4', () => {
    const tile: Tile = { x: 47, y: 33, size: 2, on: blinking(7) };
    const frames = run(new LightFinder(W, H), 4000, () => [tile], { noise: 0.01, r: rng(8) });
    const levels = frames.filter((f) => f.t >= 1500).map((f) => {
      expect(f.sources).toHaveLength(1);
      return f.sources[0].level;
    });
    expect(Math.max(...levels) - Math.min(...levels)).toBeGreaterThanOrEqual(0.4);
  });

  it('reads a single small torch anywhere in the frame at full contrast, in landscape and portrait', () => {
    for (const [w, h] of [[96, 72], [96, 128]]) {
      for (const [fx, fy] of [[0.02, 0.03], [0.5, 0.5], [0.95, 0.94]]) {
        const torch: Tile = { x: Math.floor(fx * (w - 3)), y: Math.floor(fy * (h - 3)), size: 3, on: blinking(11) };
        const frames = run(new LightFinder(w, h), 3500, () => [torch], { w, h, noise: 0.01, r: rng(12) });
        const levels = frames.filter((f) => f.t >= 1500).map((f) => {
          expect(f.sources).toHaveLength(1);
          return f.sources[0].level;
        });
        expect(Math.max(...levels) - Math.min(...levels)).toBeGreaterThan(0.75);
      }
    }
  });

  it('keeps the id of a slowly drifting tile', () => {
    const on = blinking(13);
    const finder = new LightFinder(W, H);
    const r = rng(14);
    const frames: { t: number; sources: Source[] }[] = [];
    // 6 cells per second, 36 cells in total, imaged as a camera would: at its sub-cell
    // position with soft edges (whole-cell jumps of a hard-edged tile never happen).
    for (let t = 0; t < 6000; t += FRAME_MS) {
      const tile: Rect = { x: 10 + (t / 1000) * 6, y: 30 + (t / 1000) * 2, w: 5, h: 5, value: on(Math.floor(t / SLOT_MS)) ? 0.9 : 0.05 };
      frames.push({ t, sources: finder.push(t, paintScene(W, H, [tile], { soft: true, noise: 0.01, rand: r })) });
    }
    const settled = frames.filter((f) => f.t >= 1500);
    const id = settled[0].sources[0].id;
    for (const f of settled) {
      expect(f.sources.map((s) => s.id)).toEqual([id]);
    }
    expect(settled.at(-1)!.sources[0].cx).toBeGreaterThan(0.4);
  });

  it('keeps tiles 3 cells apart separate', () => {
    const tiles: Tile[] = [
      { x: 30, y: 30, size: 5, on: blinking(15) },
      { x: 38, y: 30, size: 5, on: blinking(16) },
    ];
    const frames = run(new LightFinder(W, H), 3000, () => tiles, { noise: 0.01, r: rng(17) });
    for (const f of frames.filter((f) => f.t >= 2000)) expect(f.sources).toHaveLength(2);
  });

  it('holds a light that drops out of the swing map for ~1.5 s, still reading its level, then drops it', () => {
    const weak: Tile = { x: 10, y: 10, size: 6, value: 0.3, on: blinking(18) };
    const strongOn = blinking(19);
    // A much stronger light appears at 2 s, so the weak one falls under the relative threshold.
    const strong: Tile = { x: 70, y: 40, size: 12, value: 1, on: (slot) => slot >= 20 && strongOn(slot) };
    const finder = new LightFinder(W, H);
    const frames = run(finder, 6000, () => [weak, strong], { noise: 0.005, r: rng(20) });
    const before = frames.filter((f) => f.t >= 1500 && f.t < 2000);
    const weakId = before[0].sources[0].id;
    for (const f of before) expect(ids(f.sources)).toEqual([weakId]);

    // Find when the weak light stops being detected, if it does: it must linger for a while.
    const after = frames.filter((f) => f.t >= 2000);
    const lastSeen = after.filter((f) => f.sources.some((s) => s.id === weakId)).at(-1)!;
    const goneAt = after.find((f) => f.t > lastSeen.t)?.t ?? Infinity;
    expect(goneAt).toBeLessThan(6000);
    // While held, its position stays put and its level still follows the tile.
    const held = after.filter((f) => f.t <= lastSeen.t).map((f) => f.sources.find((s) => s.id === weakId)!);
    for (const s of held) {
      expect(s.cx).toBeCloseTo(13 / W, 1);
      expect(s.cy).toBeCloseTo(13 / H, 1);
    }
    const heldLevels = held.slice(-12).map((s) => s.level);
    expect(Math.max(...heldLevels) - Math.min(...heldLevels)).toBeGreaterThan(0.1);

    // Without holding it would have gone about 1.5 s earlier.
    const noHold = run(new LightFinder(W, H, { holdMs: 0 }), 6000, () => [weak, strong], { noise: 0.005, r: rng(20) });
    const nearWeak = (s: Source) => s.cx < 0.5 && s.cy < 0.5;
    const goneNoHold = noHold.find((f) => f.t >= 2000 && !f.sources.some(nearWeak))!.t;
    expect(after.find((f) => f.t >= 2000 && !f.sources.some(nearWeak))!.t).toBe(goneAt);
    expect(goneAt - goneNoHold).toBeGreaterThan(1400);
    expect(goneAt - goneNoHold).toBeLessThan(1600);
  });

  it('holds a light hidden for a few frames under the same id', () => {
    const on = blinking(21);
    // The tile jumps out of the picture for 200 ms and comes back.
    const tile = (t: number): Tile[] => [{ x: t >= 2500 && t < 2700 ? -100 : 40, y: 30, size: 5, on }];
    const finder = new LightFinder(W, H, { tauMs: 300 });
    const frames = run(finder, 4000, tile, { noise: 0.01, r: rng(22) });
    const settled = frames.filter((f) => f.t >= 1500);
    const id = settled[0].sources[0].id;
    for (const f of settled) expect(f.sources.map((s) => s.id)).toEqual([id]);
  });

  it('numbers sources from 1 and reuses a freed number', () => {
    const on = blinking(23);
    const a = (t: number): Tile[] => (t < 2000 ? [{ x: 10, y: 10, size: 5, on }] : t > 4500 ? [{ x: 70, y: 40, size: 5, on }] : []);
    const finder = new LightFinder(W, H, { tauMs: 150 });
    const frames = run(finder, 6500, a, { noise: 0.01, r: rng(24) });
    expect(frames.find((f) => f.sources.length)!.sources[0].id).toBe(1);
    expect(frames.at(-1)!.sources.map((s) => s.id)).toEqual([1]);
  });
});

describe('LightFinder on a hand-held phone (60 fps)', () => {
  /** Tiles at 0.9 when on and the screen's black when off. */
  const tileRects = (t: number, tiles: { x: number; y: number; size: number; on: (slot: number) => boolean }[]): Rect[] =>
    tiles.map(({ x, y, size, on }) => ({ x, y, w: size, h: size, value: on(Math.floor(t / SLOT_MS)) ? 0.9 : 0.05 }));

  it('sees a soft-edged, noisy 14×14 tile as exactly one light', () => {
    const tiles = [{ x: 40, y: 28, size: 14, on: blinking(31) }];
    const finder = new LightFinder(W, H);
    const r = rng(32);
    const seen = new Set<number>();
    for (let t = 0; t < 4000; t += FRAME60_MS) {
      const s = finder.push(t, paintScene(W, H, tileRects(t, tiles), { soft: true, noise: 0.05, rand: r }));
      if (t < 1500) continue;
      expect(s).toHaveLength(1);
      seen.add(s[0].id);
    }
    expect(seen.size).toBe(1);
  });

  const layouts: [string, { x: number; y: number; size: number }[]][] = [
    ['1 tile', [{ x: 41, y: 29, size: 14 }]],
    ['4 tiles', [{ x: 22, y: 14, size: 14 }, { x: 60, y: 14, size: 14 }, { x: 22, y: 42, size: 14 }, { x: 60, y: 42, size: 14 }]],
  ];

  it.each(layouts)('ignores a shaking laptop bezel and exposure settling, and keeps %s with stable ids', (_, layout) => {
    const tiles = layout.map((p, k) => ({ ...p, on: blinking(40 + k) }));
    const finder = new LightFinder(W, H);
    const r = rng(41);
    const first = new Map<number, Source>();
    for (let t = 0; t < 6000; t += FRAME60_MS) {
      const frame = paintScene(W, H, [...laptop(W, H), ...tileRects(t, tiles)], { bg: 0.2, soft: true, noise: 0.02, rand: r, gain: exposureRamp(t), ...shake(t) });
      const s = finder.push(t, frame);
      if (t < 1500) continue;
      expect(s).toHaveLength(tiles.length);
      if (first.size === 0) for (const x of s) first.set(x.id, x);
      expect(ids(s)).toEqual([...first.keys()].sort((a, b) => a - b));
      for (const x of s) {
        expect(Math.abs(x.cx - first.get(x.id)!.cx)).toBeLessThan(0.03);
        expect(Math.abs(x.cy - first.get(x.id)!.cy)).toBeLessThan(0.03);
      }
    }
  });

  it.each([false, true])('emits a square level: one midpoint crossing per transition, on its frame (shake: %s)', (shaking) => {
    const signal = buildTransmission('Square wave', { lanes: 1, coding: 'pulse', slotMs: 100, msgId: 1 });
    const frames = simulateLanes(signal, { fps: 60, seed: 5, leadInMs: 600, tailMs: 400 });
    const finder = new LightFinder(W, H);
    const r = rng(51);
    const levels: number[] = [];
    const truth: boolean[] = [];
    for (const { t, levels: [lv] } of frames) {
      const tile: Rect = { x: 40, y: 28, w: 14, h: 14, value: lv > 0.5 ? 0.9 : 0.05 };
      const s = finder.push(t, paintScene(W, H, [tile], { soft: true, noise: 0.05, rand: r, ...(shaking ? shake(t) : {}) }));
      // From 0.6 s after the light starts blinking.
      if (t < 1200) continue;
      expect(s).toHaveLength(1);
      levels.push(s[0].level);
      truth.push(lv > 0.5);
    }
    const mid = (Math.min(...levels) + Math.max(...levels)) / 2;
    const flips = (xs: boolean[]) => xs.flatMap((x, i) => (i > 0 && x !== xs[i - 1] ? [i] : []));
    const expected = flips(truth);
    expect(expected.length).toBeGreaterThan(20);
    expect(flips(levels.map((l) => l > mid))).toEqual(expected);
  });
});

describe('LightFinder only reports lights that blink repeatedly', () => {
  const soft = (r: () => number, more: Partial<Parameters<typeof paintScene>[3]> = {}) => ({ soft: true, noise: 0.02, rand: r, ...more });

  it('reports no source for a steady bright lamp', () => {
    const finder = new LightFinder(W, H);
    const r = rng(61);
    for (let t = 0; t < 4000; t += FRAME60_MS)
      expect(finder.push(t, paintScene(W, H, [{ x: 40, y: 28, w: 14, h: 14, value: 0.95 }], soft(r)))).toEqual([]);
  });

  it('reports no source for a light switched on once and left on', () => {
    const finder = new LightFinder(W, H);
    const r = rng(62);
    for (let t = 0; t < 4000; t += FRAME60_MS) {
      const tile: Rect = { x: 40, y: 28, w: 14, h: 14, value: t >= 1000 ? 0.9 : 0.05 };
      expect(finder.push(t, paintScene(W, H, [tile], soft(r)))).toEqual([]);
    }
  });

  it('reports no source when the screen edge moves once by 2 cells', () => {
    const finder = new LightFinder(W, H);
    const r = rng(63);
    for (let t = 0; t < 4000; t += FRAME60_MS) {
      // The hand jerks the phone 2 cells sideways and down at 1 s, over 50 ms, and holds still.
      const k = Math.min(1, Math.max(0, (t - 1000) / 50));
      expect(finder.push(t, paintScene(W, H, laptop(W, H), soft(r, { bg: 0.2, dx: 2 * k, dy: 2 * k })))).toEqual([]);
    }
  });

  it('reports a blinking tile within ~0.5 s of it starting to blink', () => {
    const signal = buildTransmission('Hello', { lanes: 1, coding: 'pulse', slotMs: 100, msgId: 2 });
    const frames = simulateLanes(signal, { fps: 60, seed: 3, leadInMs: 1000, tailMs: 0 });
    const finder = new LightFinder(W, H);
    const r = rng(64);
    let found = Infinity;
    for (const { t, levels: [lv] } of frames) {
      const s = finder.push(t, paintScene(W, H, [{ x: 40, y: 28, w: 14, h: 14, value: lv > 0.5 ? 0.9 : 0.05 }], soft(r)));
      if (t < 1000) expect(s).toEqual([]);
      else if (s.length === 1 && found === Infinity) found = t;
    }
    expect(found - 1000).toBeLessThanOrEqual(550);
  });
});

describe('LightFinder into MultiReceiver', () => {
  /** Renders each simulated lane as a tile and decodes the frames end to end. */
  function decode(text: string, lanes: number, positions: [number, number][], size: number, seed: number): string[] {
    const signal = buildTransmission(text, { lanes, coding: 'pulse', slotMs: 100, msgId: 3 });
    const samples = simulateLanes(signal, { fps: 30, jitterMs: 8, noise: 0, dropRate: 0.01, seed, leadInMs: 600, tailMs: 600 });
    const finder = new LightFinder(W, H);
    const rx = new MultiReceiver({ edge: { minContrast: 0.04 } });
    const r = rng(seed);
    const messages: string[] = [];
    for (const { t, levels } of samples) {
      const f = new Float32Array(W * H);
      for (let i = 0; i < f.length; i++) f[i] = 0.08 + (r() * 2 - 1) * 0.01;
      levels.forEach((level, lane) => {
        const [x0, y0] = positions[lane];
        // A soft tile: a bright core with a dimmer 1-cell halo, as a camera sees it.
        for (let y = y0 - 1; y < y0 + size + 1; y++)
          for (let x = x0 - 1; x < x0 + size + 1; x++) {
            const core = x >= x0 && y >= y0 && x < x0 + size && y < y0 + size;
            f[y * W + x] += Math.max(0, level) * (core ? 0.8 : 0.3);
          }
      });
      for (const e of rx.push(t, finder.push(t, f))) if (e.type === 'message') messages.push(e.text);
    }
    return messages;
  }

  it('decodes a single torch-like light', () => {
    expect(decode('Meet at the north gate, 21:40', 1, [[60, 20]], 3, 1)).toEqual(['Meet at the north gate, 21:40']);
  });

  it('decodes a message split across 4 tiles', () => {
    const pos: [number, number][] = [[20, 12], [60, 12], [20, 44], [60, 44]];
    for (const seed of [1, 2, 3]) {
      expect(decode('Four lights carry this one, in parallel.', 4, pos, 10, seed)).toEqual(['Four lights carry this one, in parallel.']);
    }
  });
});
