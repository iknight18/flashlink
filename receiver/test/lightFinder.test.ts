import { describe, expect, it } from 'vitest';
import { buildTransmission, MultiReceiver, simulateLanes } from '@flashlink/protocol';
import { LightFinder } from '../src/channels/light/lightFinder';

const W = 96;
const H = 72;
const FRAME_MS = 1000 / 30;
const SLOT_MS = 100;

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
    const frames = run(new LightFinder(W, H), 4000, () => tiles, { noise: 0.01, r: rng(9) });
    const settled = frames.filter((f) => f.t >= 1000);
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
    for (const f of both.filter((f) => f.t >= 500)) {
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
    const levels = frames.filter((f) => f.t >= 500).map((f) => {
      expect(f.sources).toHaveLength(1);
      return f.sources[0].level;
    });
    expect(Math.max(...levels) - Math.min(...levels)).toBeGreaterThanOrEqual(0.4);
  });

  it('reads a single small torch anywhere in the frame at full contrast, in landscape and portrait', () => {
    for (const [w, h] of [[96, 72], [96, 128]]) {
      for (const [fx, fy] of [[0.02, 0.03], [0.5, 0.5], [0.95, 0.94]]) {
        const torch: Tile = { x: Math.floor(fx * (w - 3)), y: Math.floor(fy * (h - 3)), size: 3, on: blinking(11) };
        const frames = run(new LightFinder(w, h), 3000, () => [torch], { w, h, noise: 0.01, r: rng(12) });
        const levels = frames.filter((f) => f.t >= 300).map((f) => {
          expect(f.sources).toHaveLength(1);
          return f.sources[0].level;
        });
        expect(Math.max(...levels) - Math.min(...levels)).toBeGreaterThan(0.75);
      }
    }
  });

  it('keeps the id of a slowly drifting tile', () => {
    const on = blinking(13);
    // 6 cells per second, 36 cells in total.
    const tile = (t: number): Tile[] => [{ x: 10 + (t / 1000) * 6, y: 30 + (t / 1000) * 2, size: 5, on }];
    const frames = run(new LightFinder(W, H), 6000, tile, { noise: 0.01, r: rng(14) });
    const settled = frames.filter((f) => f.t >= 300);
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
    for (const f of frames.filter((f) => f.t >= 1000)) expect(f.sources).toHaveLength(2);
  });

  it('holds a light that drops out of the activity map for ~0.5 s, still reading its level, then drops it', () => {
    const weak: Tile = { x: 10, y: 10, size: 6, value: 0.2, on: blinking(18) };
    const strongOn = blinking(19);
    // A much stronger light appears at 2 s, so the weak one falls under the relative threshold.
    const strong: Tile = { x: 70, y: 50, size: 6, value: 1, on: (slot) => slot >= 20 && strongOn(slot) };
    const finder = new LightFinder(W, H, { relThreshold: 0.2 });
    const frames = run(finder, 4000, () => [weak, strong], { noise: 0.005, r: rng(20) });
    const before = frames.filter((f) => f.t >= 1000 && f.t < 2000);
    const weakId = before[0].sources[0].id;
    for (const f of before) expect(ids(f.sources)).toEqual([weakId]);

    // Find when the weak light stops being detected, if it does: it must linger for a while.
    const after = frames.filter((f) => f.t >= 2000);
    const lastSeen = after.filter((f) => f.sources.some((s) => s.id === weakId)).at(-1)!;
    const goneAt = after.find((f) => f.t > lastSeen.t)?.t ?? Infinity;
    expect(goneAt).toBeLessThan(4000);
    // While held, its position stays put and its level still follows the tile.
    const held = after.filter((f) => f.t <= lastSeen.t).map((f) => f.sources.find((s) => s.id === weakId)!);
    for (const s of held) {
      expect(s.cx).toBeCloseTo(13 / W, 1);
      expect(s.cy).toBeCloseTo(13 / H, 1);
    }
    const heldLevels = held.slice(-12).map((s) => s.level);
    expect(Math.max(...heldLevels) - Math.min(...heldLevels)).toBeGreaterThan(0.1);

    // Without holding it would have gone about 0.5 s earlier.
    const noHold = run(new LightFinder(W, H, { relThreshold: 0.2, holdMs: 0 }), 4000, () => [weak, strong], { noise: 0.005, r: rng(20) });
    const nearWeak = (s: Source) => s.cx < 0.5 && s.cy < 0.5;
    const goneNoHold = noHold.find((f) => f.t >= 2000 && !f.sources.some(nearWeak))!.t;
    expect(after.find((f) => f.t >= 2000 && !f.sources.some(nearWeak))!.t).toBe(goneAt);
    expect(goneAt - goneNoHold).toBeGreaterThan(400);
    expect(goneAt - goneNoHold).toBeLessThan(600);
  });

  it('holds a light hidden for a few frames under the same id', () => {
    const on = blinking(21);
    // The tile jumps out of the picture for 200 ms and comes back.
    const tile = (t: number): Tile[] => [{ x: t >= 1500 && t < 1700 ? -100 : 40, y: 30, size: 5, on }];
    const finder = new LightFinder(W, H, { tauMs: 300 });
    const frames = run(finder, 3000, tile, { noise: 0.01, r: rng(22) });
    const settled = frames.filter((f) => f.t >= 1000);
    const id = settled[0].sources[0].id;
    for (const f of settled) expect(f.sources.map((s) => s.id)).toEqual([id]);
  });

  it('numbers sources from 1 and reuses a freed number', () => {
    const on = blinking(23);
    const a = (t: number): Tile[] => (t < 1000 ? [{ x: 10, y: 10, size: 5, on }] : t > 3000 ? [{ x: 70, y: 40, size: 5, on }] : []);
    const finder = new LightFinder(W, H, { tauMs: 150 });
    const frames = run(finder, 4000, a, { noise: 0.01, r: rng(24) });
    expect(frames.find((f) => f.sources.length)!.sources[0].id).toBe(1);
    expect(frames.at(-1)!.sources.map((s) => s.id)).toEqual([1]);
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
